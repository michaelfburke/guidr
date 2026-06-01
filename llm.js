/**
 * llm.js — Guidr LLM Enrichment Engine
 *
 * Providers: Anthropic · OpenAI · Google Gemini · OpenRouter
 *
 * Token-budget strategy
 * ─────────────────────
 * 1. Screenshots are compressed to ≤1024 px wide JPEG @ 72 % before every call
 *    (OffscreenCanvas, available in service-worker context).
 *    Typical savings: 400 KB PNG → 40–70 KB JPEG — 6-10× fewer image tokens.
 * 2. Only the "after" screenshot is sent by default. The "before" is sent only
 *    when no "after" exists.
 * 3. DOM target description is pruned to the five most signal-rich fields.
 * 4. System prompt uses Anthropic prompt-caching (cache_control) so the large
 *    system prompt (tone guide + few-shot examples) is charged once per 5-min
 *    window rather than on every step.
 * 5. Gemini: responseMimeType:"application/json" guarantees structured output
 *    with no fence-stripping overhead.
 * 6. max_tokens capped at 400 — title+body+voiceover fit comfortably.
 * 7. temperature 0 everywhere for deterministic JSON.
 */

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Enrich a single captured step.
 * @param {object} step      – DB step object (with screenshotBefore/After)
 * @param {object} settings  – { apiKey, provider, model, toneGuide, exampleGuides }
 * @returns {Promise<{title, body, voiceoverScript}>}
 */
export async function enrichStep(step, settings) {
  const screenshot = await pickAndOptimize(step);
  const target = pruneTarget(step.target);
  const system = buildSystemPrompt(settings.toneGuide, settings.exampleGuides);
  const userText = buildUserText(step, target);

  return dispatch(settings, system, userText, screenshot);
}

/**
 * Generate a cohesive full-guide voiceover script.
 * @param {object} session   – session with enriched steps[]
 * @param {object} settings
 * @returns {Promise<string>}
 */
export async function generateFullScript(session, settings) {
  const stepsText = session.steps
    .filter((s) => s.enriched)
    .map((s, i) => `Step ${i + 1} — ${s.title}: ${s.voiceoverScript}`)
    .join("\n");

  const system = `You are a narrator for product walkthrough videos.
Stitch the per-step lines into one cohesive script.
Add a one-sentence intro and a one-sentence outro.
Use smooth spoken transitions. Plain text only, no markdown.${
    settings.toneGuide ? `\n\nTone:\n${settings.toneGuide}` : ""
  }`;

  const userText = `Guide: "${session.name}"\n\n${stepsText}\n\nWrite the full narration script.`;
  return dispatchText(settings, system, userText);
}

// ─── Screenshot optimisation (OffscreenCanvas) ────────────────────────────────

const SCREENSHOT_MAX_PX = 1024;
const SCREENSHOT_QUALITY = 0.72;

async function pickAndOptimize(step) {
  const raw = step.screenshotAfter || step.screenshotBefore;
  if (!raw) return null;
  try {
    return await compressScreenshot(raw, SCREENSHOT_MAX_PX, SCREENSHOT_QUALITY);
  } catch {
    return raw; // fall back to original if OffscreenCanvas not available
  }
}

async function compressScreenshot(dataUrl, maxPx, quality) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);

  const scale = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
  const out = await canvas.convertToBlob({ type: "image/jpeg", quality });

  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(out);
  });
}

// ─── Target pruning ───────────────────────────────────────────────────────────

export function pruneTarget(t) {
  if (!t) return "Unknown";
  const parts = [];
  if (t.ariaLabel)        parts.push(`aria-label: "${t.ariaLabel}"`);
  else if (t.text)        parts.push(`text: "${t.text.slice(0, 80)}"`);
  if (t.role)             parts.push(`role: ${t.role}`);
  if (t.placeholder)      parts.push(`placeholder: "${t.placeholder.slice(0, 60)}"`);
  if (t.type && t.type !== "submit") parts.push(`type: ${t.type}`);
  if (t.nearestLandmark)  {
    const l = t.nearestLandmark;
    parts.push(`inside <${l.tag}>${l.ariaLabel ? ` "${l.ariaLabel}"` : ""}`);
  }
  return parts.join(" · ") || "Unknown element";
}

