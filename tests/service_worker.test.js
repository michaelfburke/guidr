import { beforeEach, describe, expect, it, vi } from "vitest";

// Shared across simulated SW restarts, like the real chrome.storage.session.
let sessionStore;
let onMessage;
// documentIds of side panels that are currently open.
let liveDocuments;

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
  chrome.runtime.getContexts = async ({ documentIds }) =>
    documentIds.filter((id) => liveDocuments.has(id)).map((documentId) => ({ documentId }));
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

const panelA = { documentId: "panel-A" };
const panelB = { documentId: "panel-B" };
const start = (name, tabId, sender = panelA) =>
  send({ type: "SP_START_RECORDING", sessionName: name, tabId, startedAt: Date.now() }, sender);
const stop = (sender = panelA) => send({ type: "SP_STOP_RECORDING" }, sender);

beforeEach(() => {
  sessionStore = new Map();
  liveDocuments = new Set([panelA.documentId, panelB.documentId]);
  globalThis.__resetChromeStorage();
});

describe("service_worker recording state", () => {
  it("records without an API key configured", async () => {
    await bootServiceWorker();
    expect((await start("No key", 7)).ok).toBe(true);
  });

  it("keeps recording across a service worker restart", async () => {
    await bootServiceWorker();
    const started = await start("Restart", 7);
    expect((await send(marker("First"), { tab: { id: 7 } })).ok).toBe(true);

    await bootServiceWorker(); // in-memory state is gone

    expect((await send(marker("Second"), { tab: { id: 7 } })).ok).toBe(true);
    const stopped = await stop();
    expect(stopped.ok).toBe(true);
    expect(stopped.session.id).toBe(started.sessionId);
    expect(stopped.session.steps.map((s) => s.target.text)).toEqual(["First", "Second"]);
    expect(stopped.session.steps.map((s) => s.index)).toEqual([0, 1]);
    expect(sessionStore.size).toBe(0);
  });

  it("gives captured steps draft text and leaves them unenriched", async () => {
    await bootServiceWorker();
    await start("Draft", 7);
    await send(marker("Save contact"), { tab: { id: 7 } });
    const { session } = await stop();
    expect(session.steps[0]).toMatchObject({ title: "Click Save contact", body: 'Click "Save contact".', enriched: false });
  });

  it("persists only session metadata, not steps", async () => {
    await bootServiceWorker();
    await start("Meta", 7);
    await send(marker("One"), { tab: { id: 7 } });
    const [meta] = [...sessionStore.values()];
    expect(meta).not.toHaveProperty("steps");
    expect(meta).toMatchObject({ tabId: 7, ownerDocumentId: "panel-A" });
  });

  it("rejects a second start from the same panel", async () => {
    await bootServiceWorker();
    await start("First", 7);
    const res = await start("Second", 7);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Already recording/);
  });

  it("does not let another window take over or stop a live recording", async () => {
    await bootServiceWorker();
    await start("Window A", 7, panelA);

    const res = await start("Window B", 9, panelB);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/another window/);
    expect((await stop(panelB)).ok).toBe(false);

    expect((await send(marker("Still A"), { tab: { id: 7 } })).ok).toBe(true);
    expect((await stop(panelA)).ok).toBe(true);
  });

  it("replaces a session whose side panel has closed", async () => {
    await bootServiceWorker();
    await start("Orphan", 7, panelA);
    liveDocuments.delete(panelA.documentId);

    await bootServiceWorker();
    expect((await start("Fresh", 9, panelB)).ok).toBe(true);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, { type: "GUIDR_STOP_RECORDING" });
    expect((await send(marker("Old tab"), { tab: { id: 7 } })).ok).toBe(false);
    expect((await send(marker("New tab"), { tab: { id: 9 } })).ok).toBe(true);
  });

  it("keeps the live recording when a malformed start arrives", async () => {
    await bootServiceWorker();
    await start("Live", 7);
    liveDocuments.clear();
    const res = await send({ type: "SP_START_RECORDING", sessionName: "Bad", startedAt: Date.now() }, panelB);
    expect(res.ok).toBe(false);
    expect((await send(marker("Kept"), { tab: { id: 7 } })).ok).toBe(true);
  });

  it("finishes a marker that races with Stop", async () => {
    await bootServiceWorker();
    await start("Race", 7);
    const pending = send(marker("Last"), { tab: { id: 7 } });
    const stopped = await stop();
    expect(stopped.ok).toBe(true);
    expect((await pending).ok).toBe(true);
  });

  it("reports a missing API key when enriching", async () => {
    await bootServiceWorker();
    await start("Enrich", 7);
    const { stepId } = await send(marker("Save"), { tab: { id: 7 } });
    const res = await send({ type: "SP_ENRICH_STEP", stepId });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/No API key/);
  });
});
