import { exportSession } from "../export.js";
import { db } from "../db.js";
import { createAnnotator, renderAnnotated } from "../sidepanel/annotate.js";
import { sw, escHtml, slugify, formatMs, formatBytes, formatApiError } from "../utils.js";
import { makeReorderable } from "../sidepanel/reorder.js";

// ── Read session ID from URL ───────────────────────────────────────────────
const sessionId = new URL(location.href).searchParams.get("session");

// ── State ─────────────────────────────────────────────────────────────────
let currentSession = null;
let steps = [];
let currentStepIdx = 0;
let recordingObjectUrl = null;
let extractorObjectUrl = null;
let narrationObjectUrl = null;
let narrationSyncBound = false;
let gifPreviewStopTimer = null;
let gifEncoding = false;
let currentBrand = null;
let currentFrameUrl = null;
let annotator = null;
let activeTool = null;
let hasVoice = false;   // true once a narration track is loaded for this guide
let watching = false;   // true while the full recording is playing over the frame

const GIF_MAX_WIDTH = 1280;
const GIF_SIZE_WARN_BYTES = 3 * 1024 * 1024;

// ── DOM refs ──────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }

const sessionNameEl   = $("sessionName");
const filmstrip       = $("filmstrip");
const frameImg        = $("frameImg");
const frameEmpty      = $("frameEmpty");
const srcVideo        = $("srcVideo");
const frameView       = $("frameView");
const narrationAudio  = $("narrationAudio");
const narrationVol    = $("narrationVol");
const narrationVolume = $("narrationVolume");
const narrationMute   = $("narrationMute");
const sessionMoreBtn  = $("sessionMoreBtn");
const sessionMoreMenu = $("sessionMoreMenu");
const stepSkipToggle  = $("stepSkipToggle");
const stepMoreBtn     = $("stepMoreBtn");
const stepMoreMenu    = $("stepMoreMenu");
const stepTs          = $("stepTs");
const stepNum         = $("stepNum");
const stepOf          = $("stepOf");
const stepTitle       = $("stepTitle");
const stepBody        = $("stepBody");
const prevBtn         = $("prevBtn");
const nextBtn         = $("nextBtn");
const exportBtn       = $("exportBtn");
const exportMenu      = $("exportMenu");
const extractor       = $("extractor");
const extractorCanvas = $("extractorCanvas");
const openAnnotBtn    = $("openAnnotBtn");
const gifPanel        = $("gifPanel");
const gifStart        = $("gifStart");
const gifEnd          = $("gifEnd");
const gifFps          = $("gifFps");
const gifPreviewBtn   = $("gifPreviewBtn");
const gifGenerateBtn  = $("gifGenerateBtn");
const gifStatus       = $("gifStatus");
const gifSetStartBtn  = $("gifSetStartBtn");
const gifSetEndBtn    = $("gifSetEndBtn");
const gifRangeReadout = $("gifRangeReadout");
const gifPreviewImg   = $("gifPreviewImg");
const annotPane       = $("annotPane");
const annotCanvas     = $("annotCanvas");
const annotHint       = $("annotHint");
const watchBtn        = $("watchBtn");
const watchBtnLabel   = $("watchBtnLabel");
const enrichAllTopBtn = $("enrichAllTopBtn");
const enrichAllTopLabel = $("enrichAllTopLabel");
const mediaPills      = document.querySelectorAll(".media-pill[data-mode]");
const helpBackdrop    = $("helpBackdrop");
const modalBackdrop   = $("modalBackdrop");
const modalTitle      = $("modalTitle");
const modalBody       = $("modalBody");
const modalConfirm    = $("modalConfirm");
const modalCancel     = $("modalCancel");

// ── Thumbnail cache & extraction queue ────────────────────────────────────
const thumbCache = new Map();
let extractChain = Promise.resolve();

// ── Boot ──────────────────────────────────────────────────────────────────
window.addEventListener("beforeunload", () => {
  if (recordingObjectUrl) try { URL.revokeObjectURL(recordingObjectUrl); } catch {}
  if (extractorObjectUrl) try { URL.revokeObjectURL(extractorObjectUrl); } catch {}
  if (narrationObjectUrl) try { URL.revokeObjectURL(narrationObjectUrl); } catch {}
  try { srcVideo.pause(); } catch {}
});

if (!sessionId) {
  document.body.innerHTML = '<div style="padding:48px 32px;color:#f87171;font-family:system-ui">No session ID — open this editor from a Guidr recording.</div>';
} else {
  initEditor();
}

async function initEditor() {
  let res;
  try {
    res = await sw({ type: "SP_GET_SESSION", sessionId });
  } catch (err) {
    errorToast("Could not open guide: " + err.message);
    return;
  }
  if (!res?.ok) { errorToast("Could not open guide"); return; }

  currentSession = res.session;
  steps = (res.session.steps || []).map(normalizeStep);
  sessionNameEl.value = res.session.name;
  document.title = res.session.name + " — Guidr";

  renderFilmstrip();
  if (steps.length) loadStepIntoEditor(0);

  loadRecordingIntoPlayers(sessionId)
    .then(() => populateRailThumbnails())
    .catch(err => console.error("[Guidr] loadRecordingIntoPlayers:", err));
  loadNarrationIntoPlayer(sessionId)
    .catch(err => console.error("[Guidr] loadNarrationIntoPlayer:", err));
}

function normalizeStep(s) {
  return { included: true, mediaMode: "screenshot", ...s };
}



