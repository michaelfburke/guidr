import { exportSession } from "../export.js";
import { db } from "../db.js";

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
const videoEmpty   = $("videoEmpty");
const chapterRail  = $("chapterRail");
const stepInclude  = $("stepInclude");
const stepMedia    = $("stepMedia");
const stepTs       = $("stepTs");
const stepTitle    = $("stepTitle");
const stepBody     = $("stepBody");
const stepVoice    = $("stepVoice");
const stepCounter  = $("stepCounter");
const prevBtn      = $("prevBtn");
const nextBtn      = $("nextBtn");
const exportBtn    = $("exportBtn");
const exportFmt    = $("exportFmt");
const extractor    = $("extractor");
const extractorCanvas = $("extractorCanvas");

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
  const { apiKey } = await chrome.storage.local.get("apiKey");
  const hasKey = !!apiKey;
  $("setupCard").style.display = hasKey ? "none" : "";
  $("nameRow").style.display   = hasKey ? "" : "none";
  recBtn.style.display         = hasKey ? "" : "none";
}

$("goSetupBtn").addEventListener("click", () => chrome.runtime.openOptionsPage());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.apiKey) applyOnboardingState();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "SW_STEP_CAPTURED") onStepCaptured(msg.payload.step);
  if (msg.type === "SW_STEP_ENRICHED") onStepEnriched(msg.payload.step);
});

// ── Navigation ─────────────────────────────────────────────────────────────
$("btn-home").addEventListener("click", () => showView("v-home"));
$("btn-options").addEventListener("click", () => chrome.runtime.openOptionsPage());

function showView(id) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  $(id).classList.add("active");
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

    // Countdown before MediaRecorder actually starts — gives Chrome's "is
    // sharing" indicator time to settle (otherwise the recording starts on
    // a visible layout shift) and signals to the user that recording is
    // imminent. We send SP_START_RECORDING with the *future* startedAt so
    // chapter markers align to the real MediaRecorder start moment.
    const STARTUP_COUNTDOWN_MS = 3000;
    recordingStartedAt = Date.now() + STARTUP_COUNTDOWN_MS;
    const res = await sw({
      type: "SP_START_RECORDING",
      sessionName: sessionName.value,
      tabId: tab.id,
      startedAt: recordingStartedAt,
    });
    if (!res?.ok) {
      stream.getTracks().forEach(t => t.stop());
      errorToast(res?.error || "Could not start recording");
      return;
    }

    // Countdown UI: amber button, big number, re-pulse animation each tick.
    recBtn.classList.add("counting");
    for (let n = 3; n >= 1; n--) {
      recLabel.classList.remove("tick");
      void recLabel.offsetWidth; // force reflow so the animation restarts
      recLabel.textContent = String(n);
      recLabel.classList.add("tick");
      await new Promise((r) => setTimeout(r, 1000));
    }
    recBtn.classList.remove("counting");
    recLabel.classList.remove("tick");

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

function setRecording(val) {
  isRecording = val;
  recBtn.classList.toggle("recording", val);
  recLabel.textContent = val ? "Stop recording" : "Start recording";
  recDot.style.display = val ? "" : "none";
  sessionName.disabled = val;
}

