import { db } from "../db.js";
import { ICONS } from "./icons.js";
import { sw, escHtml, timeAgo, formatMs, formatBytes, log } from "../utils.js";

const $ = (id) => document.getElementById(id);

// ── State ──────────────────────────────────────────────────────────────────
let isRecording = false;
let currentSessionId = null;
let currentSession = null;
let steps = [];

// Active MediaRecorder state — lives in the side panel because desktopCapture
// streamIds are bound to the renderer that called chooseDesktopMedia. The
// offscreen doc can't consume them; the side panel can.
let mediaRecorder = null;
let mediaStream = null;
let mediaChunks = [];
let recordingStartedAt = 0;
let recordingMimeType = "";

// Mic narration is captured in an offscreen document (Chrome side panels
// can't host the mic permission prompt). We just track whether voice was
// successfully prepared for the current recording — actual recorder state
// lives in offscreen/voice.js.
let voicePrepared = false;

// ── DOM refs ───────────────────────────────────────────────────────────────
const recBtn         = $("recBtn");
const recLabel       = $("recLabel");
const recDot         = $("recDot");
const captureSection = $("captureSection");
const captureList    = $("captureList");
const sessionsList   = $("sessionsList");

// ── Boot ───────────────────────────────────────────────────────────────────
loadSessions();
applyOnboardingState();

// If the user accidentally closes the side panel mid-recording, kill the
// stream cleanly so the OS doesn't keep capturing in the background.
window.addEventListener("beforeunload", () => {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    try { mediaRecorder.stop(); } catch {}
  }
  if (mediaStream) {
    try { mediaStream.getTracks().forEach(t => t.stop()); } catch {}
  }
  // If a voice capture is in flight when the panel closes, cancel via SW
  // so the offscreen document tears down its stream and recorder cleanly.
  if (voicePrepared) {
    voicePrepared = false;
    try { sw({ type: "SP_VOICE_CANCEL" }); } catch {}
  }
});

async function applyOnboardingState() {
  const { apiKey, onboardingSkipped } = await chrome.storage.local.get(["apiKey", "onboardingSkipped"]);
  const hasKey = !!apiKey;
  const cleared = hasKey || !!onboardingSkipped;
  $("setupCard").style.display = cleared ? "none" : "";
  recBtn.style.display         = cleared ? "" : "none";
}

$("goSetupBtn").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("skipSetupBtn").addEventListener("click", async () => {
  await chrome.storage.local.set({ onboardingSkipped: true });
  applyOnboardingState();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.apiKey || changes.onboardingSkipped)) applyOnboardingState();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "SW_STEP_CAPTURED") onStepCaptured(msg.payload.step);
  if (msg.type === "SW_STEP_ENRICHED") onStepEnriched(msg.payload.step);
  if (msg.type === "SW_MARKERS_STATUS") setMarkersWarning(!msg.active);
});

function setMarkersWarning(show) {
  const el = $("coachLine");
  if (!el) return;
  if (show) {
    el.textContent = "⚠︎ Step capture is blocked on this page. Your video is still recording — switch to your product tab to capture clicks.";
    el.style.display = "";
    el.classList.add("warn");
  } else {
    el.textContent = "Walk through your product. Each click captures a step. Stop when you’re done.";
    el.style.display = "";
    el.classList.remove("warn");
  }
}

// ── Navigation ─────────────────────────────────────────────────────────────
$("btn-home").addEventListener("click", () => showView("v-home"));
$("btn-options").addEventListener("click", () => chrome.runtime.openOptionsPage());

function showView(id) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  $(id).classList.add("active");
  $("btn-home").classList.toggle("has-back", id !== "v-home");
  if (id === "v-home") {
    loadSessions();
    currentSession = null;
    currentSessionId = null;
  }
}

