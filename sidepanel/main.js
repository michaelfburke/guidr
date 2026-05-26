import { synthesizeVideo } from '../video.js';

// ── State ──────────────────────────────────────────────────────────────────
let isRecording = false;
let currentSessionId = null;
let steps = []; // lightweight, no blob screenshots
let currentStepIdx = 0;
let currentShotDataUrl = null;

// Annotation state
let annotations = []; // per-step: stored as JSON in step.annotations
let annoMode = false;
let activeTool = "circle";
let isDragging = false;
let dragStart = null;
let pendingAnnotation = null;
let selectedAnnoId = null;

// Video state
let videoBlob = null;
let videoObjectUrl = null;

// Branding (annotation colors) — defaults match the previous hardcoded values.
const BRAND_DEFAULTS = {
  brandCircleColor:    "#7c6af7",
  brandArrowColor:     "#f87171",
  brandHighlightColor: "#fbbf24",
};
let branding = { ...BRAND_DEFAULTS };
chrome.storage.local.get(Object.keys(BRAND_DEFAULTS), (data) => {
  Object.keys(BRAND_DEFAULTS).forEach((k) => {
    if (data[k]) branding[k] = data[k];
  });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  let touched = false;
  Object.keys(BRAND_DEFAULTS).forEach((k) => {
    if (changes[k]) { branding[k] = changes[k].newValue || BRAND_DEFAULTS[k]; touched = true; }
  });
  if (touched && typeof renderAnnotations === "function") renderAnnotations();
});

// ── DOM refs ───────────────────────────────────────────────────────────────
const recBtn       = $("recBtn");
const recLabel     = $("recLabel");
const recDot       = $("recDot");
const sessionName  = $("sessionName");
const captureSection = $("captureSection");
const captureList  = $("captureList");
const sessionsList = $("sessionsList");
const mainShot     = $("mainShot");
const annoCanvas   = $("annoCanvas");
const annoCtx      = annoCanvas.getContext("2d");
const thumbStrip   = $("thumbStrip");
const stepTitle    = $("stepTitle");
const stepBody     = $("stepBody");
const stepVoice    = $("stepVoice");
const stepCounter  = $("stepCounter");
const prevBtn      = $("prevBtn");
const nextBtn      = $("nextBtn");
const exportBtn    = $("exportBtn");
const exportFmt    = $("exportFmt");

// ── Boot ───────────────────────────────────────────────────────────────────
loadSessions();
applyOnboardingState();

async function applyOnboardingState() {
  const { apiKey } = await chrome.storage.local.get("apiKey");
  const hasKey = !!apiKey;
  $("setupCard").style.display = hasKey ? "none" : "";
  $("nameRow").style.display   = hasKey ? "" : "none";
  $("recBtn").style.display    = hasKey ? "" : "none";
}

$("goSetupBtn").addEventListener("click", () => chrome.runtime.openOptionsPage());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.apiKey) applyOnboardingState();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "SW_STEP_CAPTURED")  onStepCaptured(msg.payload.step);
  if (msg.type === "SW_STEP_ENRICHED")  onStepEnriched(msg.payload.step);
  if (msg.type === "SW_CAPTURE_ERROR")  errorToast("Capture failed: " + formatApiError(msg.payload.message));
});

// ── Navigation ─────────────────────────────────────────────────────────────
$("btn-home").addEventListener("click", () => showView("v-home"));
$("btn-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("btn-video").addEventListener("click", () => showView("v-video"));

function showView(id) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  $(id).classList.add("active");
  $("btn-video").style.display = (id === "v-editor" && steps.length > 0) ? "" : "none";
}

// ── Recording ──────────────────────────────────────────────────────────────
recBtn.addEventListener("click", async () => {
  if (!isRecording) {
    const res = await sw({ type: "SP_START_RECORDING", sessionName: sessionName.value });
    if (!res?.ok) { errorToast(res?.error || "Check your API key in Settings"); return; }
    currentSessionId = res.sessionId;
    steps = [];
    setRecording(true);
    captureSection.style.display = "";
    captureList.innerHTML = "";
  } else {
    await sw({ type: "SP_STOP_RECORDING" });
    setRecording(false);
    toast("Recording stopped");
    if (steps.length) {
      setTimeout(() => openEditor(), 400);
    }
    loadSessions();
  }
});

