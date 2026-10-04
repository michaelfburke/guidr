import { beforeEach, describe, expect, it, vi } from "vitest";
import { connectOpenRouter } from "../openrouter.js";

const REDIRECT = "https://abcdefgh.chromiumapp.org/";

beforeEach(() => {
  globalThis.__resetChromeStorage();
  chrome.identity = {
    getRedirectURL: () => REDIRECT,
    launchWebAuthFlow: vi.fn(async () => `${REDIRECT}?code=auth-code`),
  };
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ key: "sk-or-v1-new" }), { status: 200 }));
});

describe("connectOpenRouter", () => {
  it("runs PKCE and saves the key as the active provider", async () => {
    expect(await connectOpenRouter()).toBe(true);

    const { url } = chrome.identity.launchWebAuthFlow.mock.calls[0][0];
    const auth = new URL(url);
    expect(auth.origin + auth.pathname).toBe("https://openrouter.ai/auth");
    expect(auth.searchParams.get("callback_url")).toBe(REDIRECT);
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");

    const [exchangeUrl, init] = fetch.mock.calls[0];
    expect(exchangeUrl).toBe("https://openrouter.ai/api/v1/auth/keys");
    const body = JSON.parse(init.body);
    expect(body.code).toBe("auth-code");
    // The challenge sent to /auth is the S256 hash of the verifier sent here.
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.code_verifier));
    const expected = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(auth.searchParams.get("code_challenge")).toBe(expected);

    expect(await chrome.storage.local.get(["provider", "apiKey", "openrouterModel"])).toEqual({
      provider: "openrouter",
      apiKey: "sk-or-v1-new",
      openrouterModel: "anthropic/claude-haiku-4.5",
    });
  });

  it("keeps a model the user already chose", async () => {
    await chrome.storage.local.set({ openrouterModel: "openai/gpt-5-mini" });
    await connectOpenRouter();
    expect((await chrome.storage.local.get("openrouterModel")).openrouterModel).toBe("openai/gpt-5-mini");
  });

  it("returns false when the user closes the window", async () => {
    chrome.identity.launchWebAuthFlow.mockRejectedValueOnce(new Error("The user did not approve access."));
    expect(await connectOpenRouter()).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(await chrome.storage.local.get("apiKey")).toEqual({});
  });

  it("reports a failed key exchange without saving anything", async () => {
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "Invalid code" } }), { status: 400 }));
    await expect(connectOpenRouter()).rejects.toThrow(/Invalid code/);
    expect(await chrome.storage.local.get("apiKey")).toEqual({});
  });
});
