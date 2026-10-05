import { connectOpenRouter } from "../openrouter.js";
import { DEFAULT_MODELS, modelBelongsTo, keyFitsProvider } from "../llm.js";
import { listModels, cachedModels, estimateStepCost, normalizeModelId } from "../models.js";

const PROVIDER_LABELS = { anthropic: "an Anthropic", openai: "an OpenAI", gemini: "a Gemini", openrouter: "an OpenRouter" };
const PROVIDER_TITLES = { anthropic: "Anthropic", openai: "OpenAI", gemini: "Gemini", openrouter: "OpenRouter" };

const KEY_URLS = {
  anthropic:  "https://console.anthropic.com/settings/keys",
  openai:     "https://platform.openai.com/api-keys",
  gemini:     "https://aistudio.google.com/app/apikey",
  openrouter: "https://openrouter.ai/keys",
};

const KEY_PLACEHOLDERS = {
  anthropic:  "sk-ant-api03-…",
  openai:     "sk-proj-…",
  gemini:     "AIzaSy…",
  openrouter: "sk-or-v1-…",
};

// ── State ──────────────────────────────────────────────────────────────────
const BRAND_DEFAULTS = {
  brandCircleColor:    "#7c6af7",
  brandArrowColor:     "#f87171",
  brandHighlightColor: "#fbbf24",
};
let state = {
  provider: "openrouter",
  apiKey: "",
  model: DEFAULT_MODELS.gemini,
  openrouterModel: DEFAULT_MODELS.openrouter,
  toneGuide: "",
  exampleGuides: [],
  screenshotQuality: 72,
  maxImageWidth: 1024,
  ...BRAND_DEFAULTS,
};
let exampleGuides = [];

// ── Load ───────────────────────────────────────────────────────────────────
chrome.storage.local.get(Object.keys(state), (data) => {
  Object.assign(state, data);
  // First-time use: persist the default provider/model so the service worker
  // can dispatch enrichment even if the user never explicitly opens this
  // page (or opens it and only sets the API key). Otherwise llm.js gets a
  // bare `undefined` provider and throws "Unknown provider: undefined".
  const seed = {};
  if (data.provider === undefined) seed.provider = state.provider;
  if (data.model === undefined)    seed.model    = state.model;
  if (Object.keys(seed).length) chrome.storage.local.set(seed);
  applyState();
});

function applyState() {
  setProvider(state.provider, false);
  document.getElementById("apiKey").value = state.apiKey || "";
  document.getElementById("toneGuide").value = state.toneGuide || "";
  document.getElementById("screenshotQuality").value = state.screenshotQuality || 72;
  document.getElementById("qualityLabel").textContent = (state.screenshotQuality || 72) + "%";
  document.getElementById("maxImageWidth").value = String(state.maxImageWidth || 1024);
  exampleGuides = state.exampleGuides || [];
  renderExamples();
  updatePreview();
  estimateStorage();
  applyBrandingToInputs();
  updateAiState();
}

// Connection summary at the top of the provider page.
function updateAiState() {
  const el = document.getElementById("aiState");
  const text = document.getElementById("aiStateText");
  const name = PROVIDER_TITLES[state.provider];
  el.classList.remove("ok", "warn");
  if (!state.apiKey) {
    text.textContent = "Not connected. Steps keep their draft text until you connect a provider.";
  } else if (!keyFitsProvider(state.provider, state.apiKey)) {
    el.classList.add("warn");
    text.textContent = `The saved key isn't for ${name}. Add your ${name} key below.`;
  } else {
    el.classList.add("ok");
    text.textContent = `Connected to ${name}. Rewrite with AI is ready in the editor.`;
  }
  // Once connected, reconnecting is a secondary action.
  const connected = !!state.apiKey && state.provider === "openrouter" && keyFitsProvider("openrouter", state.apiKey);
  const btn = document.getElementById("connectOpenRouter");
  btn.textContent = connected ? "Reconnect OpenRouter" : "Connect OpenRouter";
  btn.classList.toggle("btn-primary", !connected);
  btn.classList.toggle("btn-ghost", connected);
}