function setRecording(val) {
  isRecording = val;
  recBtn.classList.toggle("recording", val);
  recLabel.textContent = val ? "Stop recording" : "Start recording";
  recDot.style.display = val ? "" : "none";
  sessionName.disabled = val;
}

function onStepCaptured(step) {
  steps.push(step);
  // Add to live capture list
  const item = document.createElement("div");
  item.className = "capture-item";
  item.id = `cap-${step.id}`;
  const label = step.target?.text || step.target?.ariaLabel || step.pageTitle || "Step";
  item.innerHTML = `
    <div class="capture-num">${steps.length}</div>
    <div class="capture-info"><span>${escHtml(label.slice(0,50))}</span></div>
    <span class="capture-status pending">●</span>`;
  captureList.prepend(item);
}

function onStepEnriched(step) {
  const i = steps.findIndex(s => s.id === step.id);
  if (i !== -1) steps[i] = step;
  // Update capture indicator
  const cap = $(`cap-${step.id}`);
  if (cap) {
    cap.querySelector(".capture-status").className = "capture-status ok";
    cap.querySelector(".capture-status").textContent = "done";
  }
  // If editor is open and showing this step, refresh
  if (document.getElementById("v-editor").classList.contains("active") &&
      steps[currentStepIdx]?.id === step.id) {
    loadStepIntoEditor(currentStepIdx);
  }
  renderThumbStrip();
}

// ── Sessions ───────────────────────────────────────────────────────────────
async function loadSessions() {
  const res = await sw({ type: "SP_GET_SESSIONS" });
  const list = res?.sessions || [];
  if (!list.length) {
    sessionsList.innerHTML = '<div class="empty-sessions">Record your first guide to get started.</div>';
    return;
  }
  sessionsList.innerHTML = "";
  list.slice(0, 8).forEach(s => {
    const card = document.createElement("div");
    card.className = "session-card";
    card.innerHTML = `
      <img class="session-thumb" src="" data-sid="${s.id}" alt=""/>
      <div class="session-card-body">
        <strong>${escHtml(s.name)}</strong>
        <span>${s.stepCount} step${s.stepCount!==1?"s":""} · ${timeAgo(s.updatedAt)}</span>
      </div>
      <button class="session-delete" title="Delete this guide">×</button>
      <span class="chevron">›</span>`;
    sw({ type: "SP_GET_SESSION_THUMB", sessionId: s.id }).then((r) => {
      if (r?.dataUrl) card.querySelector("[data-sid]").src = r.dataUrl;
    });
    card.addEventListener("click", () => openSession(s.id));
    card.querySelector(".session-delete").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${s.name}"? This cannot be undone.`)) return;
      const res = await sw({ type: "SP_DELETE_SESSION", sessionId: s.id });
      if (!res?.ok) { errorToast("Could not delete guide"); return; }
      toast("Guide deleted");
      loadSessions();
    });
    sessionsList.appendChild(card);
  });
}

async function openSession(sessionId) {
  const res = await sw({ type: "SP_GET_SESSION", sessionId });
  if (!res?.ok) return;
  currentSessionId = sessionId;
  steps = res.session.steps;
  sessionName.value = res.session.name;
  currentStepIdx = 0;
  openEditor();
}

function openEditor() {
  showView("v-editor");
  $("btn-video").style.display = "";
  renderThumbStrip();
  loadStepIntoEditor(currentStepIdx);
}

