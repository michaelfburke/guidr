// Builds the Chrome Web Store images in store/assets/ from the real extension.
//
//   xvfb-run -a -s "-screen 0 1920x1080x24" node store/assets-src/make-assets.cjs
//
// Needs Playwright with Chromium (PLAYWRIGHT_PATH overrides where it's loaded
// from). Records a guide on a fictional demo CRM (demo-site.html), so nothing
// real appears in the images. Stand-ins, all local to this script:
//  - the unpacked copy is granted site access at install (no prompt);
//  - the side panel page is opened in a 400px popup window and composited
//    beside the app, because Playwright can't screenshot Chrome's side panel;
//  - OpenRouter sign-in, model list and chat replies are served from here,
//    with hand-written step text in place of a live model's.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "../..");
const OUT = path.join(ROOT, "store/assets");
const SITE = "http://acme.test/";
const W = 1280, H = 800, PANEL_W = 400;
const DEMO_KEY = "sk-or-v1-demo";

// What the model "writes" for each captured click, keyed by the clicked label.
const REWRITES = {
  "New contact":  ["Open the new contact form", "On the Contacts page, click New contact in the top right. A form opens."],
  "Full name":    ["Enter the contact's name", "Click Full name and type the person's first and last name."],
  "Email":        ["Add their email address", "Click Email and enter the address you use to reach them."],
  "Save contact": ["Save the contact", "Click Save contact. The new contact appears at the top of your list."],
  "Deals":        ["Go to Deals", "Select Deals in the left navigation to see your open deals."],
};

