/**
 * service_worker.js
 * MV3 background service worker. Responsibilities:
 *  - Open the side panel on extension icon click
 *  - Relay start/stop recording to content scripts
 *  - Capture screenshots (tabs.captureVisibleTab requires this context)
 *  - Orchestrate LLM enrichment calls
 *  - Persist sessions to IndexedDB via a thin DB helper
 *  - Handle export requests
 */

import { db } from "./db.js";
import { enrichStep, generateFullScript } from "./llm.js";
import { exportSession } from "./export.js";

// ─── Side panel ──────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
});

chrome.action.onClicked.addListener((tab) => {
  // Fallback for Chrome versions where setPanelBehavior isn't honoured.
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});

// ─── Message router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Async handlers must return true to keep the message channel open
  const handlers = {
    // Side panel → start recording on the active tab
    SP_START_RECORDING: () => handleStartRecording(msg, sendResponse),
    // Side panel → stop recording
    SP_STOP_RECORDING: () => handleStopRecording(msg, sendResponse),
    // Content script → capture pre-action screenshot + metadata
    GUIDR_CAPTURE_STEP: () => handleCaptureStep(msg, sender, sendResponse),
    // Content script → DOM has settled, capture post-action screenshot
    GUIDR_DOM_SETTLED: () => handleDomSettled(msg, sender, sendResponse),
    // Side panel → enrich a step with LLM
    SP_ENRICH_STEP: () => handleEnrichStep(msg, sendResponse),
    // Side panel → enrich ALL steps
    SP_ENRICH_ALL: () => handleEnrichAll(msg, sendResponse),
    // Side panel → export a session
    SP_EXPORT: () => handleExport(msg, sendResponse),
    // Side panel → get all sessions
    SP_GET_SESSIONS: () => handleGetSessions(sendResponse),
    // Side panel → get one session
    SP_GET_SESSION: () => handleGetSession(msg, sendResponse),
    // Side panel → delete a step
    SP_DELETE_STEP: () => handleDeleteStep(msg, sendResponse),
    // Side panel → delete a whole session
    SP_DELETE_SESSION: () => handleDeleteSession(msg, sendResponse),
    // Side panel → fetch a small thumbnail for the home-view session card
    SP_GET_SESSION_THUMB: () => handleGetSessionThumb(msg, sendResponse),
    // Side panel → reorder steps
    SP_REORDER_STEPS: () => handleReorderSteps(msg, sendResponse),
    // Side panel → update step text
    SP_UPDATE_STEP: () => handleUpdateStep(msg, sendResponse),
    // Side panel → fetch a single screenshot blob on demand
    SP_GET_SCREENSHOT: () => handleGetScreenshot(msg, sendResponse),
    // Side panel → fetch one step with all blobs (for video synthesis)
    SP_GET_STEP_FULL: () => handleGetStepFull(msg, sendResponse),
    // Side panel → generate cohesive voiceover script for the whole guide
    SP_GEN_SCRIPT: () => handleGenScript(msg, sendResponse),
  };

  if (handlers[msg.type]) {
    handlers[msg.type]();
    return true; // keep channel open for async sendResponse
  }
});

// ─── Recording state (in-memory; survives SW restarts via storage) ────────────

// activeSession: { id, tabId, steps: [] }
let activeSession = null;
// pendingStep: waiting for post-action screenshot
let pendingStep = null;

async function handleStartRecording({ sessionName }, sendResponse) {
  const settings = await chrome.storage.local.get(["apiKey", "provider"]);
  if (!settings.apiKey) {
    sendResponse({ ok: false, error: "No API key configured. Go to Options." });
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || /^(chrome|chrome-extension|edge|about):/.test(tab.url || "")) {
    sendResponse({ ok: false, error: "Open the page you want to record in the active tab first." });
    return;
  }

  // Optional host permission — request the first time the user records.
  // Persists across sessions; the user can revoke from chrome://extensions.
  const granted = await chrome.permissions.request({ origins: ["<all_urls>"] });
  if (!granted) {
    sendResponse({ ok: false, error: "Guidr needs permission to record on this site. Grant access and try again." });
    return;
  }

  // Hold the session in memory only — it's persisted on first step capture
  // so that aborted starts (no content script, user cancels) don't leave
  // empty zombie sessions in the recent-guides list.
  const sessionId = `session_${Date.now()}`;
  const uniqueName = await uniqueSessionName(sessionName || "Untitled guide");
  activeSession = { id: sessionId, tabId: tab.id, name: uniqueName, steps: [] };

  try {
    await injectContentScript(tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: "GUIDR_START_RECORDING" });
  } catch (err) {
    activeSession = null;
    sendResponse({ ok: false, error: `Couldn't start recording on this tab: ${err.message}` });
    return;
  }
  sendResponse({ ok: true, sessionId });
}

