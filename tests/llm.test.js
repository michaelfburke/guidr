import { describe, it, expect } from "vitest";
import {
  pruneTarget,
  buildSystemPrompt,
  buildUserText,
  buildAnthropicContent,
  buildOpenAIContent,
  buildGeminiParts,
  parseJson,
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
