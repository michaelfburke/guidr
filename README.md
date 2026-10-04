# Guidr — AI Guide Maker (Chrome Extension)

Free, open-source Chrome extension for customer success teams.
Click through any SaaS product → get step-by-step guides with AI-generated text, screenshots, and voiceover scripts.

**Bring your own API key. Nothing leaves your browser except the calls you make to your chosen LLM provider.** See [PRIVACY.md](PRIVACY.md) for details.

---

## Project structure

```
guidr-extension/
├── manifest.json          MV3 manifest
├── content_script.js      Injected on demand by the SW during recording — captures clicks + DOM context
├── service_worker.js      Background SW — orchestrates capture, LLM, storage
├── llm.js                 LLM enrichment (Anthropic, OpenAI, Gemini, OpenRouter)
├── draft.js               Template step text used before (or without) AI enrichment
├── openrouter.js          "Connect OpenRouter" sign-in (OAuth PKCE)
├── models.js              Live model lists and per-step price estimates for Settings
├── db.js                  IndexedDB wrapper (sessions + steps + recordings + GIF cache)
├── export.js              Export to Markdown, HTML, Intercom allowlist HTML, raw JSON
├── vendor/
│   └── gif.js             Local copy of gif.js (used for per-step GIF clips)
├── sidepanel/
│   └── index.html         Side panel UI (recording, step list, export)
└── options/
    └── index.html         Settings (API key, tone guide, examples)
```

---

## Quick start (load unpacked)

1. `chrome://extensions` → enable **Developer mode**
2. Click **Load unpacked** → select this folder
3. Click the Guidr icon → opens side panel
4. Optional: switch on **Record voice narration** under the record button (the first time, Settings asks for the microphone).
5. Optional: click **Connect OpenRouter** in the side panel (or paste your own key in ⚙️ Settings). Without AI, each step still gets a draft title and instruction.
6. Navigate to any SaaS app and hit **Start recording**
   - First time only: Chrome will prompt for access to all sites. This is what lets Guidr screenshot the tab during recording. You can revoke it at any time from `chrome://extensions`.
7. Click through the feature you want to document
8. Hit **Stop recording**. The guide opens in the editor with draft text; click **Rewrite all with AI** to have your provider rewrite it
9. Export as Markdown, HTML, or Intercom HTML

### Packaging for the Chrome Web Store

```sh
npm run package   # → dist/guidr-<version>.zip
```

Zips only the runtime files (no `node_modules`, tests, or docs), after
checking that `manifest.json` and `package.json` versions match and that every
relative import, `src`/`href`, CSS `url()` and `chrome.runtime.getURL` path
resolves to a shipped file. Bump the version in both files before a release.

---

## LLM providers

Guidr supports four providers. The quickest start is **Connect OpenRouter** in the side panel: sign in to OpenRouter, approve, and Guidr receives a key in your account. No copying, and one account covers Claude, GPT and Gemini models (default: `anthropic/claude-haiku-4.5`).

Or bring your own API key for whichever provider you prefer:

| Provider | Get a key |
|---|---|
| Anthropic | <https://console.anthropic.com/settings/keys> |
| OpenAI | <https://platform.openai.com/api-keys> |
| Google Gemini | <https://aistudio.google.com/apikey> |
| OpenRouter | <https://openrouter.ai/keys> |

Pick the provider and model in ⚙️ Settings. The model list comes live from the provider (the models your key can use that accept screenshots), so new models appear without an extension update. The estimated cost per step comes from OpenRouter's public price list.

Defaults, used until you pick a model, are in `DEFAULT_MODELS` in `llm.js`. Where the provider maintains a moving alias, the default uses it (`gemini-flash-latest`, `~anthropic/claude-haiku-latest`), so it follows new releases on its own. Anthropic (`claude-haiku-4-5`) and OpenAI (`gpt-6-luna`) don't offer such an alias for their small models, so those two need a bump when a new generation ships.

Requests send only the settings each model needs, plus the lowest reasoning effort the provider offers. If a model rejects one of those optional settings, the request is retried without it, so a new model generation doesn't break enrichment.