// ── Recording into players ─────────────────────────────────────────────────
async function loadRecordingIntoPlayers(sid) {
  if (recordingObjectUrl) URL.revokeObjectURL(recordingObjectUrl);
  if (extractorObjectUrl) URL.revokeObjectURL(extractorObjectUrl);
  recordingObjectUrl = null;
  extractorObjectUrl = null;

  const rec = await db.getRecording(sid);
  if (!rec?.blob) {
    srcVideo.removeAttribute("src");
    extractor.removeAttribute("src");
    frameView.classList.remove("has-video");
    return;
  }
  recordingObjectUrl = URL.createObjectURL(rec.blob);
  extractorObjectUrl = URL.createObjectURL(rec.blob);
  srcVideo.src = recordingObjectUrl;
  extractor.src = extractorObjectUrl;
  // A recording is available — reveal the "Watch recording" control.
  frameView.classList.add("has-video");

  await Promise.race([
    new Promise((resolve) => {
      if (extractor.readyState >= 2) return resolve();
      extractor.addEventListener("loadeddata", resolve, { once: true });
      extractor.addEventListener("error", resolve, { once: true });
    }),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

// ── Filmstrip ─────────────────────────────────────────────────────────────
function renderFilmstrip() {
  filmstrip.innerHTML = "";
  steps.forEach((step, i) => {
    const chip = document.createElement("div");
    chip.className = `chip${i === currentStepIdx ? " active" : ""}${step.included === false ? " excluded" : ""}`;
    chip.dataset.idx = i;
    chip.dataset.id  = step.id;
    chip.tabIndex = 0;
    chip.setAttribute("role", "button");
    const ariaLabel = step.title ? `Step ${i + 1}: ${step.title}` : `Step ${i + 1}`;
    chip.setAttribute("aria-label", ariaLabel);
    const cached = thumbCache.get(step.id);
    const rawLabel = step.title || step.target?.text || step.target?.ariaLabel || step.pageTitle || "";
    const label = rawLabel.trim().slice(0, 32) || `Step ${i + 1}`;
    chip.innerHTML = `
      <img class="chip-thumb" src="${cached || ""}" alt=""/>
      <div class="chip-meta">
        <span class="chip-num">${i + 1}</span>
        <span class="chip-time">${formatMs(step.tsMs)}</span>
      </div>
      <div class="chip-title">${escHtml(label)}</div>`;
    const activate = () => loadStepIntoEditor(i);
    chip.addEventListener("click", activate);
    chip.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); }
    });
    filmstrip.appendChild(chip);
  });
  // scroll active chip into view
  const active = filmstrip.querySelector(".chip.active");
  if (active) active.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  updateEnrichAllTopBtn();
}

makeReorderable(filmstrip, {
  getSteps: () => steps,
  onReorder: async (reordered) => {
    const activeId = steps[currentStepIdx]?.id;
    steps = reordered;
    currentStepIdx = Math.max(0, steps.findIndex((s) => s.id === activeId));
    renderFilmstrip();
    const active = filmstrip.querySelector(".chip.active");
    if (active) active.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    await sw({ type: "SP_REORDER_STEPS", sessionId, orderedIds: steps.map((s) => s.id) });
  },
});

async function populateRailThumbnails() {
  if (!extractor.src) return;
  for (const step of steps) {
    if (thumbCache.has(step.id)) continue;
    try {
      const dataUrl = await extractFrame(step.tsMs);
      thumbCache.set(step.id, dataUrl);
      const chip = filmstrip.querySelector(`.chip[data-id="${step.id}"] .chip-thumb`);
      if (chip) chip.src = dataUrl;
      // update the large frame view if this is the current step
      if (steps[currentStepIdx]?.id === step.id) setFrameImg(dataUrl);
    } catch (err) {
      console.warn("[Guidr] thumb extraction failed for step", step.index, ":", err.message);
    }
  }
}

function setFrameImg(src) {
  frameImg.classList.remove("loading");
  if (src) {
    frameImg.src = src;
    frameEmpty.style.display = "none";
  } else {
    frameImg.src = "";
    frameEmpty.style.display = "";
  }
}

function setFrameEmptyMessage(text) {
  const span = frameEmpty.querySelector("span");
  if (span) span.textContent = text;
}

// ── Step editor ───────────────────────────────────────────────────────────
function loadStepIntoEditor(idx) {
  const step = steps[idx];
  if (!step) return;
  currentStepIdx = idx;

  if (watching) exitWatchMode();
  if (srcVideo.src) {
    try { srcVideo.currentTime = Math.max(0, step.tsMs / 1000); } catch {}
  }
  if (annotPane.classList.contains("active")) closeAnnotPane();

  loadStepFields(step);
  applySkipToggleState(step.included !== false);
  setActiveMediaPill(step.mediaMode || "screenshot");
  refreshGifPanel(step);
  updateAnnotateButtonState(step);
  stepTs.textContent = formatMs(step.tsMs);

  prevBtn.disabled = idx === 0;
  nextBtn.disabled = idx === steps.length - 1;
  stepNum.textContent = String(idx + 1).padStart(2, "0");
  stepOf.textContent  = `of ${steps.length}`;

  loadStepMedia(step);
  updateVideoSurface();

  renderFilmstrip();
}

