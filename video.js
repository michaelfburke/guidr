/**
 * video.js — Guidr Video Synthesis
 *
 * Runs in the side-panel context (has DOM + Canvas + MediaRecorder access).
 *
 * Algorithm:
 *  1. For each step, show the "after" screenshot for `holdMs` ms
 *  2. Before transitioning, animate a "cursor" dot from the previous
 *     click position to the current one over `cursorMs` ms
 *  3. Draw a step-number badge in the top-left corner
 *  4. Capture the canvas stream with MediaRecorder → WebM blob
 *  5. Return an object URL the caller can assign to a <video> src or download
 *
 * Constraints:
 *  - No external dependencies
 *  - Runs entirely in the browser; no server required
 *  - MediaRecorder outputs VP8/VP9 WebM (supported in Chrome)
 */

const CANVAS_WIDTH  = 1280;
const CANVAS_HEIGHT = 720;
const FPS           = 30;
const FRAME_MS      = 1000 / FPS;

const DEFAULTS = {
  // Per-step phase timings. The sequence is:
  //   travel → click-hold (on BEFORE) → reveal crossfade → settle (on AFTER) → inter-step
  // This ordering ensures the click ripple plays on the pre-click screenshot,
  // and the screen change only happens AFTER the click is shown.
  cursorMs:        1000,    // cursor travel animation duration
  clickHoldMs:      700,    // dwell on click point before the screen reveals
  revealMs:         550,    // crossfade BEFORE → AFTER (the click's result)
  settleMs:        2000,    // dwell on AFTER so viewers can read the result
  interStepMs:      450,    // crossfade between this step's AFTER and next step's BEFORE
  showBadge:        true,   // step-number badge
  badgeColor:       "#6366f1",
  cursorColor:      "#ef4444",
  cursorRadius:     14,
  videoBitrate:     4_000_000, // 4 Mbps
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * @param {Array}  steps    - DB step objects with screenshotAfter/Before
 * @param {object} options  - override DEFAULTS
 * @param {function} onProgress - called with 0–1 progress
 * @returns {Promise<{objectUrl: string, blob: Blob}>}
 */
export async function synthesizeVideo(steps, options = {}, onProgress = () => {}) {
  const cfg = { ...DEFAULTS, ...options };

  // Build per-step image bitmaps
  const frames = await loadFrames(steps, onProgress);
  if (!frames.length) throw new Error("No frames to render");

  // Set up canvas
  const canvas = document.createElement("canvas");
  canvas.width  = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  const ctx = canvas.getContext("2d");

  // Set up MediaRecorder
  const stream = canvas.captureStream(FPS);
  const mimeType = getSupportedMimeType();
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: cfg.videoBitrate,
  });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

  recorder.start();

  await renderTimeline(ctx, frames, cfg, onProgress);

  recorder.stop();
  await new Promise((res) => (recorder.onstop = res));

  const blob = new Blob(chunks, { type: mimeType });
  return { objectUrl: URL.createObjectURL(blob), blob };
}

// ─── Frame loading ────────────────────────────────────────────────────────────

async function loadFrames(steps, onProgress) {
  const out = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const beforeSrc = step.screenshotBefore || step.screenshotAfter;
    const afterSrc  = step.screenshotAfter  || step.screenshotBefore;
    if (!beforeSrc) continue;
    try {
      const before = await loadImage(beforeSrc);
      // Reuse the bitmap if before/after point at the same data URL, or if
      // loading the after frame fails — keeps the step renderable either way.
      const after = afterSrc === beforeSrc
        ? before
        : await loadImage(afterSrc).catch(() => before);
      out.push({
        index: i,
        before,
        after,
        // Click coords are normalized against the BEFORE bitmap's viewport,
        // since that's the state the user was looking at when they clicked.
        ...clickPoint(step, before),
        title: step.title || `Step ${i + 1}`,
      });
    } catch { /* skip unloadable */ }
    onProgress(0.1 * (i / steps.length));
  }
  return out;
}