const copyExtension = (dest) => {
  for (const f of fs.readdirSync(ROOT)) {
    if (f.endsWith(".js") && !/config\.js$/.test(f)) fs.copyFileSync(path.join(ROOT, f), path.join(dest, f));
  }
  for (const d of ["editor", "fonts", "icons", "offscreen", "options", "sidepanel", "vendor"]) {
    fs.cpSync(path.join(ROOT, d), path.join(dest, d), { recursive: true });
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  manifest.host_permissions = ["<all_urls>"];
  fs.writeFileSync(path.join(dest, "manifest.json"), JSON.stringify(manifest));
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "guidr-assets-"));
  const ext = path.join(tmp, "ext");
  fs.mkdirSync(ext);
  copyExtension(ext);

  const context = await chromium.launchPersistentContext(path.join(tmp, "profile"), {
    headless: false,
    viewport: { width: W, height: H },
    args: [
      `--disable-extensions-except=${ext}`,
      `--load-extension=${ext}`,
      "--auto-select-desktop-capture-source=Acme CRM",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--window-size=${W},${H + 100}`,
      "--hide-scrollbars",
    ],
  });

  await context.route(`${SITE}**`, (r) => r.fulfill({ contentType: "text/html", body: fs.readFileSync(path.join(__dirname, "demo-site.html")) }));
  const cors = { "access-control-allow-origin": "*" };
  await context.route("https://openrouter.ai/api/v1/auth/keys", (r) => r.fulfill({ contentType: "application/json", headers: cors, body: JSON.stringify({ key: DEMO_KEY }) }));
  await context.route("https://openrouter.ai/api/v1/models**", (r) => r.fulfill({ contentType: "application/json", headers: cors, body: fs.readFileSync(path.join(__dirname, "openrouter-models.json")) }));
  await context.route("https://openrouter.ai/api/v1/key", (r) => r.fulfill({ contentType: "application/json", headers: cors, body: '{"data":{}}' }));
  await context.route("https://openrouter.ai/api/v1/chat/completions", (r) => {
    const prompt = JSON.stringify(JSON.parse(r.request().postData() || "{}").messages);
    const label = Object.keys(REWRITES).find((l) => prompt.includes(`\\"${l}\\"`)) || "Deals";
    const [title, body] = REWRITES[label];
    r.fulfill({ contentType: "application/json", headers: cors, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title, body, voiceoverScript: body }) } }] }) });
  });
  await context.addInitScript(() => {
    if (globalThis.chrome?.identity) chrome.identity.launchWebAuthFlow = async () => `${chrome.identity.getRedirectURL()}?code=demo`;
  });

  const sw = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extId = new URL(sw.url()).host;
  const extUrl = (p) => `chrome-extension://${extId}/${p}`;

  const app = context.pages()[0] || await context.newPage();
  await app.goto(SITE);
  const appTabId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u + "*" }))[0]?.id, SITE);

  // The panel gets its own popup window: in the app's window, its narrow
  // viewport would shrink what the recording captures.
  await context.addInitScript((id) => {
    if (!location.pathname.endsWith("/sidepanel/index.html")) return;
    const orig = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = (q, ...rest) => (q && q.active ? Promise.resolve([{ id }]) : orig(q, ...rest));
  }, appTabId);
  const panelOpened = context.waitForEvent("page");
  await sw.evaluate(({ url, w, h }) => chrome.windows.create({ url, type: "popup", width: w, height: h }),
    { url: extUrl("sidepanel/index.html"), w: PANEL_W, h: H });
  const panel = await panelOpened;
  await panel.setViewportSize({ width: PANEL_W, height: H });
  await panel.waitForLoadState();
  await panel.waitForTimeout(500);

  // Composites the app and the panel side by side, the way Chrome shows them.
  const sideBySide = async (name) => {
    const a = (await app.screenshot()).toString("base64");
    const p = (await panel.screenshot()).toString("base64");
    const page = await context.newPage();
    await page.setViewportSize({ width: W, height: H });
    await page.setContent(`<body style="margin:0;display:flex;background:#000">
      <img src="data:image/png;base64,${a}" width="${W - PANEL_W}" height="${H}">
      <img src="data:image/png;base64,${p}" width="${PANEL_W}" height="${H}" style="box-shadow:-1px 0 0 #2c2c3c">
    </body>`);
    await page.screenshot({ path: path.join(OUT, name) });
    await page.close();
  };

  const startRecording = async (appWidth) => {
    await app.bringToFront();
    await app.setViewportSize({ width: appWidth, height: H });
    await app.waitForTimeout(500);
    await panel.click("#recBtn");
    await panel.waitForSelector("#captureSection", { state: "visible", timeout: 20000 });
    await panel.waitForTimeout(1200);
    await app.bringToFront();
  };
  const stopRecording = async () => {
    await panel.bringToFront();
    const opened = context.waitForEvent("page", { timeout: 20000 });
    await panel.click("#recBtn");
    return opened;
  };

  // ── The guide shown in the editor shots, recorded full width ──────────
  await startRecording(W);
  await app.click("#newContact");
  await app.click("#name"); await app.keyboard.type("Jordan Lee");
  await app.click("#email"); await app.keyboard.type("jordan@contoso.test");
  await app.waitForTimeout(600);
  await app.click("#save");
  await app.waitForTimeout(900);
  await app.click("text=Deals");
  await app.waitForTimeout(1200);

  // ── Stop → editor; connect and rewrite ────────────────────────────────
  const editor = await stopRecording();
  await editor.setViewportSize({ width: W, height: H });
  await editor.waitForLoadState();
  await editor.waitForTimeout(2500);
  await editor.fill("#sessionName", "Add a new contact");
  await editor.click("#enrichAllTopBtn");
  await editor.click("#aiConnectBtn");
  await editor.waitForFunction(() => document.querySelector("#enrichAllTopBtn")?.hidden, null, { timeout: 30000 });
  await editor.waitForTimeout(800);

  // ── 2. Editor with a rewritten step ───────────────────────────────────
  await editor.click('.chip[data-idx="1"]');
  await editor.waitForTimeout(800);
  await editor.mouse.move(0, H - 1);
  await editor.waitForTimeout(3000); // let toasts fade
  await editor.screenshot({ path: path.join(OUT, "screenshot-2-editor.png") });

  // ── 3. Annotations ────────────────────────────────────────────────────
  await editor.click('.chip[data-idx="0"]');
  await editor.waitForTimeout(800);
  await editor.click("#openAnnotBtn");
  await editor.waitForTimeout(1200);
  const box = await editor.locator("#annotCanvas").boundingBox();
  const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
  const drag = async (from, to) => {
    await editor.mouse.move(...from); await editor.mouse.down();
    await editor.mouse.move(...to, { steps: 8 }); await editor.mouse.up();
    await editor.waitForTimeout(200);
  };
  // The "New contact" button sits top right of the 1280×800 demo app.
  await editor.click('.annot-tool[data-tool="highlight"]');
  await drag(at(0.876, 0.022), at(0.98, 0.093));
  await editor.click('.annot-tool[data-tool="arrow"]');
  await drag(at(0.76, 0.40), at(0.87, 0.11));
  await editor.click('.annot-tool[data-tool="circle"]');
  await editor.mouse.click(...at(0.835, 0.06));
  await editor.waitForTimeout(200);
  await editor.click('.annot-tool[data-tool="circle"]'); // deselect, so no tool hint shows
  await editor.mouse.move(0, H - 1);
  await editor.waitForTimeout(600);
  await editor.screenshot({ path: path.join(OUT, "screenshot-3-annotate.png") });
  await editor.click("#annotClose");

  // ── 4. Export menu ────────────────────────────────────────────────────
  await editor.click('.chip[data-idx="3"]');
  await editor.waitForTimeout(800);
  await editor.click("#exportBtn");
  await editor.waitForTimeout(400);
  await editor.screenshot({ path: path.join(OUT, "screenshot-4-export.png") });
  await editor.keyboard.press("Escape");

  // ── 1. Recording in progress: a second, short recording at panel width ─
  await app.goto(SITE);
  await startRecording(W - PANEL_W);
  await app.click("#newContact");
  await app.click("#name"); await app.keyboard.type("Jordan Lee");
  await app.click("#email"); await app.keyboard.type("jordan@contoso.test");
  await app.waitForTimeout(1200);
  await sideBySide("screenshot-1-record.png");
  (await stopRecording()).close();

  // ── 5. Settings, connected ────────────────────────────────────────────
  const opts = await context.newPage();
  await opts.setViewportSize({ width: W, height: H });
  await opts.goto(extUrl("options/index.html"));
  await opts.waitForTimeout(2000);
  await opts.screenshot({ path: path.join(OUT, "screenshot-5-settings.png") });

  // ── Promo tile (440×280) ──────────────────────────────────────────────
  const tile = await context.newPage();
  await tile.setViewportSize({ width: 440, height: 280 });
  await tile.goto(`file://${path.join(__dirname, "promo-tile.html")}`);
  await tile.waitForTimeout(500);
  await tile.screenshot({ path: path.join(OUT, "promo-440x280.png") });

  await context.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("Wrote", fs.readdirSync(OUT).join(", "));
})().catch((e) => { console.error(e); process.exit(1); });
