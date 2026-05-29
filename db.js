/**
 * db.js
 * Thin IndexedDB wrapper.
 *
 * Schema (v3):
 *   sessions   — { id, name, tabId, steps: [stepId], createdAt, updatedAt,
 *                  hasRecording, recordingBytes, recordingDurationMs }
 *   steps      — { id, sessionId, index, tsMs, target, url, pageTitle,
 *                  title, body, voiceoverScript, included, mediaMode,
 *                  annotations, enriched, enrichError,
 *                  gifStartMs, gifEndMs, gifFps }
 *   recordings — { id (= sessionId), blob, mimeType, durationMs, byteSize, createdAt }
 *   gifs       — { id (= stepId), sessionId, dataUrl, byteSize,
 *                  startMs, endMs, fps, createdAt }
 *
 * Sessions metadata (no blobs) is mirrored to chrome.storage.local for fast
 * listing without opening IDB.
 *
 * v1 → v2 wiped all data (capture model changed). v2 → v3 is additive: it
 * only creates the new `gifs` store; existing sessions/steps/recordings are
 * preserved.
 */

const DB_NAME = "guidr";
const DB_VERSION = 3;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      const oldVersion = e.oldVersion || 0;

      if (oldVersion < 2) {
        // Fresh install or v1 → drop everything (v1 had screenshots inside
        // steps, incompatible with the video-centric model).
        for (const name of [...db.objectStoreNames]) db.deleteObjectStore(name);

        const ss = db.createObjectStore("sessions", { keyPath: "id" });
        ss.createIndex("createdAt", "createdAt");

        const st = db.createObjectStore("steps", { keyPath: "id" });
        st.createIndex("sessionId", "sessionId");

        db.createObjectStore("recordings", { keyPath: "id" });

        chrome.storage.local.remove("guidr_sessions").catch(() => {});
      }

      if (oldVersion < 3) {
        // Additive: per-step encoded GIF cache, keyed by step id. Indexed by
        // sessionId so deleting a session can sweep its GIFs cheaply.
        const g = db.createObjectStore("gifs", { keyPath: "id" });
        g.createIndex("sessionId", "sessionId");
      }
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
    await this.deleteGifsForSession(id);
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
    await tx("gifs", "readwrite", (store) => store.delete(id)).catch(() => {});
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

  // ─── GIFs (per-step encoded clip cache) ─────────────────────────────────
  // Encoding a 2–3s GIF takes a few seconds in the worker, so we cache the
  // dataURL keyed by step id. Callers must invalidate when start/end/fps
  // change (see clearGif below).

  async saveGif({ stepId, sessionId, dataUrl, startMs, endMs, fps }) {
    const record = {
      id: stepId,
      sessionId,
      dataUrl,
      byteSize: dataUrl.length,
      startMs, endMs, fps,
      createdAt: Date.now(),
    };
    await tx("gifs", "readwrite", (store) => store.put(record));
    return record;
  },

  async getGif(stepId) {
    return tx("gifs", "readonly", (store) => store.get(stepId));
  },

  async clearGif(stepId) {
    await tx("gifs", "readwrite", (store) => store.delete(stepId));
  },

  async deleteGifsForSession(sessionId) {
    await txAll("gifs", "readwrite", (store, _results, resolve, reject) => {
      const index = store.index("sessionId");
      const req = index.openCursor(IDBKeyRange.only(sessionId));
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) { cursor.delete(); cursor.continue(); }
        else resolve();
      };
      req.onerror = () => reject(req.error);
    });
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
