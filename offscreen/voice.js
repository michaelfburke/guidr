// Offscreen mic-capture host.
//
// Chrome side panels cannot show the mic permission prompt — getUserMedia
// rejects with NotAllowedError before any prompt UI appears. Offscreen
// documents with `reason: USER_MEDIA` are the Chrome-official MV3 way to
// access user media: the prompt anchors to the focused tab's URL bar and
// the document inherits the extension origin's activation context.
//
// Lifecycle:
//   OFF_VOICE_PREPARE → getUserMedia(audio) — fires the mic prompt early so
//                       the user grants while the click activation is fresh.
//   OFF_VOICE_START   → start MediaRecorder on the held stream.
//   OFF_VOICE_STOP    → stop recorder, write blob to IDB via db.js.
//   OFF_VOICE_CANCEL  → tear down stream + recorder without saving.

import { db } from "../db.js";

let mediaRecorder = null;
let mediaStream = null;
let chunks = [];
let mimeType = "";
let activeSessionId = null;
let startedAt = 0;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen-voice") return false;
  if (msg.type === "OFF_VOICE_PREPARE") {
    prepare().then(sendResponse);
    return true;
  }
  if (msg.type === "OFF_VOICE_START") {
    start(msg.sessionId, msg.startedAt).then(sendResponse);
    return true;
  }
  if (msg.type === "OFF_VOICE_STOP") {
    stop().then(sendResponse);
    return true;
  }
  if (msg.type === "OFF_VOICE_CANCEL") {
    cancel().then(sendResponse);
    return true;
  }
  return false;
});

async function prepare() {
  if (mediaStream) return { ok: true, alreadyPrepared: true };
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    console.log("[Guidr/offscreen] mic stream acquired");
    return { ok: true };
  } catch (err) {
    const name = err?.name || "UnknownError";
    const message = err?.message || String(err);
    console.warn(`[Guidr/offscreen] prepare failed: ${name} — ${message}`);
    return { ok: false, error: name, message };
  }
}

async function start(sessionId, anchorTs) {
  if (!mediaStream) {
    const p = await prepare();
    if (!p.ok) return p;
  }
  try {
    mimeType = pickMime();
    chunks = [];
    activeSessionId = sessionId;
    startedAt = anchorTs || Date.now();
    mediaRecorder = new MediaRecorder(mediaStream, {
      mimeType,
      audioBitsPerSecond: 96_000,
    });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    mediaRecorder.start(1000);
    return { ok: true };
  } catch (err) {
    console.warn(`[Guidr/offscreen] start failed: ${err?.name} — ${err?.message}`);
    return { ok: false, error: "recorder-failed", message: err?.message };
  }
}

async function stop() {
  if (!mediaRecorder) return { ok: false, error: "not-recording" };
  const rec = mediaRecorder;
  mediaRecorder = null;
  try {
    await new Promise((resolve) => {
      if (rec.state === "inactive") return resolve();
      rec.addEventListener("stop", () => resolve(), { once: true });
      rec.stop();
    });
  } catch (err) {
    console.warn("[Guidr/offscreen] recorder stop failed:", err);
  }
  if (mediaStream) {
    try { mediaStream.getTracks().forEach((t) => t.stop()); } catch {}
    mediaStream = null;
  }
  const blob = new Blob(chunks, { type: mimeType });
  const durationMs = Date.now() - startedAt;
  chunks = [];
  const sid = activeSessionId;
  activeSessionId = null;

  if (sid && blob.size > 0) {
    try {
      await db.saveVoiceRecording({ sessionId: sid, blob, mimeType, durationMs });
    } catch (err) {
      console.error("[Guidr/offscreen] saveVoiceRecording failed:", err);
      return { ok: false, error: "save-failed", message: err?.message };
    }
  }
  return { ok: true, byteSize: blob.size, durationMs };
}

async function cancel() {
  if (mediaRecorder) {
    try { mediaRecorder.stop(); } catch {}
    mediaRecorder = null;
  }
  if (mediaStream) {
    try { mediaStream.getTracks().forEach((t) => t.stop()); } catch {}
    mediaStream = null;
  }
  chunks = [];
  activeSessionId = null;
  return { ok: true };
}

function pickMime() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return "audio/webm";
}