function onStepCaptured(step) {
  steps.push(step);
  const item = document.createElement("div");
  item.className = "capture-item";
  item.id = `cap-${step.id}`;
  const label = step.target?.text || step.target?.ariaLabel || step.pageTitle || "Step";
  item.innerHTML = `
    <div class="capture-num">${steps.length}</div>
    <div class="capture-info">
      <span>${escHtml(label.slice(0,50))}</span>
      <span class="ts">${formatMs(step.tsMs)}</span>
    </div>`;
  captureList.prepend(item);
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
    sessionsList.innerHTML = '<div class="empty-sessions">Record your first guide to get started.</div>';
    return;
  }
  sessionsList.innerHTML = "";
  list.slice(0, 12).forEach(s => {
    const card = document.createElement("div");
    card.className = "session-card";
    const sizeLabel = s.hasRecording
      ? `<span class="size-badge has-vid">${formatBytes(s.recordingBytes)}</span>`
      : `<span class="size-badge">no video</span>`;
    card.innerHTML = `
      <div class="session-card-body">
        <strong>${escHtml(s.name)}</strong>
        <span>${s.stepCount} step${s.stepCount!==1?"s":""} · ${timeAgo(s.updatedAt)} · </span>${sizeLabel}
      </div>
      <div class="session-card-actions">
        ${s.hasRecording ? `<button class="icon-act" data-act="drop-vid" title="Delete video track (keeps steps + text)">⊘ vid</button>` : ""}
        <button class="icon-act danger" data-act="delete" title="Delete this guide">×</button>
      </div>`;
    card.addEventListener("click", (e) => {
      if (e.target.closest("[data-act]")) return;
      openSession(s.id);
    });
    card.querySelector('[data-act="delete"]').addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${s.name}"? This cannot be undone.`)) return;
      const r = await sw({ type: "SP_DELETE_SESSION", sessionId: s.id });
      if (!r?.ok) return errorToast("Could not delete guide");
      toast("Guide deleted");
      loadSessions();
    });
    card.querySelector('[data-act="drop-vid"]')?.addEventListener("click", async (e) => {
      e.stopPropagation();
      const mb = (s.recordingBytes / 1024 / 1024).toFixed(1);
      if (!confirm(`Delete video track for "${s.name}" (${mb} MB)? Step text is kept; screenshots and video export will no longer be available.`)) return;
      const r = await sw({ type: "SP_DELETE_RECORDING", sessionId: s.id });
      if (!r?.ok) return errorToast("Could not delete video track");
      toast("Video track deleted");
      loadSessions();
    });
    sessionsList.appendChild(card);
  });
}

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
    videoEmpty.style.display = "";
    return;
  }
  console.log("[Guidr] loaded recording blob", { bytes: rec.byteSize, type: rec.mimeType });
  videoEmpty.style.display = "none";
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

  loadStepFields(step);
  stepInclude.checked = step.included !== false;
  stepMedia.value = step.mediaMode || "screenshot";
  stepTs.textContent = formatMs(step.tsMs);

  prevBtn.disabled = idx === 0;
  nextBtn.disabled = idx === steps.length - 1;
  stepCounter.textContent = `${idx + 1} / ${steps.length}`;

  renderChapterRail();
}

function loadStepFields(step) {
  stepTitle.value = step.title || "";
  stepBody.value  = step.body || "";
  stepVoice.value = step.voiceoverScript || "";
  autoResize(stepTitle); autoResize(stepBody); autoResize(stepVoice);
  updateCharCounts();
}

// Auto-save on edit
let saveTimer;
[stepTitle, stepBody, stepVoice].forEach(ta => {
  ta.addEventListener("input", () => {
    autoResize(ta);
    updateCharCounts();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveCurrentStep, 800);
  });
});

stepInclude.addEventListener("change", () => {
  const step = steps[currentStepIdx];
  if (!step) return;
  step.included = stepInclude.checked;
  renderChapterRail();
  saveCurrentStep();
});

stepMedia.addEventListener("change", () => {
  const step = steps[currentStepIdx];
  if (!step) return;
  step.mediaMode = stepMedia.value;
  saveCurrentStep();
});

async function saveCurrentStep() {
  const step = steps[currentStepIdx];
  if (!step) return;
  const updates = {
    title: stepTitle.value.trim(),
    body:  stepBody.value.trim(),
    voiceoverScript: stepVoice.value.trim(),
    included: step.included !== false,
    mediaMode: step.mediaMode || "screenshot",
  };
  Object.assign(step, updates);
  await sw({ type: "SP_UPDATE_STEP", stepId: step.id, updates });
}

prevBtn.addEventListener("click", () => { if (currentStepIdx > 0) loadStepIntoEditor(currentStepIdx - 1); });
nextBtn.addEventListener("click", () => { if (currentStepIdx < steps.length-1) loadStepIntoEditor(currentStepIdx + 1); });

