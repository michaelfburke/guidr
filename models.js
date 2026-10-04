/**
 * models.js — Live model lists and prices for the Settings page.
 *
 * Rather than ship a model list that goes stale, Settings asks the chosen
 * provider which models the user's key can use, keeps the ones that accept
 * images and write text, and caches the result for a day. Per-step cost
 * estimates come from OpenRouter's public price list, which covers models from
 * all four providers and needs no key.
 */

import { anthropicHeaders } from "./llm.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// Model families that can't do Guidr's job (image in, short text out).
const NOT_CHAT = /(^gpt-3|^gpt-4(-\d{4}|-32k)?$|audio|realtime|tts|transcribe|speech|embed|image-gen|dall-e|whisper|moderation|search|computer|robotics|live|veo|imagen|lyria|aqa|codex|instruct|-image)/i;

// "-latest" aliases follow the provider's newest release; list them first.
const byAliasThenNewest = (a, b) =>
  Number(/latest/.test(b.id)) - Number(/latest/.test(a.id)) || (b.created || 0) - (a.created || 0);

async function getJSON(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error?.message || `HTTP ${res.status}`);
  }
  return res.json();
}

const FETCHERS = {
  async anthropic(apiKey) {
    const models = [];
    let after = "";
    for (let page = 0; page < 10; page++) {
      const data = await getJSON(`https://api.anthropic.com/v1/models?limit=1000${after}`, anthropicHeaders(apiKey));
      models.push(...data.data);
      if (!data.has_more) break;
      after = `&after_id=${encodeURIComponent(data.last_id)}`;
    }
    return models
      .filter((m) => m.capabilities?.image_input?.supported !== false)
      .map((m) => ({ id: m.id, label: m.display_name || m.id, created: Date.parse(m.created_at) || 0 }));
  },

  async openai(apiKey) {
    // OpenAI's list has no capability data, so filter by name.
    const data = await getJSON("https://api.openai.com/v1/models", { Authorization: `Bearer ${apiKey}` });
    return data.data
      .filter((m) => /^(gpt-|o\d|chatgpt-)/.test(m.id) && !NOT_CHAT.test(m.id))
      .map((m) => ({ id: m.id, label: m.id, created: (m.created || 0) * 1000 }));
  },

  async gemini(apiKey) {
    const models = [];
    let token = "";
    for (let page = 0; page < 10; page++) {
      const data = await getJSON(
        `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${apiKey}${token}`);
      models.push(...(data.models || []));
      if (!data.nextPageToken) break;
      token = `&pageToken=${encodeURIComponent(data.nextPageToken)}`;
    }
    return models
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m) => ({ id: m.name.replace(/^models\//, ""), label: m.displayName || m.name }))
      .filter((m) => /^gemini/.test(m.id) && !NOT_CHAT.test(m.id))
      // No dates in this API; version numbers sort newest first.
      .map((m) => ({ ...m, created: Number((m.id.match(/(\d+(?:\.\d+)?)/) || [])[1] || 0) }));
  },

  async openrouter() {
    // Public catalog; a key isn't needed to read it.
    const data = await getJSON("https://openrouter.ai/api/v1/models");
    return data.data
      .filter((m) => !m.id.includes(":")) // :free, :batch, … variants
      .filter((m) => m.architecture?.input_modalities?.includes("image")
        && m.architecture?.output_modalities?.includes("text"))
      .map((m) => ({ id: m.id, label: m.name || m.id, created: (m.created || 0) * 1000 }));
  },
};

/**
 * Models for a provider, newest first. Uses a day-old cache unless `force`.
 * @returns {Promise<{ models: Array<{id, label}>, fetchedAt: number }>}
 */
export async function listModels(provider, apiKey, { force = false } = {}) {
  const key = `modelList_${provider}`;
  const cached = (await chrome.storage.local.get(key))[key];
  if (!force && cached && Date.now() - cached.fetchedAt < DAY_MS) return cached;
  const models = (await FETCHERS[provider](apiKey)).sort(byAliasThenNewest)
    .map(({ id, label }) => ({ id, label }));
  const entry = { models, fetchedAt: Date.now() };
  await chrome.storage.local.set({ [key]: entry });
  return entry;
}

/** Cached list without a network call, or null. */
export async function cachedModels(provider) {
  const key = `modelList_${provider}`;
  return (await chrome.storage.local.get(key))[key] || null;
}

// ─── Prices ──────────────────────────────────────────────────────────────────

// "claude-sonnet-5-5", "anthropic/claude-sonnet-5.5" and
// "claude-haiku-4-5-20251001" should all find the same catalog entry.
export function normalizeModelId(id) {
  return String(id || "").toLowerCase()
    .replace(/^models\//, "").replace(/^~/, "").replace(/^[\w-]+\//, "")
    .replace(/-\d{8}$/, "").replace(/\./g, "-");
}

// A typical step: compressed screenshot + prompt in, short JSON (plus some
// low-effort reasoning) out.
const STEP_INPUT_TOKENS = 1800;
const STEP_OUTPUT_TOKENS = 300;

/** Estimated USD per enriched step, or null when the model isn't in the catalog. */
export async function estimateStepCost(modelId) {
  let cached = (await chrome.storage.local.get("modelPrices")).modelPrices;
  if (!cached || Date.now() - cached.fetchedAt >= DAY_MS) {
    const data = await getJSON("https://openrouter.ai/api/v1/models");
    const prices = {};
    for (const m of data.data) {
      if (m.id.includes(":")) continue;
      const prompt = Number(m.pricing?.prompt);
      const completion = Number(m.pricing?.completion);
      if (Number.isFinite(prompt) && Number.isFinite(completion)) prices[normalizeModelId(m.id)] = [prompt, completion];
    }
    cached = { prices, fetchedAt: Date.now() };
    await chrome.storage.local.set({ modelPrices: cached });
  }
  const price = cached.prices[normalizeModelId(modelId)];
  return price ? price[0] * STEP_INPUT_TOKENS + price[1] * STEP_OUTPUT_TOKENS : null;
}
