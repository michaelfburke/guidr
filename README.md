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
├── db.js                  IndexedDB wrapper (sessions + steps with screenshots)
├── export.js              Export to Markdown, HTML, Intercom JSON, raw JSON
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
4. Go to ⚙️ Settings → choose an LLM provider, paste your API key → Save
5. Navigate to any SaaS app, name your guide, hit **Start recording**
   - First time only: Chrome will prompt for access to all sites. This is what lets Guidr screenshot the tab during recording. You can revoke it at any time from `chrome://extensions`.
6. Click through the feature you want to document
7. Hit **Stop recording** → **✦ Enrich all** to generate text
8. Export as Markdown, HTML, or Intercom JSON

---

## LLM providers

Guidr supports four providers. Bring your own API key for whichever you prefer:

| Provider | Get a key |
|---|---|
| Anthropic | <https://console.anthropic.com/settings/keys> |
| OpenAI | <https://platform.openai.com/api-keys> |
| Google Gemini | <https://aistudio.google.com/apikey> |
| OpenRouter | <https://openrouter.ai/keys> |

Pick the provider and model in ⚙️ Settings. Cost per guide varies by provider, model, and screenshot count — typically a few cents to a few tens of cents.

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
- **Sessions metadata**: `chrome.storage.local` (fast listing)
- **Steps + screenshots**: IndexedDB (no size limit, survives browser restarts)

Estimated storage: ~200KB per step with screenshot. 50-step guide ≈ 10MB.
The extension warns when IndexedDB usage exceeds 500MB. Old sessions can be archived/deleted.

---

## Roadmap

- [ ] v0.1 — capture → enrich → export (this codebase)
- [ ] v0.2 — drag-to-reorder steps, re-capture individual step
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
- **Service worker lifecycle**: Chrome may suspend the SW after inactivity. Recording state is persisted to `chrome.storage.local` so it survives restarts, but you may see a brief reconnection delay.

---

## License

MIT — see [LICENSE](LICENSE).
