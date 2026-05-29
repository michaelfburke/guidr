/**
 * service_worker.js
 * MV3 background service worker. Responsibilities:
 *  - Open the side panel on extension icon click
 *  - Track the active recording session (chapter markers, target tab)
 *  - Inject the content script for chapter-marker collection
 *  - Persist sessions/steps to IndexedDB via db.js
 *  - Drive LLM enrichment calls
 *
 * The actual video recording (MediaRecorder + getUserMedia) lives in the
 * side panel itself, not here and not in an offscreen document, because
 * desktopCapture streamIds are bound to the renderer that called
 * chrome.desktopCapture.chooseDesktopMedia. The side panel is the only
 * context where the streamId can be consumed.
 */

import { db } from "./db.js";
import { enrichStep, generateFullScript } from "./llm.js";

// ─── Side panel ──────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
});

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});

// ─── Message router ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handlers = {
    SP_START_RECORDING:    () => handleStartRecording(msg, sendResponse),
    SP_STOP_RECORDING:     () => handleStopRecording(sendResponse),
    GUIDR_CHAPTER_MARKER:  () => handleChapterMarker(msg, sender, sendResponse),
    SP_ENRICH_STEP:        () => handleEnrichStep(msg, sendResponse),
    SP_GET_SESSIONS:       () => handleGetSessions(sendResponse),
    SP_GET_SESSION:        () => handleGetSession(msg, sendResponse),
    SP_DELETE_STEP:        () => handleDeleteStep(msg, sendResponse),
    SP_DELETE_SESSION:     () => handleDeleteSession(msg, sendResponse),
    SP_REORDER_STEPS:      () => handleReorderSteps(msg, sendResponse),
    SP_UPDATE_STEP:        () => handleUpdateStep(msg, sendResponse),
    SP_UPDATE_SESSION:     () => handleUpdateSession(msg, sendResponse),
    SP_GET_RECORDING:      () => handleGetRecording(msg, sendResponse),
    SP_DELETE_RECORDING:   () => handleDeleteRecording(msg, sendResponse),
    SP_DELETE_VOICE:       () => handleDeleteVoice(msg, sendResponse),
    SP_VOICE_PREPARE:      () => handleVoicePrepare(sendResponse),
    SP_VOICE_START:        () => handleVoiceStart(msg, sendResponse),
    SP_VOICE_STOP:         () => handleVoiceStop(sendResponse),
    SP_VOICE_CANCEL:       () => handleVoiceCancel(sendResponse),
    SP_GEN_SCRIPT:         () => handleGenScript(msg, sendResponse),
  };

  if (handlers[msg.type]) {
    handlers[msg.type]();
    return true;
  }
});

// ─── Recording session state ────────────────────────────────────────────────

// activeSession: { id, tabId, name, startedAt, steps: [] }
// startedAt is the wall-clock moment the side panel started MediaRecorder —
// chapter markers are measured relative to it.
let activeSession = null;

async function handleStartRecording({ sessionName, tabId, startedAt }, sendResponse) {
  if (activeSession) {
    sendResponse({ ok: false, error: "Already recording — stop the current session first" });
    return;
  }
  if (!tabId || !startedAt) {
    sendResponse({ ok: false, error: "Missing recording context — restart the side panel and try again" });
    return;
  }

  const settings = await chrome.storage.local.get(["apiKey"]);
  if (!settings.apiKey) {
    sendResponse({ ok: false, error: "No API key configured. Go to Options." });
    return;
  }

  const sessionId = `session_${Date.now()}`;
  const uniqueName = await uniqueSessionName(sessionName || "Untitled guide");

  activeSession = {
    id: sessionId,
    tabId,
    name: uniqueName,
    startedAt,
    steps: [],
  };

  try {
    await injectContentScript(tabId);
    await chrome.tabs.sendMessage(tabId, { type: "GUIDR_START_RECORDING" });
  } catch (err) {
    // Recording can still proceed without chapter markers (e.g. on a page
    // where the content script can't be injected) — surface a warning but
    // keep the session active.
    console.warn("[Guidr] could not inject content script:", err);
  }

  sendResponse({ ok: true, sessionId });
}

async function handleStopRecording(sendResponse) {
  if (!activeSession) { sendResponse({ ok: false, error: "No active session" }); return; }

  await chrome.tabs.sendMessage(activeSession.tabId, { type: "GUIDR_STOP_RECORDING" }).catch(() => {});

  const session = { ...activeSession };
  activeSession = null;
  sendResponse({ ok: true, session });
}