async function injectContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content_script.js"],
  });
}

// While recording, re-inject the content script after navigations so the
// recording survives full-page loads. The content script's __guidrInjected
// guard makes re-injection idempotent.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (!activeSession || activeSession.tabId !== tabId) return;
  if (info.status !== "complete") return;
  try {
    await injectContentScript(tabId);
    await chrome.tabs.sendMessage(tabId, { type: "GUIDR_START_RECORDING" });
  } catch {
    // chrome://, restricted pages, or origin without host permission — ignore.
  }
});

async function handleStopRecording(_msg, sendResponse) {
  if (!activeSession) { sendResponse({ ok: false, error: "No active session" }); return; }

  // Send to the recording tab specifically — the user may have switched tabs.
  await chrome.tabs.sendMessage(activeSession.tabId, { type: "GUIDR_STOP_RECORDING" }).catch(() => {});

  const session = { ...activeSession };
  activeSession = null;
  pendingStep = null;
  sendResponse({ ok: true, session });
}

// ─── Screenshot capture ───────────────────────────────────────────────────────

async function handleCaptureStep({ payload }, sender, sendResponse) {
  if (!activeSession) { sendResponse({ ok: false }); return; }

  // Capture screenshot BEFORE the click resolves (content script fires in capture phase)
  let dataUrl = null;
  try {
    dataUrl = await captureTab(sender.tab.id);
  } catch (err) {
    notifyCaptureError(err);
    sendResponse({ ok: false, error: err.message });
    return;
  }

  const step = {
    id: `step_${Date.now()}`,
    sessionId: activeSession.id,
    index: activeSession.steps.length,
    target: payload.target,
    url: payload.url,
    pageTitle: payload.pageTitle,
    timestamp: payload.timestamp,
    screenshotBefore: dataUrl,
    screenshotAfter: null, // filled by GUIDR_DOM_SETTLED
    title: null,           // filled by LLM
    body: null,
    enriched: false,
  };

  pendingStep = step;
  sendResponse({ ok: true, stepId: step.id });
}

async function handleDomSettled({ payload }, sender, sendResponse) {
  if (!pendingStep || !activeSession) { sendResponse({ ok: false }); return; }

  try {
    pendingStep.screenshotAfter = await captureTab(sender.tab.id);
  } catch (err) {
    notifyCaptureError(err);
    pendingStep = null;
    sendResponse({ ok: false, error: err.message });
    return;
  }

  // Persist and add to session
  activeSession.steps.push(pendingStep);
  await db.saveStep(pendingStep);
  await db.saveSession(activeSession);

  // Notify side panel
  chrome.runtime.sendMessage({
    type: "SW_STEP_CAPTURED",
    payload: { step: stripScreenshots(pendingStep) },
  }).catch(() => {}); // side panel may not be open

  pendingStep = null;
  sendResponse({ ok: true });
}

async function captureTab(tabId) {
  return chrome.tabs.captureVisibleTab(null, { format: "png", quality: 90 });
}

function notifyCaptureError(err) {
  chrome.runtime.sendMessage({
    type: "SW_CAPTURE_ERROR",
    payload: { message: err.message || String(err) },
  }).catch(() => {});
}

// ─── LLM enrichment ───────────────────────────────────────────────────────────