// Fills the frame view based on the step's media mode: GIF clip, extracted
// screenshot, or an explicit "no image" placeholder.
function loadStepMedia(step) {
  const mode = step.mediaMode || "screenshot";
  srcVideo.classList.toggle("gif-mode", mode === "gif");
  if (mode === "gif") {
    frameEmpty.style.display = "none";
  } else if (mode === "none") {
    // "No image" — don't leave the screenshot on screen; show a clear
    // placeholder so the toggle's effect is obvious.
    setFrameImg(null);
    setFrameEmptyMessage("No image — this step will be text-only in the guide.");
  } else {
    const cached = thumbCache.get(step.id);
    if (cached) {
      setFrameImg(cached);
    } else if (extractor.src) {
      frameImg.classList.add("loading");
      setFrameEmptyMessage("Loading frame…");
      frameEmpty.style.display = "";
      extractFrame(step.tsMs)
        .then(dataUrl => {
          thumbCache.set(step.id, dataUrl);
          if (steps[currentStepIdx]?.id === step.id) setFrameImg(dataUrl);
          const chip = filmstrip.querySelector(`.chip[data-id="${step.id}"] .chip-thumb`);
          if (chip) chip.src = dataUrl;
        })
        .catch(() => {});
    } else {
      setFrameImg(null);
    }
  }
}

function loadStepFields(step) {
  stepTitle.value = step.title || "";
  stepBody.value  = step.body  || "";
  autoResize(stepTitle);
  autoResize(stepBody);
  updateCharCounts();
}

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
  renderFilmstrip();
  saveCurrentStep();
});

function setActiveMediaPill(mode) {
  mediaPills.forEach(p => p.setAttribute("aria-checked", p.dataset.mode === mode ? "true" : "false"));
}

function updateAnnotateButtonState(step) {
  const disabled = step.mediaMode === "gif";
  openAnnotBtn.disabled = disabled;
  openAnnotBtn.title = disabled ? "Annotations apply to screenshot steps only" : "";
}

mediaPills.forEach(p => {
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
    // Reflect the new media choice in the frame view immediately (e.g. clear
    // the screenshot when switching to "No image").
    if (watching) exitWatchMode();
    loadStepMedia(step);
    updateVideoSurface();
    saveCurrentStep();
  });
});

// ── GIF clip controls ─────────────────────────────────────────────────────
function ensureGifDefaults(step) {
  if (step.gifStartMs == null || step.gifEndMs == null) {
    const idx = steps.indexOf(step);
    const prev = idx > 0 ? steps[idx - 1] : null;
    const naiveStart  = prev ? prev.tsMs : Math.max(0, step.tsMs - 2000);
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
      cached.endMs   === step.gifEndMs   &&
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
[gifStart, gifEnd, gifFps].forEach(el => {
  el.addEventListener("input", () => {
    const step = steps[currentStepIdx];
    if (!step || step.mediaMode !== "gif") return;
    const s = parseFloat(gifStart.value) * 1000;
    const e = parseFloat(gifEnd.value)   * 1000;
    const f = parseInt(gifFps.value, 10);
    if (Number.isFinite(s)) step.gifStartMs = Math.max(0, Math.round(s));
    if (Number.isFinite(e)) step.gifEndMs   = Math.max(step.gifStartMs + 100, Math.round(e));
    if (Number.isFinite(f) && f > 0) step.gifFps = f;
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
      stepId: step.id, sessionId, dataUrl,
      startMs: step.gifStartMs, endMs: step.gifEndMs, fps: step.gifFps || 10,
    });
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
    cached.endMs   === step.gifEndMs   &&
    cached.fps     === (step.gifFps || 10)
  ) return cached.dataUrl;
  return encodeAndCacheGif(step);
}

// ── Step more menu ────────────────────────────────────────────────────────
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
    title:       stepTitle.value.trim(),
    body:        stepBody.value.trim(),
    included:    step.included !== false,
    mediaMode:   step.mediaMode || "screenshot",
    annotations: step.annotations || [],
    gifStartMs:  step.gifStartMs,
    gifEndMs:    step.gifEndMs,
    gifFps:      step.gifFps,
  };
  Object.assign(step, updates);
  await sw({ type: "SP_UPDATE_STEP", stepId: step.id, updates });
}

prevBtn.addEventListener("click", () => { if (currentStepIdx > 0) loadStepIntoEditor(currentStepIdx - 1); });
nextBtn.addEventListener("click", () => { if (currentStepIdx < steps.length - 1) loadStepIntoEditor(currentStepIdx + 1); });

// ── Delete step ───────────────────────────────────────────────────────────
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
  const res = await sw({ type: "SP_DELETE_STEP", stepId: step.id, sessionId });
  if (!res?.ok) return errorToast("Could not delete step");
  steps.splice(idx, 1);
  if (!steps.length) {
    toast("All steps deleted");
    setTimeout(() => window.close(), 1200);
    return;
  }
  if (currentStepIdx >= steps.length) currentStepIdx = steps.length - 1;
  else if (idx < currentStepIdx) currentStepIdx--;
  loadStepIntoEditor(currentStepIdx);
  toast("Step deleted");
}

// ── AI enrichment ─────────────────────────────────────────────────────────
$("enrichOneBtn").addEventListener("click", async () => {
  const step = steps[currentStepIdx];
  if (!step) return;
  const btn = $("enrichOneBtn");
  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> Enriching…';
  let screenshotDataUrl = null;
  try { screenshotDataUrl = await extractFrame(step.tsMs); } catch {}
  const res = await sw({ type: "SP_ENRICH_STEP", stepId: step.id, sessionId, screenshotDataUrl });
  btn.disabled = false;
  btn.innerHTML = originalHtml;
  if (res?.ok) { onStepEnriched(res.step); toast("Step enriched"); }
  else errorToast(formatApiError(res?.error));
});

