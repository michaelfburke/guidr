/**
 * db.js
 * Thin IndexedDB wrapper.
 *
 * Schema (v2):
 *   sessions   — { id, name, tabId, steps: [stepId], createdAt, updatedAt,
 *                  hasRecording, recordingBytes, recordingDurationMs }
 *   steps      — { id, sessionId, index, tsMs, target, url, pageTitle,
 *                  title, body, voiceoverScript, included, mediaMode,
 *                  annotations, enriched, enrichError }
 *   recordings — { id (= sessionId), blob, mimeType, durationMs, byteSize, createdAt }
 *
 * Sessions metadata (no blobs) is mirrored to chrome.storage.local for fast
 * listing without opening IDB.
 *
 * Upgrading from v1 wipes all prior data — the capture model has changed
 * (no more before/after screenshots; the source of truth is now a video
 * recording per session), so v1 records can't be played in the new UI.
 */

const DB_NAME = "guidr";
const DB_VERSION = 2;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      // Drop any pre-existing stores (v1 had screenshots inside steps).
      for (const name of [...db.objectStoreNames]) db.deleteObjectStore(name);

      const ss = db.createObjectStore("sessions", { keyPath: "id" });
      ss.createIndex("createdAt", "createdAt");

      const st = db.createObjectStore("steps", { keyPath: "id" });
      st.createIndex("sessionId", "sessionId");

      db.createObjectStore("recordings", { keyPath: "id" });

      // Clear the chrome.storage.local mirror so the home view doesn't show
      // dangling references to v1 sessions that no longer exist in IDB.
      chrome.storage.local.remove("guidr_sessions").catch(() => {});
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(storeName, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function txAll(storeName, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    const results = [];
    fn(store, results, resolve, reject);
  });
}

export const db = {
  // ─── Sessions ────────────────────────────────────────────────────────────

  async saveSession(session) {
    const now = Date.now();
    const toSave = {
      ...session,
      steps: session.steps?.map((s) => s.id || s) ?? [],
      createdAt: session.createdAt || now,
      updatedAt: now,
    };
    await tx("sessions", "readwrite", (store) => store.put(toSave));
    await mirrorSession(toSave);
  },

  async getSession(id) {
    return tx("sessions", "readonly", (store) => store.get(id));
  },

  async getAllSessions() {
    const meta = await chrome.storage.local.get("guidr_sessions");
    return meta.guidr_sessions || [];
  },

  async deleteSession(id) {
    await tx("sessions", "readwrite", (store) => store.delete(id));
    const steps = await this.getStepsForSession(id);
    for (const step of steps) await this.deleteStep(step.id);
    await this.deleteRecording(id);
    const meta = await chrome.storage.local.get("guidr_sessions");
    const list = (meta.guidr_sessions || []).filter((s) => s.id !== id);
    await chrome.storage.local.set({ guidr_sessions: list });
  },

  // ─── Steps ──────────────────────────────────────────────────────────────

  async saveStep(step) {
    await tx("steps", "readwrite", (store) => store.put(step));
  },

  async getStep(id) {
    return tx("steps", "readonly", (store) => store.get(id));
  },

  async getStepsForSession(sessionId) {
    return txAll("steps", "readonly", (store, results, resolve, reject) => {
      const index = store.index("sessionId");
      const req = index.openCursor(IDBKeyRange.only(sessionId));
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) { results.push(cursor.value); cursor.continue(); }
        else resolve(results.sort((a, b) => a.index - b.index));
      };
      req.onerror = () => reject(req.error);
    });
  },

  async deleteStep(id) {
    await tx("steps", "readwrite", (store) => store.delete(id));
  },

  // ─── Recordings (per-session webm blob) ─────────────────────────────────

  async saveRecording({ sessionId, blob, mimeType, durationMs }) {
    const record = {
      id: sessionId,
      blob,
      mimeType,
      durationMs,
      byteSize: blob.size,
      createdAt: Date.now(),
    };
    await tx("recordings", "readwrite", (store) => store.put(record));
    // Update session metadata + mirror so the home view can show size badges.
    const session = await this.getSession(sessionId);
    if (session) {
      session.hasRecording = true;
      session.recordingBytes = blob.size;
      session.recordingDurationMs = durationMs;
      await this.saveSession(session);
    }
    return record;
  },

  async getRecording(sessionId) {
    return tx("recordings", "readonly", (store) => store.get(sessionId));
  },

  async deleteRecording(sessionId) {
    await tx("recordings", "readwrite", (store) => store.delete(sessionId));
    const session = await this.getSession(sessionId);
    if (session && session.hasRecording) {
      session.hasRecording = false;
      session.recordingBytes = 0;
      session.recordingDurationMs = 0;
      await this.saveSession(session);
    }
  },

  // ─── Housekeeping ───────────────────────────────────────────────────────

  async estimateSize() {
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      return { usage: est.usage, quota: est.quota };
    }
    return null;
  },
};

// ─── Internal helpers ─────────────────────────────────────────────────────

async function mirrorSession(session) {
  const meta = await chrome.storage.local.get("guidr_sessions");
  const list = meta.guidr_sessions || [];
  const idx = list.findIndex((s) => s.id === session.id);
  const entry = {
    id: session.id,
    name: session.name,
    stepCount: session.steps.length,
    updatedAt: session.updatedAt,
    hasRecording: !!session.hasRecording,
    recordingBytes: session.recordingBytes || 0,
    recordingDurationMs: session.recordingDurationMs || 0,
  };
  if (idx === -1) list.unshift(entry);
  else list[idx] = entry;
  await chrome.storage.local.set({ guidr_sessions: list.slice(0, 200) });
}
