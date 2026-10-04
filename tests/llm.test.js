import { describe, it, expect, vi, afterEach } from "vitest";
import {
  pruneTarget,
  buildSystemPrompt,
  buildUserText,
  buildAnthropicContent,
  buildOpenAIContent,
  buildGeminiParts,
  parseJson,
  enrichStep,
  generateFullScript,
} from "../llm.js";

describe("pruneTarget", () => {
  it("returns a sentinel for missing targets", () => {
    expect(pruneTarget(null)).toBe("Unknown");
    expect(pruneTarget({})).toBe("Unknown element");
  });
  it("prefers aria-label over text and joins signal-rich fields", () => {
    const out = pruneTarget({ ariaLabel: "Save", text: "ignored", role: "button" });
    expect(out).toContain('aria-label: "Save"');
    expect(out).toContain("role: button");
    expect(out).not.toContain("ignored");
  });
  it("drops the noisy submit type but keeps others", () => {
    expect(pruneTarget({ text: "x", type: "submit" })).not.toContain("type:");
    expect(pruneTarget({ text: "x", type: "email" })).toContain("type: email");
  });
  it("describes the nearest landmark", () => {
    const out = pruneTarget({ text: "x", nearestLandmark: { tag: "nav", ariaLabel: "Main" } });
    expect(out).toContain('inside <nav> "Main"');
  });
});

describe("buildSystemPrompt", () => {
  it("uses the built-in tone when none supplied", () => {
    const p = buildSystemPrompt("");
    expect(p).toContain("Active voice");
    expect(p).not.toContain("Style examples");
  });
  it("injects a custom tone guide verbatim", () => {
    expect(buildSystemPrompt("Be terse.")).toContain("Be terse.");
  });
  it("includes up to three inline few-shot examples", () => {
    const examples = [
      { title: "T1", body: "B1" },
      { title: "T2", body: "B2" },
      { title: "T3", body: "B3" },
      { title: "T4", body: "B4" },
    ];
    const p = buildSystemPrompt("", examples);
    expect(p).toContain("Style examples");
    expect(p).toContain("T1");
    expect(p).toContain("T3");
    expect(p).not.toContain("T4");
  });
  it("renders url-style references separately from inline examples", () => {
    const p = buildSystemPrompt("", [{ kind: "url", url: "https://x.com", textSnippet: "voice sample" }]);
    expect(p).toContain("Style references");
    expect(p).toContain("https://x.com");
    expect(p).toContain("voice sample");
  });
});

describe("buildUserText", () => {
  it("includes page, 1-based index, and pruned target", () => {
    const out = buildUserText({ pageTitle: "Dash", url: "https://app/x", index: 0 }, "the Save button");
    expect(out).toContain('Page: "Dash"');
    expect(out).toContain("Step index: 1");
    expect(out).toContain("the Save button");
  });
});

describe("provider content builders", () => {
  const dataUrl = "data:image/jpeg;base64,QUJD";

  it("anthropic: text-only when no screenshot", () => {
    const c = buildAnthropicContent("hi", null);
    expect(c).toEqual([{ type: "text", text: "hi" }]);
  });
  it("anthropic: appends a base64 image block with media type", () => {
    const c = buildAnthropicContent("hi", dataUrl);
    expect(c[1]).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "QUJD" },
    });
  });

  it("openai: returns the bare string when no screenshot", () => {
    expect(buildOpenAIContent("hi", null)).toBe("hi");
  });
  it("openai: returns text+image_url parts with a screenshot", () => {
    const c = buildOpenAIContent("hi", dataUrl);
    expect(c[1]).toMatchObject({ type: "image_url", image_url: { url: dataUrl, detail: "low" } });
  });

  it("gemini: inlines base64 data with mime type", () => {
    const parts = buildGeminiParts("hi", dataUrl);
    expect(parts[0]).toEqual({ text: "hi" });
    expect(parts[1]).toMatchObject({ inline_data: { mime_type: "image/jpeg", data: "QUJD" } });
  });
});