---

## Customisation

### Tone of voice
In Settings, paste your brand voice guide. It's injected verbatim into the system prompt for every enrichment call. Example:

```
We write in second person ("you"), active voice.
Avoid jargon. Steps should be under 25 words.
Start with a verb: "Click", "Select", "Enter", "Toggle".
End with the outcome where relevant: "...to open the dashboard."
```

### Example guides
Add up to 3 example step title/body pairs in Settings.
These are used as few-shot examples in the system prompt.

---

## Per-step media

Each step exports as one of three modes, picked from a segmented control at the top of the step panel:

- **Screenshot** (default) — a still frame from the recording at the moment of the click. Supports annotations (circles, arrows, highlights, masks).
- **Animated GIF** — a short clip from the recording. Scrub the video to where you want the clip to start, hit **Start here**, scrub to where it should end, hit **End here**, pick a frame rate (5/10/15 fps), then **Generate GIF**. The encoded clip previews inline and embeds in any export format. Output is auto-downscaled to 1280px wide so Intercom and other help-center renderers accept it; a size warning appears if the result is still over ~3 MB. GIF steps don't support annotations — switch back to Screenshot to add them. Encoded clips are cached in IndexedDB so re-exports are instant.
- **No image** — skip the visual for this step.

---

## Export formats

### Markdown
Embeds screenshots as base64 data URLs. Works in any markdown renderer.
For large guides, consider the HTML export instead (same content, nicer rendering).

### HTML
Self-contained single file. Open in any browser. Good for sharing via email or Notion embed.

### Copy for Intercom
Copies the guide as [allowlist HTML](https://developers.intercom.com/docs/guides/help-center/supported-html)
to the clipboard, with screenshots inlined as base64 `<img>` tags.

To use it:
1. Pick **Copy for Intercom** in the export bar and click **Export**.
2. In Intercom, create a new article and click into the body.
3. Paste. The editor uploads the inline images to Intercom's CDN on save.

No API token, no `author_id`, no JSON to edit.

### Raw JSON
Full session backup including all metadata (no screenshots). Use to import into another browser or for debugging.

---

## Storage

- **API key + settings**: `chrome.storage.local` (sandboxed to the extension)
- **Sessions metadata mirror**: `chrome.storage.local` (fast home-view listing, no blobs)
- **WebM recordings, step metadata, cached GIFs**: IndexedDB (no fixed cap, survives browser restarts)

The source of truth for each session is a single WebM blob from `MediaRecorder`; per-click step records hold only metadata (timestamps, target info, title/body). Screenshots are derived on-demand from the WebM at export time, and GIFs (when used) are encoded once and cached. Typical sizes:

- Recording: ~3–6 MB per minute at 1080p, 4 Mbps.
- Step metadata: a few KB each.
- Cached GIF: a few hundred KB to a few MB per step depending on length and fps.

---

## Roadmap

- [ ] v0.1 — capture → enrich → export (this codebase)
- [x] v0.2 — drag-to-reorder steps, re-capture individual step
- [ ] v0.3 — ElevenLabs TTS voiceover generation
- [ ] v0.4 — synthesised walkthrough video (screenshots + animated cursor + audio)
- [ ] v0.5 — direct Intercom publish (with image upload)
- [ ] v0.6 — PII blur tool (auto-detect + manual)
- [ ] Team tier — optional cloud sync for shared guides

---

## Known limitations

- **Cross-origin iframes** (Stripe, Auth0, embedded widgets): content script cannot access these frames. Steps inside iframes are captured as screenshots only, with no DOM context.
- **Canvas/WebGL apps**: no DOM to capture; screenshot-only mode.
- **Intercom base64 images**: Intercom's Help Center API rejects data URLs. Until image hosting is added, export as HTML and embed manually.
- **Service worker lifecycle**: Chrome may suspend the SW after inactivity. The in-progress recording's state is mirrored to `chrome.storage.session` and restored when the SW wakes, so steps aren't lost mid-recording.

---

## License

MIT — see [LICENSE](LICENSE).
