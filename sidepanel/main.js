import { exportSession } from "../export.js";
import { db } from "../db.js";
import { createAnnotator, renderAnnotated } from "./annotate.js";
import { ICONS } from "./icons.js";

// ── State ──────────────────────────────────────────────────────────────────
let isRecording = false;
let currentSessionId = null;
let currentSession = null;
let steps = [];
let currentStepIdx = 0;
let recordingObjectUrl = null;
let extractorObjectUrl = null;

// Active MediaRecorder state — lives in the side panel because desktopCapture
// streamIds are bound to the renderer that called chooseDesktopMedia. The
// offscreen doc can't consume them; the side panel can.
let mediaRecorder = null;
let mediaStream = null;
let mediaChunks = [];
let recordingStartedAt = 0;
let recordingMimeType = "";

// ── DOM refs ───────────────────────────────────────────────────────────────
const recBtn       = $("recBtn");
const recLabel     = $("recLabel");
const recDot       = $("recDot");
const sessionName  = $("sessionName");
const captureSection = $("captureSection");
const captureList  = $("captureList");
const sessionsList = $("sessionsList");
const srcVideo     = $("srcVideo");
const videoPane    = $("videoPane");
const chapterRail  = $("chapterRail");
const stepSkipToggle = $("stepSkipToggle");
const stepMoreBtn    = $("stepMoreBtn");
const stepMoreMenu   = $("stepMoreMenu");
const stepTs       = $("stepTs");
const stepTitle    = $("stepTitle");
const stepBody     = $("stepBody");
const stepCounter  = $("stepCounter");
const prevBtn      = $("prevBtn");
const nextBtn      = $("nextBtn");
const exportBtn        = $("exportBtn");
const exportMenu       = $("exportMenu");
const extractor    = $("extractor");
const extractorCanvas = $("extractorCanvas");
const openAnnotBtn   = $("openAnnotBtn");
const gifPanel       = $("gifPanel");
const gifStart       = $("gifStart");
const gifEnd         = $("gifEnd");
const gifFps         = $("gifFps");
const gifPreviewBtn  = $("gifPreviewBtn");
const gifGenerateBtn = $("gifGenerateBtn");
const gifStatus      = $("gifStatus");
const gifSetStartBtn = $("gifSetStartBtn");
const gifSetEndBtn   = $("gifSetEndBtn");
const gifRangeReadout = $("gifRangeReadout");
const gifPreviewImg  = $("gifPreviewImg");
const mediaPills     = document.querySelectorAll(".media-pill[data-mode]");

// Cap auto-encoded GIFs at this width — full-HD recordings encoded at native
// resolution produce 10–30MB GIFs that some renderers (Intercom in particular)
// refuse to inline. 1280px is plenty for help-center / Notion docs.
const GIF_MAX_WIDTH = 1280;
// Warn the user above this raw size — they may want a shorter clip / lower fps.
const GIF_SIZE_WARN_BYTES = 3 * 1024 * 1024;

// GIF preview/encode state
let gifPreviewStopTimer = null;
let gifEncoding = false;

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
});

// ── Navigation ─────────────────────────────────────────────────────────────
$("btn-home").addEventListener("click", () => showView("v-home"));
$("btn-options").addEventListener("click", () => chrome.runtime.openOptionsPage());

// Auto-save the guide name (debounced) — visible in the editor topbar only.
let sessionNameSaveTimer;
sessionName.addEventListener("input", () => {
  if (!currentSessionId) return;
  clearTimeout(sessionNameSaveTimer);
  sessionNameSaveTimer = setTimeout(async () => {
    const next = sessionName.value.trim() || defaultGuideName();
    if (currentSession) currentSession.name = next;
    await sw({ type: "SP_UPDATE_SESSION", sessionId: currentSessionId, updates: { name: next } });
  }, 500);
});
sessionName.addEventListener("blur", () => {
  if (sessionName.value.trim() === "") sessionName.value = currentSession?.name || "";
});

function showView(id) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  $(id).classList.add("active");
  $("btn-home").classList.toggle("has-back", id !== "v-home");
  document.querySelector(".topbar").classList.toggle("editor", id === "v-editor");
}

