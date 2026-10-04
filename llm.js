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
 * 6. Lowest reasoning effort each provider offers; output budgets leave room
 *    for that reasoning (see "Shared request plumbing").
 * 7. No sampling parameters: current reasoning models reject or discourage
 *    them, and a 400 for an optional setting is retried without it.
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

function withModel(settings) {
  if (settings.provider === "openrouter" || modelBelongsTo(settings.provider, settings.model)) return settings;
  return { ...settings, model: DEFAULT_MODELS[settings.provider] };
}

async function dispatch(settings, system, userText, screenshotDataUrl) {
  settings = withModel(settings);
  switch (settings.provider) {
    case "anthropic":   return callAnthropic(settings, system, userText, screenshotDataUrl);
    case "openai":      return callOpenAI(settings, system, userText, screenshotDataUrl);
    case "gemini":      return callGemini(settings, system, userText, screenshotDataUrl);
    case "openrouter":  return callOpenRouter(settings, system, userText, screenshotDataUrl);
    default:            throw new Error(`Unknown provider: ${settings.provider}`);
  }
}

async function dispatchText(settings, system, userText) {
  settings = withModel(settings);
  switch (settings.provider) {
    case "anthropic":   return callAnthropicText(settings, system, userText);
    case "openai":      return callOpenAIText(settings, system, userText);
    case "gemini":      return callGeminiText(settings, system, userText);
    case "openrouter":  return callOpenRouterText(settings, system, userText);
    default:            throw new Error(`Unknown provider: ${settings.provider}`);
  }
}

// ─── Shared request plumbing ─────────────────────────────────────────────────
//
// Models come and go faster than releases of this extension, and each
// generation changes which request settings it accepts (Claude Opus 4.7
// dropped `temperature`; GPT reasoning models want `reasoning_effort`; Gemini 3
// replaced thinking budgets with levels). So each request sends only what it
// needs, plus a few *optional* settings that keep newer reasoning models fast
// and cheap. When a model rejects one of those with a 400 naming it, the
// request is retried without it.

/**
 * @param {string} provider  – name for error messages
 * @param {Array<[string, RegExp]>} optional – [dotted body path, matcher for the 400 message]
 */
async function postJSON(provider, url, headers, body, optional = []) {
  let pending = [...optional];
  for (;;) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();
    const err = await httpError(res, provider);
    const drop = res.status === 400 && pending.find(([path, re]) => hasPath(body, path) && re.test(err.message));
    if (!drop) throw err;
    deletePath(body, drop[0]);
    pending = pending.filter((o) => o !== drop);
  }
}

function hasPath(obj, path) {
  const keys = path.split(".");
  const last = keys.pop();
  const parent = keys.reduce((o, k) => o?.[k], obj);
  return !!parent && last in parent;
}

function deletePath(obj, path) {
  const keys = path.split(".");
  const last = keys.pop();
  const parent = keys.reduce((o, k) => o?.[k], obj);
  if (parent) delete parent[last];
  // Drop containers the deletion emptied, e.g. output_config: {}.
  if (keys.length && parent && !Object.keys(parent).length) deletePath(obj, keys.join("."));
}

// Room for a short answer plus the reasoning that newer models do first even
// at their lowest setting. Only tokens actually generated are billed.
const STEP_MAX_TOKENS = 2048;
const SCRIPT_MAX_TOKENS = 4096;

// ─── Anthropic ────────────────────────────────────────────────────────────────

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
// Undated alias: follows Haiku 4.5 snapshots. Settings offers the live list.
const ANTHROPIC_DEFAULT_MODEL = "claude-haiku-4-5";
const ANTHROPIC_OPTIONAL = [["output_config.effort", /effort/i]];

export function anthropicHeaders(apiKey) {
  return {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    // Required for CORS: without it the API rejects the preflight, so calls
    // fail whenever the extension lacks host access to api.anthropic.com
    // (fresh install, or the user declined site access).
    "anthropic-dangerous-direct-browser-access": "true",
  };
}

// Newer Claude models think before answering, so the text isn't always the
// first content block.
const anthropicText = (data) => (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");

async function callAnthropic(settings, system, userText, screenshotDataUrl) {
  const body = {
    model: settings.model || ANTHROPIC_DEFAULT_MODEL,
    max_tokens: STEP_MAX_TOKENS,
    // Lowest reasoning effort: a short, well-specified writing task. Models
    // without effort support (e.g. Haiku 4.5) reject it and are retried.
    output_config: { effort: "low" },
    // Prompt caching: system prompt is charged once per 5-min cache window
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: buildAnthropicContent(userText, screenshotDataUrl) }],
  };
  const data = await postJSON("Anthropic", ANTHROPIC_URL, anthropicHeaders(settings.apiKey), body, ANTHROPIC_OPTIONAL);
  return parseJson(anthropicText(data));
}

