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

  // Keyboard activation of a control makes the browser dispatch a synthetic
  // click (event.detail === 0) right after our keydown marker — on keydown for
  // Enter, on keyup for Space, and on the form's submit button for Enter in a
  // text field. Remember what the key acted on and swallow that one echo, so
  // one action yields one step.
  const KEY_ECHO_MAX_MS = 10_000;
  let pendingKeyEcho = null; // { el, form, ts }

  function handleClick(e) {
    if (e.detail === 0 && isKeyEcho(e.target)) {
      pendingKeyEcho = null;
      return;
    }
    emitMarker(e.target);
  }

  function isKeyEcho(target) {
    if (!pendingKeyEcho || Date.now() - pendingKeyEcho.ts > KEY_ECHO_MAX_MS) return false;
    const { el, form } = pendingKeyEcho;
    return el === target || el.contains(target) || (!!form && target.form === form);
  }

  function emitMarker(el) {
    chrome.runtime.sendMessage({
      type: "GUIDR_CHAPTER_MARKER",
      payload: {
        absTs: Date.now(),
        target: describeElement(el),
        url: location.href,
        pageTitle: document.title,
      },
    }).catch(() => {});
  }

  const BUTTON_INPUT_TYPES = ["button", "submit", "reset", "image"];
  const TOGGLE_INPUT_TYPES = ["checkbox", "radio"];
  const NON_TEXT_INPUT_TYPES = [...BUTTON_INPUT_TYPES, ...TOGGLE_INPUT_TYPES, "file", "color", "range", "hidden"];
  const ENTER_ROLES = ["button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "option", "treeitem"];
  const SPACE_ROLES = ["button", "checkbox", "radio", "switch", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "option"];

  // Does pressing `key` on `el` perform an action worth a step? Mirrors which
  // keys activate which controls, so e.g. Space on a link (scrolls) or Enter
  // on a checkbox (does nothing) doesn't create a phantom step.
  function keyActivates(el, key) {
    const tag = el.tagName.toLowerCase();
    const type = (el.type || "").toLowerCase();
    const role = el.getAttribute("role");
    if (tag === "textarea" || tag === "select" || el.isContentEditable) return false;
    if (key === "Enter") {
      if (tag === "button" || (tag === "a" && el.hasAttribute("href"))) return true;
      if (tag === "input") return BUTTON_INPUT_TYPES.includes(type) || !NON_TEXT_INPUT_TYPES.includes(type); // implicit submit
      return ENTER_ROLES.includes(role);
    }
    // Space
    if (tag === "button") return true;
    if (tag === "input") return BUTTON_INPUT_TYPES.includes(type) || TOGGLE_INPUT_TYPES.includes(type);
    if (tag === "a") return false;
    return SPACE_ROLES.includes(role);
  }

  function handleKeyNav(e) {
    if (!["Enter", " "].includes(e.key) || e.repeat) return;
    const el = document.activeElement;
    if (!el || el === document.body || !keyActivates(el, e.key)) return;
    pendingKeyEcho = { el, form: el.form || null, ts: Date.now() };
    emitMarker(el);
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

  // A <label>'s own words, minus any field nested inside it (a wrapped
  // <select> would otherwise contribute every option).
  function labelText(label) {
    const copy = label.cloneNode(true);
    copy.querySelectorAll("input, select, textarea").forEach((n) => n.remove());
    return copy.textContent;
  }

  const clip = (s) => String(s || "").replace(/\s+/g, " ").trim().slice(0, 120);

  function getVisibleText(el) {
    const label = el.getAttribute("aria-label") || el.getAttribute("title");
    if (label) return clip(label);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" ");
      if (clip(text)) return clip(text);
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "input" && BUTTON_INPUT_TYPES.includes((el.type || "").toLowerCase())) {
      return clip(el.value); // a button's caption, not user data
    }
    if (tag === "input" || tag === "textarea" || tag === "select") {
      // Describe a field by what labels it. Never read its value: that's
      // what the user typed, and a select's text is every option.
      const fromLabels = [...(el.labels || [])].map(labelText).join(" ");
      return clip(fromLabels || el.placeholder || el.name);
    }
    return clip(el.innerText || el.textContent);
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