// Returns {clickX, clickY} normalized 0–1 inside the screenshot bitmap.
// Prefers the pre-normalized point from content_script (correct on HiDPI).
// Falls back to rect/img-dim math for old sessions captured before that
// field existed — this is only accurate when devicePixelRatio is 1.
function clickPoint(step, img) {
  const t = step.target;
  if (t?.click && typeof t.click.x === "number") {
    return { clickX: t.click.x, clickY: t.click.y };
  }
  if (t?.rect && t.viewport) {
    return {
      clickX: (t.rect.x + t.rect.width  / 2) / t.viewport.width,
      clickY: (t.rect.y + t.rect.height / 2) / t.viewport.height,
    };
  }
  if (t?.rect) {
    const iw = img.naturalWidth  || CANVAS_WIDTH;
    const ih = img.naturalHeight || CANVAS_HEIGHT;
    return {
      clickX: (t.rect.x + t.rect.width  / 2) / iw,
      clickY: (t.rect.y + t.rect.height / 2) / ih,
    };
  }
  return { clickX: 0.5, clickY: 0.5 };
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// ─── Timeline renderer ────────────────────────────────────────────────────────

async function renderTimeline(ctx, frames, cfg, onProgress) {
  const fCursor    = msToFrames(cfg.cursorMs);
  const fClickHold = msToFrames(cfg.clickHoldMs);
  const fReveal    = msToFrames(cfg.revealMs);
  const fSettle    = msToFrames(cfg.settleMs);
  const fInter     = msToFrames(cfg.interStepMs);
  const perStep    = fCursor + fClickHold + fReveal + fSettle;
  const totalFrames = frames.length * perStep + Math.max(0, frames.length - 1) * fInter;
  let rendered = 0;
  const tick = () => { rendered++; onProgress(0.1 + 0.85 * (rendered / totalFrames)); };

  // Cursor position is stored in image-normalized coordinates (0–1) and mapped
  // through each frame's letterbox transform at draw time.
  let cursorX = 0.5;
  let cursorY = 0.5;

  for (let fi = 0; fi < frames.length; fi++) {
    const frame = frames[fi];
    const nextFrame = frames[fi + 1] || null;

    // — Phase 1: cursor travels on the BEFORE screenshot (pre-click state) —
    for (let t = 0; t <= fCursor; t++) {
      const p = easeInOut(t / fCursor);
      const nx = lerp(cursorX, frame.clickX, p);
      const ny = lerp(cursorY, frame.clickY, p);
      clearCanvas(ctx);
      const tr = drawScreenshot(ctx, frame.before);
      drawCursor(ctx, tr.dx + nx * tr.dw, tr.dy + ny * tr.dh, cfg);
      if (cfg.showBadge) drawBadge(ctx, fi + 1, frame.title);
      await nextFrame_(); tick();
    }
    cursorX = frame.clickX;
    cursorY = frame.clickY;

    // — Phase 2: click ripple + dwell, still on BEFORE so the click reads —
    for (let t = 0; t < fClickHold; t++) {
      clearCanvas(ctx);
      const tr = drawScreenshot(ctx, frame.before);
      const cx = tr.dx + cursorX * tr.dw;
      const cy = tr.dy + cursorY * tr.dh;
      drawCursor(ctx, cx, cy, cfg);
      if (t < FPS * 0.5) drawRipple(ctx, cx, cy, t, cfg);
      if (cfg.showBadge) drawBadge(ctx, fi + 1, frame.title);
      await nextFrame_(); tick();
    }

    // — Phase 3: reveal — crossfade BEFORE → AFTER. Cursor stays at click. —
    for (let t = 0; t < fReveal; t++) {
      const alpha = (t + 1) / fReveal;
      clearCanvas(ctx);
      const trB = drawScreenshot(ctx, frame.before);
      ctx.globalAlpha = alpha;
      const trA = drawScreenshot(ctx, frame.after);
      ctx.globalAlpha = 1;
      const lb = alpha >= 0.5 ? trA : trB;
      drawCursor(ctx, lb.dx + cursorX * lb.dw, lb.dy + cursorY * lb.dh, cfg);
      if (cfg.showBadge) drawBadge(ctx, fi + 1, frame.title);
      await nextFrame_(); tick();
    }

    // — Phase 4: settle on AFTER so the viewer reads the result —
    for (let t = 0; t < fSettle; t++) {
      clearCanvas(ctx);
      const tr = drawScreenshot(ctx, frame.after);
      drawCursor(ctx, tr.dx + cursorX * tr.dw, tr.dy + cursorY * tr.dh, cfg);
      if (cfg.showBadge) drawBadge(ctx, fi + 1, frame.title);
      await nextFrame_(); tick();
    }

    // — Phase 5: inter-step — crossfade this step's AFTER → next step's BEFORE.
    // Usually these are nearly identical (same viewport state); the crossfade
    // smooths over any minor differences (e.g. fresh DOM after navigation).
    if (nextFrame) {
      for (let t = 0; t < fInter; t++) {
        const alpha = (t + 1) / fInter;
        clearCanvas(ctx);
        const trA = drawScreenshot(ctx, frame.after);
        ctx.globalAlpha = alpha;
        const trN = drawScreenshot(ctx, nextFrame.before);
        ctx.globalAlpha = 1;
        const useNext = alpha >= 0.5;
        const lb = useNext ? trN : trA;
        drawCursor(ctx, lb.dx + cursorX * lb.dw, lb.dy + cursorY * lb.dh, cfg);
        if (cfg.showBadge) {
          drawBadge(ctx, useNext ? fi + 2 : fi + 1, useNext ? nextFrame.title : frame.title);
        }
        await nextFrame_(); tick();
      }
    }
  }
}

// ─── Drawing helpers ──────────────────────────────────────────────────────────

function clearCanvas(ctx) {
  ctx.fillStyle = "#0d0d12";
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
}

function drawScreenshot(ctx, img) {
  // Letterbox into canvas. Returns the destination rect so callers can map
  // image-normalized coordinates (e.g. the cursor's click point) into canvas
  // pixels without double-counting the letterbox margins. The caller is
  // responsible for clearing the canvas first — that way a crossfade can
  // draw two screenshots in sequence without the second one repainting
  // the background over the first at reduced alpha.
  const cw = CANVAS_WIDTH, ch = CANVAS_HEIGHT;
  const iw = img.naturalWidth  || img.width;
  const ih = img.naturalHeight || img.height;
  const scale = Math.min(cw / iw, ch / ih);
  const dw = iw * scale, dh = ih * scale;
  const dx = (cw - dw) / 2,  dy = (ch - dh) / 2;

  ctx.drawImage(img, dx, dy, dw, dh);
  return { dx, dy, dw, dh };
}

function drawCursor(ctx, cx, cy, cfg) {
  // Outer halo — drawn at a constant low alpha so the cursor doesn't flicker
  // dim→bright→dim as it transitions between motion phases.
  ctx.beginPath();
  ctx.arc(cx, cy, cfg.cursorRadius * 1.8, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(239,68,68,0.18)";
  ctx.fill();

  // Inner dot
  ctx.beginPath();
  ctx.arc(cx, cy, cfg.cursorRadius * 0.55, 0, Math.PI * 2);
  ctx.fillStyle = cfg.cursorColor;
  ctx.fill();

  // Border
  ctx.beginPath();
  ctx.arc(cx, cy, cfg.cursorRadius, 0, Math.PI * 2);
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, cfg.cursorRadius, 0, Math.PI * 2);
  ctx.strokeStyle = cfg.cursorColor;
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawRipple(ctx, cx, cy, frame, cfg) {
  const progress = Math.min(frame / (FPS * 0.4), 1);
  const radius = cfg.cursorRadius * (1 + progress * 3);
  const alpha = (1 - progress) * 0.5;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(239,68,68,${alpha})`;
  ctx.lineWidth = 2;
  ctx.stroke();
}

function drawBadge(ctx, num, title) {
  const pad = 10, h = 32, r = 8;
  const label = `${num}  ${title.slice(0, 38)}${title.length > 38 ? "…" : ""}`;

  ctx.font = "bold 13px system-ui";
  const tw = ctx.measureText(label).width;
  const w = tw + pad * 2 + 28;
  const x = 20, y = 20;

  // Pill background
  roundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = "rgba(10,10,18,0.78)";
  ctx.fill();
  ctx.strokeStyle = "rgba(99,102,241,0.5)";
  ctx.lineWidth = 1;
  ctx.stroke();

  // Number chip
  roundRect(ctx, x + 5, y + 5, 22, 22, 5);
  ctx.fillStyle = "#6366f1";
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.font = "bold 12px system-ui";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(num), x + 16, y + 16);

  // Title text
  ctx.fillStyle = "#e8e8f0";
  ctx.font = "13px system-ui";
  ctx.textAlign = "left";
  ctx.fillText(title.slice(0, 38) + (title.length > 38 ? "…" : ""), x + 32, y + 16);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function msToFrames(ms) { return Math.max(1, Math.round((ms / 1000) * FPS)); }
function lerp(a, b, t)  { return a + (b - a) * t; }
function easeInOut(t)   { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

function getSupportedMimeType() {
  const types = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  return types.find((t) => MediaRecorder.isTypeSupported(t)) || "video/webm";
}

// Yield to browser every frame so MediaRecorder has time to process
function nextFrame_() {
  return new Promise((res) => requestAnimationFrame(res));
}
