import { describe, it, expect, beforeEach } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { db } from "../db.js";

// db.js opens a fresh connection per call and never closes it, so
// deleteDatabase() would block on the leaked open handles. Swapping in a brand
// new factory gives each test a clean, isolated IndexedDB world instead.
function resetDb() {
  globalThis.indexedDB = new IDBFactory();
}

describe("db schema & CRUD", () => {
  beforeEach(() => {
    globalThis.__resetChromeStorage();
    resetDb();
  });

  it("creates all four stores on a fresh install", async () => {
    // Any call triggers onupgradeneeded from version 0 → all blocks run.
    await db.saveSession({ id: "s1", name: "S1", steps: [] });
    // Reach into the opened DB and assert the stores exist.
    const dbi = await new Promise((resolve) => {
      const r = indexedDB.open("guidr", 4);
      r.onsuccess = () => resolve(r.result);
    });
    const names = [...dbi.objectStoreNames].sort();
    expect(names).toEqual(["gifs", "recordings", "sessions", "steps", "voiceRecordings"]);
  });

  it("getStepsForSession returns steps sorted by index", async () => {
    await db.saveSession({ id: "s1", name: "S1", steps: [] });
    await db.saveStep({ id: "b", sessionId: "s1", index: 2 });
    await db.saveStep({ id: "a", sessionId: "s1", index: 0 });
    await db.saveStep({ id: "c", sessionId: "s1", index: 1 });
    const steps = await db.getStepsForSession("s1");
    expect(steps.map((s) => s.id)).toEqual(["a", "c", "b"]);
  });

  it("mirrors session metadata (no blobs) into chrome.storage.local", async () => {
    await db.saveSession({ id: "s1", name: "Mirror me", steps: [{ id: "x" }] });
    const mirror = await db.getAllSessions();
    expect(mirror[0]).toMatchObject({ id: "s1", name: "Mirror me", stepCount: 1 });
    expect(mirror[0]).not.toHaveProperty("steps");
  });

  it("caches and clears per-step GIFs", async () => {
    await db.saveGif({ stepId: "st1", sessionId: "s1", dataUrl: "data:gif", startMs: 0, endMs: 100, fps: 10 });
    expect((await db.getGif("st1")).dataUrl).toBe("data:gif");
    await db.clearGif("st1");
    expect(await db.getGif("st1")).toBeUndefined();
  });

  it("deletes a session and cascades to its steps, gifs, and mirror", async () => {
    await db.saveSession({ id: "s1", name: "S1", steps: [] });
    await db.saveStep({ id: "st1", sessionId: "s1", index: 0 });
    await db.saveGif({ stepId: "st1", sessionId: "s1", dataUrl: "d", startMs: 0, endMs: 1, fps: 5 });
    await db.deleteSession("s1");
    expect(await db.getStep("st1")).toBeUndefined();
    expect(await db.getGif("st1")).toBeUndefined();
    expect(await db.getAllSessions()).toHaveLength(0);
  });
});

describe("db migration ladder", () => {
  beforeEach(() => {
    globalThis.__resetChromeStorage();
    resetDb();
  });

  it("wipes a legacy v1 database and rebuilds the v4 schema", async () => {
    // Build a v1 database with an incompatible store + stale mirror.
    await new Promise((resolve) => {
      const r = indexedDB.open("guidr", 1);
      r.onupgradeneeded = (e) => {
        e.target.result.createObjectStore("legacy", { keyPath: "id" });
      };
      r.onsuccess = () => {
        r.result.close();
        resolve();
      };
    });
    await chrome.storage.local.set({ guidr_sessions: [{ id: "old" }] });

    // Opening through db.js (version 4) must drop "legacy" and create the v4 stores.
    await db.saveSession({ id: "new", name: "New", steps: [] });

    const dbi = await new Promise((resolve) => {
      const r = indexedDB.open("guidr", 4);
      r.onsuccess = () => resolve(r.result);
    });
    const names = [...dbi.objectStoreNames];
    expect(names).not.toContain("legacy");
    expect(names).toEqual(expect.arrayContaining(["sessions", "steps", "recordings", "gifs", "voiceRecordings"]));
  });
});
