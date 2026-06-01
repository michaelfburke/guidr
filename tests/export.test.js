import { describe, it, expect, beforeEach } from "vitest";
import { exportSession } from "../export.js";

function makeSession(overrides = {}) {
  return {
    name: "My Guide",
    steps: [
      { title: "Open settings", body: "Click the gear icon.", screenshotAfter: "data:image/png;base64,AAA" },
      { title: "Save changes", body: "Press Save.", screenshotAfter: null },
    ],
    ...overrides,
  };
}

describe("exportSession", () => {
  beforeEach(() => globalThis.__resetChromeStorage());

  it("throws on an unknown format", async () => {
    await expect(exportSession(makeSession(), "pdf")).rejects.toThrow(/Unknown format/);
  });

  it("produces markdown with a heading, embedded image, and slugified filename", async () => {
    const out = await exportSession(makeSession(), "markdown");
    expect(out.filename).toBe("my-guide.md");
    expect(out.mimeType).toBe("text/markdown");
    expect(out.content).toContain("# My Guide");
    expect(out.content).toContain("## Step 1: Open settings");
    expect(out.content).toContain("![Step 1 screenshot](data:image/png;base64,AAA)");
    // Step 2 has no screenshot — no image line for it.
    expect(out.content).not.toContain("Step 2 screenshot");
  });

  it("produces self-contained HTML with escaped, branded content", async () => {
    const out = await exportSession(makeSession({ name: "A <b> & C" }), "html");
    expect(out.filename).toBe("a-b-c.html");
    expect(out.content).toContain("<!DOCTYPE html>");
    expect(out.content).toContain("A &lt;b&gt; &amp; C");
    expect(out.content).toContain("Open settings");
  });

  it("respects custom brand colors from storage in the HTML export", async () => {
    await chrome.storage.local.set({ brandCircleColor: "#123456" });
    const out = await exportSession(makeSession(), "html");
    expect(out.content).toContain("#123456");
  });

  it("produces Intercom allowlist HTML with numbered headings", async () => {
    const out = await exportSession(makeSession(), "intercom");
    expect(out.filename).toBe("my-guide-intercom.html");
    expect(out.content).toContain("<h2>1. Open settings</h2>");
    expect(out.content).toContain("<p>Click the gear icon.</p>");
    expect(out.content).toContain('<img src="data:image/png;base64,AAA"');
  });

  it("produces JSON backup that strips screenshot blobs", async () => {
    const out = await exportSession(makeSession(), "json");
    expect(out.filename).toBe("my-guide-backup.json");
    const parsed = JSON.parse(out.content);
    expect(parsed._guidr_export.version).toBe("0.1");
    expect(parsed.steps[0]).not.toHaveProperty("screenshotAfter");
    expect(parsed.steps[0].title).toBe("Open settings");
  });
});