// ─── Prompt construction ──────────────────────────────────────────────────────

export function buildSystemPrompt(toneGuide = "", examples = []) {
  const tone = toneGuide.trim() || `• Active voice, second person ("you").
• Action-first titles ("Enable two-factor authentication", not "How to enable…").
• Body: one sentence of what to do + one sentence of why/outcome. ≤35 words total.
• No jargon. Name the specific button/field, never say "click the button".`;

  const inline = examples.filter((e) => e?.kind !== "url" && e?.title && e?.body).slice(0, 3);
  const urlRefs = examples.filter((e) => e?.kind === "url" && e?.textSnippet).slice(0, 3);

  const fewShot = inline.length
    ? `\n## Style examples (match this closely)\n\n` +
      inline
        .map((e, i) => `Example ${i + 1}:\n{"title":"${e.title}","body":"${e.body}"}`)
        .join("\n\n")
    : "";

  const styleRefs = urlRefs.length
    ? `\n## Style references — match the voice and structure, do NOT copy content\n\n` +
      urlRefs
        .map((e) => `From ${e.url}:\n${e.textSnippet.slice(0, 2000)}`)
        .join("\n\n---\n\n")
    : "";

  return `You write step-by-step product documentation from screenshot evidence and UI metadata.

## Tone & style
${tone}${fewShot}${styleRefs}

## Inputs
- Screenshot: the PRIMARY source. Describe what is visible — the screen the user is on, the dialog/panel/state shown, the action implied by that state.
- Element metadata: SECONDARY. If it is empty, generic ("Unknown"), or describes a backdrop / wrapper / close icon, IGNORE it and describe the screen instead.
- The screenshot shows the state AFTER the click, so describe what the user accomplished or what is now in front of them — not the literal element clicked.

## Output
Return ONLY a valid JSON object — no markdown fences, no preamble, nothing else:
{"title":"…","body":"…"}

title : ≤8 words, action verb first
body  : ≤35 words, what + why/outcome

## Fallback
Only use this if the screenshot is genuinely blank or missing — never because metadata is weak:
{"title":"Uncaptured step","body":"Screenshot was unavailable for this step."}`.trim();
}

export function buildUserText(step, prunedTarget) {
  return `Page: "${step.pageTitle}" (${step.url.slice(0, 120)})
Step index: ${step.index + 1}
Element: ${prunedTarget}

Describe what the user did and write the documentation step.`;
}

// ─── Provider dispatch ────────────────────────────────────────────────────────

async function dispatch(settings, system, userText, screenshotDataUrl) {
  switch (settings.provider) {
    case "anthropic":   return callAnthropic(settings, system, userText, screenshotDataUrl);
    case "openai":      return callOpenAI(settings, system, userText, screenshotDataUrl);
    case "gemini":      return callGemini(settings, system, userText, screenshotDataUrl);
    case "openrouter":  return callOpenRouter(settings, system, userText, screenshotDataUrl);
    default:            throw new Error(`Unknown provider: ${settings.provider}`);
  }
}

async function dispatchText(settings, system, userText) {
  switch (settings.provider) {
    case "anthropic":   return callAnthropicText(settings, system, userText);
    case "openai":      return callOpenAIText(settings, system, userText);
    case "gemini":      return callGeminiText(settings, system, userText);
    case "openrouter":  return callOpenRouterText(settings, system, userText);
    default:            throw new Error(`Unknown provider: ${settings.provider}`);
  }
}

// ─── Anthropic ────────────────────────────────────────────────────────────────

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_DEFAULT_MODEL = "claude-haiku-4-5-20251001";

function anthropicHeaders(apiKey) {
  return {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "prompt-caching-2024-07-31",
  };
}

async function callAnthropic(settings, system, userText, screenshotDataUrl) {
  const content = buildAnthropicContent(userText, screenshotDataUrl);
  const body = {
    model: settings.model || ANTHROPIC_DEFAULT_MODEL,
    max_tokens: 400,
    temperature: 0,
    // Prompt caching: system prompt is charged once per 5-min cache window
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content }],
  };
  const data = await anthropicFetch(body, settings.apiKey);
  return parseJson(data.content?.[0]?.text || "");
}