async function handleChapterMarker({ payload }, sender, sendResponse) {
  if (!activeSession) { sendResponse({ ok: false }); return; }
  if (sender.tab?.id !== activeSession.tabId) { sendResponse({ ok: false }); return; }

  const tsMs = Math.max(0, (payload.absTs || Date.now()) - activeSession.startedAt);
  const step = {
    id: `step_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    sessionId: activeSession.id,
    index: activeSession.steps.length,
    tsMs,
    target: payload.target,
    url: payload.url,
    pageTitle: payload.pageTitle,
    title: null,
    body: null,
    voiceoverScript: null,
    included: true,
    mediaMode: "screenshot",
    annotations: [],
    enriched: false,
  };

  activeSession.steps.push(step);
  await db.saveStep(step);
  await db.saveSession(activeSession);

  chrome.runtime.sendMessage({
    type: "SW_STEP_CAPTURED",
    payload: { step },
  }).catch(() => {});

  sendResponse({ ok: true, stepId: step.id });
}

// ─── Tab lifecycle ───────────────────────────────────────────────────────────

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (!activeSession || activeSession.tabId !== tabId) return;
  if (info.status !== "complete") return;
  try {
    await injectContentScript(tabId);
    await chrome.tabs.sendMessage(tabId, { type: "GUIDR_START_RECORDING" });
  } catch {
    // chrome://, restricted, or no host permission — ignore.
  }
});

async function injectContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content_script.js"],
  });
}

// ─── LLM enrichment ──────────────────────────────────────────────────────────

async function handleEnrichStep({ stepId, sessionId, screenshotDataUrl }, sendResponse) {
  const step = await db.getStep(stepId);
  const settings = await chrome.storage.local.get(["apiKey", "provider", "model", "openrouterModel", "toneGuide", "exampleGuides"]);
  if (!step || !settings.apiKey) { sendResponse({ ok: false }); return; }

  try {
    // Defensive: existing installs where the options page was never
    // explicitly opened may have apiKey set but provider undefined. The
    // default matches options/main.js (state.provider = "gemini").
    if (!settings.provider) settings.provider = "gemini";
    if (settings.provider === "openrouter" && settings.openrouterModel) {
      settings.model = settings.openrouterModel;
    }
    // llm.js expects screenshot bytes on the step object. We don't persist
    // them anymore — the side panel extracts a frame from the source video
    // at step.tsMs and passes it inline for this single call.
    const stepForLlm = { ...step, screenshotAfter: screenshotDataUrl || null };
    const result = await enrichStep(stepForLlm, settings);
    const updated = { ...step, ...result, enriched: true };
    await db.saveStep(updated);

    if (activeSession?.id === sessionId) {
      const idx = activeSession.steps.findIndex((s) => s.id === stepId);
      if (idx !== -1) activeSession.steps[idx] = updated;
    }

    sendResponse({ ok: true, step: updated });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

// ─── CRUD helpers ────────────────────────────────────────────────────────────

async function uniqueSessionName(baseName) {
  const sessions = await db.getAllSessions();
  const taken = new Set(sessions.map((s) => s.name));
  if (!taken.has(baseName)) return baseName;
  for (let n = 2; n < 10000; n++) {
    const candidate = `${baseName} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${baseName} (${Date.now()})`;
}

async function handleGetSessions(sendResponse) {
  const sessions = await db.getAllSessions();
  sendResponse({ ok: true, sessions });
}

async function handleGetSession({ sessionId }, sendResponse) {
  const session = await db.getSession(sessionId);
  if (!session) { sendResponse({ ok: false }); return; }
  const steps = await db.getStepsForSession(sessionId);
  sendResponse({ ok: true, session: { ...session, steps } });
}

async function handleDeleteStep({ stepId, sessionId }, sendResponse) {
  await db.deleteStep(stepId);
  const session = await db.getSession(sessionId);
  if (session) {
    session.steps = (session.steps || []).filter((id) => id !== stepId);
    await db.saveSession(session);
  }
  sendResponse({ ok: true });
}

async function handleDeleteSession({ sessionId }, sendResponse) {
  if (activeSession?.id === sessionId) activeSession = null;
  await db.deleteSession(sessionId);
  sendResponse({ ok: true });
}

async function handleReorderSteps({ sessionId, orderedIds }, sendResponse) {
  const steps = await db.getStepsForSession(sessionId);
  for (const step of steps) {
    step.index = orderedIds.indexOf(step.id);
    await db.saveStep(step);
  }
  sendResponse({ ok: true });
}

async function handleUpdateStep({ stepId, updates }, sendResponse) {
  const step = await db.getStep(stepId);
  if (!step) { sendResponse({ ok: false }); return; }
  const updated = { ...step, ...updates };
  await db.saveStep(updated);
  sendResponse({ ok: true, step: updated });
}

async function handleUpdateSession({ sessionId, updates }, sendResponse) {
  const session = await db.getSession(sessionId);
  if (!session) { sendResponse({ ok: false }); return; }
  const updated = { ...session, ...updates, updatedAt: Date.now() };
  await db.saveSession(updated);
  sendResponse({ ok: true, session: updated });
}

// ─── Recording fetch / delete ────────────────────────────────────────────────

async function handleGetRecording({ sessionId }, sendResponse) {
  const rec = await db.getRecording(sessionId);
  if (!rec) { sendResponse({ ok: false }); return; }
  sendResponse({
    ok: true,
    blob: rec.blob,
    mimeType: rec.mimeType,
    durationMs: rec.durationMs,
    byteSize: rec.byteSize,
  });
}

async function handleDeleteRecording({ sessionId }, sendResponse) {
  await db.deleteRecording(sessionId);
  sendResponse({ ok: true });
}

async function handleDeleteVoice({ sessionId }, sendResponse) {
  await db.deleteVoiceRecording(sessionId);
  sendResponse({ ok: true });
}

// ─── Offscreen mic capture ──────────────────────────────────────────────────
// Side panels can't host the mic permission prompt (Chrome side-panel
// limitation — getUserMedia rejects with NotAllowedError before any prompt
// UI appears). We host mic capture in an offscreen document instead.

const OFFSCREEN_PATH = "offscreen/voice.html";

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: "Recording microphone narration alongside screen captures.",
  });
}

async function closeOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (contexts.length === 0) return;
  try { await chrome.offscreen.closeDocument(); } catch {}
}

async function relayToOffscreen(payload) {
  try {
    const res = await chrome.runtime.sendMessage({ target: "offscreen-voice", ...payload });
    return res || { ok: false, error: "no-response" };
  } catch (err) {
    return { ok: false, error: "relay-failed", message: err?.message };
  }
}

async function handleVoicePrepare(sendResponse) {
  try {
    await ensureOffscreen();
    const res = await relayToOffscreen({ type: "OFF_VOICE_PREPARE" });
    sendResponse(res);
  } catch (err) {
    console.warn("[Guidr] handleVoicePrepare failed:", err);
    sendResponse({ ok: false, error: "sw-failed", message: err?.message });
  }
}

async function handleVoiceStart({ sessionId, startedAt }, sendResponse) {
  try {
    await ensureOffscreen();
    const res = await relayToOffscreen({ type: "OFF_VOICE_START", sessionId, startedAt });
    sendResponse(res);
  } catch (err) {
    console.warn("[Guidr] handleVoiceStart failed:", err);
    sendResponse({ ok: false, error: "sw-failed", message: err?.message });
  }
}

async function handleVoiceStop(sendResponse) {
  try {
    const res = await relayToOffscreen({ type: "OFF_VOICE_STOP" });
    // Close offscreen once recording is done so we don't keep an idle
    // document around (Chrome may also close it on its own).
    closeOffscreen().catch(() => {});
    sendResponse(res);
  } catch (err) {
    console.warn("[Guidr] handleVoiceStop failed:", err);
    sendResponse({ ok: false, error: "sw-failed", message: err?.message });
  }
}

async function handleVoiceCancel(sendResponse) {
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (contexts.length > 0) {
      await relayToOffscreen({ type: "OFF_VOICE_CANCEL" });
      closeOffscreen().catch(() => {});
    }
    sendResponse({ ok: true });
  } catch (err) {
    console.warn("[Guidr] handleVoiceCancel failed:", err);
    sendResponse({ ok: false, error: "sw-failed", message: err?.message });
  }
}

// ─── Script generation ──────────────────────────────────────────────────────

async function handleGenScript({ sessionId }, sendResponse) {
  const session = await db.getSession(sessionId);
  const steps = await db.getStepsForSession(sessionId);
  if (!session) { sendResponse({ ok: false, error: "Session not found" }); return; }

  const settings = await chrome.storage.local.get(["apiKey", "provider", "model", "openrouterModel", "toneGuide"]);
  if (!settings.apiKey) { sendResponse({ ok: false, error: "No API key configured" }); return; }
  if (!settings.provider) settings.provider = "gemini";
  if (settings.provider === "openrouter" && settings.openrouterModel) {
    settings.model = settings.openrouterModel;
  }

  try {
    const script = await generateFullScript({ ...session, steps }, settings);
    sendResponse({ ok: true, script });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}