// ── Thumbnail strip ────────────────────────────────────────────────────────
function renderThumbStrip() {
  thumbStrip.innerHTML = "";
  steps.forEach((step, i) => {
    const item = document.createElement("div");
    item.className = `thumb-item${i === currentStepIdx ? " active" : ""}${step.enriched ? " enriched" : ""}`;
    item.draggable = true;
    item.dataset.idx = i;
    item.dataset.id  = step.id;
    item.innerHTML = `
      <img class="thumb-img" src="" alt="Step ${i+1}"/>
      <div class="thumb-num">${i+1}</div>
      <button class="thumb-del" title="Delete step ${i+1}">×</button>`;
    // Load thumbnail lazily
    loadStepScreenshot(step.id, "after").then(url => {
      if (url) item.querySelector("img").src = url;
    });
    item.addEventListener("click", () => { currentStepIdx = i; renderThumbStrip(); loadStepIntoEditor(i); });
    item.querySelector(".thumb-del").addEventListener("click", (e) => {
      e.stopPropagation();
      deleteStepAt(i);
    });
    // Drag-to-reorder
    setupDrag(item, i);
    thumbStrip.appendChild(item);
  });
  // Add new step button
  const addBtn = document.createElement("button");
  addBtn.className = "thumb-add";
  addBtn.title = "Record another step";
  addBtn.textContent = "+";
  addBtn.addEventListener("click", () => {
    showView("v-home");
    if (!isRecording) recBtn.click();
  });
  thumbStrip.appendChild(addBtn);
}

// ── Drag-to-reorder ────────────────────────────────────────────────────────
let dragSrcIdx = null;
function setupDrag(item, idx) {
  item.addEventListener("dragstart", () => { dragSrcIdx = idx; item.style.opacity = "0.4"; });
  item.addEventListener("dragend",   () => { item.style.opacity = ""; dragSrcIdx = null; });
  item.addEventListener("dragover",  (e) => { e.preventDefault(); item.classList.add("drag-over"); });
  item.addEventListener("dragleave", () => item.classList.remove("drag-over"));
  item.addEventListener("drop",      (e) => {
    e.preventDefault();
    item.classList.remove("drag-over");
    if (dragSrcIdx === null || dragSrcIdx === idx) return;
    const moved = steps.splice(dragSrcIdx, 1)[0];
    steps.splice(idx, 0, moved);
    currentStepIdx = idx;
    const orderedIds = steps.map(s => s.id);
    sw({ type: "SP_REORDER_STEPS", sessionId: currentSessionId, orderedIds });
    renderThumbStrip();
    loadStepIntoEditor(currentStepIdx);
  });
}