async function callAnthropicText(settings, system, userText) {
  const body = {
    model: settings.model || ANTHROPIC_DEFAULT_MODEL,
    max_tokens: 800,
    temperature: 0,
    system,
    messages: [{ role: "user", content: userText }],
  };
  const data = await anthropicFetch(body, settings.apiKey);
  return data.content?.[0]?.text?.trim() || "";
}

async function anthropicFetch(body, apiKey) {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: anthropicHeaders(apiKey),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await httpError(res, "Anthropic");
  return res.json();
}

// Build a rich error from a non-OK Response: preserves status, retry-after,
// and the provider's actual error message so the UI can give the user a
// real diagnostic instead of swallowing the detail.
async function httpError(res, provider) {
  const raw = await res.text().catch(() => "");
  let body;
  try { body = JSON.parse(raw); } catch { body = null; }
  const apiMsg =
    body?.error?.message ||
    body?.error?.error?.message ||
    body?.message ||
    raw.slice(0, 200) ||
    res.statusText;
  const retryAfterHdr = res.headers.get("retry-after");
  const retryAfterSec = retryAfterHdr ? Number(retryAfterHdr) : null;
  const suffix = retryAfterSec ? ` (retry after ${retryAfterSec}s)` : "";
  const err = new Error(`${provider} ${res.status}: ${apiMsg}${suffix}`);
  err.status = res.status;
  err.retryAfter = Number.isFinite(retryAfterSec) ? retryAfterSec : null;
  err.provider = provider;
  return err;
}

export function buildAnthropicContent(userText, screenshotDataUrl) {
  const content = [{ type: "text", text: userText }];
  if (screenshotDataUrl) {
    const base64 = screenshotDataUrl.split(",")[1];
    const mediaType = screenshotDataUrl.match(/data:([^;]+);/)?.[1] || "image/jpeg";
    content.push({ type: "image", source: { type: "base64", media_type: mediaType, data: base64 } });
  }
  return content;
}

// ─── OpenAI ───────────────────────────────────────────────────────────────────

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_DEFAULT_MODEL = "gpt-4o-mini";

async function callOpenAI(settings, system, userText, screenshotDataUrl) {
  const userContent = buildOpenAIContent(userText, screenshotDataUrl);
  const data = await openAIFetch(
    OPENAI_URL, settings.apiKey, {}, settings.model || OPENAI_DEFAULT_MODEL,
    system, userContent, 400
  );
  return parseJson(data.choices?.[0]?.message?.content || "");
}

async function callOpenAIText(settings, system, userText) {
  const data = await openAIFetch(
    OPENAI_URL, settings.apiKey, {}, settings.model || OPENAI_DEFAULT_MODEL,
    system, userText, 800
  );
  return data.choices?.[0]?.message?.content?.trim() || "";
}

async function openAIFetch(url, apiKey, extraHeaders, model, system, userContent, maxTokens) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...extraHeaders,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature: 0,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
    }),
  });
  if (!res.ok) throw await httpError(res, url.includes("openrouter") ? "OpenRouter" : "OpenAI");
  return res.json();
}

export function buildOpenAIContent(userText, screenshotDataUrl) {
  if (!screenshotDataUrl) return userText;
  return [
    { type: "text", text: userText },
    { type: "image_url", image_url: { url: screenshotDataUrl, detail: "low" } },
  ];
}

// ─── Google Gemini ────────────────────────────────────────────────────────────

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_DEFAULT_MODEL = "gemini-2.5-flash";