// ── Recording ──────────────────────────────────────────────────────────────
recBtn.addEventListener("click", async () => {
  if (!isRecording) {
    // Prepare the mic FIRST via the offscreen document. Side-panel
    // getUserMedia can't show the permission prompt; offscreen docs with
    // reason USER_MEDIA can. This call asks the offscreen doc to acquire the
    // mic stream now — the prompt appears anchored to the focused tab.
    // Soft failure: a denied or unavailable mic continues with video-only.
    voicePrepared = false;
    const voicePrep = await sw({ type: "SP_VOICE_PREPARE" });
    if (voicePrep?.ok) {
      voicePrepared = true;
    } else {
      showVoicePrepError(voicePrep);
    }

    // First-run hint: show a coach toast before the picker opens so the user
    // knows to pick the tab or window they want to walk through.
    const { pickerHintShown } = await chrome.storage.local.get(["pickerHintShown"]);
    if (!pickerHintShown) {
      toast("Pick the tab or window you want to walk through in the picker", 4000);
      chrome.storage.local.set({ pickerHintShown: true });
    }

    let streamId;
    try {
      streamId = await new Promise((resolve, reject) => {
        chrome.desktopCapture.chooseDesktopMedia(["tab", "window", "screen"], (id) => {
          if (!id) reject(new Error("Capture cancelled"));
          else resolve(id);
        });
      });
    } catch (err) {
      console.warn("[Guidr] desktopCapture failed:", err);
      if (voicePrepared) {
        voicePrepared = false;
        sw({ type: "SP_VOICE_CANCEL" });
      }
      errorToast(err.message === "Capture cancelled"
        ? "Recording cancelled"
        : "Could not start screen capture: " + err.message);
      return;
    }

    // Consume the streamId here (same renderer as chooseDesktopMedia) — this
    // is the only context Chrome will let the streamId be used from.
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: "desktop",
            chromeMediaSourceId: streamId,
          },
        },
      });
    } catch (err) {
      console.warn("[Guidr] getUserMedia failed:", err);
      if (voicePrepared) {
        voicePrepared = false;
        sw({ type: "SP_VOICE_CANCEL" });
      }
      errorToast(`Could not start capture (${err.name}): ${err.message}`);
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) {
      errorToast("No active tab to record");
      stream.getTracks().forEach(t => t.stop());
      if (voicePrepared) {
        voicePrepared = false;
        sw({ type: "SP_VOICE_CANCEL" });
      }
      return;
    }

    const hasHost = await chrome.permissions.contains({ origins: ["<all_urls>"] });
    if (!hasHost) { try { await chrome.permissions.request({ origins: ["<all_urls>"] }); } catch {} }

    // Brief "get ready" beat before MediaRecorder actually starts — gives
    // Chrome's "is sharing" indicator time to settle (otherwise the recording
    // starts on a visible layout shift). We send SP_START_RECORDING with the
    // *future* startedAt so chapter markers align to the real MediaRecorder
    // start moment.
    const STARTUP_COUNTDOWN_MS = 800;
    recordingStartedAt = Date.now() + STARTUP_COUNTDOWN_MS;
    // Use the default name unconditionally — the topbar name input belongs
    // to whatever guide was last open in the editor and would otherwise leak
    // into the new recording (e.g. "Test" → uniqueSessionName → "Test (2)").
    const res = await sw({
      type: "SP_START_RECORDING",
      sessionName: defaultGuideName(),
      tabId: tab.id,
      startedAt: recordingStartedAt,
    });
    if (!res?.ok) {
      stream.getTracks().forEach(t => t.stop());
      if (voicePrepared) {
        voicePrepared = false;
        sw({ type: "SP_VOICE_CANCEL" });
      }
      errorToast(res?.error || "Could not start recording");
      return;
    }

    // If the starting page blocks content-script injection, warn the user
    // immediately so they know to navigate to their product before clicking.
    if (res.markersActive === false) setMarkersWarning(true);

    recBtn.classList.add("getready");
    recLabel.textContent = "Get ready…";
    await new Promise((r) => setTimeout(r, STARTUP_COUNTDOWN_MS));
    recBtn.classList.remove("getready");

    // Wire up MediaRecorder locally.
    recordingMimeType = pickMimeType();
    mediaRecorder = new MediaRecorder(stream, {
      mimeType: recordingMimeType,
      videoBitsPerSecond: 4_000_000,
    });
    mediaChunks = [];
    mediaStream = stream;
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) mediaChunks.push(e.data); };
    mediaRecorder.start(1000);

    if (voicePrepared) {
      const startRes = await sw({
        type: "SP_VOICE_START",
        sessionId: res.sessionId,
        startedAt: recordingStartedAt,
      });
      if (!startRes?.ok) {
        console.warn("[Guidr] voice start failed:", startRes);
        voicePrepared = false;
      }
    }

    // If the captured tab/window closes, MediaRecorder's track will end —
    // surface a clean stop in that case.
    stream.getVideoTracks()[0]?.addEventListener("ended", () => {
      if (isRecording) finalizeRecording();
    });

    currentSessionId = res.sessionId;
    steps = [];
    setRecording(true);
    captureSection.style.display = "";
    captureList.innerHTML = "";
    $("sessionsSection").style.display = "none";

    const { seenFirstRecording } = await chrome.storage.local.get("seenFirstRecording");
    const coachEl = $("coachLine");
    // If markers are already blocked, setMarkersWarning already set the warn
    // variant. Otherwise show the normal coach hint on first use.
    if (res.markersActive === false) {
      coachEl.style.display = "";
    } else if (!seenFirstRecording) {
      coachEl.style.display = "";
      coachEl.textContent = "Walk through your product. Each click captures a step. Stop when you're done.";
      chrome.storage.local.set({ seenFirstRecording: true });
    } else {
      coachEl.style.display = "none";
    }

    // Green "go" burst announcing recording is live, then settle into the
    // standard recording state.
    recBtn.classList.add("starting");
    setTimeout(() => recBtn.classList.remove("starting"), 650);
  } else {
    await finalizeRecording();
  }
});