let enrichAllRunning = false;
async function runEnrichAll() {
  if (enrichAllRunning) return;
  stepMoreMenu.classList.remove("open");
  const pending = steps.filter(s => !s.enriched);
  if (!pending.length) { toast("All steps are already enriched"); return; }
  enrichAllRunning = true;
  enrichAllTopBtn.setAttribute("aria-busy", "true");
  updateEnrichAllTopBtn();
  toast(`Enriching ${pending.length} step${pending.length === 1 ? "" : "s"}…`, 4000);
  let failed = null;
  for (const step of pending) {
    let screenshotDataUrl = null;
    try { screenshotDataUrl = await extractFrame(step.tsMs); } catch {}
    const res = await sw({ type: "SP_ENRICH_STEP", stepId: step.id, sessionId, screenshotDataUrl });
    if (res?.ok) onStepEnriched(res.step);
    else if (!failed) failed = res?.error;
  }
  enrichAllRunning = false;
  enrichAllTopBtn.removeAttribute("aria-busy");
  updateEnrichAllTopBtn();
  if (failed) errorToast(formatApiError(failed));
  else toast("All steps enriched");
}
$("enrichAllBtn").addEventListener("click", runEnrichAll);
enrichAllTopBtn.addEventListener("click", runEnrichAll);

// Surfaces the guide-level "Enrich all" action in the topbar whenever there
// are steps still missing AI text, with a live count — so it isn't buried in
// the per-step overflow menu.
function updateEnrichAllTopBtn() {
  const unenriched = steps.filter(s => !s.enriched).length;
  if (!unenriched || enrichAllRunning) {
    enrichAllTopBtn.hidden = true;
    return;
  }
  enrichAllTopBtn.hidden = false;
  enrichAllTopLabel.textContent = unenriched === steps.length
    ? "Enrich all"
    : `Enrich ${unenriched}`;
}

function onStepEnriched(step) {
  const i = steps.findIndex(s => s.id === step.id);
  if (i !== -1) steps[i] = step;
  if (steps[currentStepIdx]?.id === step.id) loadStepFields(step);
  renderFilmstrip();
  updateEnrichAllTopBtn();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "SW_STEP_ENRICHED") onStepEnriched(msg.payload.step);
});

// ── Annotation editor ─────────────────────────────────────────────────────
async function getBrand() {
  if (currentBrand) return currentBrand;
  const data = await chrome.storage.local.get(["brandCircleColor", "brandArrowColor", "brandHighlightColor"]);
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
    currentBrand = null;
    if (annotator) annotator.redraw();
  }
});

openAnnotBtn.addEventListener("click", () => {
  stepMoreMenu.classList.remove("open");
  openAnnotPaneForCurrentStep();
});
$("annotClose").addEventListener("click", closeAnnotPane);
// Jump straight to the Branding settings where annotation colors are defined.
$("annotBrandBtn").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("options/index.html#branding") });
});
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

document.querySelectorAll(".annot-tool[data-tool]").forEach(btn => {
  btn.addEventListener("click", () => {
    const tool = btn.dataset.tool;
    activeTool = activeTool === tool ? null : tool;
    document.querySelectorAll(".annot-tool[data-tool]").forEach(b => {
      b.classList.toggle("active", b.dataset.tool === activeTool);
    });
    annotator?.setTool(activeTool);
  });
});

