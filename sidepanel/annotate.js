/**
 * annotate.js
 * Drawing primitives + interactive editor for step annotations.
 *
 * Annotation shape (stored in step.annotations[]):
 *   { id, kind: "circle",    xPct, yPct, number }
 *   { id, kind: "arrow",     x1Pct, y1Pct, x2Pct, y2Pct }
 *   { id, kind: "highlight", xPct, yPct, wPct, hPct }
 *   { id, kind: "mask",      xPct, yPct, wPct, hPct }
 *
 * All coords are 0-1 fractions of the frame's natural width/height so
 * annotations survive any rescale. Rendering converts to pixel coords
 * at draw time.
 */

const DEFAULTS = {
  brandCircleColor:    "#7c6af7",
  brandArrowColor:     "#f87171",
  brandHighlightColor: "#fbbf24",
};

// ── Drawing primitives ─────────────────────────────────────────────────────

function drawCircle(ctx, a, w, h, brand) {
  const x = a.xPct * w;
  const y = a.yPct * h;
  const radius = Math.max(18, Math.min(w, h) * 0.035);
  const color = brand.brandCircleColor;

  // Outer halo
  ctx.beginPath();
  ctx.arc(x, y, radius + 6, 0, Math.PI * 2);
  ctx.fillStyle = color + "33";
  ctx.fill();

  // Solid disc
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // Number label
  ctx.fillStyle = "#fff";
  ctx.font = `bold ${Math.round(radius * 1.05)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(a.number || 1), x, y + 1);
}

function drawArrow(ctx, a, w, h, brand) {
  const x1 = a.x1Pct * w, y1 = a.y1Pct * h;
  const x2 = a.x2Pct * w, y2 = a.y2Pct * h;
  const color = brand.brandArrowColor;
  const thickness = Math.max(3, Math.min(w, h) * 0.005);

  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = thickness;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  // Arrow head
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const headLen = Math.max(14, thickness * 4);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - headLen * Math.cos(angle - 0.45), y2 - headLen * Math.sin(angle - 0.45));
  ctx.lineTo(x2 - headLen * Math.cos(angle + 0.45), y2 - headLen * Math.sin(angle + 0.45));
  ctx.closePath();
  ctx.fill();
}

function drawHighlight(ctx, a, w, h, brand) {
  const x = a.xPct * w, y = a.yPct * h;
  const bw = a.wPct * w, bh = a.hPct * h;
  const color = brand.brandHighlightColor;

  ctx.fillStyle = color + "33";
  ctx.fillRect(x, y, bw, bh);
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(2, Math.min(w, h) * 0.004);
  ctx.strokeRect(x, y, bw, bh);
}

function drawMask(ctx, a, w, h) {
  // Pixelate by drawing a 1/12 scale into a tiny offscreen canvas then
  // re-drawing it without smoothing. Fast and bulletproof.
  const x = Math.round(a.xPct * w);
  const y = Math.round(a.yPct * h);
  const bw = Math.round(a.wPct * w);
  const bh = Math.round(a.hPct * h);
  if (bw < 4 || bh < 4) return;

  const SCALE = 12;
  const tw = Math.max(2, Math.round(bw / SCALE));
  const th = Math.max(2, Math.round(bh / SCALE));
  const off = document.createElement("canvas");
  off.width = tw; off.height = th;
  const offCtx = off.getContext("2d");
  offCtx.imageSmoothingEnabled = false;
  offCtx.drawImage(ctx.canvas, x, y, bw, bh, 0, 0, tw, th);

  const prevSmoothing = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, 0, 0, tw, th, x, y, bw, bh);
  ctx.imageSmoothingEnabled = prevSmoothing;
}

export function drawAnnotation(ctx, a, w, h, brand) {
  switch (a.kind) {
    case "circle":    return drawCircle(ctx, a, w, h, brand);
    case "arrow":     return drawArrow(ctx, a, w, h, brand);
    case "highlight": return drawHighlight(ctx, a, w, h, brand);
    case "mask":      return drawMask(ctx, a, w, h);
  }
}

// ── Bake annotations into a frame for export ───────────────────────────────

export async function renderAnnotated(frameDataUrl, annotations, brand = DEFAULTS) {
  if (!frameDataUrl) return null;
  if (!annotations || !annotations.length) return frameDataUrl;

  const img = await loadImage(frameDataUrl);
  const w = img.naturalWidth, h = img.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, w, h);

  // Mask first (operates on pixels below), then everything else on top.
  for (const a of annotations.filter((x) => x.kind === "mask")) {
    drawAnnotation(ctx, a, w, h, brand);
  }
  for (const a of annotations.filter((x) => x.kind !== "mask")) {
    drawAnnotation(ctx, a, w, h, brand);
  }
  return canvas.toDataURL("image/jpeg", 0.9);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// ── Interactive editor ─────────────────────────────────────────────────────

export function createAnnotator({ canvas, getFrame, getBrand, getAnnotations, onChange }) {
  let activeTool = null;
  let dragStart = null;
  let dragCurrent = null;
  let cachedImage = null;
  let cachedFrameUrl = null;

  const ctx = canvas.getContext("2d");

  function setTool(tool) {
    activeTool = tool;
    canvas.style.cursor = tool ? "crosshair" : "default";
  }

  async function ensureImage() {
    const url = getFrame();
    if (!url) { cachedImage = null; return null; }
    if (cachedFrameUrl === url && cachedImage) return cachedImage;
    cachedFrameUrl = url;
    cachedImage = await loadImage(url);
    return cachedImage;
  }

  async function redraw() {
    const img = await ensureImage();
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (img) ctx.drawImage(img, 0, 0, w, h);

    const annotations = getAnnotations() || [];
    const brand = getBrand();
    // Mask first
    for (const a of annotations.filter((x) => x.kind === "mask")) {
      drawAnnotation(ctx, a, w, h, brand);
    }
    for (const a of annotations.filter((x) => x.kind !== "mask")) {
      drawAnnotation(ctx, a, w, h, brand);
    }

    // Live preview during drag
    if (dragStart && dragCurrent && activeTool) {
      const preview = buildAnnotationFromDrag(activeTool, dragStart, dragCurrent, annotations);
      if (preview) drawAnnotation(ctx, preview, w, h, brand);
    }
  }

  function pointToPct(e) {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    return { x: clamp01(x), y: clamp01(y) };
  }

  function onDown(e) {
    if (!activeTool) return;
    e.preventDefault();
    dragStart = pointToPct(e);
    dragCurrent = dragStart;
    redraw();
  }

  function onMove(e) {
    if (!dragStart) return;
    dragCurrent = pointToPct(e);
    redraw();
  }

  function onUp(e) {
    if (!dragStart) return;
    dragCurrent = pointToPct(e);
    const annotations = getAnnotations() || [];
    const created = buildAnnotationFromDrag(activeTool, dragStart, dragCurrent, annotations, /*commit*/ true);
    dragStart = dragCurrent = null;
    if (created) {
      onChange([...annotations, created]);
    } else {
      redraw();
    }
  }

  canvas.addEventListener("mousedown", onDown);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);

  function destroy() {
    canvas.removeEventListener("mousedown", onDown);
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  }

  return { setTool, redraw, destroy };
}

function buildAnnotationFromDrag(tool, start, end, existing, commit = false) {
  const id = `ann_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  if (tool === "circle") {
    // Click-to-place: ignore drag distance, anchor at end point.
    const nextNumber = (existing.filter((a) => a.kind === "circle").length) + 1;
    return { id, kind: "circle", xPct: end.x, yPct: end.y, number: nextNumber };
  }
  if (tool === "arrow") {
    const dx = end.x - start.x, dy = end.y - start.y;
    if (commit && Math.hypot(dx, dy) < 0.01) return null;
    return { id, kind: "arrow", x1Pct: start.x, y1Pct: start.y, x2Pct: end.x, y2Pct: end.y };
  }
  if (tool === "highlight" || tool === "mask") {
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const w = Math.abs(end.x - start.x);
    const h = Math.abs(end.y - start.y);
    if (commit && (w < 0.005 || h < 0.005)) return null;
    return { id, kind: tool, xPct: x, yPct: y, wPct: w, hPct: h };
  }
  return null;
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }
