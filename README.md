# Guidr — AI Guide Maker (Chrome Extension)

Free, open-source Chrome extension for customer success teams.
Click through any SaaS product → get step-by-step guides with AI-generated text, screenshots, and voiceover scripts.

**Bring your own API key. Nothing leaves your browser.**

---

## Project structure

```
guidr-extension/
├── manifest.json          MV3 manifest
├── content_script.js      Injected into pages — captures clicks + DOM context
├── service_worker.js      Background SW — orchestrates capture, LLM, storage
├── llm.js                 LLM enrichment (Anthropic + OpenAI)
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
4. Go to ⚙️ Settings → paste your Anthropic or OpenAI API key → Save
5. Navigate to any SaaS app, name your guide, hit **Start recording**
6. Click through the feature you want to document
7. Hit **Stop recording** → **✦ Enrich all** to generate text
8. Export as Markdown, HTML, or Intercom JSON

---

## LLM providers

| Provider | Model used | Notes |
|---|---|---|
| Anthropic (recommended) | claude-opus-4-6 | Best multimodal quality; get key at console.anthropic.com |
| OpenAI | gpt-4o | Good alternative; get key at platform.openai.com |

Cost per guide: roughly $0.05–0.20 depending on screenshot count and provider.

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

### Intercom Article JSON
Ready for the [Intercom Articles API](https://developers.intercom.com/docs/references/rest-api/api.intercom.io/Articles/article/).
Fill in `author_id` and `parent_id` (your collection), then POST to:
```
POST https://api.intercom.io/articles
Authorization: Bearer YOUR_INTERCOM_TOKEN
Content-Type: application/json
```
Screenshots in Intercom articles require image hosting (Intercom doesn't accept base64).
Upload screenshots to S3/Cloudinary and replace the `<img>` srcs before posting. This is a v2 feature.

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