document.querySelectorAll(".annot-tool[data-hint]").forEach(btn => {
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
  const img = await new Promise((resolve) => {
    const i = new Image();
    i.onload  = () => resolve(i);
    i.onerror = () => resolve(null);
    i.src = frame;
  });
  if (img) { annotCanvas.width = img.naturalWidth; annotCanvas.height = img.naturalHeight; }
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
  document.querySelectorAll(".annot-tool[data-tool]").forEach(b => b.classList.remove("active"));
  annotator?.setTool(null);
}

// ── Frame extraction ──────────────────────────────────────────────────────
async function waitForExtractorReady() {
  if (!extractor.src) throw new Error("No recording loaded");
  if (extractor.readyState >= 2 && extractor.videoWidth > 0) return;
  await new Promise((resolve) => {
    const done = () => {
      extractor.removeEventListener("loadeddata", done);
      extractor.removeEventListener("canplay",    done);
      extractor.removeEventListener("error",      done);
      resolve();
    };
    extractor.addEventListener("loadeddata", done, { once: true });
    extractor.addEventListener("canplay",    done, { once: true });
    extractor.addEventListener("error",      done, { once: true });
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

function seekExtractor(targetSec) {
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      extractor.removeEventListener("seeked", onSeeked);
      extractor.removeEventListener("error",  onErr);
      resolve();
    };
    const onErr = () => {
      extractor.removeEventListener("seeked", onSeeked);
      extractor.removeEventListener("error",  onErr);
      reject(new Error("Extractor error during seek"));
    };
    extractor.addEventListener("seeked", onSeeked, { once: true });
    extractor.addEventListener("error",  onErr,    { once: true });
    setTimeout(() => { if (!extractor.seeking) onSeeked(); }, 1500);
    extractor.currentTime = Math.max(0, targetSec);
  });
}

function extractGifClip(startMs, endMs, fps) {
  const job = () => (async () => {
    await waitForExtractorReady();
    if (typeof window.GIF !== "function") throw new Error("GIF encoder not loaded (vendor/gif.js missing)");
    const sourceW = extractor.videoWidth;
    const sourceH = extractor.videoHeight;
    const scale = sourceW > GIF_MAX_WIDTH ? GIF_MAX_WIDTH / sourceW : 1;
    const w = Math.max(1, Math.round(sourceW * scale));
    const h = Math.max(1, Math.round(sourceH * scale));
    const safeFps = Math.max(1, Math.min(30, fps || 10));
    const delay = Math.round(1000 / safeFps);
    const frameTimes = [];
    for (let t = startMs; t < endMs; t += delay) frameTimes.push(t);
    if (!frameTimes.length || frameTimes[frameTimes.length - 1] < endMs) frameTimes.push(endMs);

    const gif = new window.GIF({
      workers: 2, quality: 10, width: w, height: h,
      workerScript: chrome.runtime.getURL("vendor/gif.worker.js"),
    });

    extractorCanvas.width = w;
    extractorCanvas.height = h;
    const ctx = extractorCanvas.getContext("2d");

    for (let i = 0; i < frameTimes.length; i++) {
      await seekExtractor(frameTimes[i] / 1000);
      ctx.drawImage(extractor, 0, 0, w, h);
      gif.addFrame(extractorCanvas, { copy: true, delay });
      setGifStatus(`Capturing frame ${i + 1}/${frameTimes.length}…`);
    }

    return new Promise((resolve, reject) => {
      gif.on("progress", p => setGifStatus(`Encoding… ${Math.round(p * 100)}%`));
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

// ── Session name auto-save ────────────────────────────────────────────────
let sessionNameSaveTimer;
sessionNameEl.addEventListener("input", () => {
  clearTimeout(sessionNameSaveTimer);
  sessionNameSaveTimer = setTimeout(async () => {
    const next = sessionNameEl.value.trim() || (currentSession?.name || "Untitled guide");
    if (currentSession) currentSession.name = next;
    document.title = next + " — Guidr";
    await sw({ type: "SP_UPDATE_SESSION", sessionId, updates: { name: next } });
  }, 500);
});
sessionNameEl.addEventListener("blur", () => {
  if (sessionNameEl.value.trim() === "") sessionNameEl.value = currentSession?.name || "";
});

// ── Session more menu (topbar) ─────────────────────────────────────────────
function refreshSessionMoreMenu() {
  if (!currentSession) return;
  const hasVid   = !!currentSession.hasRecording;
  const hasVoice = !!currentSession.hasVoice;
  $("sessDropVidItem").style.display   = hasVid   ? "" : "none";
  $("sessDropVoiceItem").style.display = hasVoice ? "" : "none";
  $("sessSep").style.display           = (hasVid || hasVoice) ? "" : "none";
}

sessionMoreBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  refreshSessionMoreMenu();
  sessionMoreMenu.classList.toggle("open");
});
document.addEventListener("click", (e) => {
  if (!sessionMoreMenu.contains(e.target) && e.target !== sessionMoreBtn && !sessionMoreBtn.contains(e.target)) {
    sessionMoreMenu.classList.remove("open");
  }
});

$("sessDropVidItem").addEventListener("click", async () => {
  sessionMoreMenu.classList.remove("open");
  const mb = ((currentSession?.recordingBytes || 0) / 1024 / 1024).toFixed(1);
  const ok = await confirmModal({
    title: "Remove video?",
    body: `"${currentSession?.name}" will keep its steps and text. The ${mb} MB video track will be deleted, and screenshots and video export will no longer be available.`,
    confirmLabel: "Remove video",
  });
  if (!ok) return;
  const r = await sw({ type: "SP_DELETE_RECORDING", sessionId });
  if (!r?.ok) return errorToast("Could not delete video track");
  currentSession.hasRecording = false;
  currentSession.recordingBytes = 0;
  await loadRecordingIntoPlayers(sessionId);
  toast("Video track deleted");
});

$("sessDropVoiceItem").addEventListener("click", async () => {
  sessionMoreMenu.classList.remove("open");
  const ok = await confirmModal({
    title: "Remove narration?",
    body: `The narration for "${currentSession?.name}" will be permanently removed. The video and text are unaffected.`,
    confirmLabel: "Remove narration",
  });
  if (!ok) return;
  const r = await sw({ type: "SP_DELETE_VOICE", sessionId });
  if (!r?.ok) return errorToast("Could not delete narration");
  currentSession.hasVoice = false;
  currentSession.voiceBytes = 0;
  if (narrationObjectUrl) {
    try { URL.revokeObjectURL(narrationObjectUrl); } catch {}
    narrationObjectUrl = null;
  }
  narrationAudio.removeAttribute("src");
  narrationAudio.load();
  setNarrationOverlayVisible(false);
  toast("Narration deleted");
});

$("sessDeleteItem").addEventListener("click", async () => {
  sessionMoreMenu.classList.remove("open");
  const ok = await confirmModal({
    title: "Delete guide?",
    body: `"${currentSession?.name}" and all its steps will be permanently removed. This cannot be undone.`,
    confirmLabel: "Delete guide",
  });
  if (!ok) return;
  const r = await sw({ type: "SP_DELETE_SESSION", sessionId });
  if (!r?.ok) return errorToast("Could not delete guide");
  toast("Guide deleted");
  setTimeout(() => window.close(), 800);
});

$('sessSettingsItem').addEventListener('click', () => { sessionMoreMenu.classList.remove('open'); chrome.runtime.openOptionsPage(); });

// ── Narration sync ────────────────────────────────────────────────────────
function bindNarrationSync() {
  if (narrationSyncBound) return;
  narrationSyncBound = true;
  const syncTime = () => {
    if (!narrationAudio.src) return;
    const drift = narrationAudio.currentTime - srcVideo.currentTime;
    if (Math.abs(drift) > 0.15) narrationAudio.currentTime = srcVideo.currentTime;
  };
  srcVideo.addEventListener("play", () => { if (!narrationAudio.src) return; syncTime(); narrationAudio.play().catch(() => {}); });
  srcVideo.addEventListener("pause",  () => narrationAudio.pause());
  srcVideo.addEventListener("ended",  () => narrationAudio.pause());
  srcVideo.addEventListener("seeked", () => {
    if (!narrationAudio.src) return;
    syncTime();
    if (!srcVideo.paused) narrationAudio.play().catch(() => {});
  });
  srcVideo.addEventListener("ratechange", () => { narrationAudio.playbackRate = srcVideo.playbackRate; });
}

async function loadNarrationIntoPlayer(sid) {
  if (narrationObjectUrl) { try { URL.revokeObjectURL(narrationObjectUrl); } catch {} narrationObjectUrl = null; }
  narrationAudio.removeAttribute("src");
  narrationAudio.load();
  setNarrationOverlayVisible(false);
  let voice;
  try { voice = await db.getVoiceRecording(sid); }
  catch (err) { console.warn("[Guidr] getVoiceRecording failed:", err); return; }
  if (!voice?.blob) return;
  narrationObjectUrl = URL.createObjectURL(voice.blob);
  narrationAudio.src = narrationObjectUrl;
  narrationAudio.playbackRate = srcVideo.playbackRate;
  await applyStoredNarrationVolume();
  bindNarrationSync();
  setNarrationOverlayVisible(true);
}

function setNarrationOverlayVisible(visible) {
  hasVoice = !!visible;
  narrationVol.hidden = !visible;
  frameView.classList.toggle("has-voice", hasVoice);
  updateVideoSurface();
}

// The narration volume control only belongs on screen while the recording is
// actually visible — watch mode or a GIF step — never over a static screenshot.
function updateVideoSurface() {
  const step = steps[currentStepIdx];
  const showingVideo = watching || step?.mediaMode === "gif";
  frameView.classList.toggle("show-video", showingVideo);
}

async function applyStoredNarrationVolume() {
  const { narrationVolume: vol, narrationMuted: muted } =
    await chrome.storage.local.get(["narrationVolume", "narrationMuted"]);
  const v = typeof vol === "number" ? vol : 1;
  const m = !!muted;
  narrationAudio.volume = v;
  narrationAudio.muted  = m;
  narrationVolume.value = String(v);
  narrationVol.classList.toggle("muted", m);
  narrationMute.setAttribute("aria-label", m ? "Unmute narration" : "Mute narration");
  narrationMute.setAttribute("title",      m ? "Unmute narration" : "Mute narration");
}

narrationVolume.addEventListener("input", () => {
  const v = Number(narrationVolume.value);
  narrationAudio.volume = v;
  if (narrationAudio.muted && v > 0) { narrationAudio.muted = false; narrationVol.classList.remove("muted"); }
  chrome.storage.local.set({ narrationVolume: v, narrationMuted: narrationAudio.muted });
});
narrationMute.addEventListener("click", () => {
  const next = !narrationAudio.muted;
  narrationAudio.muted = next;
  narrationVol.classList.toggle("muted", next);
  narrationMute.setAttribute("aria-label", next ? "Unmute narration" : "Mute narration");
  narrationMute.setAttribute("title",      next ? "Unmute narration" : "Mute narration");
  chrome.storage.local.set({ narrationMuted: next });
});

// ── Watch recording ───────────────────────────────────────────────────────
// Lets the user play back the full screen recording before exporting. The
// video overlays the frame view; narration (if any) syncs via bindNarrationSync.
function enterWatchMode() {
  if (!srcVideo.src) { errorToast("No recording loaded for this guide"); return; }
  watching = true;
  if (annotPane.classList.contains("active")) closeAnnotPane();
  srcVideo.classList.add("watch-mode");
  watchBtn.querySelector(".nv-ico-on").style.display = "none";
  watchBtn.querySelector(".nv-ico-off").style.display = "";
  watchBtnLabel.textContent = "Close";
  updateVideoSurface();
  srcVideo.play().catch(() => {});
}

function exitWatchMode() {
  watching = false;
  srcVideo.classList.remove("watch-mode");
  try { srcVideo.pause(); } catch {}
  watchBtn.querySelector(".nv-ico-on").style.display = "";
  watchBtn.querySelector(".nv-ico-off").style.display = "none";
  watchBtnLabel.textContent = "Watch recording";
  updateVideoSurface();
}

watchBtn.addEventListener("click", () => {
  if (watching) exitWatchMode();
  else enterWatchMode();
});

// ── Export ────────────────────────────────────────────────────────────────
function updateExportSummary() {
  const el = $("exportSummary");
  if (!el) return;
  const total    = steps.length;
  const included = steps.filter(s => s.included !== false).length;
  const skipped  = total - included;
  el.textContent = skipped > 0
    ? `${included} of ${total} steps · ${skipped} skipped`
    : `${total} step${total !== 1 ? "s" : ""}`;
}

function setExportMenuOpen(open) {
  exportMenu.classList.toggle("open", open);
  exportBtn.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) updateExportSummary();
}

exportBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  setExportMenuOpen(!exportMenu.classList.contains("open"));
});
document.addEventListener("click", (e) => {
  if (!exportMenu.contains(e.target) && e.target !== exportBtn) setExportMenuOpen(false);
});

exportMenu.querySelectorAll(".btn-row").forEach(btn => {
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const row    = btn.closest(".export-row");
    const fmt    = row?.dataset.fmt;
    const action = btn.dataset.action;
    if (!fmt || !action) return;
    const rowBtns  = row.querySelectorAll(".btn-row");
    rowBtns.forEach(b => { b.disabled = true; });
    const original = btn.innerHTML;
    if (action === "copy") {
      btn.innerHTML = "Copying\u2026";
    } else {
      btn.innerHTML = `<span class="spin"></span>`;
    }
    try {
      if (fmt === "video") await downloadRecording();
      else await doDocumentExport(fmt, action);
      setExportMenuOpen(false);
    } catch (err) {
      errorToast("Export failed: " + formatApiError(err.message || String(err)));
    }
    rowBtns.forEach(b => { b.disabled = false; });
    btn.innerHTML = original;
  });
});