// ── Step editor ────────────────────────────────────────────────────────────
async function loadStepIntoEditor(idx) {
  const step = steps[idx];
  if (!step) return;
  currentStepIdx = idx;

  // Screenshot
  const url = await loadStepScreenshot(step.id, "after") || await loadStepScreenshot(step.id, "before");
  currentShotDataUrl = url;
  if (url) {
    const sizeCanvasToShot = () => {
      if (!mainShot.naturalWidth) return;
      const r = mainShot.getBoundingClientRect();
      annoCanvas.width  = mainShot.naturalWidth;
      annoCanvas.height = mainShot.naturalHeight;
      // Preserve the toggled pointer-events; only set position/size.
      annoCanvas.style.position = "absolute";
      annoCanvas.style.top = "0";
      annoCanvas.style.left = "0";
      annoCanvas.style.width  = r.width  + "px";
      annoCanvas.style.height = r.height + "px";
      annotations = step.annotations || [];
      renderAnnotations();
    };
    mainShot.onload = sizeCanvasToShot;
    mainShot.src = url;
    // If the browser served the same URL from cache, onload won't fire — size now.
    if (mainShot.complete && mainShot.naturalWidth) sizeCanvasToShot();
  }

  // Text fields
  stepTitle.value = step.title || "";
  stepBody.value  = step.body || "";
  stepVoice.value = step.voiceoverScript || "";
  autoResize(stepTitle); autoResize(stepBody); autoResize(stepVoice);
  updateCharCounts();

  // Navigation
  prevBtn.disabled = idx === 0;
  nextBtn.disabled = idx === steps.length - 1;
  stepCounter.textContent = `${idx + 1} / ${steps.length}`;

  // Refresh thumbnail strip selection
  thumbStrip.querySelectorAll(".thumb-item").forEach((t, i) => {
    t.classList.toggle("active", i === idx);
  });
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

async function saveCurrentStep() {
  const step = steps[currentStepIdx];
  if (!step) return;
  const updates = {
    title: stepTitle.value.trim(),
    body:  stepBody.value.trim(),
    voiceoverScript: stepVoice.value.trim(),
    annotations: JSON.parse(JSON.stringify(annotations)),
  };
  Object.assign(step, updates);
  await sw({ type: "SP_UPDATE_STEP", stepId: step.id, updates });
}

// Step navigation
prevBtn.addEventListener("click", () => { if (currentStepIdx > 0) { currentStepIdx--; renderThumbStrip(); loadStepIntoEditor(currentStepIdx); } });
nextBtn.addEventListener("click", () => { if (currentStepIdx < steps.length-1) { currentStepIdx++; renderThumbStrip(); loadStepIntoEditor(currentStepIdx); } });

// Keyboard shortcuts
document.addEventListener("keydown", (e) => {
  if (!document.getElementById("v-editor").classList.contains("active")) return;
  if (e.target.matches("textarea, input")) return;
  if (e.key === "ArrowLeft")  prevBtn.click();
  if (e.key === "ArrowRight") nextBtn.click();
  if (e.key === "Delete" || e.key === "Backspace") {
    if (selectedAnnoId !== null) removeAnnotation(selectedAnnoId);
  }
  if ((e.metaKey || e.ctrlKey) && e.key === "z") { undoAnnotation(); }
});

// ── AI Enrichment ───────────────────────────────────────────────────────────
$("enrichOneBtn").addEventListener("click", async () => {
  const step = steps[currentStepIdx];
  if (!step) return;
  const btn = $("enrichOneBtn");
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Enriching…';
  const res = await sw({ type: "SP_ENRICH_STEP", stepId: step.id, sessionId: currentSessionId });
  btn.disabled = false; btn.textContent = "Enrich with AI";
  if (res?.ok) { onStepEnriched(res.step); toast("Step enriched"); }
  else errorToast(formatApiError(res?.error));
});

$("enrichAllBtn").addEventListener("click", async () => {
  const btn = $("enrichAllBtn");
  btn.disabled = true; btn.textContent = "Enriching…";
  const res = await sw({ type: "SP_ENRICH_ALL", sessionId: currentSessionId });
  btn.disabled = false; btn.textContent = "Enrich all steps";
  // Surface the first per-step error if any came back; otherwise success.
  const failed = (res?.steps || []).find(s => s.enrichError);
  if (failed) errorToast(formatApiError(failed.enrichError));
  else toast("All steps enriched");
});

// ── Annotation system ───────────────────────────────────────────────────────
let annoUndoStack = [];

$("toggleAnnoBtn").addEventListener("click", () => {
  annoMode = !annoMode;
  $("annoToolbar").style.display = annoMode ? "" : "none";
  $("toggleAnnoBtn").classList.toggle("active-tool", annoMode);
  annoCanvas.style.cursor = annoMode ? "crosshair" : "default";
  annoCanvas.style.pointerEvents = annoMode ? "auto" : "none";
});

async function deleteStepAt(idx) {
  const step = steps[idx];
  if (!step) return;
  const label = (step.title || `Step ${idx + 1}`).trim();
  if (!confirm(`Delete "${label}"? This cannot be undone.`)) return;
  const res = await sw({ type: "SP_DELETE_STEP", stepId: step.id, sessionId: currentSessionId });
  if (!res?.ok) { errorToast("Could not delete step"); return; }
  steps.splice(idx, 1);
  if (!steps.length) {
    toast("Step deleted — no steps remain");
    showView("v-home");
    loadSessions();
    return;
  }
  if (currentStepIdx >= steps.length) currentStepIdx = steps.length - 1;
  else if (idx < currentStepIdx) currentStepIdx--;
  renderThumbStrip();
  loadStepIntoEditor(currentStepIdx);
  toast("Step deleted");
}

$("deleteStepBtn").addEventListener("click", () => deleteStepAt(currentStepIdx));

$("retakeBtn").addEventListener("click", async () => {
  if (!isRecording) {
    showView("v-home");
    toast("Start recording and re-capture this step, then come back.");
    return;
  }
  // If actively recording, mark step for re-capture
  toast("Perform the action again to re-capture this step.");
});

document.querySelectorAll(".tool-btn[data-tool]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tool-btn[data-tool]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    activeTool = btn.dataset.tool;
  });
});

