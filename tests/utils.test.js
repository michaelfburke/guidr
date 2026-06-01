import { describe, it, expect, vi, afterEach } from "vitest";
import {
  escHtml,
  slugify,
  timeAgo,
  formatMs,
  formatBytes,
  formatApiError,
} from "../utils.js";

describe("escHtml", () => {
  it("escapes the HTML-significant characters", () => {
    expect(escHtml('<a href="x">&</a>')).toBe("&lt;a href=\"x\"&gt;&amp;&lt;/a&gt;");
  });
  it("coerces nullish input to an empty string", () => {
    expect(escHtml(null)).toBe("");
    expect(escHtml(undefined)).toBe("");
  });
});

describe("slugify", () => {
  it("lowercases and dashes non-alphanumerics", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
  });
  it("trims leading/trailing dashes", () => {
    expect(slugify("  --Spaces--  ")).toBe("spaces");
  });
  it("caps length at 50 characters", () => {
    expect(slugify("a".repeat(80)).length).toBe(50);
  });
});

describe("timeAgo", () => {
  afterEach(() => vi.useRealTimers());

  it("returns empty string for falsy timestamps", () => {
    expect(timeAgo(0)).toBe("");
    expect(timeAgo(null)).toBe("");
  });

  it("buckets durations into just now / minutes / hours / days", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
    const now = Date.now();
    expect(timeAgo(now - 30 * 1000)).toBe("just now");
    expect(timeAgo(now - 5 * 60 * 1000)).toBe("5m ago");
    expect(timeAgo(now - 3 * 3600 * 1000)).toBe("3h ago");
    expect(timeAgo(now - 2 * 86400 * 1000)).toBe("2d ago");
  });
});

describe("formatMs", () => {
  it("formats milliseconds as m:ss.s", () => {
    expect(formatMs(0)).toBe("0:00.0");
    expect(formatMs(1500)).toBe("0:01.5");
    expect(formatMs(65000)).toBe("1:05.0");
  });
  it("clamps negative values to zero", () => {
    expect(formatMs(-100)).toBe("0:00.0");
  });
});

describe("formatBytes", () => {
  it("formats KB / MB / GB with the expected precision", () => {
    expect(formatBytes(0)).toBe("0 KB");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2.00 GB");
  });
});

describe("formatApiError", () => {
  it("falls back when given nothing", () => {
    expect(formatApiError("")).toMatch(/something went wrong/i);
  });
  it("recognises rate-limit / 429 errors and surfaces a retry hint", () => {
    const msg = formatApiError("Anthropic 429: rate limit exceeded (retry after 12s)");
    expect(msg).toMatch(/rate limit/i);
    expect(msg).toMatch(/~12s/);
  });
  it("maps billing / 402 errors", () => {
    expect(formatApiError("OpenAI 402: payment required")).toMatch(/no credits/i);
  });
  it("maps auth / 401 errors", () => {
    expect(formatApiError("Gemini 401: invalid api key")).toMatch(/api key was rejected/i);
  });
  it("maps model-not-found / 404 errors", () => {
    expect(formatApiError("OpenAI 404: model not found")).toMatch(/different one in settings/i);
  });
  it("maps permission / 403 errors", () => {
    expect(formatApiError("Gemini 403: permission denied")).toMatch(/permission or safety/i);
  });
  it("truncates very long unmatched messages", () => {
    const long = "x".repeat(300);
    expect(formatApiError(long).length).toBeLessThanOrEqual(180);
  });
});