async function finalizeRecording() {
  if (!mediaRecorder) return;
  const recorder = mediaRecorder;
  const sessionId = currentSessionId;
  mediaRecorder = null;

  try {
    await new Promise((resolve) => {
      if (recorder.state === "inactive") return resolve();
      recorder.addEventListener("stop", () => resolve(), { once: true });
      recorder.stop();
    });
  } catch (err) {
    console.warn("[Guidr] recorder stop failed:", err);
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }

  const blob = new Blob(mediaChunks, { type: recordingMimeType });
  const durationMs = Date.now() - recordingStartedAt;
  mediaChunks = [];

  try {
    if (sessionId && blob.size > 0) {
      await db.saveRecording({ sessionId, blob, mimeType: recordingMimeType, durationMs });
    }
  } catch (err) {
    console.error("[Guidr] saveRecording failed:", err);
    if (err.name === "QuotaExceededError") {
      errorToast("Storage is full — delete old guides or their video tracks to free space, then re-record.", 8000);
    } else {
      errorToast("Could not save recording: " + err.message);
    }
  }

  // Stop the offscreen mic recorder. The offscreen doc writes the blob to
  // IDB directly (cross-context Blob marshalling via sendMessage strips the
  // payload). A failure here is non-fatal — the video has already been saved.
  if (voicePrepared) {
    voicePrepared = false;
    try {
      const stopRes = await sw({ type: "SP_VOICE_STOP" });
      if (!stopRes?.ok) console.warn("[Guidr] voice stop failed:", stopRes);
    } catch (err) {
      console.error("[Guidr] SP_VOICE_STOP failed:", err);
    }
  }

  await sw({ type: "SP_STOP_RECORDING" });
  setRecording(false);
  captureSection.style.display = "none";
  $("sessionsSection").style.display = "";
  loadSessions();
  if (steps.length) {
    toast("Recording stopped");
    setTimeout(() => openSession(sessionId), 300);
  } else {
    // No chapter markers were captured. The video is saved, but the user
    // should know so they can re-record on an interactive page or add steps
    // manually in the editor.
    errorToast(
      "Recording saved, but no steps were captured. Open the guide to add steps manually, or re-record on your product page.",
      8000
    );
  }
}