// ── Navigation ─────────────────────────────────────────────────────────────
function showSection(name) {
  const link = document.querySelector(`nav a[data-section="${name}"]`);
  const section = document.getElementById(`section-${name}`);
  if (!link || !section) return;
  document.querySelectorAll("nav a").forEach((a) => a.classList.remove("active"));
  document.querySelectorAll("section").forEach((s) => s.classList.remove("active"));
  link.classList.add("active");
  section.classList.add("active");
}

document.querySelectorAll("nav a[data-section]").forEach((link) => {
  link.addEventListener("click", (e) => {
    e.preventDefault();
    showSection(link.dataset.section);
  });
});

// Deep link: editor's "Brand colors" shortcut opens options/index.html#branding.
if (location.hash) {
  const target = location.hash.replace(/^#/, "");
  if (document.getElementById(`section-${target}`)) showSection(target);
}

// "Back to guides": the guide list lives in the side panel, which is usually
// already open beside this tab, so opening it alone changes nothing visible.
// Open it, then close Settings (everything here auto-saves) to land back on
// the tab the user came from.
// chrome.sidePanel.open() must be called synchronously inside the user gesture;
// awaiting windows.getCurrent() first would consume the gesture and the call
// would be rejected. So we cache the window id up front.
let currentWindowId = null;
chrome.windows.getCurrent().then((w) => { currentWindowId = w?.id ?? null; }).catch(() => {});

document.getElementById("backToGuides")?.addEventListener("click", async (e) => {
  e.preventDefault();
  if (currentWindowId == null) return;
  try {
    await chrome.sidePanel.open({ windowId: currentWindowId });
  } catch (err) {
    console.warn("[Guidr] Could not open side panel:", err);
  }
  // Closing the window's last tab would close the window, panel included.
  const [tab, tabs] = await Promise.all([chrome.tabs.getCurrent(), chrome.tabs.query({ windowId: currentWindowId })]);
  if (tab && tabs.length > 1) chrome.tabs.remove(tab.id);
});

// ── Provider cards ─────────────────────────────────────────────────────────
document.querySelectorAll(".provider-card").forEach((card) => {
  card.addEventListener("click", () => setProvider(card.dataset.provider, true));
});

function setProvider(p, _updateInput = true) {
  state.provider = p;
  document.querySelectorAll(".provider-card").forEach((c) => {
    c.classList.toggle("selected", c.dataset.provider === p);
    c.querySelector("input").checked = c.dataset.provider === p;
  });
  // Key link
  document.getElementById("keyLink").href = KEY_URLS[p] || "#";
  document.getElementById("keyLink").textContent = `Get ${PROVIDER_LABELS[p]} key`;
  document.getElementById("apiKey").placeholder = KEY_PLACEHOLDERS[p] || "API key…";
  document.getElementById("connectOpenRouterRow").style.display = p === "openrouter" ? "" : "none";
  // Model picker: the provider's default right away, then the live list.
  const isOpenRouter = p === "openrouter";
  document.getElementById("modelSelect").style.display = isOpenRouter ? "none" : "";
  document.getElementById("openrouterModelRow").style.display = isOpenRouter ? "" : "none";
  if (isOpenRouter) {
    document.getElementById("openrouterModel").value = state.openrouterModel || DEFAULT_MODELS.openrouter;
  } else if (!modelBelongsTo(p, state.model)) {
    state.model = DEFAULT_MODELS[p];
  }
  cachedModels(p).then((cached) => { if (state.provider === p) renderModels(p, cached); });
  refreshModels(p);
  updateCostEstimate();
  updateAiState();
}


const modelLabel = (m) => (m.label && m.label !== m.id ? `${m.label} · ${m.id}` : m.id);

function renderModels(p, entry, error) {
  const status = document.getElementById("modelStatus");
  const models = entry?.models || [];
  if (p === "openrouter") {
    const list = document.getElementById("openrouterModels");
    list.innerHTML = "";
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m.id; opt.textContent = m.label;
      list.appendChild(opt);
    }
  } else {
    const sel = document.getElementById("modelSelect");
    const def = DEFAULT_MODELS[p];
    // The default may be an undated alias of a listed snapshot
    // (claude-haiku-4-5 vs claude-haiku-4-5-20251001): show it once.
    const isDefault = (m) => normalizeModelId(m.id) === normalizeModelId(def);
    const listed = models.find(isDefault);
    // A saved snapshot of the default (e.g. the old dated Haiku id) is the
    // same model: select the default entry rather than flag it unavailable.
    if (isDefault({ id: state.model })) state.model = def;
    const options = [{ id: def, text: `${listed ? `${listed.label} · ${def}` : def} · recommended` }];
    for (const m of models) if (!isDefault(m)) options.push({ id: m.id, text: modelLabel(m) });
    if (!options.some((o) => o.id === state.model)) {
      options.push({ id: state.model, text: `${state.model} · not offered to your key` });
    }
    sel.innerHTML = "";
    for (const o of options) {
      const opt = document.createElement("option");
      opt.value = o.id; opt.textContent = o.text;
      sel.appendChild(opt);
    }
    sel.value = state.model;
  }
  if (error) {
    status.className = "hint err";
    status.textContent = `Couldn't load the model list: ${error.message}`;
  } else if (models.length) {
    status.className = "hint";
    status.textContent = `${models.length} vision models available${p === "openrouter" ? "" : " to your key"} · updated daily`;
  } else {
    status.className = "hint";
    status.textContent = state.apiKey && p !== "openrouter" && !keyFitsProvider(p, state.apiKey)
      ? `Your saved key isn't for ${PROVIDER_LABELS[p].replace(/^an? /, "")}. Add one to see its models.`
      : "Test your key to see every model your account can use.";
  }
}