$("undoBtn").addEventListener("click", undoAnnotation);
$("clearAnnoBtn").addEventListener("click", () => {
  annoUndoStack.push([...annotations]);
  annotations = [];
  renderAnnotations();
  saveCurrentStep();
});

annoCanvas.addEventListener("mousedown", onAnnoMouseDown);
annoCanvas.addEventListener("mousemove", onAnnoMouseMove);
annoCanvas.addEventListener("mouseup",   onAnnoMouseUp);
annoCanvas.addEventListener("click",     onAnnoClick);

function canvasPos(e) {
  const rect = annoCanvas.getBoundingClientRect();
  const scaleX = annoCanvas.width  / rect.width;
  const scaleY = annoCanvas.height / rect.height;
  return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
}

function onAnnoClick(e) {
  if (!annoMode) return;
  const pos = canvasPos(e);
  if (activeTool === "circle") {
    annoUndoStack.push([...annotations]);
    annotations.push({ id: Date.now(), type:"circle", x:pos.x, y:pos.y,
      r:22, color: branding.brandCircleColor, label: String(annotations.filter(a=>a.type==="circle").length+1) });
    renderAnnotations();
    saveCurrentStep();
  }
  // Click to select/deselect existing annotation
  const hit = annotations.find(a => hitTest(a, pos));
  selectedAnnoId = hit ? hit.id : null;
  renderAnnotations();
}

function onAnnoMouseDown(e) {
  if (!annoMode) return;
  const pos = canvasPos(e);
  if (activeTool === "highlight" || activeTool === "arrow") {
    isDragging = true;
    dragStart = pos;
    pendingAnnotation = { id: Date.now(), type: activeTool, x1:pos.x, y1:pos.y, x2:pos.x, y2:pos.y,
      color: activeTool === "highlight" ? branding.brandHighlightColor : branding.brandArrowColor };
  }
}
function onAnnoMouseMove(e) {
  if (!isDragging || !pendingAnnotation) return;
  const pos = canvasPos(e);
  pendingAnnotation.x2 = pos.x; pendingAnnotation.y2 = pos.y;
  renderAnnotations(pendingAnnotation);
}
function onAnnoMouseUp(e) {
  if (!isDragging || !pendingAnnotation) return;
  isDragging = false;
  const dx = Math.abs(pendingAnnotation.x2 - pendingAnnotation.x1);
  const dy = Math.abs(pendingAnnotation.y2 - pendingAnnotation.y1);
  if (dx > 5 || dy > 5) {
    annoUndoStack.push([...annotations]);
    annotations.push({ ...pendingAnnotation });
    saveCurrentStep();
  }
  pendingAnnotation = null;
  renderAnnotations();
}

function undoAnnotation() {
  if (!annoUndoStack.length) return;
  annotations = annoUndoStack.pop();
  renderAnnotations();
  saveCurrentStep();
}

function removeAnnotation(id) {
  annoUndoStack.push([...annotations]);
  annotations = annotations.filter(a => a.id !== id);
  selectedAnnoId = null;
  renderAnnotations();
  saveCurrentStep();
}

function hitTest(a, pos) {
  if (a.type === "circle") {
    const dx = a.x - pos.x, dy = a.y - pos.y;
    return Math.sqrt(dx*dx+dy*dy) <= (a.r+6);
  }
  if (a.type === "highlight" || a.type === "arrow") {
    const minX = Math.min(a.x1,a.x2)-10, maxX = Math.max(a.x1,a.x2)+10;
    const minY = Math.min(a.y1,a.y2)-10, maxY = Math.max(a.y1,a.y2)+10;
    return pos.x>=minX && pos.x<=maxX && pos.y>=minY && pos.y<=maxY;
  }
  return false;
}

