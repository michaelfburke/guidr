# Chrome Web Store Listing — Guidr

Copy-paste ready content for the Chrome Web Store developer console.

---

## Short Description (132 chars max)

```
Record your screen, let AI write the guide. Privacy-first, zero servers, bring your own API key.
```
_(96 chars)_

---

## Full Description

```
Guidr turns screen recordings into polished step-by-step guides — automatically.

Click through any web product while Guidr records your actions. Then hit Enrich: Guidr sends each step's screenshot and element metadata to your AI provider of choice, and gets back a clear title, a detailed description, and a voiceover script. Done.

KEY FEATURES

▶ One-click recording
Open the side panel, click Start, and click through your product. Guidr tracks every action.

✦ AI enrichment
Powered by Anthropic Claude, OpenAI GPT, Google Gemini, or OpenRouter. Bring your own API key — Guidr never touches it.

✏ Step editor
Edit titles, rewrite descriptions, reorder steps, and trim GIF clips before you export.

◎ Annotations
Draw circles, arrows, and highlights on screenshots. Mask sensitive content before sharing.

📤 Four export formats
Markdown (with embedded screenshots), self-contained HTML, Intercom-ready HTML, and raw JSON backup.

🔒 Privacy-first by design
No servers. No telemetry. Your recordings, screenshots, and API key never leave your browser. Everything lives in extension-sandboxed IndexedDB and chrome.storage.local.

SUPPORTED AI PROVIDERS
• Anthropic (Claude 3/4 with prompt caching)
• OpenAI (GPT-4o and newer)
• Google Gemini
• OpenRouter (access 100+ models)

PERFECT FOR
• Customer success and support teams
• Technical writers
• Onboarding specialists
• Anyone who writes "how to" documentation

HOW IT WORKS
1. Open Guidr from the Chrome toolbar and click Start Recording
2. Click through the product flow you want to document
3. Click Stop — Guidr saves every step with a screenshot
4. Hit Enrich (all steps) to let AI write the titles and descriptions
5. Export as Markdown, HTML, or directly to Intercom

FREE & OPEN SOURCE
Guidr is free to use. You only pay for the AI API calls you make to your chosen provider.
```

---

## Permission Justifications

Use these in the "Permissions" section of the developer console.

| Permission | Justification |
|-----------|--------------|
| `activeTab` | Required to inject the recording logic and capture screenshots of the tab the user is actively recording. |
| `scripting` | Required to inject the content script that tracks clicks and captures element metadata (CSS selector, ARIA label, bounding rectangle) during a recording session. |
| `tabs` | Required to read the URL and title of the active tab so each recorded step can be annotated with the correct page context. |
| `storage` | Required to persist the user's API key, model preference, tone-of-voice guide, and session metadata locally in their browser. No data is synced or sent anywhere. |
| `sidePanel` | Guidr's entire UI lives in the Chrome side panel. This permission is required to open the side panel from the toolbar action. |
| `downloads` | Required to save exported guides (Markdown, HTML, JSON files) to the user's disk when they click the Export button. |
| `desktopCapture` | Required to start the screen capture stream used to record the user's walkthrough. Chrome mandates this permission for any extension that captures the screen. |
| `offscreen` | Chrome side panels cannot request microphone access directly. An offscreen document is required to capture optional voice narration for voiceover scripts. |
| `optional host permissions: <all_urls>` | Requested the first time the user starts a recording so that screenshot capture continues to work after page navigations within a session. This is optional — the user is prompted to grant it and can revoke it at any time from chrome://extensions. |

---

## Category

**Productivity**

Secondary: Developer Tools

---

## Tags / Keywords

```
guide maker, documentation, screen recording, step-by-step guide, AI writing, customer success,
technical writing, Intercom, onboarding, how-to, walkthrough, screenshot
```

---

## Privacy Policy URL

```
https://michaelfburke.github.io/guidr/privacy.html
```

---

## Promotional Assets Checklist

- [ ] **Screenshots** (required, min 1): 1280×800 or 640×400 PNG/JPEG
  - Screenshot 1: Recording in progress — side panel open, steps list building up
  - Screenshot 2: Step editor — screenshot with annotation circle, AI-generated title/body visible
  - Screenshot 3: Exported Markdown or HTML guide output
  - Screenshot 4: Options/Settings page showing API key and tone guide fields
- [x] **Small promo tile**: 440×280 PNG — see `docs/promo-tile.svg` (render to PNG before upload)
- [ ] **Large promo tile**: 920×680 PNG (optional but recommended)
- [ ] **Marquee promo tile**: 1400×560 PNG (required if you want featured placement)
- [ ] **Demo video**: YouTube link (optional but strongly recommended for conversion)

---

## Notes

- Update `homepage_url` in `manifest.json` to `https://michaelfburke.github.io/guidr` before packaging.
- Update the "Add to Chrome" button hrefs in `docs/index.html` and `docs/privacy.html` once the store URL is known.
- The store URL format is typically: `https://chromewebstore.google.com/detail/<extension-name>/<id>`
