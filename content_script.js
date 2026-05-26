/**
 * content_script.js
 * Injected into every page. Captures user interactions and DOM context.
 * Sends events to service_worker.js via chrome.runtime.sendMessage.
 *
 * Captured per step:
 *  - screenshot (requested from service worker via tabs.captureVisibleTab)
 *  - click target: selector, text, role, aria-label, bounding rect
 *  - url + page title
 *  - pre-action and post-action screenshots (waits for DOM settle)
 */

(function () {
  // Guard: don't double-inject
  if (window.__guidrInjected) return;
  window.__guidrInjected = true;

  // ─── State ────────────────────────────────────────────────────────────────

  let isRecording = false;
  let overlay = null; // click highlight ring

  // ─── Listen for commands from the side panel (via service worker) ─────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "GUIDR_START_RECORDING") {
      startRecording();
      sendResponse({ ok: true });
    }
    if (msg.type === "GUIDR_STOP_RECORDING") {
      stopRecording();
      sendResponse({ ok: true });
    }
    if (msg.type === "GUIDR_PING") {
      sendResponse({ ok: true, recording: isRecording });
    }
  });

  // ─── Recording lifecycle ──────────────────────────────────────────────────

  function startRecording() {
    if (isRecording) return;
    isRecording = true;
    injectOverlayStyles();
    document.addEventListener("click", handleClick, true); // capture phase
    document.addEventListener("keydown", handleKeyNav, true);
    showBanner("Recording — click through your product");
  }

  function stopRecording() {
    if (!isRecording) return;
    isRecording = false;
    document.removeEventListener("click", handleClick, true);
    document.removeEventListener("keydown", handleKeyNav, true);
    removeBanner();
    removeOverlay();
  }

  // ─── Click handler ────────────────────────────────────────────────────────

  async function handleClick(e) {
    // Ignore clicks on our own injected UI
    if (e.target.closest("[data-guidr-ui]")) return;

    const el = e.target;
    const target = describeElement(el);
    flashOverlay(el);

    // Hide Guidr's own banner/ring before capture so they don't end up in the screenshot.
    // Restore once the service worker confirms capture is done.
    setGuidrUIHidden(true);
    requestAnimationFrame(() => {
      chrome.runtime.sendMessage({
        type: "GUIDR_CAPTURE_STEP",
        payload: { target, url: location.href, pageTitle: document.title, timestamp: Date.now() },
      }, () => setGuidrUIHidden(false));
    });

    // After the action resolves and DOM settles, capture the "after" frame — same hide/restore.
    waitForDOMSettle().then(() => {
      setGuidrUIHidden(true);
      requestAnimationFrame(() => {
        chrome.runtime.sendMessage({
          type: "GUIDR_DOM_SETTLED",
          payload: { url: location.href },
        }, () => setGuidrUIHidden(false));
      });
    });
  }

  function setGuidrUIHidden(hide) {
    document.querySelectorAll("[data-guidr-ui]").forEach((el) => {
      el.style.visibility = hide ? "hidden" : "";
    });
  }

  // ─── Keyboard navigation (tab + enter / space) ────────────────────────────

  function handleKeyNav(e) {
    if (!["Enter", " "].includes(e.key)) return;
    const el = document.activeElement;
    if (!el || el === document.body) return;
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    const isInteractive =
      ["button", "a", "input", "select", "textarea"].includes(tag) ||
      ["button", "link", "menuitem", "tab", "option"].includes(role);
    if (!isInteractive) return;
    handleClick({ target: el, stopPropagation: () => {} });
  }

  // ─── DOM settle detection ─────────────────────────────────────────────────

  function waitForDOMSettle(timeout = 2000, quietPeriod = 300) {
    return new Promise((resolve) => {
      let timer;
      const observer = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          observer.disconnect();
          resolve();
        }, quietPeriod);
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
      });
      // Also resolve on hard timeout
      setTimeout(() => {
        observer.disconnect();
        resolve();
      }, timeout);
      // Kick off immediately in case nothing changes
      timer = setTimeout(() => {
        observer.disconnect();
        resolve();
      }, quietPeriod);
    });
  }

  // ─── Element descriptor ───────────────────────────────────────────────────

  /**
   * Returns a rich, serialisable description of a DOM element.
   * This is what the LLM receives as context for generating step text.
   */
  function describeElement(el) {
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classNames: [...el.classList].slice(0, 6), // don't send everything
      text: getVisibleText(el),
      placeholder: el.placeholder || null,
      ariaLabel: el.getAttribute("aria-label") || null,
      role: el.getAttribute("role") || inferRole(el),
      type: el.type || null, // for inputs
      href: el.tagName === "A" ? el.href : null,
      name: el.name || null,
      selector: buildSelector(el),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      // Viewport at capture time — required by the video renderer to map
      // click coordinates correctly on HiDPI displays where the screenshot
      // is captured at viewport × devicePixelRatio.
      viewport: { width: vw, height: vh, dpr: window.devicePixelRatio || 1 },
      // Pre-normalized click point (0–1 in viewport space). Center of rect,
      // clamped so off-screen elements don't push the cursor outside the frame.
      click: {
        x: Math.max(0, Math.min(1, (rect.x + rect.width / 2) / vw)),
        y: Math.max(0, Math.min(1, (rect.y + rect.height / 2) / vh)),
      },
      // Nearest ancestor with a semantic role (helps LLM understand context)
      nearestLandmark: getNearestLandmark(el),
    };
  }

  function getVisibleText(el) {
    // Prefer aria-label, then innerText trimmed to 120 chars
    const label = el.getAttribute("aria-label") || el.getAttribute("title");
    if (label) return label.trim().slice(0, 120);
    return (el.innerText || el.textContent || "").trim().slice(0, 120);
  }

  function inferRole(el) {
    const map = {
      button: "button",
      a: "link",
      input: el.type === "checkbox" ? "checkbox" : el.type === "radio" ? "radio" : "textbox",
      select: "listbox",
      textarea: "textbox",
      nav: "navigation",
      main: "main",
      header: "banner",
      footer: "contentinfo",
    };
    return map[el.tagName.toLowerCase()] || null;
  }

  function getNearestLandmark(el) {
    const landmarks = ["nav", "main", "header", "footer", "aside", "section", "form", "dialog"];
    let node = el.parentElement;
    while (node && node !== document.body) {
      if (landmarks.includes(node.tagName.toLowerCase())) {
        return {
          tag: node.tagName.toLowerCase(),
          ariaLabel: node.getAttribute("aria-label") || null,
          id: node.id || null,
        };
      }
      node = node.parentElement;
    }
    return null;
  }

  /**
   * Build a short, stable CSS selector for the element.
   * Prefers id > aria-label > role+text > nth-child fallback.
   */
  function buildSelector(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    if (el.getAttribute("data-testid")) return `[data-testid="${el.getAttribute("data-testid")}"]`;
    if (el.getAttribute("aria-label"))
      return `[aria-label="${el.getAttribute("aria-label")}"]`;
    // Simple nth-child path (max 4 levels)
    const parts = [];
    let node = el;
    for (let i = 0; i < 4 && node && node !== document.body; i++) {
      const tag = node.tagName.toLowerCase();
      const siblings = node.parentElement
        ? [...node.parentElement.children].filter((c) => c.tagName === node.tagName)
        : [];
      const idx = siblings.indexOf(node) + 1;
      parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${idx})` : tag);
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  // ─── Visual feedback ──────────────────────────────────────────────────────

  function injectOverlayStyles() {
    if (document.getElementById("guidr-styles")) return;
    const style = document.createElement("style");
    style.id = "guidr-styles";
    style.textContent = `
      @keyframes guidr-ring-out {
        0%   { transform: scale(1);   opacity: 0.9; }
        100% { transform: scale(2.2); opacity: 0; }
      }
      #guidr-overlay-ring {
        position: fixed;
        pointer-events: none;
        border-radius: 6px;
        border: 3px solid #6366f1;
        background: rgba(99,102,241,0.08);
        z-index: 2147483647;
        animation: guidr-ring-out 0.5s ease-out forwards;
      }
      #guidr-banner {
        position: fixed;
        bottom: 24px;
        left: 50%;
        transform: translateX(-50%);
        background: #18181b;
        color: #fff;
        font-family: system-ui, sans-serif;
        font-size: 13px;
        padding: 8px 18px;
        border-radius: 999px;
        z-index: 2147483647;
        box-shadow: 0 4px 20px rgba(0,0,0,0.35);
        display: flex;
        align-items: center;
        gap: 8px;
        pointer-events: none;
      }
      #guidr-banner::before {
        content: '';
        display: inline-block;
        width: 8px; height: 8px;
        border-radius: 50%;
        background: #ef4444;
        animation: guidr-blink 1s ease-in-out infinite;
      }
      @keyframes guidr-blink {
        0%, 100% { opacity: 1; }
        50%       { opacity: 0.2; }
      }
    `;
    document.head.appendChild(style);
  }

  function flashOverlay(el) {
    removeOverlay();
    const rect = el.getBoundingClientRect();
    overlay = document.createElement("div");
    overlay.id = "guidr-overlay-ring";
    overlay.setAttribute("data-guidr-ui", "true");
    overlay.style.cssText = `
      left: ${rect.left - 4}px;
      top: ${rect.top - 4}px;
      width: ${rect.width + 8}px;
      height: ${rect.height + 8}px;
    `;
    document.body.appendChild(overlay);
    setTimeout(removeOverlay, 600);
  }

  function removeOverlay() {
    if (overlay) { overlay.remove(); overlay = null; }
  }

  function showBanner(text) {
    removeBanner();
    const banner = document.createElement("div");
    banner.id = "guidr-banner";
    banner.setAttribute("data-guidr-ui", "true");
    banner.textContent = text;
    document.body.appendChild(banner);
  }

  function removeBanner() {
    document.getElementById("guidr-banner")?.remove();
  }
})();