describe("parseJson", () => {
  it("parses a clean JSON object", () => {
    expect(parseJson('{"title":"T","body":"B"}')).toMatchObject({ title: "T", body: "B" });
  });
  it("strips markdown code fences", () => {
    expect(parseJson('```json\n{"title":"T","body":"B"}\n```')).toMatchObject({ title: "T" });
  });
  it("falls back to voiceoverScript = body when absent", () => {
    expect(parseJson('{"title":"T","body":"B"}').voiceoverScript).toBe("B");
  });
  it("leniently recovers a truncated response", () => {
    const out = parseJson('{"title":"Enable 2FA","body":"Click the toggle and confir');
    expect(out.title).toBe("Enable 2FA");
    expect(out.body).toContain("Click the toggle");
  });
  it("throws when nothing usable is present", () => {
    expect(() => parseJson("complete garbage")).toThrow(/no usable content/i);
  });
});

describe("provider requests", () => {
  afterEach(() => vi.unstubAllGlobals());

  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const ok = '{"title":"Click Save","body":"Saves it."}';
  const step = { index: 0, url: "https://app.test/", pageTitle: "App", target: { text: "Save" } };
  const bodyOf = (fetchMock, i = 0) => JSON.parse(fetchMock.mock.calls[i][1].body);

  function stubFetch(...responses) {
    const fetchMock = vi.fn(async () => responses.length > 1 ? responses.shift() : responses[0].clone());
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  describe("anthropic", () => {
    const settings = { provider: "anthropic", apiKey: "sk-ant-test", model: "claude-sonnet-5-5" };

    it("sends the browser-access header, low effort, and no sampling params", async () => {
      const fetchMock = stubFetch(json({ content: [{ type: "text", text: ok }] }));
      expect((await enrichStep(step, settings)).title).toBe("Click Save");
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://api.anthropic.com/v1/messages");
      expect(init.headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
      const body = bodyOf(fetchMock);
      expect(body).not.toHaveProperty("temperature");
      expect(body.output_config).toEqual({ effort: "low" });
      expect(body.max_tokens).toBeGreaterThanOrEqual(2048);
      expect(body.model).toBe("claude-sonnet-5-5");
    });

    it("reads the answer after a thinking block", async () => {
      stubFetch(json({ content: [{ type: "thinking", thinking: "" }, { type: "text", text: ok }] }));
      expect((await enrichStep(step, settings)).title).toBe("Click Save");
    });

    it("retries without effort when the model rejects it", async () => {
      const fetchMock = stubFetch(
        json({ error: { message: "output_config.effort: effort is not supported on this model" } }, 400),
        json({ content: [{ type: "text", text: ok }] }),
      );
      expect((await enrichStep(step, { ...settings, model: "claude-haiku-4-5" })).title).toBe("Click Save");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(bodyOf(fetchMock, 1)).not.toHaveProperty("output_config");
    });

    it("does not retry other 400s", async () => {
      const fetchMock = stubFetch(json({ error: { message: "messages: image too large" } }, 400));
      await expect(enrichStep(step, settings)).rejects.toThrow(/image too large/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("uses the same request shape for full-script generation", async () => {
      const fetchMock = stubFetch(json({ content: [{ type: "text", text: "Welcome. Click Save. Done." }] }));
      const out = await generateFullScript(
        { name: "Guide", steps: [{ enriched: true, title: "Save", voiceoverScript: "Click Save." }] },
        settings,
      );
      expect(out).toBe("Welcome. Click Save. Done.");
      expect(fetchMock.mock.calls[0][1].headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
      expect(bodyOf(fetchMock)).not.toHaveProperty("temperature");
    });

    it("ignores a saved model from another provider", async () => {
      const fetchMock = stubFetch(json({ content: [{ type: "text", text: ok }] }));
      await enrichStep(step, { ...settings, model: "gemini-flash-latest" });
      expect(bodyOf(fetchMock).model).toBe("claude-haiku-4-5");
    });
  });

  describe("openai", () => {
    const settings = { provider: "openai", apiKey: "sk-test" };

    it("uses max_completion_tokens and low reasoning effort, no temperature", async () => {
      const fetchMock = stubFetch(json({ choices: [{ message: { content: ok } }] }));
      expect((await enrichStep(step, settings)).title).toBe("Click Save");
      const body = bodyOf(fetchMock);
      expect(body).toMatchObject({ model: "gpt-6-luna", reasoning_effort: "low" });
      expect(body.max_completion_tokens).toBeGreaterThanOrEqual(2048);
      expect(body).not.toHaveProperty("max_tokens");
      expect(body).not.toHaveProperty("temperature");
    });

    it("retries without reasoning_effort for non-reasoning models", async () => {
      const fetchMock = stubFetch(
        json({ error: { message: "Unrecognized request argument supplied: reasoning_effort" } }, 400),
        json({ choices: [{ message: { content: ok } }] }),
      );
      await enrichStep(step, { ...settings, model: "gpt-4o" });
      expect(bodyOf(fetchMock, 1)).not.toHaveProperty("reasoning_effort");
    });
  });

  describe("gemini", () => {
    const settings = { provider: "gemini", apiKey: "AIza-test" };

    it("defaults to the Flash alias, asks for low thinking, and skips thought parts", async () => {
      const fetchMock = stubFetch(json({ candidates: [{ content: { parts: [{ text: "hmm", thought: true }, { text: ok }] } }] }));
      expect((await enrichStep(step, settings)).title).toBe("Click Save");
      expect(fetchMock.mock.calls[0][0]).toContain("/models/gemini-flash-latest:generateContent");
      const { generationConfig } = bodyOf(fetchMock);
      expect(generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
      expect(generationConfig).not.toHaveProperty("temperature");
    });

    it("falls back to a zero thinking budget for Gemini 2.5", async () => {
      const fetchMock = stubFetch(
        json({ error: { message: 'Invalid JSON payload received. Unknown name "thinkingLevel"' } }, 400),
        json({ candidates: [{ content: { parts: [{ text: ok }] } }] }),
      );
      await enrichStep(step, { ...settings, model: "gemini-2.5-flash" });
      expect(bodyOf(fetchMock, 1).generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
    });

    it("then to the minimum budget, then to no thinking config", async () => {
      const reject = (msg) => json({ error: { message: msg } }, 400);
      const fetchMock = stubFetch(
        reject("thinking_level is not supported for this model"),
        reject("Budget 0 is invalid. This model only works in thinking mode."),
        reject("thinking budget 128 out of range"),
        json({ candidates: [{ content: { parts: [{ text: ok }] } }] }),
      );
      await enrichStep(step, { ...settings, model: "gemini-2.5-pro" });
      expect(bodyOf(fetchMock, 1).generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
      expect(bodyOf(fetchMock, 2).generationConfig.thinkingConfig).toEqual({ thinkingBudget: 128 });
      expect(bodyOf(fetchMock, 3).generationConfig).not.toHaveProperty("thinkingConfig");
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });
  });

  describe("api key guard", () => {
    it("never sends a key that belongs to another provider", async () => {
      const fetchMock = stubFetch(json({ choices: [{ message: { content: ok } }] }));
      await expect(enrichStep(step, { provider: "openai", apiKey: "sk-ant-api03-x" }))
        .rejects.toThrow(/isn't for OpenAI/);
      await expect(enrichStep(step, { provider: "anthropic", apiKey: "AIzaSyX" })).rejects.toThrow(/Anthropic key/);
      await expect(enrichStep(step, { provider: "gemini", apiKey: "sk-or-v1-x" })).rejects.toThrow(/Gemini key/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("allows matching and unrecognised key formats", async () => {
      stubFetch(json({ choices: [{ message: { content: ok } }] }));
      await expect(enrichStep(step, { provider: "openai", apiKey: "sk-proj-x" })).resolves.toBeTruthy();
      await expect(enrichStep(step, { provider: "openrouter", apiKey: "custom-token" })).resolves.toBeTruthy();
    });
  });

  describe("openrouter", () => {
    it("defaults to the Haiku alias with low, hidden reasoning", async () => {
      const fetchMock = stubFetch(json({ choices: [{ message: { content: ok } }] }));
      await enrichStep(step, { provider: "openrouter", apiKey: "sk-or-v1-test" });
      expect(bodyOf(fetchMock)).toMatchObject({
        model: "~anthropic/claude-haiku-latest",
        reasoning: { effort: "low", exclude: true },
      });
    });
  });
});
