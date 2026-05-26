/**
 * db.js
 * Thin IndexedDB wrapper.
 *
 * Schema:
 *   sessions  — { id, name, tabId, steps: [stepId], createdAt, updatedAt }
 *   steps     — { id, sessionId, index, target, url, pageTitle, timestamp,
 *                 screenshotBefore, screenshotAfter, title, body,
 *                 voiceoverScript, enriched, enrichError }
 *
 * chrome.storage.local is limited to ~10MB so we use IndexedDB for blobs.
 * Sessions metadata (no screenshots) is also mirrored to chrome.storage.local
 * for fast listing without opening IDB.
 */

const DB_NAME = "guidr";
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("sessions")) {
        const ss = db.createObjectStore("sessions", { keyPath: "id" });
        ss.createIndex("createdAt", "createdAt");
      }
      if (!db.objectStoreNames.contains("steps")) {
        const st = db.createObjectStore("steps", { keyPath: "id" });
        st.createIndex("sessionId", "sessionId");
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

// ─── Sessions ─────────────────────────────────────────────────────────────────

export const db = {
  async saveSession(session) {
    const now = Date.now();
    const toSave = {
      ...session,
      steps: session.steps?.map((s) => s.id || s) ?? [], // store only IDs
      createdAt: session.createdAt || now,
      updatedAt: now,
    };
    await tx("sessions", "readwrite", (store) => store.put(toSave));
    // Mirror lightweight metadata to chrome.storage for fast listing
    const meta = await chrome.storage.local.get("guidr_sessions");
    const list = meta.guidr_sessions || [];
    const idx = list.findIndex((s) => s.id === session.id);
    const entry = { id: toSave.id, name: toSave.name, stepCount: toSave.steps.length, updatedAt: now };
    if (idx === -1) list.unshift(entry);
    else list[idx] = entry;
    await chrome.storage.local.set({ guidr_sessions: list.slice(0, 200) }); // cap at 200
  },

  async getSession(id) {
    return tx("sessions", "readonly", (store) => store.get(id));
  },

  async getAllSessions() {
    // Return lightweight list from chrome.storage
    const meta = await chrome.storage.local.get("guidr_sessions");
    return meta.guidr_sessions || [];
  },

  async deleteSession(id) {
    await tx("sessions", "readwrite", (store) => store.delete(id));
    // Delete all steps
    const steps = await this.getStepsForSession(id);
    for (const step of steps) await this.deleteStep(step.id);
    // Update mirror
    const meta = await chrome.storage.local.get("guidr_sessions");
    const list = (meta.guidr_sessions || []).filter((s) => s.id !== id);
    await chrome.storage.local.set({ guidr_sessions: list });
  },

  // ─── Steps ──────────────────────────────────────────────────────────────────

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

  // ─── Screenshot retrieval (large blobs, called on demand) ───────────────────

  async getScreenshot(stepId, which = "after") {
    const step = await this.getStep(stepId);
    if (!step) return null;
    return which === "before" ? step.screenshotBefore : step.screenshotAfter;
  },

  // ─── Housekeeping ────────────────────────────────────────────────────────────

  /** Estimate total IndexedDB size (rough) */
  async estimateSize() {
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      return { usage: est.usage, quota: est.quota };
    }
    return null;
  },

  /** Delete sessions older than maxAgeDays that have been exported */
  async pruneOldSessions(maxAgeDays = 30) {
    const sessions = await this.getAllSessions();
    const cutoff = Date.now() - maxAgeDays * 86400 * 1000;
    for (const s of sessions) {
      if (s.updatedAt < cutoff && s.exported) {
        await this.deleteSession(s.id);
      }
    }
  },
};