async function callAnthropicText(settings, system, userText) {
  const body = {
    model: settings.model || ANTHROPIC_DEFAULT_MODEL,
    max_tokens: SCRIPT_MAX_TOKENS,
    output_config: { effort: "low" },
    system,
    messages: [{ role: "user", content: userText }],
  };
  const data = await postJSON("Anthropic", ANTHROPIC_URL, anthropicHeaders(settings.apiKey), body, ANTHROPIC_OPTIONAL);
  return anthropicText(data).trim();
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
// OpenAI has no "latest" alias for its small model; Settings offers the live list.
const OPENAI_DEFAULT_MODEL = "gpt-6-luna";
const OPENAI_OPTIONAL = [["reasoning_effort", /reasoning/i]];

async function callOpenAI(settings, system, userText, screenshotDataUrl) {
  const data = await openAIFetch(settings, system, buildOpenAIContent(userText, screenshotDataUrl), STEP_MAX_TOKENS);
  return parseJson(data.choices?.[0]?.message?.content || "");
}

async function callOpenAIText(settings, system, userText) {
  const data = await openAIFetch(settings, system, userText, SCRIPT_MAX_TOKENS);
  return data.choices?.[0]?.message?.content?.trim() || "";
}

function openAIFetch(settings, system, userContent, maxTokens) {
  // No temperature: reasoning models only accept the default.
  // max_completion_tokens is accepted by every chat model; max_tokens is not.
  const body = {
    model: settings.model || OPENAI_DEFAULT_MODEL,
    max_completion_tokens: maxTokens,
    reasoning_effort: "low",
    messages: [
      { role: "system", content: system },
      { role: "user", content: userContent },
    ],
  };
  return postJSON("OpenAI", OPENAI_URL, { Authorization: `Bearer ${settings.apiKey}` }, body, OPENAI_OPTIONAL);
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
// Google-maintained alias for the current Flash model.
const GEMINI_DEFAULT_MODEL = "gemini-flash-latest";
const GEMINI_OPTIONAL = [["generationConfig.thinkingConfig", /thinking/i]];

// Thinking parts carry `thought: true`; keep only the answer.
const geminiText = (data) =>
  (data.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("");

function geminiFetch(settings, body) {
  const model = settings.model || GEMINI_DEFAULT_MODEL;
  // No temperature: Gemini 3 recommends the default and can loop below it.
  body.generationConfig.thinkingConfig = { thinkingLevel: "low" };
  return postJSON("Gemini", `${GEMINI_BASE}/${model}:generateContent?key=${settings.apiKey}`, {}, body, GEMINI_OPTIONAL);
}

async function callGemini(settings, system, userText, screenshotDataUrl) {
  const data = await geminiFetch(settings, {
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: buildGeminiParts(userText, screenshotDataUrl) }],
    generationConfig: {
      maxOutputTokens: STEP_MAX_TOKENS,
      responseMimeType: "application/json", // ← Gemini native structured output
    },
  });
  return parseJson(geminiText(data));
}

async function callGeminiText(settings, system, userText) {
  const data = await geminiFetch(settings, {
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: userText }] }],
    generationConfig: { maxOutputTokens: SCRIPT_MAX_TOKENS },
  });
  return geminiText(data).trim();
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
// OpenRouter-maintained alias for Anthropic's current Haiku: fast, cheap,
// vision-capable, good at short instructional copy.
export const OPENROUTER_DEFAULT_MODEL = "~anthropic/claude-haiku-latest";
const OPENROUTER_HEADERS = { "HTTP-Referer": "https://guidr.extension", "X-Title": "Guidr" };

async function callOpenRouter(settings, system, userText, screenshotDataUrl) {
  const data = await openRouterFetch(settings, system, buildOpenAIContent(userText, screenshotDataUrl), STEP_MAX_TOKENS);
  return parseJson(data.choices?.[0]?.message?.content || "");
}

async function callOpenRouterText(settings, system, userText) {
  const data = await openRouterFetch(settings, system, userText, SCRIPT_MAX_TOKENS);
  return data.choices?.[0]?.message?.content?.trim() || "";
}

function openRouterFetch(settings, system, userContent, maxTokens) {
  // OpenRouter translates `reasoning` per model and ignores it where unsupported.
  const body = {
    model: settings.model || OPENROUTER_DEFAULT_MODEL,
    max_tokens: maxTokens,
    reasoning: { effort: "low", exclude: true },
    messages: [
      { role: "system", content: system },
      { role: "user", content: userContent },
    ],
  };
  return postJSON("OpenRouter", OPENROUTER_URL,
    { Authorization: `Bearer ${settings.apiKey}`, ...OPENROUTER_HEADERS }, body, [["reasoning", /reasoning/i]]);
}

// The saved model is one setting shared by all providers; only use it with
// the provider it belongs to. (OpenRouter has its own openrouterModel.)
const MODEL_PREFIX = { anthropic: /^claude-/, openai: /^(gpt-|o\d|chatgpt-)/, gemini: /^gemini-/ };
export const modelBelongsTo = (provider, id) => !!id && !!MODEL_PREFIX[provider]?.test(id);

/** Model used when the user hasn't picked one, per provider. */
export const DEFAULT_MODELS = {
  anthropic: ANTHROPIC_DEFAULT_MODEL,
  openai: OPENAI_DEFAULT_MODEL,
  gemini: GEMINI_DEFAULT_MODEL,
  openrouter: OPENROUTER_DEFAULT_MODEL,
};

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