async function handleEnrichStep({ stepId, sessionId }, sendResponse) {
  const step = await db.getStep(stepId);
  const settings = await chrome.storage.local.get(["apiKey", "provider", "model", "openrouterModel", "toneGuide", "exampleGuides"]);

  if (!step || !settings.apiKey) { sendResponse({ ok: false }); return; }

  try {
    // OpenRouter stores its model under a different key.
    if (settings.provider === "openrouter" && settings.openrouterModel) {
      settings.model = settings.openrouterModel;
    }
    const result = await enrichStep(step, settings);
    const updated = { ...step, ...result, enriched: true };
    await db.saveStep(updated);

    // Update session in memory if active
    if (activeSession?.id === sessionId) {
      const idx = activeSession.steps.findIndex((s) => s.id === stepId);
      if (idx !== -1) activeSession.steps[idx] = updated;
    }

    sendResponse({ ok: true, step: stripScreenshots(updated) });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

async function handleEnrichAll({ sessionId }, sendResponse) {
  const session = await db.getSession(sessionId);
  if (!session) { sendResponse({ ok: false }); return; }

  // session.steps in storage is an array of step IDs — hydrate first.
  const steps = await db.getStepsForSession(sessionId);
  const settings = await chrome.storage.local.get(["apiKey", "provider", "model", "openrouterModel", "toneGuide", "exampleGuides"]);
  const results = [];

  if (settings.provider === "openrouter" && settings.openrouterModel) {
    settings.model = settings.openrouterModel;
  }

  for (const step of steps) {
    if (step.enriched) { results.push(step); continue; }
    try {
      const result = await enrichStep(step, settings);
      const updated = { ...step, ...result, enriched: true };
      await db.saveStep(updated);
      results.push(updated);
      // Stream progress to side panel
      chrome.runtime.sendMessage({
        type: "SW_STEP_ENRICHED",
        payload: { step: stripScreenshots(updated) },
      }).catch(() => {});
    } catch (err) {
      results.push({ ...step, enrichError: err.message });
    }
  }

  sendResponse({ ok: true, steps: results.map(stripScreenshots) });
}

// ─── CRUD helpers ─────────────────────────────────────────────────────────────

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

  // Attach steps (without screenshot blobs for the list view)
  const steps = await db.getStepsForSession(sessionId);
  sendResponse({ ok: true, session: { ...session, steps: steps.map(stripScreenshots) } });
}

async function handleDeleteStep({ stepId, sessionId }, sendResponse) {
  await db.deleteStep(stepId);
  // session.steps is an array of IDs (strings).
  const session = await db.getSession(sessionId);
  if (session) {
    session.steps = (session.steps || []).filter((id) => id !== stepId);
    await db.saveSession(session);
  }
  sendResponse({ ok: true });
}

async function handleDeleteSession({ sessionId }, sendResponse) {
  if (activeSession?.id === sessionId) {
    activeSession = null;
    pendingStep = null;
  }
  await db.deleteSession(sessionId);
  sendResponse({ ok: true });
}

async function handleGetSessionThumb({ sessionId }, sendResponse) {
  const session = await db.getSession(sessionId);
  const firstId = session?.steps?.[0];
  if (!firstId) { sendResponse({ ok: true, dataUrl: null }); return; }
  const step = await db.getStep(firstId);
  const raw = step?.screenshotAfter || step?.screenshotBefore;
  if (!raw) { sendResponse({ ok: true, dataUrl: null }); return; }
  try {
    const small = await compressForThumb(raw);
    sendResponse({ ok: true, dataUrl: small });
  } catch {
    sendResponse({ ok: true, dataUrl: raw });
  }
}

async function compressForThumb(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, 160 / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
  const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.72 });
  return await new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.readAsDataURL(out);
  });
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
  sendResponse({ ok: true, step: stripScreenshots(updated) });
}

// ─── Export ───────────────────────────────────────────────────────────────────

async function handleExport({ sessionId, format }, sendResponse) {
  const session = await db.getSession(sessionId);
  const steps = await db.getStepsForSession(sessionId);

  if (!session) { sendResponse({ ok: false }); return; }

  try {
    const result = await exportSession({ ...session, steps }, format);
    sendResponse({ ok: true, ...result });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

/** Strip large screenshot data URLs for IPC — side panel fetches them on demand */
function stripScreenshots(step) {
  const { screenshotBefore, screenshotAfter, ...rest } = step;
  return {
    ...rest,
    hasScreenshotBefore: !!screenshotBefore,
    hasScreenshotAfter: !!screenshotAfter,
  };
}

// ─── Side-panel-on-demand fetches ─────────────────────────────────────────────

async function handleGetScreenshot({ stepId, which }, sendResponse) {
  const dataUrl = await db.getScreenshot(stepId, which || "after");
  sendResponse({ ok: true, dataUrl });
}

async function handleGenScript({ sessionId }, sendResponse) {
  const session = await db.getSession(sessionId);
  const steps   = await db.getStepsForSession(sessionId);
  if (!session) { sendResponse({ ok: false, error: "Session not found" }); return; }

  const settings = await chrome.storage.local.get(["apiKey", "provider", "model", "openrouterModel", "toneGuide"]);
  if (!settings.apiKey) { sendResponse({ ok: false, error: "No API key configured" }); return; }
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

async function handleGetStepFull({ stepId }, sendResponse) {
  const step = await db.getStep(stepId);
  sendResponse({ ok: !!step, step });
}