async function downloadRecording() {
  const rec = await db.getRecording(sessionId);
  if (!rec?.blob) throw new Error("No video recording available for this guide");
  const voice = currentSession?.hasVoice ? await db.getVoiceRecording(sessionId) : null;
  let blob = rec.blob;
  if (voice?.blob) {
    startProgressToast("Embedding narration… 0%");
    try {
      blob = await muxVideoWithNarration(rec.blob, voice.blob, (pct) => {
        updateProgressToast(`Embedding narration… ${Math.round(pct * 100)}%`);
      });
      endProgressToast("Video downloaded");
    } catch (err) {
      console.warn("[Guidr] mux failed, falling back to silent video:", err);
      endProgressToast("Could not embed narration — downloaded silent video", 5000);
      blob = rec.blob;
    }
  } else {
    toast("Video downloaded");
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = slugify(currentSession?.name || sessionNameEl.value || "guide") + ".webm";
  a.click();
  URL.revokeObjectURL(url);
}

async function muxVideoWithNarration(videoBlob, audioBlob, onProgress) {
  const videoEl = document.createElement("video");
  videoEl.muted = true; videoEl.preload = "auto"; videoEl.playsInline = true;
  videoEl.style.cssText = "position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;";
  const audioEl = document.createElement("audio");
  audioEl.preload = "auto";
  audioEl.style.cssText = "position:absolute;left:-9999px;top:-9999px;";
  const videoUrl = URL.createObjectURL(videoBlob);
  const audioUrl = URL.createObjectURL(audioBlob);
  videoEl.src = videoUrl; audioEl.src = audioUrl;
  document.body.appendChild(videoEl); document.body.appendChild(audioEl);
  let audioCtx = null, progressTimer = null;
  try {
    await Promise.all([
      new Promise((res, rej) => {
        if (videoEl.readyState >= 1) return res();
        videoEl.addEventListener("loadedmetadata", () => res(), { once: true });
        videoEl.addEventListener("error", () => rej(new Error("video load failed")), { once: true });
      }),
      new Promise((res, rej) => {
        if (audioEl.readyState >= 1) return res();
        audioEl.addEventListener("loadedmetadata", () => res(), { once: true });
        audioEl.addEventListener("error", () => rej(new Error("audio load failed")), { once: true });
      }),
    ]);
    const videoStream = videoEl.captureStream?.() || videoEl.mozCaptureStream?.();
    if (!videoStream) throw new Error("captureStream unsupported");
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const dest = audioCtx.createMediaStreamDestination();
    audioCtx.createMediaElementSource(audioEl).connect(dest);
    const combined = new MediaStream([...videoStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const mimeType = pickMuxMimeType();
    const recorder = new MediaRecorder(combined, { mimeType, videoBitsPerSecond: 4_000_000, audioBitsPerSecond: 96_000 });
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    const durationMs = Math.max(
      isFinite(videoEl.duration) ? videoEl.duration * 1000 : 0,
      isFinite(audioEl.duration) ? audioEl.duration * 1000 : 0
    );
    return await new Promise((resolve, reject) => {
      const startTs = Date.now();
      recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType.split(";")[0] }));
      recorder.onerror = (e) => reject(e?.error || new Error("MediaRecorder failed"));
      videoEl.addEventListener("ended", () => {
        setTimeout(() => { try { recorder.stop(); } catch {} }, 200);
      }, { once: true });
      videoEl.currentTime = 0; audioEl.currentTime = 0;
      recorder.start(500);
      Promise.all([videoEl.play(), audioEl.play()]).catch((err) => {
        try { recorder.stop(); } catch {}
        reject(err);
      });
      if (onProgress && durationMs > 0) {
        progressTimer = setInterval(() => {
          onProgress(Math.min(1, (Date.now() - startTs) / durationMs));
        }, 250);
      }
    });
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    try { videoEl.pause(); } catch {}
    try { audioEl.pause(); } catch {}
    videoEl.removeAttribute("src"); audioEl.removeAttribute("src");
    videoEl.load(); audioEl.load();
    videoEl.remove(); audioEl.remove();
    URL.revokeObjectURL(videoUrl); URL.revokeObjectURL(audioUrl);
    if (audioCtx) audioCtx.close().catch(() => {});
  }
}