async function callGemini(settings, system, userText, screenshotDataUrl) {
  const parts = buildGeminiParts(userText, screenshotDataUrl);
  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts }],
    generationConfig: {
      maxOutputTokens: 400,
      temperature: 0,
      responseMimeType: "application/json", // ← Gemini native structured output
    },
  };
  const model = settings.model || GEMINI_DEFAULT_MODEL;
  const res = await fetch(`${GEMINI_BASE}/${model}:generateContent?key=${settings.apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await httpError(res, "Gemini");
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return parseJson(text);
}

async function callGeminiText(settings, system, userText) {
  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: userText }] }],
    generationConfig: { maxOutputTokens: 800, temperature: 0 },
  };
  const model = settings.model || GEMINI_DEFAULT_MODEL;
  const res = await fetch(`${GEMINI_BASE}/${model}:generateContent?key=${settings.apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await httpError(res, "Gemini");
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
}

export function buildGeminiParts(userText, screenshotDataUrl) {
  const parts = [{ text: userText }];
  if (screenshotDataUrl) {
    const base64 = screenshotDataUrl.split(",")[1];
    const mimeType = screenshotDataUrl.match(/data:([^;]+);/)?.[1] || "image/jpeg";
    parts.push({ inline_data: { mime_type: mimeType, data: base64 } });
  }
  return parts;
}

// ─── OpenRouter ───────────────────────────────────────────────────────────────

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
// Sensible default: fast, cheap, vision-capable
const OPENROUTER_DEFAULT_MODEL = "google/gemini-2.0-flash-001";

async function callOpenRouter(settings, system, userText, screenshotDataUrl) {
  const userContent = buildOpenAIContent(userText, screenshotDataUrl); // same format
  const data = await openAIFetch(
    OPENROUTER_URL,
    settings.apiKey,
    {
      "HTTP-Referer": "https://guidr.extension",
      "X-Title": "Guidr",
    },
    settings.model || OPENROUTER_DEFAULT_MODEL,
    system,
    userContent,
    400
  );
  return parseJson(data.choices?.[0]?.message?.content || "");
}

async function callOpenRouterText(settings, system, userText) {
  const data = await openAIFetch(
    OPENROUTER_URL,
    settings.apiKey,
    { "HTTP-Referer": "https://guidr.extension", "X-Title": "Guidr" },
    settings.model || OPENROUTER_DEFAULT_MODEL,
    system,
    userText,
    800
  );
  return data.choices?.[0]?.message?.content?.trim() || "";
}

// ─── JSON parser (resilient) ──────────────────────────────────────────────────

export function parseJson(raw) {
  const cleaned = raw.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();

  // Strict parse first.
  try {
    const p = JSON.parse(cleaned);
    if (p && (p.title || p.body)) {
      return {
        title: String(p.title || "").trim(),
        body:  String(p.body  || "").trim(),
        voiceoverScript: String(p.voiceoverScript || p.body || "").trim(),
      };
    }
  } catch {}

  // Lenient extraction — handles responses truncated by max_tokens
  // (closing `"` allowed to be absent at end-of-string).
  const extract = (field) =>
    cleaned.match(new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)("|$)`))?.[1];
  const title = extract("title");
  const body  = extract("body");
  const voice = extract("voiceoverScript");

  if (!title?.trim() && !body?.trim()) {
    throw new Error("Model returned no usable content — response was truncated or blocked. Try again, or pick a model with a larger output budget.");
  }

  return {
    title: (title || "").trim(),
    body:  (body  || "").trim(),
    voiceoverScript: (voice || body || "").trim(),
  };
}

// ─── Model lists (for options page) ──────────────────────────────────────────

export const PROVIDER_MODELS = {
  anthropic: [
    { value: "claude-haiku-4-5-20251001",  label: "Claude Haiku (fast · cheap · recommended)" },
    { value: "claude-sonnet-4-6",           label: "Claude Sonnet (balanced)" },
    { value: "claude-opus-4-7",             label: "Claude Opus (highest quality)" },
  ],
  openai: [
    { value: "gpt-4o-mini",  label: "GPT-4o Mini (fast · cheap · recommended)" },
    { value: "gpt-4o",       label: "GPT-4o (higher quality)" },
  ],
  gemini: [
    { value: "gemini-2.5-flash",       label: "Gemini 2.5 Flash (fast · cheap · recommended)" },
    { value: "gemini-2.5-pro",         label: "Gemini 2.5 Pro (highest quality)" },
    { value: "gemini-2.5-flash-lite",  label: "Gemini 2.5 Flash Lite (cheapest)" },
    { value: "gemini-2.0-flash",       label: "Gemini 2.0 Flash (legacy)" },
  ],
  openrouter: [], // free-text model string in options
};

export const PROVIDER_KEY_URLS = {
  anthropic:  "https://console.anthropic.com/settings/keys",
  openai:     "https://platform.openai.com/api-keys",
  gemini:     "https://aistudio.google.com/app/apikey",
  openrouter: "https://openrouter.ai/keys",
};