function pickMimeType() {
  const candidates = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return "video/webm";
}

// Surface the offscreen mic-prep failure as a long, actionable toast so the
// user doesn't have to dig through devtools to learn what went wrong.
//
// Chrome won't let side panels (or offscreen documents triggered from them)
// show the mic permission prompt without prior grant. The only reliable path
// to grant mic for this extension origin is via the options page, which is a
// regular extension tab and *can* show the prompt. We route the user there.
function showVoicePrepError(res) {
  const name = res?.error || "unknown";
  const message = res?.message || "";
  console.warn(`[Guidr] voice prepare failed: ${name} — ${message}`);
  if (name === "NotAllowedError") {
    errorToast(
      "Microphone not granted. Open Settings → Recording → Enable microphone, then try again. " +
      "Recording without narration.",
      10000
    );
  } else if (name === "NotFoundError") {
    toast("No microphone detected. Recording without narration.");
  } else if (name === "NotReadableError") {
    toast("Microphone is in use by another app. Recording without narration.");
  } else {
    errorToast(
      `Microphone unavailable (${name}${message ? ` — ${message}` : ""}). Recording without narration.`,
      9000
    );
  }
}

let recStatusTimer = null;
function setRecording(val) {
  isRecording = val;
  recBtn.classList.toggle("recording", val);
  recLabel.textContent = val ? "Stop recording" : "Start recording";
  recDot.style.display = val ? "" : "none";
  if (val) {
    updateRecStatus();
    recStatusTimer = setInterval(updateRecStatus, 1000);
  } else if (recStatusTimer) {
    clearInterval(recStatusTimer);
    recStatusTimer = null;
  }
}

function updateRecStatus() {
  const elapsed = Math.max(0, Date.now() - recordingStartedAt) / 1000;
  const m = Math.floor(elapsed / 60);
  const s = Math.floor(elapsed - m * 60);
  $("recTime").textContent = `${m}:${String(s).padStart(2, "0")}`;
  $("recStepCount").textContent = steps.length;
  $("recStepPlural").textContent = steps.length === 1 ? "" : "s";
}

function defaultGuideName() {
  const d = new Date();
  const month = d.toLocaleString(undefined, { month: "short" });
  const day = d.getDate();
  const hr = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `Untitled guide · ${month} ${day}, ${hr}:${min}`;
}

function onStepCaptured(step) {
  steps.push(step);
  renderCaptureList();
  if (isRecording) updateRecStatus();
}

const CAPTURE_VISIBLE_MAX = 6;

function renderCaptureList() {
  captureList.innerHTML = "";
  const total = steps.length;
  const hidden = Math.max(0, total - CAPTURE_VISIBLE_MAX);
  if (hidden > 0) {
    const pill = document.createElement("div");
    pill.className = "capture-earlier";
    pill.textContent = `+${hidden} earlier`;
    captureList.appendChild(pill);
  }
  steps.slice(-CAPTURE_VISIBLE_MAX).forEach((step) => {
    const item = document.createElement("div");
    item.className = `capture-item${step.included === false ? " dropped" : ""}`;
    item.id = `cap-${step.id}`;
    const rawLabel = step.target?.text || step.target?.ariaLabel || step.pageTitle || "Step";
    const cleanLabel = String(rawLabel).replace(/\s+/g, " ").trim().slice(0, 40);
    const number = step.index + 1;
    const dropTitle = step.included === false ? "Include in guide" : "Exclude from guide";
    item.innerHTML = `
      <div class="capture-num">${number}</div>
      <div class="capture-info">
        <span>Clicked "${escHtml(cleanLabel)}"</span>
        <span class="ts">${formatMs(step.tsMs)}</span>
      </div>
      <button class="capture-drop" data-id="${step.id}" title="${dropTitle}" aria-label="${dropTitle}">${step.included === false ? ICONS.rotateCcw : ICONS.x}</button>`;
    captureList.appendChild(item);
  });
  captureList.querySelectorAll(".capture-drop").forEach((btn) => {
    btn.addEventListener("click", () => toggleCaptureDropped(btn.dataset.id));
  });
}

