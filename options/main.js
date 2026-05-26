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
  provider: "anthropic",
  apiKey: "",
  model: "claude-haiku-4-5-20251001",
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

function setProvider(p, updateInput = true) {
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
    sel.value = state.model || models[0].value;
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
document.getElementById("addExampleBtn").addEventListener("click", () => {
  if (exampleGuides.length >= 3) { alert("Max 3 examples."); return; }
  document.getElementById("exampleForm").style.display = "";
  document.getElementById("addExampleBtn").style.display = "none";
});
document.getElementById("cancelExampleBtn").addEventListener("click", () => {
  document.getElementById("exampleForm").style.display = "none";
  document.getElementById("addExampleBtn").style.display = "";
  clearExampleForm();
});
document.getElementById("saveExampleBtn").addEventListener("click", () => {
  const title = document.getElementById("exTitle").value.trim();
  const body  = document.getElementById("exBody").value.trim();
  const voice = document.getElementById("exVoice").value.trim();
  if (!title || !body) { alert("Title and body are required."); return; }
  exampleGuides.push({ title, body, voiceoverScript: voice || body });
  renderExamples();
  document.getElementById("exampleForm").style.display = "none";
  document.getElementById("addExampleBtn").style.display = "";
  clearExampleForm();
});
function clearExampleForm() {
  ["exTitle","exBody","exVoice"].forEach(id => document.getElementById(id).value = "");
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
    li.innerHTML = `
      <div class="example-item-body">
        <strong>${escHtml(ex.title)}</strong>
        <span>${escHtml(ex.body)}</span>
      </div>
      <button title="Remove" data-i="${i}">×</button>`;
    list.appendChild(li);
  });
  list.querySelectorAll("button[data-i]").forEach(btn => {
    btn.addEventListener("click", () => {
      exampleGuides.splice(Number(btn.dataset.i), 1);
      renderExamples();
    });
  });
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
  if (!confirm("This will delete ALL guides, steps, and screenshots. Cannot be undone.")) return;
  await chrome.storage.local.clear();
  // Clear IndexedDB
  indexedDB.deleteDatabase("guidr");
  alert("All data cleared.");
});

// ── Save buttons ───────────────────────────────────────────────────────────
function flashSaved(id) {
  const el = document.getElementById(id);
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2500);
}

document.getElementById("saveProvider").addEventListener("click", () => {
  chrome.storage.local.set({
    provider: state.provider,
    apiKey: document.getElementById("apiKey").value.trim(),
    model: document.getElementById("modelSelect").value || state.model,
    openrouterModel: document.getElementById("openrouterModel").value.trim(),
  }, () => flashSaved("savedProvider"));
});

document.getElementById("saveTone").addEventListener("click", () => {
  chrome.storage.local.set({ toneGuide: document.getElementById("toneGuide").value.trim() },
    () => flashSaved("savedTone"));
});

document.getElementById("saveExamples").addEventListener("click", () => {
  chrome.storage.local.set({ exampleGuides }, () => flashSaved("savedExamples"));
});

document.getElementById("saveAdvanced").addEventListener("click", () => {
  chrome.storage.local.set({
    screenshotQuality: Number(document.getElementById("screenshotQuality").value),
    maxImageWidth: Number(document.getElementById("maxImageWidth").value),
  }, () => flashSaved("savedAdvanced"));
});

function escHtml(s) {
  return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
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

BRAND_FIELDS.forEach(({ key, pickerId, hexId }) => {
  const picker = document.getElementById(pickerId);
  const hexIn  = document.getElementById(hexId);
  picker.addEventListener("input", () => {
    state[key] = picker.value;
    hexIn.value = picker.value;
    drawBrandPreview();
  });
  hexIn.addEventListener("input", () => {
    const v = hexIn.value.trim();
    if (HEX_RE.test(v)) {
      state[key] = v.toLowerCase();
      picker.value = state[key];
      drawBrandPreview();
    }
  });
});

document.getElementById("saveBranding").addEventListener("click", () => {
  const payload = {};
  BRAND_FIELDS.forEach(({ key }) => { payload[key] = state[key] || BRAND_DEFAULTS[key]; });
  chrome.storage.local.set(payload, () => flashSaved("savedBranding"));
});

document.getElementById("resetBranding").addEventListener("click", () => {
  Object.assign(state, BRAND_DEFAULTS);
  applyBrandingToInputs();
});

function drawBrandPreview() {
  const canvas = document.getElementById("brandPreview");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  // Subtle backdrop grid
  ctx.fillStyle = "#191921";
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