let modelsRequest = 0;
async function refreshModels(p, { force = false } = {}) {
  // The key is shared across providers: don't send one provider's key to another.
  if (p !== "openrouter" && (!state.apiKey || !keyFitsProvider(p, state.apiKey))) return;
  const req = ++modelsRequest;
  try {
    const entry = await listModels(p, state.apiKey, { force });
    if (req === modelsRequest && state.provider === p) renderModels(p, entry);
  } catch (e) {
    if (req === modelsRequest && state.provider === p) renderModels(p, await cachedModels(p), e);
  }
}

document.getElementById("modelSelect").addEventListener("change", () => {
  state.model = document.getElementById("modelSelect").value;
  updateCostEstimate();
});
document.getElementById("openrouterModel").addEventListener("change", updateCostEstimate);

let costRequest = 0;
async function updateCostEstimate() {
  const model = state.provider === "openrouter" ? state.openrouterModel : state.model;
  const el = document.getElementById("costEst");
  const bar = document.getElementById("costBar");
  const req = ++costRequest;
  let cost = null;
  try { cost = await estimateStepCost(model); } catch {}
  if (req !== costRequest) return;
  if (cost == null) {
    el.textContent = "—";
    el.title = "No public price found for this model";
    bar.style.width = "0%";
    return;
  }
  el.textContent = `~$${Number(cost.toPrecision(2))} / step`;
  el.title = "Estimate from OpenRouter's public price list: one screenshot and a short answer";
  // Budget bar: full at 2¢ per step.
  const pct = Math.max(4, Math.min(100, Math.round((cost / 0.02) * 100)));
  bar.style.width = pct + "%";
  bar.style.background = cost < 0.001 ? "var(--success)" : cost < 0.005 ? "var(--warn)" : "var(--error)";
}

// ── Key show/hide & test ───────────────────────────────────────────────────
document.getElementById("toggleKey").addEventListener("click", () => {
  const inp = document.getElementById("apiKey");
  const btn = document.getElementById("toggleKey");
  inp.type = inp.type === "password" ? "text" : "password";
  btn.textContent = inp.type === "password" ? "Show" : "Hide";
});

