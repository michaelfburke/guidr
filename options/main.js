// Cost estimates per 1000 tokens (USD) — rough, for display only
const COST_MAP = {
  "claude-haiku-4-5-20251001": { in: 0.00025, out: 0.00125, label: "~$0.002 / step" },
  "claude-sonnet-4-6":         { in: 0.003,   out: 0.015,   label: "~$0.02 / step" },
  "claude-opus-4-7":           { in: 0.015,   out: 0.075,   label: "~$0.08 / step" },
  "gpt-4o-mini":               { in: 0.00015, out: 0.0006,  label: "~$0.001 / step" },
  "gpt-4o":                    { in: 0.0025,  out: 0.01,    label: "~$0.015 / step" },
  "gemini-2.5-flash":          { in: 0.0003,  out: 0.0025,  label: "~$0.001 / step" },
  "gemini-2.5-flash-lite":     { in: 0.0001,  out: 0.0004,  label: "~$0.0005 / step" },
  "gemini-2.5-pro":            { in: 0.00125, out: 0.01,    label: "~$0.012 / step" },
  "gemini-2.0-flash":          { in: 0.0001,  out: 0.0004,  label: "~$0.001 / step" },
};

const MODEL_LISTS = {
  anthropic: [
    { value: "claude-haiku-4-5-20251001",  label: "Claude Haiku · fast · recommended" },
    { value: "claude-sonnet-4-6",           label: "Claude Sonnet · balanced" },
    { value: "claude-opus-4-7",             label: "Claude Opus · highest quality" },
  ],
  openai: [
    { value: "gpt-4o-mini", label: "GPT-4o Mini · fast · recommended" },
    { value: "gpt-4o",      label: "GPT-4o · higher quality" },
  ],
  gemini: [
    { value: "gemini-2.5-flash",       label: "Gemini 2.5 Flash · fast · recommended" },
    { value: "gemini-2.5-pro",         label: "Gemini 2.5 Pro · highest quality" },
    { value: "gemini-2.5-flash-lite",  label: "Gemini 2.5 Flash Lite · cheapest" },
    { value: "gemini-2.0-flash",       label: "Gemini 2.0 Flash · legacy" },
  ],
  openrouter: [],
};

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
  provider: "gemini",
  apiKey: "",
  model: "gemini-2.5-flash",
  openrouterModel: "google/gemini-2.0-flash-001",
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
}

// ── Navigation ─────────────────────────────────────────────────────────────
document.querySelectorAll("nav a[data-section]").forEach((link) => {
  link.addEventListener("click", (e) => {
    e.preventDefault();
    document.querySelectorAll("nav a").forEach((a) => a.classList.remove("active"));
    document.querySelectorAll("section").forEach((s) => s.classList.remove("active"));
    link.classList.add("active");
    document.getElementById(`section-${link.dataset.section}`).classList.add("active");
  });
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
  document.getElementById("keyLink").textContent = `Get ${p.charAt(0).toUpperCase() + p.slice(1)} key`;
  document.getElementById("apiKey").placeholder = KEY_PLACEHOLDERS[p] || "API key…";
  // Model select
  const models = MODEL_LISTS[p] || [];
  const sel = document.getElementById("modelSelect");
  sel.innerHTML = "";
  if (models.length) {
    models.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.value; opt.textContent = m.label;
      sel.appendChild(opt);
    });
    const valid = models.some((m) => m.value === state.model);
    sel.value = valid ? state.model : models[0].value;
    state.model = sel.value;
    sel.style.display = "";
    document.getElementById("openrouterModelRow").style.display = "none";
  } else {
    // OpenRouter: free text
    sel.style.display = "none";
    document.getElementById("openrouterModelRow").style.display = "";
    document.getElementById("openrouterModel").value = state.openrouterModel || "";
  }
  updateCostEstimate();
}

document.getElementById("modelSelect").addEventListener("change", () => {
  state.model = document.getElementById("modelSelect").value;
  updateCostEstimate();
});

function updateCostEstimate() {
  const model = state.model || document.getElementById("modelSelect").value;
  const cost = COST_MAP[model];
  const el = document.getElementById("costEst");
  const bar = document.getElementById("costBar");
  if (cost) {
    el.textContent = cost.label;
    // Budget bar: 0 = green (cheap), 100 = red (expensive)
    const vals = Object.values(COST_MAP).map(c => parseFloat(c.label.replace(/[^0-9.]/g,"")));
    const max = Math.max(...vals);
    const val = parseFloat(cost.label.replace(/[^0-9.]/g,""));
    const pct = Math.round((val / max) * 100);
    bar.style.width = pct + "%";
    bar.style.background = pct < 33 ? "var(--success)" : pct < 66 ? "var(--warn)" : "var(--error)";
  } else {
    el.textContent = "—";
  }
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
  st.className="status busy"; st.innerHTML='<span class="spinner"></span> Testing…';

  try {
    let ok = false, errMsg = "";
    if (p === "anthropic") {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST", headers:{"Content-Type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01"},
        body:JSON.stringify({model:"claude-haiku-4-5-20251001",max_tokens:5,messages:[{role:"user",content:"Hi"}]})
      });
      ok = r.ok; if (!ok) errMsg = (await r.json().catch(()=>({}))).error?.message || r.status;
    } else if (p === "openai") {
      const r = await fetch("https://api.openai.com/v1/models",{headers:{Authorization:`Bearer ${key}`}});
      ok = r.ok; if (!ok) errMsg = (await r.json().catch(()=>({}))).error?.message || r.status;
    } else if (p === "gemini") {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
      ok = r.ok; if (!ok) errMsg = (await r.json().catch(()=>({}))).error?.message || r.status;
    } else if (p === "openrouter") {
      const r = await fetch("https://openrouter.ai/api/v1/models",{headers:{Authorization:`Bearer ${key}`}});
      ok = r.ok; if (!ok) errMsg = (await r.json().catch(()=>({}))).error?.message || r.status;
    }
    st.className = ok ? "status ok" : "status err";
    st.textContent = ok ? "Key valid" : String(errMsg);
    if (ok) autoSave({ apiKey: key }, "savedProvider");
  } catch(e) {
    st.className = "status err"; st.textContent = e.message;
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
    setMicStatus("Microphone enabled — narration will record from the side panel.", "ok");
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
  if (!key) return;
  autoSave({ apiKey: key }, "savedProvider");
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
