/**
 * Vitest global setup.
 *
 * Provides a minimal in-memory `chrome` stub and a real (fake) IndexedDB so the
 * extension's pure modules can be imported and exercised headlessly. Nothing
 * here ships with the extension — it exists only to make the modules testable
 * outside a browser.
 */
import "fake-indexeddb/auto";

// In-memory backing store for chrome.storage.local.
const store = new Map();

/**
 * Mimics chrome.storage.local's dual API: both callback-style
 * (`get(keys, cb)`) and promise-style (`await get(keys)`) are used across the
 * codebase, so the stub supports both.
 */
function read(keys) {
  const out = {};
  if (keys == null) {
    for (const [k, v] of store) out[k] = v;
  } else if (typeof keys === "string") {
    if (store.has(keys)) out[keys] = store.get(keys);
  } else if (Array.isArray(keys)) {
    for (const k of keys) if (store.has(k)) out[k] = store.get(k);
  } else if (typeof keys === "object") {
    for (const k of Object.keys(keys)) out[k] = store.has(k) ? store.get(k) : keys[k];
  }
  return out;
}

const local = {
  get(keys, cb) {
    const out = read(keys);
    if (typeof cb === "function") {
      cb(out);
      return undefined;
    }
    return Promise.resolve(out);
  },
  set(items, cb) {
    for (const [k, v] of Object.entries(items)) store.set(k, v);
    if (typeof cb === "function") {
      cb();
      return undefined;
    }
    return Promise.resolve();
  },
  remove(keys, cb) {
    const arr = Array.isArray(keys) ? keys : [keys];
    for (const k of arr) store.delete(k);
    if (typeof cb === "function") {
      cb();
      return undefined;
    }
    return Promise.resolve();
  },
  clear() {
    store.clear();
    return Promise.resolve();
  },
};

globalThis.chrome = {
  storage: { local },
  runtime: {
    sendMessage: () => Promise.resolve(null),
    onMessage: { addListener: () => {} },
    lastError: null,
  },
};

// Expose a reset hook so individual suites can start from a clean slate.
globalThis.__resetChromeStorage = () => store.clear();
