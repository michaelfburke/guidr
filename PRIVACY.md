# Guidr Privacy Policy

_Last updated: 2026-10-03_

Guidr is a Chrome extension that records you clicking through a web app and
uses an AI provider you choose (Anthropic, OpenAI, Google Gemini, or
OpenRouter) to turn the recording into a step-by-step guide. This policy
describes exactly what data the extension handles, where it lives, and where
(if anywhere) it goes.

## TL;DR

- Guidr has no server. The developer never sees your data.
- Recordings live only in your browser, in extension-sandboxed storage.
- Nothing leaves your browser until you click **Enrich** or **Generate
  script**. Then the relevant step data is sent to the AI provider you
  selected, using the API key you provided.
- Your API key is stored locally and only ever sent to that provider.
- Uninstalling the extension or clicking **Clear all Guidr data** deletes
  everything.

## What Guidr captures

Only while you are actively recording a guide, and only after you start it:

- **Screen video.** When you start a recording, Chrome asks you to choose
  what to share — a browser tab, a window, or your entire screen. Guidr
  records a video of whatever you pick until you stop. Anything visible in
  the shared area is in the video, including text you type into forms.
  Choose a single tab and close anything sensitive before recording.
- **Microphone narration.** When you start a recording, Guidr asks Chrome
  for microphone access. If you allow it, your narration is recorded
  alongside the video until you stop. If you deny access or have no
  microphone, the recording continues without audio.
- **Click details.** For each click (or keyboard activation of a button or
  link) in the recorded tab: the element's tag, id, CSS classes, visible
  text, ARIA label and role, placeholder, input type and name, link URL,
  a CSS selector, its position on screen, the viewport size, and the
  nearest page landmark.
- **Page context.** The page URL and document title at the moment of each
  click.

Guidr does **not** record keystrokes as data, read form values, clipboard
contents or cookies, or capture anything when you are not recording. (As
noted above, the screen video shows whatever is on screen.)

## What Guidr stores, and where

All of this stays on your machine:

- **API key, provider and model choice, tone-of-voice guide, example guides,
  and UI preferences:** `chrome.storage.local` (sandboxed per extension, not
  synced to your Google account).
- **Guide list** (titles, step counts, timestamps): `chrome.storage.local`.
- **The in-progress recording's step list:** `chrome.storage.session`
  (in memory, cleared when the browser closes).
- **Screen recordings, narration audio, step details, generated text, and
  cached GIFs:** IndexedDB inside the extension.

Guidr sends the developer no telemetry, analytics, crash reports, or
recordings.

## What gets sent to third parties

Guidr makes network requests only for the actions below, directly from your
browser. It does not proxy or observe them.

**When you click Enrich on a step**, Guidr sends to your chosen AI provider:

- One still frame from the screen recording, taken at the moment of the click.
- A summary of that step's click details (element type, text, label, role)
  and the page URL and title.
- Your tone-of-voice guide and example guides, if you added any.

**When you click Generate script**, Guidr sends the guide's title and each
step's generated title and voiceover text.

**When you test your key or load the model list in Settings**, Guidr sends
your API key to the provider to validate it and list available models.

Your API key accompanies every provider request. The destination depends on
your provider selection:

- Anthropic — `https://api.anthropic.com`
- OpenAI — `https://api.openai.com`
- Google Gemini — `https://generativelanguage.googleapis.com` (the key is sent
  as a URL parameter, as Google's API requires)
- OpenRouter — `https://openrouter.ai`

The provider's own privacy and data-retention policies apply to anything you
send. Screen video and narration audio are never uploaded; only the single
frames described above are.

**When you add an example guide by URL in Settings**, Guidr asks for
permission to access that site, then fetches the page (without cookies) to
extract a text sample. The sample is stored locally and included in
enrichment prompts as a style reference.

Guidr contacts no other network endpoint and does not load remote code.

## Permissions, and why

- `desktopCapture` — to record the tab, window, or screen you choose.
- `offscreen` — to host microphone capture for narration (Chrome side panels
  cannot show the microphone permission prompt themselves).
- `activeTab`, `scripting` — to inject the click-detail logic into
  the tab you are recording, and re-inject it after the tab navigates.
- `storage` — to remember your settings and guide list.
- `sidePanel` — Guidr's UI is a side panel.
- `downloads` — to save guides you export to disk.
- Optional host access (`<all_urls>`) — requested the first time you record,
  so click details can be collected on whatever site you document, and when
  you add an example guide by URL. Granted by you, revocable at
  `chrome://extensions` → Guidr → Site access.

## Your controls

- Delete an individual guide, its video, or its narration from the side panel.
- Clear all Guidr data: Settings → **Clear all Guidr data**, or remove the
  extension at `chrome://extensions`.
- Revoke site access at any time from `chrome://extensions`.
- Use Guidr with no API key: you can record and edit guides by hand, and
  no data leaves your browser.

## Children

Guidr is not directed at children under 13 and the developer does not
knowingly collect data from them. (Guidr does not collect data from anyone.)

## Changes to this policy

If the data Guidr handles ever changes, this document will be updated and the
"Last updated" date above will move forward. Material changes will also be
noted in the extension's release notes.

## Contact

Questions: open an issue at <https://github.com/michaelfburke/guidr/issues>.
