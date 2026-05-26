# Guidr Privacy Policy

_Last updated: 2026-05-26_

Guidr is a Chrome extension that records your interactions with web pages and
uses an AI provider you choose (Anthropic, OpenAI, or OpenRouter) to turn them
into step-by-step guides. This policy describes exactly what data the extension
handles, where it lives, and where (if anywhere) it goes.

## TL;DR

- Guidr has no server. The developer never sees your data.
- Recordings live only in your browser, in extension-sandboxed storage.
- When you click **Enrich**, the captured step (screenshot + DOM metadata) is
  sent to the AI provider you selected, using the API key you provided.
- Your API key is stored locally and only ever sent to that provider.
- Uninstalling the extension or clearing its storage deletes everything.

## What Guidr captures

While you are actively recording a guide, and only then, Guidr captures:

- Screenshots of the active browser tab (before and after each click).
- The element you clicked: CSS selector, visible text, ARIA label, role, and
  bounding rectangle.
- The page URL and document title at the moment of the click.
- The viewport dimensions and device pixel ratio (needed to render the guide).

Guidr does **not** capture: keystrokes, form values, clipboard contents, cookies,
browser history outside the recording session, or anything from tabs other than
the one you are recording.

## What Guidr stores, and where

- **API key, model selection, tone-of-voice settings, and example guides:**
  `chrome.storage.local` (sandboxed per-extension, never synced).
- **Session metadata** (guide titles, step lists): `chrome.storage.local`.
- **Steps and screenshots:** IndexedDB inside the extension, in your browser.

All of the above stays on your machine. Guidr operates no server and the
developer receives no telemetry, analytics, crash reports, or recordings.

## What gets sent to third parties

When you click **Enrich** on a step or **Generate script** for a guide, Guidr
sends the following to the AI provider you configured in Settings:

- The step screenshot(s).
- The DOM metadata for the clicked element.
- The page URL and title.
- Your tone-of-voice guide and any example guides, if you provided them.
- Your API key, in the request's Authorization header.

The destination depends on your provider selection:

- Anthropic — `https://api.anthropic.com`
- OpenAI — `https://api.openai.com`
- OpenRouter — `https://openrouter.ai`

These requests are made directly from your browser to the provider. Guidr does
not proxy or observe them. The provider's own privacy and data-retention
policies apply to anything you send.

Guidr does not contact any other network endpoint. It does not load remote code.

## Permissions, and why

- `activeTab`, `tabs`, `scripting` — needed to inject the recording logic into
  the tab you choose to record, and to take screenshots of that tab.
- `storage` — to remember your API key and settings.
- `sidePanel` — Guidr's UI is a side panel.
- `downloads` — to save guides you export to disk.
- `optional_host_permissions: <all_urls>` — requested the first time you record,
  so screenshot capture continues to work after page navigations. Granted by
  you, revocable at `chrome://extensions` → Guidr → Site access.

## Your controls

- Delete an individual guide or step from the side panel.
- Clear all Guidr data: `chrome://extensions` → Guidr → Remove, or use the
  "Clear all data" button in Settings.
- Revoke the all-sites permission at any time from `chrome://extensions`.
- Use a different API key, or no key — without one, no data leaves your browser.

## Children

Guidr is not directed at children under 13 and the developer does not knowingly
collect data from them. (Guidr does not collect data from anyone.)

## Changes to this policy

If the data Guidr handles ever changes, this document will be updated and the
"Last updated" date above will move forward. Material changes will also be
noted in the extension's release notes.

## Contact

Questions: open an issue at <https://github.com/michaelfburke/guidr/issues>.