async function toggleCaptureDropped(stepId) {
  const step = steps.find((s) => s.id === stepId);
  if (!step) return;
  step.included = step.included === false ? true : false;
  renderCaptureList();
  await sw({ type: "SP_UPDATE_STEP", stepId, updates: { included: step.included } });
}

function onStepEnriched(step) {
  const i = steps.findIndex(s => s.id === step.id);
  if (i !== -1) steps[i] = step;
}

// ── Sessions list ──────────────────────────────────────────────────────────
async function loadSessions() {
  const res = await sw({ type: "SP_GET_SESSIONS" });
  const list = res?.sessions || [];
  if (!list.length) {
    sessionsList.innerHTML = '<div class="empty-sessions">No guides yet. Hit <strong>Start recording</strong>, walk through your product, then stop. Your guide appears here.</div>';
    return;
  }
  sessionsList.innerHTML = "";
  list.slice(0, 12).forEach(s => {
    const card = document.createElement("div");
    card.className = "session-card";
    const vidBadge = s.hasRecording
      ? `<span class="size-badge has-vid">${formatBytes(s.recordingBytes)}</span>`
      : `<span class="size-badge">no video</span>`;
    const voiceBadge = s.hasVoice
      ? `<span class="size-badge has-voice">${formatBytes(s.voiceBytes)}</span>`
      : "";
    const dropVidItem = s.hasRecording
      ? `<div class="menu-item" data-act="drop-vid">${ICONS.videoOff} Remove video (keep text)</div>`
      : "";
    const dropVoiceItem = s.hasVoice
      ? `<div class="menu-item" data-act="drop-voice">${ICONS.videoOff} Remove narration (keep text)</div>`
      : "";
    const sep = (dropVidItem || dropVoiceItem) ? `<div class="sep"></div>` : "";
    card.innerHTML = `
      <div class="session-card-body">
        <strong>${escHtml(s.name)}</strong>
        <div class="meta">
          <span>${s.stepCount} step${s.stepCount!==1?"s":""} · ${timeAgo(s.updatedAt)}</span>
          ${vidBadge}
          ${voiceBadge}
        </div>
      </div>
      <div class="overflow-wrap">
        <button class="overflow-btn" data-act="more" aria-label="More actions">${ICONS.moreHorizontal}</button>
        <div class="overflow-menu">
          ${dropVidItem}
          ${dropVoiceItem}
          ${sep}
          <div class="menu-item danger" data-act="delete">${ICONS.trash} Delete guide</div>
        </div>
      </div>`;
    card.addEventListener("click", (e) => {
      if (e.target.closest("[data-act], .overflow-menu")) return;
      openSession(s.id);
    });
    const menu = card.querySelector(".overflow-menu");
    card.querySelector('[data-act="more"]').addEventListener("click", (e) => {
      e.stopPropagation();
      document.querySelectorAll(".session-card .overflow-menu.open").forEach((m) => {
        if (m !== menu) m.classList.remove("open");
      });
      menu.classList.toggle("open");
    });
    card.querySelector('[data-act="delete"]').addEventListener("click", async (e) => {
      e.stopPropagation();
      menu.classList.remove("open");
      const ok = await confirmModal({
        title: "Delete guide?",
        body: `"${s.name}" and all its steps will be permanently removed. This cannot be undone.`,
        confirmLabel: "Delete guide",
      });
      if (!ok) return;
      const r = await sw({ type: "SP_DELETE_SESSION", sessionId: s.id });
      if (!r?.ok) return errorToast("Could not delete guide");
      toast("Guide deleted");
      loadSessions();
    });
    card.querySelector('[data-act="drop-vid"]')?.addEventListener("click", async (e) => {
      e.stopPropagation();
      menu.classList.remove("open");
      const mb = (s.recordingBytes / 1024 / 1024).toFixed(1);
      const ok = await confirmModal({
        title: "Remove video?",
        body: `"${s.name}" will keep its steps and text. The ${mb} MB video track will be deleted, and screenshots and video export will no longer be available.`,
        confirmLabel: "Remove video",
      });
      if (!ok) return;
      const r = await sw({ type: "SP_DELETE_RECORDING", sessionId: s.id });
      if (!r?.ok) return errorToast("Could not delete video track");
      toast("Video track deleted");
      loadSessions();
    });
    card.querySelector('[data-act="drop-voice"]')?.addEventListener("click", async (e) => {
      e.stopPropagation();
      menu.classList.remove("open");
      const mb = (s.voiceBytes / 1024 / 1024).toFixed(1);
      const ok = await confirmModal({
        title: "Remove narration?",
        body: `"${s.name}" will keep its steps, text, and video. The ${mb} MB narration audio will be deleted.`,
        confirmLabel: "Remove narration",
      });
      if (!ok) return;
      const r = await sw({ type: "SP_DELETE_VOICE", sessionId: s.id });
      if (!r?.ok) return errorToast("Could not delete narration");
      toast("Narration deleted");
      loadSessions();
    });
    sessionsList.appendChild(card);
  });
}

