# Chrome Web Store listing — draft

Copy for the Developer Dashboard. Not shipped in the extension zip.
Keep in sync with `manifest.json`, `PRIVACY.md`, and the README.

---

## Store listing tab

**Name** (from manifest): Guidr – AI Guide Maker

**Summary** (manifest `description`, ≤132 chars):
> Click through any SaaS product and generate polished step-by-step guides with AI.

**Category:** Productivity → Workflow & Planning

**Language:** English

**Description:**

> Turn a click-through of any web app into a polished, step-by-step help article in minutes.
>
> Guidr is built for customer success, support, and enablement teams who write how-to guides. Start a recording, walk through the feature the way a customer would, and stop. Guidr turns every click into a step with a screenshot, then uses AI to write a clear title and instructions for each one.
>
> HOW IT WORKS
> • Record: pick a tab, window, or screen and click through your product. Switch on narration to talk over it if you like.
> • Draft: every click instantly becomes a step with a plain title and instruction, no setup needed.
> • Rewrite with AI: one click rewrites every step into a clear title, body, and voiceover line, in your brand's tone of voice.
> • Edit: reorder steps, annotate screenshots with arrows, circles, highlights and masks, or swap a screenshot for a short GIF clip.
> • Export: Markdown, a self-contained HTML page, Intercom-ready HTML on your clipboard, or raw JSON.
>
> BRING YOUR OWN AI
> Connect OpenRouter in two clicks, or paste your own API key from Anthropic, OpenAI, or Google Gemini. You choose the provider and model and pay them directly. A typical guide costs a few cents. AI is optional: without it, you still get an editable step-by-step draft.
>
> PRIVATE BY DESIGN
> Guidr has no server and no account. Recordings, narration, and guides stay in your browser. Nothing is sent anywhere until you click Rewrite with AI, and then only that step's screenshot and click details go straight to the AI provider you chose. No analytics, no tracking.
>
> Free and open source (MIT): https://github.com/michaelfburke/guidr

**Graphic assets:**
- [x] Icon 128×128 (`icons/icon128.png`): 96×96 artwork, 16px transparent padding
- [x] Screenshots 1280×800, in upload order: `store/assets/screenshot-1-record.png` (recording) · `-2-editor` (rewritten step) · `-3-annotate` · `-4-export` · `-5-settings`
- [x] Small promo tile 440×280: `store/assets/promo-440x280.png`
- Regenerate both after UI changes: `xvfb-run -a -s "-screen 0 1920x1080x24" node store/assets-src/make-assets.cjs` (needs Playwright with Chromium)

**Homepage URL:** https://michaelfburke.github.io/guidr/ (GitHub Pages, `docs/`)
**Support URL:** https://github.com/michaelfburke/guidr/issues

---

## Privacy practices tab

**Single purpose:**
> Guidr records a user-initiated walkthrough of a web page (screen video plus click details) and turns it into a step-by-step written guide, optionally using an AI provider the user configures with their own API key.

**Permission justifications:**

| Permission | Justification |
|---|---|
| `desktopCapture` | Records the tab, window or screen the user picks in Chrome's share dialog when they start a recording. The video is the source of each step's screenshot. |
| `offscreen` | Hosts microphone capture for optional narration. Chrome side panels cannot show the microphone permission prompt, so an offscreen document with reason USER_MEDIA is used. |
| `activeTab` | Identifies the tab the user is on when they start recording, so click capture is attached to it. |
| `scripting` | Injects the click-capture script into the tab being recorded, only while recording, and re-injects it after that tab navigates. |
| `storage` | Saves the user's settings (AI provider, API key, tone guide, examples), the guide list, and the in-progress recording state so it survives the service worker being suspended. |
| `sidePanel` | Guidr's main UI (start/stop recording, guide list) lives in the side panel. |
| `downloads` | Saves exported guides (Markdown, HTML, JSON) to the user's disk. |
| `identity` | Opens OpenRouter's sign-in page via launchWebAuthFlow when the user clicks "Connect OpenRouter", and receives the authorization code that is exchanged for the user's own OpenRouter API key. No Google account or profile data is read. |
| Host permission `<all_urls>` (optional) | Requested at runtime the first time the user records, so click details can be captured on whichever site they are documenting; also requested for one origin when the user adds an example guide by URL. Not granted at install; revocable in chrome://extensions. |

**Remote code:** No, I am not using remote code. All JavaScript is packaged with the extension; `vendor/gif.js` is a bundled local copy.

**Data usage:** tick what Guidr *transmits* off the device. Everything else stays in local storage. Guidr only transmits at the user's request, directly to the AI provider they configured:
- [x] **Website content**: a still frame from the recording and the clicked element's visible text and label, sent when the user clicks Rewrite with AI
- [x] **Web history**: the URL and title of the page where each step happened, sent with that step
- [x] **User activity**: which element was clicked, sent with that step
- [ ] Authentication information. Decide: the user's own API key is sent only to the provider that issued it, as the request credential. My reading is this isn't collecting the user's auth info for Guidr, but tick it if you want to be conservative.
- [ ] Personally identifiable info, health, financial, personal communications, location: not collected. Screenshots can incidentally show such data on screen; the description and privacy policy tell users to record a single tab and close sensitive content.

**Certifications** (all true, per PRIVACY.md):
- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** https://michaelfburke.github.io/guidr/privacy/ (generated from PRIVACY.md by `npm run build:privacy`; CI fails if it falls out of date)

---

## Before you submit

- [ ] Click **Connect OpenRouter** with a real OpenRouter account and confirm the key arrives and Rewrite with AI works. (Automated run covers everything except OpenRouter's real sign-in page, which needs an account.)
- [ ] Load the packaged zip unpacked in your own Chrome, on a fresh profile: the first Record click should show the site-access prompt *before* the mic prompt and screen picker, and steps should be captured. (Automated Chromium run of record → steps → SW restart → stop → editor → rewrite passes, but it pre-grants site access, so it can't see that prompt.)
- [x] Screenshots and promo tile made
- [ ] Version bumped in both `manifest.json` and `package.json`; `npm run package`; upload `dist/guidr-<version>.zip`
- [ ] Privacy policy URL loads (homepage confirmed live)
