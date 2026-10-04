import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listModels, cachedModels, estimateStepCost, normalizeModelId } from "../models.js";

const json = (body) => new Response(JSON.stringify(body), { status: 200 });

beforeEach(() => globalThis.__resetChromeStorage());
afterEach(() => vi.unstubAllGlobals());

describe("listModels", () => {
  it("anthropic: keeps image models, newest first, with the browser-access header", async () => {
    const fetchMock = vi.fn(async () => json({
      has_more: false,
      data: [
        { id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5", created_at: "2025-10-01T00:00:00Z", capabilities: { image_input: { supported: true } } },
        { id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5", created_at: "2026-09-28T00:00:00Z", capabilities: { image_input: { supported: true } } },
        { id: "claude-text-only", display_name: "Text", created_at: "2026-01-01T00:00:00Z", capabilities: { image_input: { supported: false } } },
      ],
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { models } = await listModels("anthropic", "sk-ant");
    expect(models.map((m) => m.id)).toEqual(["claude-sonnet-5-5", "claude-haiku-4-5-20251001"]);
    expect(fetchMock.mock.calls[0][1].headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
  });

  it("openai: drops audio, image, embedding and legacy text models", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: [
      { id: "gpt-6-luna", created: 300 }, { id: "gpt-6-sol", created: 400 },
      { id: "gpt-4o-audio-preview", created: 200 }, { id: "gpt-image-2", created: 500 },
      { id: "text-embedding-3-small", created: 100 }, { id: "gpt-3.5-turbo", created: 50 },
      { id: "gpt-4", created: 60 }, { id: "dall-e-3", created: 70 },
    ] })));
    const { models } = await listModels("openai", "sk");
    expect(models.map((m) => m.id)).toEqual(["gpt-6-sol", "gpt-6-luna"]);
  });

  it("gemini: generateContent Gemini models, aliases first, then newest version", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ models: [
      { name: "models/gemini-3.5-flash-lite", displayName: "Gemini 3.5 Flash-Lite", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-3.8-flash", displayName: "Gemini 3.8 Flash", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-flash-latest", displayName: "Gemini Flash Latest", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-3.1-flash-image", displayName: "Image", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-embedding-001", displayName: "Embedding", supportedGenerationMethods: ["embedContent"] },
      { name: "models/gemma-4", displayName: "Gemma", supportedGenerationMethods: ["generateContent"] },
    ] })));
    const { models } = await listModels("gemini", "AIza");
    expect(models.map((m) => m.id)).toEqual(["gemini-flash-latest", "gemini-3.8-flash", "gemini-3.5-flash-lite"]);
  });

  it("openrouter: image-in, text-out models without variant suffixes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: [
      { id: "~anthropic/claude-haiku-latest", name: "Claude Haiku Latest", created: 1, architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
      { id: "openai/gpt-6-luna", name: "GPT-6 Luna", created: 3, architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
      { id: "openai/gpt-6-luna:batch", name: "batch", created: 3, architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
      { id: "some/text-only", name: "Text", created: 4, architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
    ] })));
    const { models } = await listModels("openrouter");
    expect(models.map((m) => m.id)).toEqual(["~anthropic/claude-haiku-latest", "openai/gpt-6-luna"]);
  });

  it("caches for a day unless forced", async () => {
    const fetchMock = vi.fn(async () => json({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await listModels("openai", "sk");
    await listModels("openai", "sk");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await listModels("openai", "sk", { force: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await cachedModels("openai")).models).toEqual([]);
  });

  it("surfaces the provider's error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401 })));
    await expect(listModels("anthropic", "bad")).rejects.toThrow(/invalid x-api-key/);
  });
});

describe("prices", () => {
  it("matches provider ids to OpenRouter catalog ids", () => {
    expect(normalizeModelId("claude-haiku-4-5-20251001")).toBe(normalizeModelId("anthropic/claude-haiku-4.5"));
    expect(normalizeModelId("claude-sonnet-5-5")).toBe(normalizeModelId("anthropic/claude-sonnet-5.5"));
    expect(normalizeModelId("gemini-flash-latest")).toBe(normalizeModelId("~google/gemini-flash-latest"));
    expect(normalizeModelId("models/gemini-3.8-flash")).toBe(normalizeModelId("google/gemini-3.8-flash"));
  });

  it("estimates a step from per-token prices, or null when unknown", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: [
      { id: "anthropic/claude-haiku-4.5", pricing: { prompt: "0.000001", completion: "0.000005" } },
    ] })));
    expect(await estimateStepCost("claude-haiku-4-5")).toBeCloseTo(1800 * 0.000001 + 300 * 0.000005);
    expect(await estimateStepCost("mystery-model")).toBeNull();
  });
});
