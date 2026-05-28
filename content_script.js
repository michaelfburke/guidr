/**
 * content_script.js
 * Injected on demand by the service worker when the user starts recording
 * (chrome.scripting.executeScript) and re-injected after navigations within
 * the recording tab. Not injected at install time.
 *
 * In the new (video-track) capture model this script does not capture any
 * images. The source of truth is a desktopCapture MediaStream owned by the
 * side panel. The job of this script is to emit timestamped chapter markers
 * — { absTs, target, url, pageTitle } — that the service worker maps onto
 * the video timeline.
 *
 * No on-page overlays during recording — anything we paint would end up in
 * the captured video and distract viewers. The side panel is the source of
 * "we are recording" feedback.
 */

(function () {
  if (window.__guidrInjected) return;
  window.__guidrInjected = true;

  let isRecording = false;

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

  function startRecording() {
    if (isRecording) return;
    isRecording = true;
    document.addEventListener("click", handleClick, true);
    document.addEventListener("keydown", handleKeyNav, true);
  }

  function stopRecording() {
    if (!isRecording) return;
    isRecording = false;
    document.removeEventListener("click", handleClick, true);
    document.removeEventListener("keydown", handleKeyNav, true);
  }

  function handleClick(e) {
    const el = e.target;
    const target = describeElement(el);

    chrome.runtime.sendMessage({
      type: "GUIDR_CHAPTER_MARKER",
      payload: {
        absTs: Date.now(),
        target,
        url: location.href,
        pageTitle: document.title,
      },
    });
  }

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

  function describeElement(el) {
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classNames: [...el.classList].slice(0, 6),
      text: getVisibleText(el),
      placeholder: el.placeholder || null,
      ariaLabel: el.getAttribute("aria-label") || null,
      role: el.getAttribute("role") || inferRole(el),
      type: el.type || null,
      href: el.tagName === "A" ? el.href : null,
      name: el.name || null,
      selector: buildSelector(el),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      viewport: { width: vw, height: vh, dpr: window.devicePixelRatio || 1 },
      click: {
        x: Math.max(0, Math.min(1, (rect.x + rect.width / 2) / vw)),
        y: Math.max(0, Math.min(1, (rect.y + rect.height / 2) / vh)),
      },
      nearestLandmark: getNearestLandmark(el),
    };
  }

  function getVisibleText(el) {
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

  function buildSelector(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    if (el.getAttribute("data-testid")) return `[data-testid="${el.getAttribute("data-testid")}"]`;
    if (el.getAttribute("aria-label"))
      return `[aria-label="${el.getAttribute("aria-label")}"]`;
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

})();