// ── Recording ──────────────────────────────────────────────────────────────
recBtn.addEventListener("click", async () => {
  if (!isRecording) {
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
      errorToast(`Could not start capture (${err.name}): ${err.message}`);
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) { errorToast("No active tab to record"); stream.getTracks().forEach(t => t.stop()); return; }

    const hasHost = await chrome.permissions.contains({ origins: ["<all_urls>"] });
    if (!hasHost) { try { await chrome.permissions.request({ origins: ["<all_urls>"] }); } catch {} }

    // Brief "get ready" beat before MediaRecorder actually starts — gives
    // Chrome's "is sharing" indicator time to settle (otherwise the recording
    // starts on a visible layout shift). We send SP_START_RECORDING with the
    // *future* startedAt so chapter markers align to the real MediaRecorder
    // start moment.
    const STARTUP_COUNTDOWN_MS = 800;
    recordingStartedAt = Date.now() + STARTUP_COUNTDOWN_MS;
    const res = await sw({
      type: "SP_START_RECORDING",
      sessionName: sessionName.value.trim() || defaultGuideName(),
      tabId: tab.id,
      startedAt: recordingStartedAt,
    });
    if (!res?.ok) {
      stream.getTracks().forEach(t => t.stop());
      errorToast(res?.error || "Could not start recording");
      return;
    }

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
    $("coachLine").style.display = seenFirstRecording ? "none" : "";
    if (!seenFirstRecording) {
      chrome.storage.local.set({ seenFirstRecording: true });
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
    errorToast("Could not save recording: " + err.message);
  }

  await sw({ type: "SP_STOP_RECORDING" });
  setRecording(false);
  captureSection.style.display = "none";
  $("sessionsSection").style.display = "";
  toast("Recording stopped");
  loadSessions();
  if (steps.length) setTimeout(() => openSession(sessionId), 300);
}

function pickMimeType() {
  const candidates = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return "video/webm";
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
  if ($("v-editor").classList.contains("active") && steps[currentStepIdx]?.id === step.id) {
    loadStepFields(step);
  }
  renderChapterRail();
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
    const sizeLabel = s.hasRecording
      ? `<span class="size-badge has-vid">${formatBytes(s.recordingBytes)}</span>`
      : `<span class="size-badge">no video</span>`;
    const dropVidItem = s.hasRecording
      ? `<div class="menu-item" data-act="drop-vid">${ICONS.videoOff} Remove video (keep text)</div><div class="sep"></div>`
      : "";
    card.innerHTML = `
      <div class="session-card-body">
        <strong>${escHtml(s.name)}</strong>
        <div class="meta">
          <span>${s.stepCount} step${s.stepCount!==1?"s":""} · ${timeAgo(s.updatedAt)}</span>
          ${sizeLabel}
        </div>
      </div>
      <div class="overflow-wrap">
        <button class="overflow-btn" data-act="more" aria-label="More actions">${ICONS.moreHorizontal}</button>
        <div class="overflow-menu">
          ${dropVidItem}
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
    sessionsList.appendChild(card);
  });
}

// Close any open session-card menu when clicking elsewhere
document.addEventListener("click", (e) => {
  if (e.target.closest(".session-card .overflow-wrap")) return;
  document.querySelectorAll(".session-card .overflow-menu.open").forEach((m) => m.classList.remove("open"));
});

// ── Open session in editor ─────────────────────────────────────────────────
async function openSession(sessionId) {
  console.log("[Guidr] openSession", sessionId);
  let res;
  try {
    res = await sw({ type: "SP_GET_SESSION", sessionId });
  } catch (err) {
    console.error("[Guidr] SP_GET_SESSION failed:", err);
    return errorToast("Could not open guide: " + err.message);
  }
  if (!res?.ok) {
    console.warn("[Guidr] SP_GET_SESSION returned not-ok:", res);
    return errorToast("Could not open guide");
  }

  currentSessionId = sessionId;
  currentSession = res.session;
  steps = (res.session.steps || []).map(normalizeStep);
  sessionName.value = res.session.name;
  currentStepIdx = 0;

  // Show the editor immediately — recording load is best-effort and must
  // never block the UI. If the video blob fails to load (broken webm
  // duration, missing recording, etc.) the editor still shows the steps
  // and text and stays usable.
  showView("v-editor");
  renderChapterRail();
  loadStepIntoEditor(0);

  thumbCache.clear();
  loadRecordingIntoPlayers(sessionId)
    .then(() => populateRailThumbnails())
    .catch((err) => console.error("[Guidr] loadRecordingIntoPlayers failed:", err));
}

function normalizeStep(s) {
  return {
    included: true,
    mediaMode: "screenshot",
    ...s,
  };
}

async function loadRecordingIntoPlayers(sessionId) {
  if (recordingObjectUrl) URL.revokeObjectURL(recordingObjectUrl);
  if (extractorObjectUrl) URL.revokeObjectURL(extractorObjectUrl);
  recordingObjectUrl = null;
  extractorObjectUrl = null;

  // Read directly from IDB — chrome.runtime messaging strips Blobs from
  // sendResponse payloads, so going through the service worker turns the
  // recording into an empty object.
  const rec = await db.getRecording(sessionId);
  if (!rec?.blob) {
    console.log("[Guidr] no recording blob for session", sessionId);
    srcVideo.removeAttribute("src");
    srcVideo.style.display = "none";
    extractor.removeAttribute("src");
    videoPane.classList.add("empty");
    return;
  }
  console.log("[Guidr] loaded recording blob", { bytes: rec.byteSize, type: rec.mimeType });
  videoPane.classList.remove("empty");
  recordingObjectUrl = URL.createObjectURL(rec.blob);
  extractorObjectUrl = URL.createObjectURL(rec.blob);
  srcVideo.src = recordingObjectUrl;
  srcVideo.style.display = "";
  extractor.src = extractorObjectUrl;

  // Wait for the extractor to be seekable — but never hang. MediaRecorder
  // webm output has missing duration metadata in some Chrome versions which
  // can delay loadeddata indefinitely; we cap the wait at 3s and let the
  // editor stay usable either way.
  await Promise.race([
    new Promise((resolve) => {
      if (extractor.readyState >= 2) return resolve();
      extractor.addEventListener("loadeddata", resolve, { once: true });
      extractor.addEventListener("error", (e) => {
        console.warn("[Guidr] extractor error:", e);
        resolve();
      }, { once: true });
    }),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

// ── Chapter rail ───────────────────────────────────────────────────────────
// Thumbnails are extracted lazily once the recording is ready; this cache
// keeps us from re-seeking every time the rail re-renders.
const thumbCache = new Map(); // stepId → dataURL

function renderChapterRail() {
  chapterRail.innerHTML = "";
  steps.forEach((step, i) => {
    const chip = document.createElement("div");
    chip.className = `chip${i === currentStepIdx ? " active" : ""}${step.included === false ? " excluded" : ""}`;
    chip.dataset.idx = i;
    chip.dataset.id = step.id;
    const cached = thumbCache.get(step.id);
    chip.innerHTML = `
      <img class="chip-thumb" src="${cached || ""}" alt=""/>
      <div class="chip-meta">
        <span class="chip-num">${i+1}</span>
        <span class="chip-time">${formatMs(step.tsMs)}</span>
      </div>`;
    chip.addEventListener("click", () => {
      currentStepIdx = i;
      loadStepIntoEditor(i);
    });
    chapterRail.appendChild(chip);
  });
}

async function populateRailThumbnails() {
  if (!extractor.src) return;
  for (const step of steps) {
    if (thumbCache.has(step.id)) continue;
    try {
      const dataUrl = await extractFrame(step.tsMs);
      thumbCache.set(step.id, dataUrl);
      const chip = chapterRail.querySelector(`.chip[data-id="${step.id}"] .chip-thumb`);
      if (chip) chip.src = dataUrl;
    } catch (err) {
      console.warn("[Guidr] thumb extraction failed for step", step.index, ":", err.message);
    }
  }
}

// ── Step editor ────────────────────────────────────────────────────────────
function loadStepIntoEditor(idx) {
  const step = steps[idx];
  if (!step) return;
  currentStepIdx = idx;

  // Seek the source video to this step's timestamp so the viewer sees the
  // frame that prompted the click.
  if (srcVideo.src) {
    try { srcVideo.currentTime = Math.max(0, step.tsMs / 1000); } catch {}
  }

  // Close annotation pane when navigating between steps — each step has its
  // own frame and annotations, so the open pane would show stale state.
  if (annotPane?.classList.contains("active")) closeAnnotPane();

  loadStepFields(step);
  applySkipToggleState(step.included !== false);
  setActiveMediaPill(step.mediaMode || "screenshot");
  refreshGifPanel(step);
  updateAnnotateButtonState(step);
  stepTs.textContent = formatMs(step.tsMs);

  prevBtn.disabled = idx === 0;
  nextBtn.disabled = idx === steps.length - 1;
  stepCounter.textContent = `${idx + 1} / ${steps.length}`;

  renderChapterRail();
}

function loadStepFields(step) {
  stepTitle.value = step.title || "";
  stepBody.value  = step.body || "";
  autoResize(stepTitle); autoResize(stepBody);
  updateCharCounts();
}

// Auto-save on edit
let saveTimer;
[stepTitle, stepBody].forEach(ta => {
  ta.addEventListener("input", () => {
    autoResize(ta);
    updateCharCounts();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveCurrentStep, 800);
  });
});

function applySkipToggleState(included) {
  stepSkipToggle.classList.toggle("skipped", !included);
  stepSkipToggle.setAttribute("aria-checked", included ? "true" : "false");
}

stepSkipToggle.addEventListener("click", () => {
  const step = steps[currentStepIdx];
  if (!step) return;
  step.included = !(step.included !== false);
  applySkipToggleState(step.included);
  renderChapterRail();
  saveCurrentStep();
});

function setActiveMediaPill(mode) {
  mediaPills.forEach((p) => p.setAttribute("aria-checked", p.dataset.mode === mode ? "true" : "false"));
}

function updateAnnotateButtonState(step) {
  const disabled = step.mediaMode === "gif";
  openAnnotBtn.disabled = disabled;
  openAnnotBtn.title = disabled
    ? "Annotations apply to screenshot steps only"
    : "";
}

mediaPills.forEach((p) => {
  p.addEventListener("click", () => {
    const step = steps[currentStepIdx];
    if (!step) return;
    const mode = p.dataset.mode;
    if (step.mediaMode === mode) return;
    step.mediaMode = mode;
    if (mode === "gif") ensureGifDefaults(step);
    setActiveMediaPill(mode);
    refreshGifPanel(step);
    updateAnnotateButtonState(step);
    saveCurrentStep();
  });
});

// ── GIF clip controls ──────────────────────────────────────────────────────
// Default window: from the previous step's click to this one ("show the
// action that led up to this click"), but capped at 5s so long pauses
// between steps don't produce 30-second GIFs.
function ensureGifDefaults(step) {
  if (step.gifStartMs == null || step.gifEndMs == null) {
    const idx = steps.indexOf(step);
    const prev = idx > 0 ? steps[idx - 1] : null;
    const naiveStart = prev ? prev.tsMs : Math.max(0, step.tsMs - 2000);
    const cappedStart = Math.max(naiveStart, step.tsMs - 5000);
    step.gifStartMs = Math.max(0, cappedStart);
    step.gifEndMs   = step.tsMs;
  }
  if (!step.gifFps) step.gifFps = 10;
}

function refreshGifPanel(step) {
  const isGif = step.mediaMode === "gif";
  gifPanel.hidden = !isGif;
  if (!isGif) return;
  ensureGifDefaults(step);
  gifStart.value = (step.gifStartMs / 1000).toFixed(1);
  gifEnd.value   = (step.gifEndMs   / 1000).toFixed(1);
  gifFps.value   = String(step.gifFps || 10);
  const startS = (step.gifStartMs / 1000).toFixed(1);
  const endS   = (step.gifEndMs   / 1000).toFixed(1);
  const durS   = ((step.gifEndMs - step.gifStartMs) / 1000).toFixed(1);
  gifRangeReadout.textContent = `${startS}s → ${endS}s · ${durS}s clip`;
  updateGifStatus(step);
  refreshGifPreviewImg(step);
}

async function refreshGifPreviewImg(step) {
  const cached = await db.getGif(step.id).catch(() => null);
  const matches = cached
    && cached.startMs === step.gifStartMs
    && cached.endMs   === step.gifEndMs
    && cached.fps     === (step.gifFps || 10);
  if (matches) {
    gifPreviewImg.src = cached.dataUrl;
    gifPreviewImg.hidden = false;
  } else {
    gifPreviewImg.removeAttribute("src");
    gifPreviewImg.hidden = true;
  }
}

// Data-URL length → approximate decoded byte count. Base64 expands by 4/3
// and includes a small "data:image/gif;base64," prefix; close enough for a
// user-facing size readout. (formatBytes lives further down — reused from
// the session list size badges.)
function approxBase64ByteSize(dataUrl) {
  const comma = dataUrl.indexOf(",");
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return Math.floor((b64.length * 3) / 4);
}

function setGifStatus(text, cls = "") {
  gifStatus.textContent = text;
  gifStatus.className = "gif-status" + (cls ? " " + cls : "");
}

async function updateGifStatus(step) {
  if (gifEncoding) return;
  try {
    const cached = await db.getGif(step.id);
    if (!cached) { setGifStatus("Not generated yet"); return; }
    const matches =
      cached.startMs === step.gifStartMs &&
      cached.endMs   === step.gifEndMs &&
      cached.fps     === (step.gifFps || 10);
    if (!matches) { setGifStatus("Stale — click Generate to refresh", "warn"); return; }
    const bytes = approxBase64ByteSize(cached.dataUrl);
    if (bytes > GIF_SIZE_WARN_BYTES) {
      setGifStatus(`Large · ${formatBytes(bytes)} — try lower fps or shorter clip`, "warn");
    } else {
      setGifStatus(`Ready · ${formatBytes(bytes)}`, "ok");
    }
  } catch {
    setGifStatus("Not generated yet");
  }
}

let gifTrimSaveTimer;
[gifStart, gifEnd, gifFps].forEach((el) => {
  el.addEventListener("input", () => {
    const step = steps[currentStepIdx];
    if (!step || step.mediaMode !== "gif") return;
    const s = parseFloat(gifStart.value) * 1000;
    const e = parseFloat(gifEnd.value)   * 1000;
    const f = parseInt(gifFps.value, 10);
    if (Number.isFinite(s)) step.gifStartMs = Math.max(0, Math.round(s));
    if (Number.isFinite(e)) step.gifEndMs   = Math.max(step.gifStartMs + 100, Math.round(e));
    if (Number.isFinite(f) && f > 0) step.gifFps = f;
    // Window/fps change invalidates any cached encode.
    db.clearGif(step.id).catch(() => {});
    updateGifStatus(step);
    clearTimeout(gifTrimSaveTimer);
    gifTrimSaveTimer = setTimeout(saveCurrentStep, 500);
  });
});

gifSetStartBtn.addEventListener("click", () => {
  const step = steps[currentStepIdx];
  if (!step || step.mediaMode !== "gif" || !srcVideo.src) return;
  const ms = Math.max(0, Math.round(srcVideo.currentTime * 1000));
  // Keep at least 100ms of clip — clamp against the end.
  step.gifStartMs = Math.min(ms, (step.gifEndMs ?? ms + 100) - 100);
  db.clearGif(step.id).catch(() => {});
  refreshGifPanel(step);
  saveCurrentStep();
});

gifSetEndBtn.addEventListener("click", () => {
  const step = steps[currentStepIdx];
  if (!step || step.mediaMode !== "gif" || !srcVideo.src) return;
  const ms = Math.max(0, Math.round(srcVideo.currentTime * 1000));
  step.gifEndMs = Math.max(ms, (step.gifStartMs ?? 0) + 100);
  db.clearGif(step.id).catch(() => {});
  refreshGifPanel(step);
  saveCurrentStep();
});

gifPreviewBtn.addEventListener("click", async () => {
  const step = steps[currentStepIdx];
  if (!step || step.mediaMode !== "gif") return;
  if (!srcVideo.src) { errorToast("No recording loaded"); return; }
  try {
    srcVideo.currentTime = Math.max(0, step.gifStartMs / 1000);
    await srcVideo.play();
    if (gifPreviewStopTimer) clearTimeout(gifPreviewStopTimer);
    gifPreviewStopTimer = setTimeout(() => {
      try { srcVideo.pause(); } catch {}
    }, Math.max(0, step.gifEndMs - step.gifStartMs));
  } catch (e) {
    errorToast("Preview failed: " + e.message);
  }
});

gifGenerateBtn.addEventListener("click", async () => {
  const step = steps[currentStepIdx];
  if (!step || step.mediaMode !== "gif") return;
  if (!extractor.src) { errorToast("No recording loaded"); return; }
  if (gifEncoding) return;
  try {
    await encodeAndCacheGif(step);
    toast("GIF generated");
  } catch (e) {
    errorToast("GIF generation failed: " + e.message);
    setGifStatus("Failed — try again", "err");
  }
});

async function encodeAndCacheGif(step) {
  gifEncoding = true;
  gifGenerateBtn.disabled = true;
  setGifStatus("Encoding…");
  try {
    const dataUrl = await extractGifClip(step.gifStartMs, step.gifEndMs, step.gifFps || 10);
    await db.saveGif({
      stepId: step.id,
      sessionId: currentSessionId,
      dataUrl,
      startMs: step.gifStartMs,
      endMs:   step.gifEndMs,
      fps:     step.gifFps || 10,
    });
    // Only refresh the inline preview if the user is still on this step — if
    // they navigated away mid-encode (export-time path), don't clobber the
    // visible step's preview.
    if (steps[currentStepIdx]?.id === step.id) refreshGifPreviewImg(step);
    const bytes = approxBase64ByteSize(dataUrl);
    if (bytes > GIF_SIZE_WARN_BYTES) {
      setGifStatus(`Large · ${formatBytes(bytes)} — try lower fps or shorter clip`, "warn");
    } else {
      setGifStatus(`Ready · ${formatBytes(bytes)}`, "ok");
    }
    return dataUrl;
  } finally {
    gifEncoding = false;
    gifGenerateBtn.disabled = false;
  }
}

async function getOrEncodeGif(step) {
  const cached = await db.getGif(step.id);
  if (
    cached &&
    cached.startMs === step.gifStartMs &&
    cached.endMs   === step.gifEndMs &&
    cached.fps     === (step.gifFps || 10)
  ) {
    return cached.dataUrl;
  }
  return encodeAndCacheGif(step);
}

// Overflow menu open/close
stepMoreBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  stepMoreMenu.classList.toggle("open");
});
document.addEventListener("click", (e) => {
  if (!stepMoreMenu.contains(e.target) && e.target !== stepMoreBtn) {
    stepMoreMenu.classList.remove("open");
  }
});

async function saveCurrentStep() {
  const step = steps[currentStepIdx];
  if (!step) return;
  const updates = {
    title: stepTitle.value.trim(),
    body:  stepBody.value.trim(),
    included: step.included !== false,
    mediaMode: step.mediaMode || "screenshot",
    annotations: step.annotations || [],
    gifStartMs: step.gifStartMs,
    gifEndMs:   step.gifEndMs,
    gifFps:     step.gifFps,
  };
  Object.assign(step, updates);
  await sw({ type: "SP_UPDATE_STEP", stepId: step.id, updates });
}

prevBtn.addEventListener("click", () => { if (currentStepIdx > 0) loadStepIntoEditor(currentStepIdx - 1); });
nextBtn.addEventListener("click", () => { if (currentStepIdx < steps.length-1) loadStepIntoEditor(currentStepIdx + 1); });

const ANNOT_KEYS = { "1": "circle", "2": "arrow", "3": "highlight", "4": "mask" };

document.addEventListener("keydown", (e) => {
  const isTyping = e.target.matches("textarea, input, select, [contenteditable]");

  // Esc — close any open menu / sheet from anywhere.
  if (e.key === "Escape") {
    if (helpBackdrop.classList.contains("open")) { closeHelp(); return; }
    if (exportMenu.classList.contains("open"))   { setExportMenuOpen(false); return; }
    if (stepMoreMenu.classList.contains("open")) { stepMoreMenu.classList.remove("open"); return; }
    if (annotPane?.classList.contains("active")) { closeAnnotPane(); return; }
  }

  // `?` opens the help sheet (when not typing).
  if (!isTyping && (e.key === "?" || (e.key === "/" && e.shiftKey))) {
    e.preventDefault();
    openHelp();
    return;
  }

  // Editor-only shortcuts below.
  if (!$("v-editor").classList.contains("active")) return;

  // Cmd/Ctrl+Enter — enrich current step. Works from anywhere in the editor,
  // including when focused inside a textarea.
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    $("enrichOneBtn").click();
    return;
  }

  if (isTyping) return;

  if (e.key === "ArrowLeft")  prevBtn.click();
  if (e.key === "ArrowRight") nextBtn.click();

  // Annotation tool selection (only when the pane is open).
  if (annotPane?.classList.contains("active") && ANNOT_KEYS[e.key]) {
    const btn = document.querySelector(`.annot-tool[data-tool="${ANNOT_KEYS[e.key]}"]`);
    if (btn) btn.click();
  }
});

// Help sheet
const helpBackdrop = $("helpBackdrop");
function openHelp() { helpBackdrop.classList.add("open"); }
function closeHelp() { helpBackdrop.classList.remove("open"); }
$("helpBtn").addEventListener("click", openHelp);
$("helpClose").addEventListener("click", closeHelp);
helpBackdrop.addEventListener("click", (e) => { if (e.target === helpBackdrop) closeHelp(); });

$("deleteStepBtn").addEventListener("click", () => {
  stepMoreMenu.classList.remove("open");
  deleteStepAt(currentStepIdx);
});

async function deleteStepAt(idx) {
  const step = steps[idx];
  if (!step) return;
  const label = (step.title || `Step ${idx + 1}`).trim();
  const ok = await confirmModal({
    title: "Delete step?",
    body: `"${label}" will be removed from this guide. This cannot be undone.`,
    confirmLabel: "Delete step",
  });
  if (!ok) return;
  const res = await sw({ type: "SP_DELETE_STEP", stepId: step.id, sessionId: currentSessionId });
  if (!res?.ok) return errorToast("Could not delete step");
  steps.splice(idx, 1);
  if (!steps.length) {
    toast("Step deleted — no steps remain");
    showView("v-home");
    loadSessions();
    return;
  }
  if (currentStepIdx >= steps.length) currentStepIdx = steps.length - 1;
  else if (idx < currentStepIdx) currentStepIdx--;
  loadStepIntoEditor(currentStepIdx);
  toast("Step deleted");
}

// ── AI Enrichment ──────────────────────────────────────────────────────────
$("enrichOneBtn").addEventListener("click", async () => {
  const step = steps[currentStepIdx];
  if (!step) return;
  const btn = $("enrichOneBtn");
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Enriching…';
  let screenshotDataUrl = null;
  try { screenshotDataUrl = await extractFrame(step.tsMs); } catch {}
  const res = await sw({ type: "SP_ENRICH_STEP", stepId: step.id, sessionId: currentSessionId, screenshotDataUrl });
  btn.disabled = false; btn.textContent = "Enrich with AI";
  if (res?.ok) { onStepEnriched(res.step); toast("Step enriched"); }
  else errorToast(formatApiError(res?.error));
});

let enrichAllRunning = false;
$("enrichAllBtn").addEventListener("click", async () => {
  if (enrichAllRunning) return;
  stepMoreMenu.classList.remove("open");
  const pending = steps.filter((s) => !s.enriched);
  if (!pending.length) { toast("All steps are already enriched"); return; }
  enrichAllRunning = true;
  toast(`Enriching ${pending.length} step${pending.length === 1 ? "" : "s"}…`, 4000);
  let failed = null;
  for (const step of pending) {
    let screenshotDataUrl = null;
    try { screenshotDataUrl = await extractFrame(step.tsMs); } catch {}
    const res = await sw({ type: "SP_ENRICH_STEP", stepId: step.id, sessionId: currentSessionId, screenshotDataUrl });
    if (res?.ok) onStepEnriched(res.step);
    else if (!failed) failed = res?.error;
  }
  enrichAllRunning = false;
  if (failed) errorToast(formatApiError(failed));
  else toast("All steps enriched");
});

// ── Annotation editor ──────────────────────────────────────────────────────
const annotPane    = $("annotPane");
const annotCanvas  = $("annotCanvas");
let currentBrand = null;
let currentFrameUrl = null;
let annotator = null;
let activeTool = null;

async function getBrand() {
  if (currentBrand) return currentBrand;
  const data = await chrome.storage.local.get(["brandCircleColor","brandArrowColor","brandHighlightColor"]);
  currentBrand = {
    brandCircleColor:    data.brandCircleColor    || "#7c6af7",
    brandArrowColor:     data.brandArrowColor     || "#f87171",
    brandHighlightColor: data.brandHighlightColor || "#fbbf24",
  };
  return currentBrand;
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.brandCircleColor || changes.brandArrowColor || changes.brandHighlightColor) {
    currentBrand = null; // force reload on next use
    if (annotator) annotator.redraw();
  }
});

$("openAnnotBtn").addEventListener("click", async () => {
  stepMoreMenu.classList.remove("open");
  await openAnnotPaneForCurrentStep();
});

$("annotClose").addEventListener("click", () => closeAnnotPane());
$("annotUndo").addEventListener("click", () => {
  const step = steps[currentStepIdx];
  if (!step?.annotations?.length) return;
  step.annotations = step.annotations.slice(0, -1);
  saveCurrentStep();
  annotator?.redraw();
});
$("annotClear").addEventListener("click", async () => {
  const step = steps[currentStepIdx];
  if (!step?.annotations?.length) return;
  const ok = await confirmModal({
    title: "Clear all annotations?",
    body: `All ${step.annotations.length} annotation${step.annotations.length === 1 ? "" : "s"} on this step will be removed.`,
    confirmLabel: "Clear annotations",
  });
  if (!ok) return;
  step.annotations = [];
  saveCurrentStep();
  annotator?.redraw();
});

document.querySelectorAll(".annot-tool[data-tool]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tool = btn.dataset.tool;
    activeTool = activeTool === tool ? null : tool;
    document.querySelectorAll(".annot-tool[data-tool]").forEach((b) => {
      b.classList.toggle("active", b.dataset.tool === activeTool);
    });
    annotator?.setTool(activeTool);
  });
});

// Annotation toolbar hint label — shows the focused/hovered tool's name and shortcut.
const annotHint = $("annotHint");
document.querySelectorAll(".annot-tool[data-hint]").forEach((btn) => {
  btn.addEventListener("mouseenter", () => { annotHint.textContent = btn.dataset.hint; });
  btn.addEventListener("focus",      () => { annotHint.textContent = btn.dataset.hint; });
  btn.addEventListener("mouseleave", () => { annotHint.innerHTML = "&nbsp;"; });
  btn.addEventListener("blur",       () => { annotHint.innerHTML = "&nbsp;"; });
});

async function openAnnotPaneForCurrentStep() {
  const step = steps[currentStepIdx];
  if (!step) return;
  if (step.mediaMode === "gif") {
    toast("Annotations apply to screenshot steps only — switch this step to Screenshot to annotate", 4500);
    return;
  }
  if (!extractor.src) {
    errorToast("No recording loaded — annotations need a video frame to draw on.");
    return;
  }
  let frame;
  try {
    frame = await extractFrame(step.tsMs);
  } catch (err) {
    errorToast("Could not extract frame: " + err.message);
    return;
  }
  currentFrameUrl = frame;

  // Size canvas to frame's natural ratio (for crisper rendering)
  const img = await new Promise((resolve) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => resolve(null);
    i.src = frame;
  });
  if (img) {
    annotCanvas.width  = img.naturalWidth;
    annotCanvas.height = img.naturalHeight;
  }

  await getBrand();
  if (!annotator) {
    annotator = createAnnotator({
      canvas: annotCanvas,
      getFrame: () => currentFrameUrl,
      getBrand: () => currentBrand,
      getAnnotations: () => steps[currentStepIdx]?.annotations || [],
      onChange: (next) => {
        const s = steps[currentStepIdx];
        if (!s) return;
        s.annotations = next;
        saveCurrentStep();
        annotator.redraw();
      },
    });
  }
  annotator.setTool(activeTool);
  annotPane.classList.add("active");
  await annotator.redraw();
}

function closeAnnotPane() {
  annotPane.classList.remove("active");
  activeTool = null;
  document.querySelectorAll(".annot-tool[data-tool]").forEach((b) => b.classList.remove("active"));
  annotator?.setTool(null);
}

// ── Frame extraction ───────────────────────────────────────────────────────
// Seeks are serialized so concurrent callers don't race on currentTime.
let extractChain = Promise.resolve();

async function waitForExtractorReady() {
  if (!extractor.src) throw new Error("No recording loaded");
  if (extractor.readyState >= 2 && extractor.videoWidth > 0) return;
  await new Promise((resolve) => {
    const done = () => {
      extractor.removeEventListener("loadeddata", done);
      extractor.removeEventListener("canplay", done);
      extractor.removeEventListener("error", done);
      resolve();
    };
    extractor.addEventListener("loadeddata", done, { once: true });
    extractor.addEventListener("canplay", done, { once: true });
    extractor.addEventListener("error", done, { once: true });
    setTimeout(done, 4000);
  });
  if (extractor.readyState < 2 || !extractor.videoWidth) {
    throw new Error(`extractor not seekable (readyState=${extractor.readyState}, dims=${extractor.videoWidth}x${extractor.videoHeight})`);
  }
}

function extractFrame(tsMs) {
  const job = () => (async () => {
    await waitForExtractorReady();
    await seekExtractor(tsMs / 1000);
    const w = extractor.videoWidth;
    const h = extractor.videoHeight;
    extractorCanvas.width = w;
    extractorCanvas.height = h;
    extractorCanvas.getContext("2d").drawImage(extractor, 0, 0, w, h);
    return extractorCanvas.toDataURL("image/jpeg", 0.85);
  })();
  extractChain = extractChain.then(job, job);
  return extractChain;
}

// Seek the hidden extractor to `targetSec` and wait until it's at rest.
// Some MediaRecorder webms have malformed duration metadata and never fire
// `seeked` near the end, so we cap the wait and resolve with whatever frame
// is on the element.
function seekExtractor(targetSec) {
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      extractor.removeEventListener("seeked", onSeeked);
      extractor.removeEventListener("error", onErr);
      resolve();
    };
    const onErr = () => {
      extractor.removeEventListener("seeked", onSeeked);
      extractor.removeEventListener("error", onErr);
      reject(new Error("Extractor error during seek"));
    };
    extractor.addEventListener("seeked", onSeeked, { once: true });
    extractor.addEventListener("error",  onErr,    { once: true });
    setTimeout(() => { if (!extractor.seeking) onSeeked(); }, 1500);
    extractor.currentTime = Math.max(0, targetSec);
  });
}

// Encode an animated GIF clip from the recording by seeking the extractor
// once per frame and feeding each into a gif.js encoder running in a worker.
// Returns a `data:image/gif;base64,...` URL ready to embed in Markdown/HTML.
function extractGifClip(startMs, endMs, fps) {
  const job = () => (async () => {
    await waitForExtractorReady();
    if (typeof window.GIF !== "function") {
      throw new Error("GIF encoder not loaded (vendor/gif.js missing)");
    }
    // Auto-downscale source resolution to keep file sizes reasonable. Native
    // 1920x1080 screen recordings produce 15–30MB GIFs that Intercom and other
    // help-center renderers refuse to inline as data URLs.
    const sourceW = extractor.videoWidth;
    const sourceH = extractor.videoHeight;
    const scale = sourceW > GIF_MAX_WIDTH ? GIF_MAX_WIDTH / sourceW : 1;
    const w = Math.max(1, Math.round(sourceW * scale));
    const h = Math.max(1, Math.round(sourceH * scale));
    const safeFps = Math.max(1, Math.min(30, fps || 10));
    const delay = Math.round(1000 / safeFps);
    const frameTimes = [];
    for (let t = startMs; t < endMs; t += delay) frameTimes.push(t);
    if (!frameTimes.length || frameTimes[frameTimes.length - 1] < endMs) {
      frameTimes.push(endMs);
    }

    const gif = new window.GIF({
      workers: 2,
      quality: 10,
      width: w,
      height: h,
      workerScript: chrome.runtime.getURL("vendor/gif.worker.js"),
    });

    extractorCanvas.width = w;
    extractorCanvas.height = h;
    const ctx = extractorCanvas.getContext("2d");

    for (let i = 0; i < frameTimes.length; i++) {
      await seekExtractor(frameTimes[i] / 1000);
      ctx.drawImage(extractor, 0, 0, w, h);
      // `copy: true` snapshots the canvas pixels right now — without it
      // gif.js would read every frame from the same canvas after our loop
      // ends and produce N copies of the last frame.
      gif.addFrame(extractorCanvas, { copy: true, delay });
      setGifStatus(`Capturing frame ${i + 1}/${frameTimes.length}…`);
    }

    return new Promise((resolve, reject) => {
      gif.on("progress", (p) => {
        setGifStatus(`Encoding… ${Math.round(p * 100)}%`);
      });
      gif.on("finished", (blob) => {
        const reader = new FileReader();
        reader.onload  = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("Failed to read GIF blob"));
        reader.readAsDataURL(blob);
      });
      try { gif.render(); } catch (err) { reject(err); }
    });
  })();
  extractChain = extractChain.then(job, job);
  return extractChain;
}

// ── Export ─────────────────────────────────────────────────────────────────
function setExportMenuOpen(open) {
  exportMenu.classList.toggle("open", open);
  exportBtn.setAttribute("aria-expanded", open ? "true" : "false");
}

exportBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  setExportMenuOpen(!exportMenu.classList.contains("open"));
});
document.addEventListener("click", (e) => {
  if (!exportMenu.contains(e.target) && e.target !== exportBtn) {
    setExportMenuOpen(false);
  }
});

exportMenu.querySelectorAll(".btn-row").forEach((btn) => {
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!currentSessionId) return;
    const row = btn.closest(".export-row");
    const fmt = row?.dataset.fmt;
    const action = btn.dataset.action;
    if (!fmt || !action) return;

    const buttons = exportMenu.querySelectorAll(".btn-row");
    buttons.forEach((b) => (b.disabled = true));
    const original = btn.textContent;
    if (action === "copy") btn.textContent = "Copying…";
    try {
      if (fmt === "video") {
        await downloadRecording();
        toast("Video downloaded");
      } else {
        await doDocumentExport(fmt, action);
      }
      setExportMenuOpen(false);
    } catch (err) {
      errorToast("Export failed: " + formatApiError(err.message || String(err)));
    }
    buttons.forEach((b) => (b.disabled = false));
    if (action === "copy") btn.textContent = original;
  });
});

async function downloadRecording() {
  const rec = await db.getRecording(currentSessionId);
  if (!rec?.blob) throw new Error("No video recording available for this guide");
  const url = URL.createObjectURL(rec.blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = slugify(currentSession?.name || sessionName.value || "guide") + ".webm";
  a.click();
  URL.revokeObjectURL(url);
}

async function doDocumentExport(fmt, action = "download") {
  // Build the export-ready session: only included steps, with screenshots
  // derived from the video for steps that want one.
  const included = steps.filter(s => s.included !== false);
  if (!included.length && fmt !== "json") throw new Error("No steps included in the guide");

  const brand = await getBrand();
  const hydrated = [];
  for (const step of included) {
    let screenshot = null;
    if (step.mediaMode === "gif" && extractor.src) {
      try {
        screenshot = await getOrEncodeGif(step);
        console.log("[Guidr] export: gif for step", step.index, "·", Math.round((screenshot?.length || 0) / 1024), "KB");
      } catch (err) {
        console.warn("[Guidr] export: gif encoding failed for step", step.index, ":", err.message);
      }
      // Annotations are intentionally not composited onto GIFs.
    } else if (step.mediaMode !== "none" && extractor.src) {
      try {
        screenshot = await extractFrame(step.tsMs);
        if (step.annotations && step.annotations.length) {
          screenshot = await renderAnnotated(screenshot, step.annotations, brand);
        }
        console.log("[Guidr] export: extracted frame for step", step.index, "at", step.tsMs, "ms ·", Math.round((screenshot?.length || 0) / 1024), "KB");
      } catch (err) {
        console.warn("[Guidr] export: frame extraction failed for step", step.index, ":", err.message);
      }
    } else if (!extractor.src) {
      console.warn("[Guidr] export: no extractor.src — recording not loaded yet");
    }
    hydrated.push({ ...step, screenshotAfter: screenshot, screenshotBefore: null });
  }

  const result = await exportSession({
    ...currentSession,
    name: currentSession?.name || sessionName.value,
    steps: hydrated,
  }, fmt);

  if (action === "copy") {
    try {
      const isHtml = fmt === "intercom" || fmt === "html";
      const items = isHtml
        ? [new ClipboardItem({
            "text/html":  new Blob([result.content], { type: "text/html" }),
            "text/plain": new Blob([result.content], { type: "text/plain" }),
          })]
        : [new ClipboardItem({
            "text/plain": new Blob([result.content], { type: "text/plain" }),
          })];
      await navigator.clipboard.write(items);
      toast(fmt === "intercom"
        ? "Copied — paste into your help-center editor"
        : "Copied to clipboard");
    } catch (e) {
      errorToast("Clipboard write failed: " + e.message);
    }
    return;
  }

  const blob = new Blob([result.content], { type: result.mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = result.filename; a.click();
  URL.revokeObjectURL(url);
  toast("Downloaded " + result.filename);
}

// ── Char counts ────────────────────────────────────────────────────────────
function updateCharCounts() {
  const pairs = [
    [stepTitle, "titleCount", 60],
    [stepBody,  "bodyCount",  200],
  ];
  pairs.forEach(([ta, countId, max]) => {
    const n = ta.value.length;
    const el = $(countId);
    el.textContent = `${n} / ${max}`;
    el.classList.toggle("over", n > max);
  });
}

function autoResize(ta) {
  ta.style.height = "auto";
  ta.style.height = ta.scrollHeight + "px";
}

// ── Utilities ──────────────────────────────────────────────────────────────
function sw(msg) {
  return new Promise(res => chrome.runtime.sendMessage(msg, (r) => res(r || null)));
}
function $(id) { return document.getElementById(id); }
function escHtml(s) {
  return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}
function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,50);
}
function timeAgo(ts) {
  if (!ts) return "";
  const d = Date.now()-ts;
  if (d < 60000) return "just now";
  if (d < 3600000) return `${Math.floor(d/60000)}m ago`;
  if (d < 86400000) return `${Math.floor(d/3600000)}h ago`;
  return `${Math.floor(d/86400000)}d ago`;
}
function formatMs(ms) {
  const total = Math.max(0, ms || 0) / 1000;
  const m = Math.floor(total / 60);
  const s = (total - m * 60).toFixed(1);
  return `${m}:${s.padStart(4, "0")}`;
}
function formatBytes(bytes) {
  if (!bytes) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
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

function formatApiError(raw) {
  if (!raw) return "Something went wrong. Check the service worker console.";
  const s = String(raw);
  if (/\b429\b|quota|rate.?limit|resource_exhausted/i.test(s)) {
    const retryMatch = s.match(/retry after (\d+(?:\.\d+)?)s/i);
    const waitHint = retryMatch
      ? ` Try again in ~${Math.ceil(Number(retryMatch[1]))}s.`
      : " Wait a moment and retry, or switch model in Settings.";
    const apiMsg = s
      .replace(/^\w+\s+\d{3}:\s*/, "")
      .replace(/\s*\(retry after [^)]+\)\s*$/i, "")
      .trim();
    const detail = apiMsg.length > 140 ? apiMsg.slice(0, 137) + "…" : apiMsg;
    return `Rate limit: ${detail}.${waitHint}`;
  }
  if (/insufficient|billing|payment.?required|\b402\b/i.test(s)) {
    return "Account has no credits. Top up at your provider's billing page, then retry.";
  }
  if (/\b401\b|unauthorized|invalid.?api.?key|api.?key.?not.?valid/i.test(s)) {
    return "API key was rejected. Re-check it in Settings under Provider.";
  }
  if (/\b404\b|model.*not.?(found|exist)|no.?such.?model/i.test(s)) {
    return "Selected model isn't available for your key. Pick a different one in Settings.";
  }
  if (/\b403\b|permission|forbidden|safety|blocked/i.test(s)) {
    return "Provider refused the request (permission or safety filter). Try a different model.";
  }
  return s.length > 180 ? s.slice(0, 177) + "…" : s;
}