function renderAnnotations(preview = null) {
  annoCtx.clearRect(0, 0, annoCanvas.width, annoCanvas.height);
  const all = preview ? [...annotations, preview] : annotations;
  all.forEach(a => drawAnnotation(a, a.id === selectedAnnoId));
}

function colorForAnnotation(a) {
  if (a.type === "circle")    return branding.brandCircleColor    || a.color || BRAND_DEFAULTS.brandCircleColor;
  if (a.type === "arrow")     return branding.brandArrowColor     || a.color || BRAND_DEFAULTS.brandArrowColor;
  if (a.type === "highlight") return branding.brandHighlightColor || a.color || BRAND_DEFAULTS.brandHighlightColor;
  return a.color || BRAND_DEFAULTS.brandCircleColor;
}

function drawAnnotation(a, selected = false) {
  const ctx = annoCtx;
  ctx.save();
  if (selected) { ctx.shadowColor = "#fff"; ctx.shadowBlur = 6; }
  const color = colorForAnnotation(a);

  if (a.type === "circle") {
    // Outer glow
    ctx.beginPath();
    ctx.arc(a.x, a.y, a.r + 8, 0, Math.PI*2);
    ctx.fillStyle = color + "22";
    ctx.fill();
    // Circle
    ctx.beginPath();
    ctx.arc(a.x, a.y, a.r, 0, Math.PI*2);
    ctx.fillStyle = color + "cc";
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2.5;
    ctx.stroke();
    // Label
    ctx.fillStyle = "#fff";
    ctx.font = `bold ${Math.round(a.r * 0.85)}px Syne, system-ui`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(a.label || "", a.x, a.y + 1);
  }

  if (a.type === "highlight") {
    const x = Math.min(a.x1,a.x2), y = Math.min(a.y1,a.y2);
    const w = Math.abs(a.x2-a.x1), h = Math.abs(a.y2-a.y1);
    ctx.fillStyle = color + "33";
    ctx.fillRect(x,y,w,h);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(x,y,w,h);
  }

  if (a.type === "arrow") {
    const dx = a.x2-a.x1, dy = a.y2-a.y1;
    const len = Math.sqrt(dx*dx+dy*dy);
    if (len < 2) { ctx.restore(); return; }
    const angle = Math.atan2(dy, dx);
    const headLen = 14;
    ctx.strokeStyle = color;
    ctx.fillStyle   = color;
    ctx.lineWidth   = 2.5;
    ctx.lineCap     = "round";
    ctx.beginPath();
    ctx.moveTo(a.x1,a.y1);
    ctx.lineTo(a.x2,a.y2);
    ctx.stroke();
    // Arrowhead
    ctx.beginPath();
    ctx.moveTo(a.x2, a.y2);
    ctx.lineTo(a.x2 - headLen*Math.cos(angle-0.4), a.y2 - headLen*Math.sin(angle-0.4));
    ctx.lineTo(a.x2 - headLen*Math.cos(angle+0.4), a.y2 - headLen*Math.sin(angle+0.4));
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

// ── Video ───────────────────────────────────────────────────────────────────
$("generateVideoBtn").addEventListener("click", async () => {
  const btn = $("generateVideoBtn");
  if (!steps.length) { toast("No steps to render"); return; }

  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> Rendering…';
  $("progBar").style.display = "";

  // Hydrate steps with screenshot data
  const hydratedSteps = await Promise.all(
    steps.map(async s => {
      const full = await sw({ type: "SP_GET_STEP_FULL", stepId: s.id });
      return full?.step || s;
    })
  );

  try {
    const result = await synthesizeVideo(hydratedSteps, {}, (p) => {
      $("progFill").style.width = Math.round(p*100) + "%";
    });
    videoBlob = result.blob;
    if (videoObjectUrl) URL.revokeObjectURL(videoObjectUrl);
    videoObjectUrl = result.objectUrl;
    $("videoEl").src = videoObjectUrl;
    $("videoEl").style.display = "";
    $("videoPlaceholder").style.display = "none";
    $("downloadVideoBtn").style.display = "";
    toast("Video ready");
  } catch(err) {
    toast("Video error: " + err.message);
  }
  btn.disabled = false;
  btn.textContent = "Re-generate";
  $("progBar").style.display = "none";
});

$("downloadVideoBtn").addEventListener("click", () => {
  if (!videoObjectUrl) return;
  const a = document.createElement("a");
  a.href = videoObjectUrl;
  a.download = slugify(sessionName.value || "guide") + ".webm";
  a.click();
});

// Full voiceover script
$("genScriptBtn").addEventListener("click", async () => {
  const btn = $("genScriptBtn");
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Writing…';
  const res = await sw({ type: "SP_GEN_SCRIPT", sessionId: currentSessionId });
  btn.disabled = false; btn.textContent = "Generate script";
  if (res?.ok) { $("fullScript").value = res.script; autoResize($("fullScript")); }
  else errorToast(formatApiError(res?.error));
});

$("copyScriptBtn").addEventListener("click", () => {
  navigator.clipboard.writeText($("fullScript").value).then(() => toast("Copied"));
});

// ── Export ─────────────────────────────────────────────────────────────────
exportBtn.addEventListener("click", async () => {
  if (!currentSessionId) return;
  exportBtn.textContent = "…";
  exportBtn.disabled = true;
  const res = await sw({ type: "SP_EXPORT", sessionId: currentSessionId, format: exportFmt.value });
  exportBtn.textContent = "Export";
  exportBtn.disabled = false;
  if (!res?.ok) { errorToast("Export failed: " + formatApiError(res?.error)); return; }
  const blob = new Blob([res.content], { type: res.mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = res.filename; a.click();
  URL.revokeObjectURL(url);
  toast("Downloaded " + res.filename);
});

// ── Screenshot loader (requests blob from SW) ──────────────────────────────
async function loadStepScreenshot(stepId, which) {
  const res = await sw({ type: "SP_GET_SCREENSHOT", stepId, which });
  return res?.dataUrl || null;
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

// Parse common LLM / API error strings into a short, actionable message.
function formatApiError(raw) {
  if (!raw) return "Something went wrong. Check the service worker console.";
  const s = String(raw);

  // Provider quota / rate-limit — surface the actual provider message and
  // the retry-after window so the user can verify it's still rate-limited
  // (rather than us showing a stale-looking generic toast).
  if (/\b429\b|quota|rate.?limit|resource_exhausted/i.test(s)) {
    const retryMatch = s.match(/retry after (\d+(?:\.\d+)?)s/i);
    const waitHint = retryMatch
      ? ` Try again in ~${Math.ceil(Number(retryMatch[1]))}s.`
      : " Wait a moment and retry, or switch model in Settings.";
    // Strip our own "Provider 429:" prefix and the trailing "(retry after …)" we appended.
    const apiMsg = s
      .replace(/^\w+\s+\d{3}:\s*/, "")
      .replace(/\s*\(retry after [^)]+\)\s*$/i, "")
      .trim();
    const detail = apiMsg.length > 140 ? apiMsg.slice(0, 137) + "…" : apiMsg;
    return `Rate limit: ${detail}.${waitHint}`;
  }
  // Billing / payment
  if (/insufficient|billing|payment.?required|\b402\b/i.test(s)) {
    return "Account has no credits. Top up at your provider's billing page, then retry.";
  }
  // Auth
  if (/\b401\b|unauthorized|invalid.?api.?key|api.?key.?not.?valid/i.test(s)) {
    return "API key was rejected. Re-check it in Settings under Provider.";
  }
  // Model not found
  if (/\b404\b|model.*not.?(found|exist)|no.?such.?model/i.test(s)) {
    return "Selected model isn't available for your key. Pick a different one in Settings.";
  }
  // Permission / blocked content
  if (/\b403\b|permission|forbidden|safety|blocked/i.test(s)) {
    return "Provider refused the request (permission or safety filter). Try a different model.";
  }
  // Default: trim long error to one line
  return s.length > 180 ? s.slice(0, 177) + "…" : s;
}
