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
  holdMs:           2200,   // how long each screenshot is visible
  cursorMs:         600,    // cursor travel animation duration
  transitionMs:     300,   // crossfade between screenshots
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
    const src = step.screenshotAfter || step.screenshotBefore;
    if (!src) continue;
    try {
      const img = await loadImage(src);
      out.push({
        index: i,
        bitmap: img,
        clickX: step.target?.rect ? (step.target.rect.x + step.target.rect.width  / 2) / (img.naturalWidth  || CANVAS_WIDTH)  : 0.5,
        clickY: step.target?.rect ? (step.target.rect.y + step.target.rect.height / 2) / (img.naturalHeight || CANVAS_HEIGHT) : 0.5,
        title: step.title || `Step ${i + 1}`,
      });
    } catch { /* skip unloadable */ }
    onProgress(0.1 * (i / steps.length));
  }
  return out;
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
  const totalFrames = frames.length * (
    msToFrames(cfg.cursorMs) + msToFrames(cfg.holdMs) + msToFrames(cfg.transitionMs)
  );
  let rendered = 0;

  // Start position: centre of canvas
  let cursorX = 0.5;
  let cursorY = 0.5;

  for (let fi = 0; fi < frames.length; fi++) {
    const frame = frames[fi];
    const nextFrame = frames[fi + 1] || null;
    const targetX = frame.clickX;
    const targetY = frame.clickY;

    // — Phase 1: animate cursor travel to click point —
    const cursorFrames = msToFrames(cfg.cursorMs);
    for (let t = 0; t <= cursorFrames; t++) {
      const p = easeInOut(t / cursorFrames);
      const cx = lerp(cursorX, targetX, p) * CANVAS_WIDTH;
      const cy = lerp(cursorY, targetY, p) * CANVAS_HEIGHT;
      drawScreenshot(ctx, frame.bitmap);
      drawCursor(ctx, cx, cy, cfg, t / cursorFrames);
      if (cfg.showBadge) drawBadge(ctx, fi + 1, frame.title);
      await nextFrame_(); rendered++;
      onProgress(0.1 + 0.85 * (rendered / totalFrames));
    }
    cursorX = targetX;
    cursorY = targetY;

    // — Phase 2: click ripple + hold —
    const holdFrames = msToFrames(cfg.holdMs);
    for (let t = 0; t < holdFrames; t++) {
      drawScreenshot(ctx, frame.bitmap);
      drawCursor(ctx, cursorX * CANVAS_WIDTH, cursorY * CANVAS_HEIGHT, cfg, 1);
      if (t < FPS * 0.4) drawRipple(ctx, cursorX * CANVAS_WIDTH, cursorY * CANVAS_HEIGHT, t, cfg);
      if (cfg.showBadge) drawBadge(ctx, fi + 1, frame.title);
      await nextFrame_(); rendered++;
      onProgress(0.1 + 0.85 * (rendered / totalFrames));
    }

    // — Phase 3: crossfade to next frame —
    if (nextFrame) {
      const transFrames = msToFrames(cfg.transitionMs);
      for (let t = 0; t < transFrames; t++) {
        const alpha = t / transFrames;
        drawScreenshot(ctx, frame.bitmap);
        ctx.globalAlpha = alpha;
        drawScreenshot(ctx, nextFrame.bitmap);
        ctx.globalAlpha = 1;
        await nextFrame_(); rendered++;
      }
    }
  }
}

// ─── Drawing helpers ──────────────────────────────────────────────────────────

function drawScreenshot(ctx, img) {
  // Letterbox into canvas
  const cw = CANVAS_WIDTH, ch = CANVAS_HEIGHT;
  const iw = img.naturalWidth  || img.width;
  const ih = img.naturalHeight || img.height;
  const scale = Math.min(cw / iw, ch / ih);
  const dw = iw * scale, dh = ih * scale;
  const dx = (cw - dw) / 2,  dy = (ch - dh) / 2;

  ctx.fillStyle = "#0d0d12";
  ctx.fillRect(0, 0, cw, ch);
  ctx.drawImage(img, dx, dy, dw, dh);
}

function drawCursor(ctx, cx, cy, cfg, progress) {
  // Outer ring (fades in)
  ctx.beginPath();
  ctx.arc(cx, cy, cfg.cursorRadius * 1.8, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(239,68,68,${0.12 * progress})`;
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
