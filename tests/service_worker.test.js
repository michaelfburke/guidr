import { beforeEach, describe, expect, it, vi } from "vitest";

// Shared across simulated SW restarts, like the real chrome.storage.session.
let sessionStore;
let onMessage;

const noopEvent = { addListener: () => {} };

function installChrome() {
  chrome.storage.session = {
    get: async (key) => (sessionStore.has(key) ? { [key]: structuredClone(sessionStore.get(key)) } : {}),
    set: async (items) => { for (const [k, v] of Object.entries(items)) sessionStore.set(k, structuredClone(v)); },
    remove: async (key) => { sessionStore.delete(key); },
  };
  chrome.runtime.onMessage = { addListener: (fn) => { onMessage = fn; } };
  chrome.runtime.onInstalled = noopEvent;
  chrome.runtime.sendMessage = () => Promise.resolve();
  chrome.action = { onClicked: noopEvent };
  chrome.sidePanel = { setPanelBehavior: () => Promise.resolve(), open: () => Promise.resolve() };
  chrome.tabs = { onUpdated: noopEvent, sendMessage: vi.fn(() => Promise.resolve()) };
  chrome.scripting = { executeScript: () => Promise.resolve() };
}

/** Load a fresh copy of the service worker, as Chrome does after terminating it. */
async function bootServiceWorker() {
  vi.resetModules();
  installChrome();
  await import("../service_worker.js");
}

function send(msg, sender = {}) {
  return new Promise((resolve) => {
    expect(onMessage(msg, sender, resolve)).toBe(true);
  });
}

const marker = (text) => ({
  type: "GUIDR_CHAPTER_MARKER",
  payload: { absTs: Date.now(), target: { text }, url: "https://app.test/", pageTitle: "App" },
});

beforeEach(() => {
  sessionStore = new Map();
  globalThis.__resetChromeStorage();
});

describe("service_worker recording state", () => {
  it("records without an API key configured", async () => {
    await bootServiceWorker();
    const res = await send({ type: "SP_START_RECORDING", sessionName: "No key", tabId: 7, startedAt: Date.now() });
    expect(res.ok).toBe(true);
  });

  it("keeps recording across a service worker restart", async () => {
    await bootServiceWorker();
    const start = await send({ type: "SP_START_RECORDING", sessionName: "Restart", tabId: 7, startedAt: Date.now() });
    expect((await send(marker("First"), { tab: { id: 7 } })).ok).toBe(true);

    await bootServiceWorker(); // in-memory state is gone

    expect((await send(marker("Second"), { tab: { id: 7 } })).ok).toBe(true);
    const stop = await send({ type: "SP_STOP_RECORDING" });
    expect(stop.ok).toBe(true);
    expect(stop.session.id).toBe(start.sessionId);
    expect(stop.session.steps.map((s) => s.target.text)).toEqual(["First", "Second"]);
    expect(stop.session.steps.map((s) => s.index)).toEqual([0, 1]);
    expect(sessionStore.size).toBe(0);
  });

  it("replaces a session orphaned by a closed side panel instead of blocking", async () => {
    await bootServiceWorker();
    await send({ type: "SP_START_RECORDING", sessionName: "Orphan", tabId: 7, startedAt: Date.now() });

    await bootServiceWorker();
    const res = await send({ type: "SP_START_RECORDING", sessionName: "Fresh", tabId: 9, startedAt: Date.now() });
    expect(res.ok).toBe(true);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, { type: "GUIDR_STOP_RECORDING" });
    expect((await send(marker("Old tab"), { tab: { id: 7 } })).ok).toBe(false);
    expect((await send(marker("New tab"), { tab: { id: 9 } })).ok).toBe(true);
  });

  it("reports a missing API key when enriching", async () => {
    await bootServiceWorker();
    await send({ type: "SP_START_RECORDING", sessionName: "Enrich", tabId: 7, startedAt: Date.now() });
    const { stepId } = await send(marker("Save"), { tab: { id: 7 } });
    const res = await send({ type: "SP_ENRICH_STEP", stepId });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/No API key/);
  });
});