function pickMuxMimeType() {
  const candidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  for (const c of candidates) if (MediaRecorder.isTypeSupported(c)) return c;
  return "video/webm";
}

async function doDocumentExport(fmt, action = "download") {
  const included = steps.filter(s => s.included !== false);
  if (!included.length && fmt !== "json") throw new Error("No steps included in the guide");
  if (!extractor.src && fmt !== "json" && included.some(s => s.mediaMode !== "none")) {
    toast("No video loaded — steps will export without screenshots", 4000);
  }
  const brand = await getBrand();
  const hydrated = [];
  for (const step of included) {
    let screenshot = null;
    if (step.mediaMode === "gif" && extractor.src) {
      try { screenshot = await getOrEncodeGif(step); }
      catch (err) { console.warn("[Guidr] export: gif encoding failed for step", step.index, ":", err.message); }
    } else if (step.mediaMode !== "none" && extractor.src) {
      try {
        screenshot = await extractFrame(step.tsMs);
        if (step.annotations?.length) screenshot = await renderAnnotated(screenshot, step.annotations, brand);
      } catch (err) { console.warn("[Guidr] export: frame extraction failed for step", step.index, ":", err.message); }
    }
    hydrated.push({ ...step, screenshotAfter: screenshot, screenshotBefore: null });
  }
  const result = await exportSession({
    ...currentSession,
    name: currentSession?.name || sessionNameEl.value,
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
        : [new ClipboardItem({ "text/plain": new Blob([result.content], { type: "text/plain" }) })];
      await navigator.clipboard.write(items);
      toast(fmt === "intercom" ? "Copied — paste into your help-center editor" : "Copied to clipboard");
    } catch (e) { errorToast("Clipboard write failed: " + e.message); }
    return;
  }
  const blob = new Blob([result.content], { type: result.mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = result.filename; a.click();
  URL.revokeObjectURL(url);
  toast("Downloaded " + result.filename);
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────
function openHelp()  { helpBackdrop.classList.add("open");    }
function closeHelp() { helpBackdrop.classList.remove("open"); }
$('helpMenuItem').addEventListener('click', () => { sessionMoreMenu.classList.remove('open'); openHelp(); });
$("helpClose").addEventListener("click", closeHelp);
helpBackdrop.addEventListener("click", (e) => { if (e.target === helpBackdrop) closeHelp(); });

const ANNOT_KEYS = { "1": "circle", "2": "arrow", "3": "highlight", "4": "mask" };

document.addEventListener("keydown", (e) => {
  const isTyping = e.target.matches("textarea, input, select, [contenteditable]");
  if (e.key === "Escape") {
    if (helpBackdrop.classList.contains("open"))    { closeHelp(); return; }
    if (exportMenu.classList.contains("open"))      { setExportMenuOpen(false); return; }
    if (stepMoreMenu.classList.contains("open"))    { stepMoreMenu.classList.remove("open"); return; }
    if (sessionMoreMenu.classList.contains("open")) { sessionMoreMenu.classList.remove("open"); return; }
    if (annotPane.classList.contains("active"))     { closeAnnotPane(); return; }
  }
  if (!isTyping && (e.key === "?" || (e.key === "/" && e.shiftKey))) {
    e.preventDefault(); openHelp(); return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault(); $("enrichOneBtn").click(); return;
  }
  if (isTyping) return;
  if (e.key === "ArrowLeft")  prevBtn.click();
  if (e.key === "ArrowRight") nextBtn.click();
  if (annotPane.classList.contains("active") && ANNOT_KEYS[e.key]) {
    const btn = document.querySelector(`.annot-tool[data-tool="${ANNOT_KEYS[e.key]}"]`);
    if (btn) btn.click();
  }
});

// ── Char counts ───────────────────────────────────────────────────────────
function updateCharCounts() {
  [[stepTitle, "titleCount", 60], [stepBody, "bodyCount", 200]].forEach(([ta, id, max]) => {
    const n = ta.value.length;
    const el = $(id);
    el.textContent = `${n} / ${max}`;
    el.classList.toggle("over", n > max);
  });
}
function autoResize(ta) { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; }

// ── Toast ─────────────────────────────────────────────────────────────────
let toastTimer;
function toast(msg, ms = 2600) {
  const el = $("toast");
  el.textContent = msg; el.classList.remove("error"); el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}
function errorToast(msg, ms = 6000) {
  const el = $("toast");
  el.textContent = msg; el.classList.add("show", "error");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}
function startProgressToast(msg) {
  const el = $("toast");
  el.textContent = msg; el.classList.remove("error"); el.classList.add("show");
  clearTimeout(toastTimer); toastTimer = null;
}
function updateProgressToast(msg) {
  const el = $("toast");
  if (el.classList.contains("show")) el.textContent = msg;
}
function endProgressToast(finalMsg, ms = 2600) { toast(finalMsg, ms); }

// ── Confirm modal ─────────────────────────────────────────────────────────
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
modalBackdrop.addEventListener("click", (e) => { if (e.target === modalBackdrop) closeModal(false); });

function confirmModal({ title, body, confirmLabel = "Delete", cancelLabel = "Cancel", danger = true }) {
  modalTitle.textContent   = title;
  modalBody.textContent    = body;
  modalConfirm.textContent = confirmLabel;
  modalCancel.textContent  = cancelLabel;
  modalConfirm.classList.toggle("danger",  danger);
  modalConfirm.classList.toggle("primary", !danger);
  modalBackdrop.classList.add("open");
  document.addEventListener("keydown", onModalKey);
  modalConfirm.focus();
  return new Promise((resolve) => { modalResolver = resolve; });
}
