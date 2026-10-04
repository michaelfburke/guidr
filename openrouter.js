/**
 * openrouter.js — "Connect OpenRouter" (OAuth PKCE)
 *
 * Signs the user in to OpenRouter in a Chrome auth window and receives an API
 * key they own, instead of making them create and paste one. The key goes
 * straight from OpenRouter to chrome.storage.local, like a pasted key; there
 * is no Guidr server involved.
 * https://openrouter.ai/docs/use-cases/oauth-pkce
 */

import { OPENROUTER_DEFAULT_MODEL } from "./llm.js";

const AUTH_URL = "https://openrouter.ai/auth";
const KEY_EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys";

const base64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * Runs the sign-in flow and saves the key as the active provider.
 * Call from a click handler in an extension page that stays open while the
 * auth window is up (side panel or options page).
 * @returns {Promise<boolean>} true when connected, false when the user closed the window
 */
export async function connectOpenRouter() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));

  const url = new URL(AUTH_URL);
  url.searchParams.set("callback_url", chrome.identity.getRedirectURL());
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("key_label", "Guidr"); // how the key is named in their OpenRouter dashboard

  let redirect;
  try {
    redirect = await chrome.identity.launchWebAuthFlow({ url: url.href, interactive: true });
  } catch (err) {
    // Closing the window rejects with "The user did not approve access."
    if (/did not approve|cancel|closed/i.test(err?.message || "")) return false;
    throw err;
  }
  const code = redirect && new URL(redirect).searchParams.get("code");
  if (!code) throw new Error("OpenRouter didn't return an authorization code.");

  const res = await fetch(KEY_EXCHANGE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.key) {
    throw new Error(`OpenRouter sign-in failed: ${data.error?.message || res.status}`);
  }

  const { openrouterModel } = await chrome.storage.local.get("openrouterModel");
  await chrome.storage.local.set({
    provider: "openrouter",
    apiKey: data.key,
    openrouterModel: openrouterModel || OPENROUTER_DEFAULT_MODEL,
  });
  return true;
}