document.getElementById("testKey").addEventListener("click", async () => {
  const key = document.getElementById("apiKey").value.trim();
  const p = state.provider;
  const st = document.getElementById("keyStatus");
  if (!key) { st.className="status err"; st.textContent="Enter a key first."; return; }
  if (!keyFitsProvider(p, key)) {
    st.className = "status err";
    st.textContent = `That doesn't look like ${PROVIDER_LABELS[p]} key. Check the provider selected above.`;
    return;
  }
  st.className="status busy"; st.innerHTML='<span class="spinner"></span> Testing…';

  try {
    if (p === "openrouter") {
      // OpenRouter's model list is public, so check the key itself.
      const r = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${key}` } });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error?.message || `HTTP ${r.status}`);
    } else {
      // Listing models proves the key works and refreshes the picker.
      const entry = await listModels(p, key, { force: true });
      if (state.provider === p) renderModels(p, entry);
    }
    st.className = "status ok";
    st.textContent = "Key works and is saved";
    state.apiKey = key;
    autoSave({ apiKey: key }, "savedProvider");
    updateAiState();
  } catch (e) {
    st.className = "status err"; st.textContent = e.message;
  }
});

document.getElementById("connectOpenRouter").addEventListener("click", async () => {
  const btn = document.getElementById("connectOpenRouter");
  const st = document.getElementById("keyStatus");
  btn.disabled = true;
  st.className = "status busy"; st.innerHTML = '<span class="spinner"></span> Waiting for OpenRouter…';
  try {
    if (!(await connectOpenRouter())) { st.className = "status"; st.textContent = ""; return; }
    Object.assign(state, await chrome.storage.local.get(["provider", "apiKey", "openrouterModel"]));
    applyState();
    st.className = "status ok"; st.textContent = "Connected to OpenRouter";
    flashSaved("savedProvider");
  } catch (e) {
    st.className = "status err"; st.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
});

// ── Tone preview ───────────────────────────────────────────────────────────
document.getElementById("toneGuide").addEventListener("input", updatePreview);
function updatePreview() {
  const guide = document.getElementById("toneGuide").value.trim();
  const preview = document.getElementById("promptPreview");
  if (guide) {
    preview.textContent = `[System prompt will include]\n\n## Tone & style\n${guide}`;
  } else {
    preview.textContent = "[Default tone will be used when no guide is set]";
  }
}

// ── Examples ──────────────────────────────────────────────────────────────
const URL_SNIPPET_MAX = 4000;

document.getElementById("addExampleBtn").addEventListener("click", async () => {
  if (exampleGuides.length >= 3) {
    await notifyModal({ title: "Maximum reached", body: "You can have up to 3 examples. Remove one before adding another." });
    return;
  }
  document.getElementById("exampleForm").style.display = "";
  document.getElementById("urlForm").style.display = "none";
});
document.getElementById("cancelExampleBtn").addEventListener("click", () => {
  document.getElementById("exampleForm").style.display = "none";
  clearExampleForm();
});
document.getElementById("saveExampleBtn").addEventListener("click", async () => {
  const title = document.getElementById("exTitle").value.trim();
  const body  = document.getElementById("exBody").value.trim();
  if (!title || !body) {
    await notifyModal({ title: "Missing fields", body: "Both title and body are required to add an example." });
    return;
  }
  exampleGuides.push({ title, body });
  renderExamples();
  autoSave({ exampleGuides }, "savedExamples");
  document.getElementById("exampleForm").style.display = "none";
  clearExampleForm();
});
function clearExampleForm() {
  ["exTitle","exBody"].forEach(id => document.getElementById(id).value = "");
}

// Reference-URL form
document.getElementById("addUrlBtn").addEventListener("click", async () => {
  if (exampleGuides.length >= 3) {
    await notifyModal({ title: "Maximum reached", body: "You can have up to 3 examples. Remove one before adding another." });
    return;
  }
  document.getElementById("urlForm").style.display = "";
  document.getElementById("exampleForm").style.display = "none";
  document.getElementById("urlStatus").textContent = "";
});
document.getElementById("cancelUrlBtn").addEventListener("click", () => {
  document.getElementById("urlForm").style.display = "none";
  document.getElementById("exUrl").value = "";
  document.getElementById("urlStatus").textContent = "";
});
document.getElementById("fetchUrlBtn").addEventListener("click", async () => {
  const urlInput = document.getElementById("exUrl");
  const st = document.getElementById("urlStatus");
  const raw = urlInput.value.trim();
  if (!/^https?:\/\//i.test(raw)) {
    st.className = "status err"; st.textContent = "Enter a full https:// URL.";
    return;
  }
  st.className = "status busy"; st.innerHTML = '<span class="spinner"></span> Fetching…';
  // Ensure we have permission to read the URL host — request on demand.
  try {
    const granted = await chrome.permissions.request({ origins: [new URL(raw).origin + "/*"] });
    if (!granted) {
      st.className = "status err";
      st.textContent = "Host permission denied — can't fetch this URL.";
      return;
    }
  } catch {
    // Older chrome versions or non-extension contexts fall through.
  }
  try {
    const res = await fetch(raw, { credentials: "omit" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const snippet = htmlToText(html).slice(0, URL_SNIPPET_MAX);
    if (!snippet) throw new Error("page had no readable text");
    exampleGuides.push({
      kind: "url",
      url: raw,
      fetchedAt: Date.now(),
      textSnippet: snippet,
    });
    renderExamples();
    autoSave({ exampleGuides }, "savedExamples");
    document.getElementById("urlForm").style.display = "none";
    urlInput.value = "";
    st.textContent = "";
  } catch (e) {
    st.className = "status err";
    st.textContent = `Couldn't read that page (${e.message}). Try a different URL or add an inline example.`;
  }
});

// Minimal HTML → text sanitizer. Strips scripts/styles, removes tags,
// collapses whitespace. Not bullet-proof, but enough for help-center articles.
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function renderExamples() {
  const list = document.getElementById("examplesList");
  if (!exampleGuides.length) {
    list.innerHTML='<li style="color:var(--muted);font-size:13px;padding:6px 0">No examples added yet.</li>';
    return;
  }
  list.innerHTML = "";
  exampleGuides.forEach((ex, i) => {
    const li = document.createElement("li");
    li.className = "example-item";
    if (ex.kind === "url") {
      const host = (() => { try { return new URL(ex.url).hostname; } catch { return ex.url; } })();
      const preview = (ex.textSnippet || "").slice(0, 140);
      li.innerHTML = `
        <div class="example-item-body">
          <strong><svg class="ico ico-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg> ${escHtml(host)}</strong>
          <span>${escHtml(preview)}…</span>
        </div>
        <button title="Remove" data-i="${i}">×</button>`;
    } else {
      li.innerHTML = `
        <div class="example-item-body">
          <strong>${escHtml(ex.title)}</strong>
          <span>${escHtml(ex.body)}</span>
        </div>
        <button title="Remove" data-i="${i}">×</button>`;
    }
    list.appendChild(li);
  });
  list.querySelectorAll("button[data-i]").forEach(btn => {
    btn.addEventListener("click", () => {
      exampleGuides.splice(Number(btn.dataset.i), 1);
      renderExamples();
      autoSave({ exampleGuides }, "savedExamples");
    });
  });
}

// ── Recording / microphone access ──────────────────────────────────────────
// Chrome side panels can't show the mic permission prompt — getUserMedia
// rejects with NotAllowedError before any prompt UI appears. The options page
// is a normal extension tab, so prompts work reliably here. After the user
// grants once, the permission applies to the entire extension origin
// (side panel, offscreen, popup — all of them).
const micBtn    = document.getElementById("enableMicBtn");
const micStatus = document.getElementById("micStatus");

refreshMicStatus();

micBtn?.addEventListener("click", async () => {
  micBtn.disabled = true;
  setMicStatus("Requesting…", "");
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // We don't need the stream — just the permission grant. Stop tracks
    // immediately so the OS mic indicator turns off.
    stream.getTracks().forEach((t) => t.stop());
    // Granting here is how the side panel's narration switch gets turned on.
    await chrome.storage.local.set({ narrationEnabled: true });
    setMicStatus("Microphone allowed. Narration is on; switch it off under the record button.", "ok");
  } catch (err) {
    console.warn(`[Guidr/options] mic getUserMedia failed: ${err?.name} — ${err?.message}`);
    if (err?.name === "NotAllowedError") {
      setMicStatus(
        "Permission was blocked. Open chrome://settings/content/microphone, remove any Block entry for Guidr, then try again.",
        "err"
      );
    } else if (err?.name === "NotFoundError") {
      setMicStatus("No microphone detected on this device.", "err");
    } else {
      setMicStatus(`Microphone unavailable (${err?.name || "unknown"}).`, "err");
    }
  } finally {
    micBtn.disabled = false;
    refreshMicStatus();
  }
});

async function refreshMicStatus() {
  if (!micBtn || !micStatus) return;
  let state = null;
  try {
    state = (await navigator.permissions.query({ name: "microphone" })).state;
  } catch {}
  if (state === "granted") {
    micBtn.textContent = "Microphone enabled ✓";
    micBtn.classList.remove("btn-primary");
    micBtn.classList.add("btn-ghost");
    if (!micStatus.textContent) setMicStatus("Microphone enabled — narration will record from the side panel.", "ok");
  } else if (state === "denied") {
    micBtn.textContent = "Retry permission";
    micBtn.classList.add("btn-primary");
    micBtn.classList.remove("btn-ghost");
    if (!micStatus.textContent) setMicStatus("Permission is blocked at the browser level. Clear it in chrome://settings/content/microphone first.", "err");
  } else {
    micBtn.textContent = "Enable microphone";
    micBtn.classList.add("btn-primary");
    micBtn.classList.remove("btn-ghost");
  }
}

function setMicStatus(text, kind) {
  if (!micStatus) return;
  micStatus.textContent = text;
  micStatus.classList.remove("ok", "err");
  if (kind) micStatus.classList.add(kind);
}

// ── Storage ────────────────────────────────────────────────────────────────
async function estimateStorage() {
  if (!navigator.storage?.estimate) return;
  const { usage, quota } = await navigator.storage.estimate();
  const pct = quota ? Math.round((usage / quota) * 100) : 0;
  const mbUsed = (usage / 1024 / 1024).toFixed(1);
  const mbQuota = (quota / 1024 / 1024 / 1024).toFixed(1);
  document.getElementById("storageInfo").innerHTML =
    `<span class="pill"><span class="dot" style="background:${pct>80?'var(--error)':'var(--success)'}"></span>
     ${mbUsed} MB used · ${mbQuota} GB quota</span>`;
}

document.getElementById("screenshotQuality").addEventListener("input", function() {
  document.getElementById("qualityLabel").textContent = this.value + "%";
});

document.getElementById("clearDataBtn").addEventListener("click", async () => {
  const ok = await confirmModal({
    title: "Clear all Guidr data?",
    body: "This deletes every guide, step, recording and setting. It cannot be undone.",
    confirmLabel: "Clear everything",
    danger: true,
  });
  if (!ok) return;
  await chrome.storage.local.clear();
  // Clear IndexedDB
  indexedDB.deleteDatabase("guidr");
  await notifyModal({
    title: "Cleared",
    body: "All Guidr data has been removed from this browser.",
    confirmLabel: "OK",
  });
  location.reload(); // show the cleared settings, not the ones still in memory
});

// ── Auto-save plumbing ─────────────────────────────────────────────────────
function flashSaved(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2500);
}

function autoSave(patch, savedId) {
  chrome.storage.local.set(patch, () => flashSaved(savedId));
}

// Per-section debouncer so rapid edits don't write every keystroke.
const saveTimers = {};
function debouncedSave(key, patch, savedId, ms = 600) {
  clearTimeout(saveTimers[key]);
  saveTimers[key] = setTimeout(() => autoSave(patch, savedId), ms);
}

// Provider section — selecting a card/model writes immediately.
document.querySelectorAll(".provider-card").forEach((card) => {
  card.addEventListener("click", () => {
    autoSave({ provider: state.provider, model: state.model }, "savedProvider");
  });
});
document.getElementById("modelSelect").addEventListener("change", () => {
  state.model = document.getElementById("modelSelect").value;
  autoSave({ model: state.model }, "savedProvider");
});
document.getElementById("openrouterModel").addEventListener("input", (e) => {
  state.openrouterModel = e.target.value.trim();
  debouncedSave("openrouterModel", { openrouterModel: state.openrouterModel }, "savedProvider");
});

// API key — only persist on blur or after a successful Test.
document.getElementById("apiKey").addEventListener("blur", () => {
  const key = document.getElementById("apiKey").value.trim();
  if (!key || key === state.apiKey) return;
  state.apiKey = key;
  autoSave({ apiKey: key }, "savedProvider");
  refreshModels(state.provider, { force: true });
  updateAiState();
});

// Tone — debounced on input.
document.getElementById("toneGuide").addEventListener("input", () => {
  debouncedSave("tone", { toneGuide: document.getElementById("toneGuide").value.trim() }, "savedTone");
});

// Advanced — slider + width.
document.getElementById("screenshotQuality").addEventListener("input", () => {
  const v = Number(document.getElementById("screenshotQuality").value);
  debouncedSave("ssq", { screenshotQuality: v }, "savedAdvanced", 300);
});
document.getElementById("maxImageWidth").addEventListener("change", () => {
  autoSave({ maxImageWidth: Number(document.getElementById("maxImageWidth").value) }, "savedAdvanced");
});

function escHtml(s) {
  return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ── In-page confirm / notify modal ─────────────────────────────────────────
const modalBackdrop = document.getElementById("modalBackdrop");
const modalTitleEl  = document.getElementById("modalTitle");
const modalBodyEl   = document.getElementById("modalBody");
const modalConfirm  = document.getElementById("modalConfirm");
const modalCancel   = document.getElementById("modalCancel");
let modalResolver = null;

function closeModal(result) {
  modalBackdrop.classList.remove("open");
  document.removeEventListener("keydown", onModalKey);
  if (modalResolver) { modalResolver(result); modalResolver = null; }
}
function onModalKey(e) {
  if (e.key === "Escape") closeModal(false);
  else if (e.key === "Enter") closeModal(true);
}
modalCancel.addEventListener("click", () => closeModal(false));
modalConfirm.addEventListener("click", () => closeModal(true));
modalBackdrop.addEventListener("click", (e) => {
  if (e.target === modalBackdrop) closeModal(false);
});

function confirmModal({ title, body, confirmLabel = "OK", cancelLabel = "Cancel", danger = false }) {
  modalTitleEl.textContent = title;
  modalBodyEl.textContent  = body;
  modalConfirm.textContent = confirmLabel;
  modalCancel.textContent  = cancelLabel;
  modalConfirm.classList.toggle("danger", danger);
  modalConfirm.classList.toggle("primary", !danger);
  modalCancel.style.display = "";
  modalBackdrop.classList.add("open");
  document.addEventListener("keydown", onModalKey);
  modalConfirm.focus();
  return new Promise((resolve) => { modalResolver = resolve; });
}

function notifyModal({ title, body, confirmLabel = "OK" }) {
  modalTitleEl.textContent = title;
  modalBodyEl.textContent  = body;
  modalConfirm.textContent = confirmLabel;
  modalConfirm.classList.remove("danger");
  modalConfirm.classList.add("primary");
  modalCancel.style.display = "none";
  modalBackdrop.classList.add("open");
  document.addEventListener("keydown", onModalKey);
  modalConfirm.focus();
  return new Promise((resolve) => { modalResolver = resolve; });
}

// ── Branding (annotation color customization) ─────────────────────────────
const BRAND_FIELDS = [
  { key: "brandCircleColor",    pickerId: "brandCircleColor",    hexId: "brandCircleHex"    },
  { key: "brandArrowColor",     pickerId: "brandArrowColor",     hexId: "brandArrowHex"     },
  { key: "brandHighlightColor", pickerId: "brandHighlightColor", hexId: "brandHighlightHex" },
];

function applyBrandingToInputs() {
  BRAND_FIELDS.forEach(({ key, pickerId, hexId }) => {
    const val = state[key] || BRAND_DEFAULTS[key];
    document.getElementById(pickerId).value = val;
    document.getElementById(hexId).value = val;
  });
  drawBrandPreview();
}

const HEX_RE = /^#([0-9a-fA-F]{6})$/;

function persistBranding() {
  const payload = {};
  BRAND_FIELDS.forEach(({ key }) => { payload[key] = state[key] || BRAND_DEFAULTS[key]; });
  debouncedSave("branding", payload, "savedBranding", 400);
}

BRAND_FIELDS.forEach(({ key, pickerId, hexId }) => {
  const picker = document.getElementById(pickerId);
  const hexIn  = document.getElementById(hexId);
  picker.addEventListener("input", () => {
    state[key] = picker.value;
    hexIn.value = picker.value;
    drawBrandPreview();
    persistBranding();
  });
  hexIn.addEventListener("input", () => {
    const v = hexIn.value.trim();
    if (HEX_RE.test(v)) {
      state[key] = v.toLowerCase();
      picker.value = state[key];
      drawBrandPreview();
      persistBranding();
    }
  });
});

document.getElementById("resetBranding").addEventListener("click", () => {
  Object.assign(state, BRAND_DEFAULTS);
  applyBrandingToInputs();
  persistBranding();
});

function drawBrandPreview() {
  const canvas = document.getElementById("brandPreview");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  // Subtle backdrop grid
  ctx.fillStyle = "#17171f";
  ctx.fillRect(0, 0, W, H);

  // Highlight box on the left
  const hx = 30, hy = 28, hw = 90, hh = 64;
  ctx.fillStyle   = state.brandHighlightColor + "33";
  ctx.fillRect(hx, hy, hw, hh);
  ctx.strokeStyle = state.brandHighlightColor;
  ctx.lineWidth   = 2;
  ctx.strokeRect(hx, hy, hw, hh);

  // Arrow in the middle
  const ax1 = 160, ay1 = 90, ax2 = 240, ay2 = 30;
  ctx.strokeStyle = state.brandArrowColor;
  ctx.fillStyle   = state.brandArrowColor;
  ctx.lineWidth   = 2.5;
  ctx.lineCap     = "round";
  ctx.beginPath();
  ctx.moveTo(ax1, ay1);
  ctx.lineTo(ax2, ay2);
  ctx.stroke();
  const angle = Math.atan2(ay2 - ay1, ax2 - ax1);
  const headLen = 12;
  ctx.beginPath();
  ctx.moveTo(ax2, ay2);
  ctx.lineTo(ax2 - headLen * Math.cos(angle - 0.4), ay2 - headLen * Math.sin(angle - 0.4));
  ctx.lineTo(ax2 - headLen * Math.cos(angle + 0.4), ay2 - headLen * Math.sin(angle + 0.4));
  ctx.closePath();
  ctx.fill();

  // Numbered circle on the right
  const cx = 340, cy = 60, r = 22;
  ctx.beginPath();
  ctx.arc(cx, cy, r + 8, 0, Math.PI * 2);
  ctx.fillStyle = state.brandCircleColor + "22";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = state.brandCircleColor + "cc";
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.fillStyle = "#fff";
  ctx.font = "bold 18px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("1", cx, cy + 1);
}