document.addEventListener("keydown", (e) => {
  if (!$("v-editor").classList.contains("active")) return;
  if (e.target.matches("textarea, input, select")) return;
  if (e.key === "ArrowLeft")  prevBtn.click();
  if (e.key === "ArrowRight") nextBtn.click();
});

$("deleteStepBtn").addEventListener("click", () => deleteStepAt(currentStepIdx));

async function deleteStepAt(idx) {
  const step = steps[idx];
  if (!step) return;
  const label = (step.title || `Step ${idx + 1}`).trim();
  if (!confirm(`Delete "${label}"? This cannot be undone.`)) return;
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

$("enrichAllBtn").addEventListener("click", async () => {
  const btn = $("enrichAllBtn");
  btn.disabled = true; btn.textContent = "Enriching…";
  let failed = null;
  for (const step of steps) {
    if (step.enriched) continue;
    let screenshotDataUrl = null;
    try { screenshotDataUrl = await extractFrame(step.tsMs); } catch {}
    const res = await sw({ type: "SP_ENRICH_STEP", stepId: step.id, sessionId: currentSessionId, screenshotDataUrl });
    if (res?.ok) onStepEnriched(res.step);
    else if (!failed) failed = res?.error;
  }
  btn.disabled = false; btn.textContent = "Enrich all steps";
  if (failed) errorToast(formatApiError(failed));
  else toast("All steps enriched");
});

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
    return new Promise((resolve, reject) => {
      const target = Math.max(0, tsMs / 1000);
      const onSeeked = () => {
        extractor.removeEventListener("seeked", onSeeked);
        extractor.removeEventListener("error", onErr);
        try {
          const w = extractor.videoWidth;
          const h = extractor.videoHeight;
          extractorCanvas.width = w;
          extractorCanvas.height = h;
          const ctx = extractorCanvas.getContext("2d");
          ctx.drawImage(extractor, 0, 0, w, h);
          resolve(extractorCanvas.toDataURL("image/jpeg", 0.85));
        } catch (e) { reject(e); }
      };
      const onErr = (e) => {
        extractor.removeEventListener("seeked", onSeeked);
        extractor.removeEventListener("error", onErr);
        reject(new Error("Extractor error during seek"));
      };
      extractor.addEventListener("seeked", onSeeked, { once: true });
      extractor.addEventListener("error", onErr, { once: true });
      // Safety net: some webms don't fire `seeked` reliably if the requested
      // time is past a malformed duration boundary. Time out and resolve
      // with whatever frame is currently on the extractor.
      setTimeout(() => {
        if (!extractor.seeking) onSeeked();
      }, 1500);
      extractor.currentTime = target;
    });
  })();
  extractChain = extractChain.then(job, job);
  return extractChain;
}

// ── Export ─────────────────────────────────────────────────────────────────
exportBtn.addEventListener("click", async () => {
  if (!currentSessionId) return;
  const fmt = exportFmt.value;
  exportBtn.textContent = "…";
  exportBtn.disabled = true;
  try {
    if (fmt === "video") {
      await downloadRecording();
      toast("Video downloaded");
    } else {
      await doDocumentExport(fmt);
    }
  } catch (err) {
    errorToast("Export failed: " + formatApiError(err.message || String(err)));
  }
  exportBtn.textContent = "Export";
  exportBtn.disabled = false;
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

async function doDocumentExport(fmt) {
  // Build the export-ready session: only included steps, with screenshots
  // derived from the video for steps that want one.
  const included = steps.filter(s => s.included !== false);
  if (!included.length && fmt !== "json") throw new Error("No steps marked Include");

  const hydrated = [];
  for (const step of included) {
    let screenshot = null;
    if (step.mediaMode !== "none" && extractor.src) {
      try {
        screenshot = await extractFrame(step.tsMs);
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

  if (result.clipboard) {
    try {
      const htmlBlob = new Blob([result.content], { type: "text/html" });
      const textBlob = new Blob([result.content], { type: "text/plain" });
      await navigator.clipboard.write([
        new ClipboardItem({ "text/html": htmlBlob, "text/plain": textBlob })
      ]);
      toast("Copied — paste into your Intercom article editor");
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
    [stepVoice, "voiceCount", 280],
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