// Close any open session-card menu when clicking elsewhere
document.addEventListener("click", (e) => {
  if (e.target.closest(".session-card .overflow-wrap")) return;
  document.querySelectorAll(".session-card .overflow-menu.open").forEach((m) => m.classList.remove("open"));
});

// ── Open session in editor ─────────────────────────────────────────────────
function openSession(sessionId) {
  chrome.tabs.create({
    url: chrome.runtime.getURL("editor/index.html") + "?session=" + encodeURIComponent(sessionId),
  });
}

// ── In-panel confirm modal ────────────────────────────────────────────────
const modalBackdrop = $("modalBackdrop");
const modalTitle    = $("modalTitle");
const modalBody     = $("modalBody");
const modalConfirm  = $("modalConfirm");
const modalCancel   = $("modalCancel");
let modalResolver = null;

function closeModal(result) {
  modalBackdrop.classList.remove("open");
  document.removeEventListener("keydown", onModalKey);
  if (modalResolver) { modalResolver(result); modalResolver = null; }
}
function onModalKey(e) {
  if (e.key === "Escape") closeModal(false);
  else if (e.key === "Enter") closeModal(true);
}
modalCancel.addEventListener("click", () => closeModal(false));
modalConfirm.addEventListener("click", () => closeModal(true));
modalBackdrop.addEventListener("click", (e) => {
  if (e.target === modalBackdrop) closeModal(false);
});

function confirmModal({ title, body, confirmLabel = "Delete", cancelLabel = "Cancel", danger = true }) {
  modalTitle.textContent = title;
  modalBody.textContent  = body;
  modalConfirm.textContent = confirmLabel;
  modalCancel.textContent  = cancelLabel;
  modalConfirm.classList.toggle("danger", danger);
  modalConfirm.classList.toggle("primary", !danger);
  modalBackdrop.classList.add("open");
  document.addEventListener("keydown", onModalKey);
  modalConfirm.focus();
  return new Promise((resolve) => { modalResolver = resolve; });
}

let toastTimer;
function toast(msg, ms = 2600) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("error");
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}
function errorToast(msg, ms = 6000) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show", "error");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}


