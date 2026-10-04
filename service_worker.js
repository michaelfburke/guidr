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
import { draftStep } from "./draft.js";

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
    SP_START_RECORDING:    () => handleStartRecording(msg, sender, sendResponse),
    SP_STOP_RECORDING:     () => handleStopRecording(sender, sendResponse),
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

// activeSession: { id, tabId, name, startedAt, ownerDocumentId, steps: [] }
// startedAt is the wall-clock moment the side panel started MediaRecorder —
// chapter markers are measured relative to it. ownerDocumentId is the side
// panel document that started the recording; only it may stop it.
//
// Chrome terminates an idle service worker after ~30s, which would wipe this
// in-memory copy mid-recording. The session's metadata (not its steps, which
// are already in IndexedDB) is mirrored to chrome.storage.session (in-memory,
// cleared on browser restart) and the steps are reloaded from IndexedDB on the
// next wake-up. Every handler that reads activeSession must
// `await restoreActiveSession()` first.
const ACTIVE_SESSION_KEY = "guidr_activeSession";
let activeSession = null;
let restorePromise = null;

function restoreActiveSession() {
  restorePromise ??= (async () => {
    try {
      const { [ACTIVE_SESSION_KEY]: meta } = await chrome.storage.session.get(ACTIVE_SESSION_KEY);
      if (!meta || activeSession) return;
      const steps = await db.getStepsForSession(meta.id);
      activeSession ??= { ...meta, steps: steps.sort((a, b) => a.index - b.index) };
    } catch (err) {
      console.warn("[Guidr] could not restore recording state:", err);
    }
  })();
  return restorePromise;
}

async function setActiveSession(session) {
  activeSession = session;
  try {
    if (session) {
      const { steps: _steps, ...meta } = session;
      await chrome.storage.session.set({ [ACTIVE_SESSION_KEY]: meta });
    } else {
      await chrome.storage.session.remove(ACTIVE_SESSION_KEY);
    }
  } catch (err) {
    console.warn("[Guidr] could not persist recording state:", err);
  }
}

// A session whose owning side panel has closed can never be stopped by it.
async function isOwnerAlive(session) {
  if (!session.ownerDocumentId) return true;
  try {
    const contexts = await chrome.runtime.getContexts({ documentIds: [session.ownerDocumentId] });
    return contexts.length > 0;
  } catch {
    return true;
  }
}

async function handleStartRecording({ sessionName, tabId, startedAt }, sender, sendResponse) {
  if (!tabId || !startedAt) {
    sendResponse({ ok: false, error: "Missing recording context — restart the side panel and try again" });
    return;
  }

  await restoreActiveSession();
  if (activeSession) {
    if (await isOwnerAlive(activeSession)) {
      const elsewhere = activeSession.ownerDocumentId && activeSession.ownerDocumentId !== sender.documentId;
      sendResponse({
        ok: false,
        error: elsewhere
          ? "Guidr is already recording in another window — stop that recording first"
          : "Already recording — stop the current session first",
      });
      return;
    }
    // The side panel that owned it closed mid-recording without stopping.
    // Detach it rather than blocking new recordings until the browser restarts.
    const stale = activeSession;
    await setActiveSession(null);
    await chrome.tabs.sendMessage(stale.tabId, { type: "GUIDR_STOP_RECORDING" }).catch(() => {});
  }

  // No API key check here: recording is fully local. The key is only needed
  // for enrichment, which reports its own error if it's missing.
  const sessionId = `session_${Date.now()}`;
  const uniqueName = await uniqueSessionName(sessionName || "Untitled guide");

  await setActiveSession({
    id: sessionId,
    tabId,
    name: uniqueName,
    startedAt,
    ownerDocumentId: sender.documentId || null,
    steps: [],
  });

  let markersActive = false;
  try {
    await injectContentScript(tabId);
    await chrome.tabs.sendMessage(tabId, { type: "GUIDR_START_RECORDING" });
    markersActive = true;
  } catch {
    // Recording proceeds without chapter markers (e.g. chrome://, restricted
    // pages, no host permission). The side panel shows a persistent warning so
    // the user knows to switch tabs before clicking through their product.
  }

  sendResponse({ ok: true, sessionId, markersActive });
}

async function handleStopRecording(sender, sendResponse) {
  await restoreActiveSession();
  if (!activeSession) { sendResponse({ ok: false, error: "No active session" }); return; }
  const owner = activeSession.ownerDocumentId;
  if (owner && sender.documentId && owner !== sender.documentId) {
    sendResponse({ ok: false, error: "This recording belongs to another window" });
    return;
  }

  const session = activeSession;
  await setActiveSession(null);
  await chrome.tabs.sendMessage(session.tabId, { type: "GUIDR_STOP_RECORDING" }).catch(() => {});
  sendResponse({ ok: true, session: { ...session } });
}

async function handleChapterMarker({ payload }, sender, sendResponse) {
  await restoreActiveSession();
  // Hold a local reference: Stop can clear activeSession while we await below.
  const session = activeSession;
  if (!session) { sendResponse({ ok: false }); return; }
  if (sender.tab?.id !== session.tabId) { sendResponse({ ok: false }); return; }

  const tsMs = Math.max(0, (payload.absTs || Date.now()) - session.startedAt);
  const step = {
    id: `step_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    sessionId: session.id,
    index: session.steps.length,
    tsMs,
    target: payload.target,
    url: payload.url,
    pageTitle: payload.pageTitle,
    // Template text so the guide reads sensibly without AI; enrichment replaces it.
    ...draftStep(payload.target, payload.pageTitle),
    voiceoverScript: null,
    included: true,
    mediaMode: "screenshot",
    annotations: [],
    enriched: false,
  };

  session.steps.push(step);
  await db.saveStep(step);
  await db.saveSession(session);

  chrome.runtime.sendMessage({
    type: "SW_STEP_CAPTURED",
    payload: { step },
  }).catch(() => {});

  sendResponse({ ok: true, stepId: step.id });
}

// ─── Tab lifecycle ───────────────────────────────────────────────────────────

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  await restoreActiveSession();
  if (!activeSession || activeSession.tabId !== tabId) return;
  if (info.status !== "complete") return;
  try {
    await injectContentScript(tabId);
    await chrome.tabs.sendMessage(tabId, { type: "GUIDR_START_RECORDING" });
    chrome.runtime.sendMessage({ type: "SW_MARKERS_STATUS", active: true }).catch(() => {});
  } catch {
    // Navigated to a restricted page (chrome://, file://, etc.) — step capture
    // is not available here. Notify the side panel so it can warn the user.
    chrome.runtime.sendMessage({ type: "SW_MARKERS_STATUS", active: false }).catch(() => {});
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
  if (!step) { sendResponse({ ok: false, error: "Step not found" }); return; }
  if (!settings.apiKey) { sendResponse({ ok: false, error: "No API key configured. Add one in Settings to enrich steps." }); return; }

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

    await restoreActiveSession();
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
  await restoreActiveSession();
  if (activeSession?.id === sessionId) await setActiveSession(null);
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
