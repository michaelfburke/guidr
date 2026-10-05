#!/usr/bin/env node
/**
 * scripts/build-privacy.js
 * Renders PRIVACY.md into docs/privacy/index.html, the policy page on the
 * project site (the Chrome Web Store privacy policy URL).
 *
 *   npm run build:privacy           write the page
 *   npm run build:privacy -- --check  fail if the page is out of date (CI)
 *
 * Handles the Markdown PRIVACY.md uses: headings, paragraphs, bullet lists
 * with wrapped lines, **bold**, _italic_, `code` and [links](url).
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "PRIVACY.md");
const OUT = join(ROOT, "docs/privacy/index.html");

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function inline(text) {
  const codes = [];
  let s = esc(text).replace(/`([^`]+)`/g, (_, c) => `\uE000${codes.push(c) - 1}\uE000`);
  s = s
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])_([^_]+)_(?=[\s).,;:]|$)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
  return s.replace(/\uE000(\d+)\uE000/g, (_, i) => `<code>${codes[i]}</code>`);
}

export function markdownToHtml(md) {
  const out = [];
  let para = [];
  let list = null; // items, each an array of lines
  const flushPara = () => { if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`); para = []; };
  const flushList = () => {
    if (list) out.push(`<ul>\n${list.map((it) => `  <li>${inline(it.join(" "))}</li>`).join("\n")}\n</ul>`);
    list = null;
  };
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    const heading = line.match(/^(#{1,3}) (.*)$/);
    const bullet = line.match(/^- (.*)$/);
    if (heading) {
      flushPara(); flushList();
      const level = heading[1].length;
      const id = heading[2].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      out.push(`<h${level} id="${id}">${inline(heading[2])}</h${level}>`);
    } else if (bullet) {
      flushPara();
      (list ||= []).push([bullet[1]]);
    } else if (!line.trim()) {
      flushPara(); flushList();
    } else if (list && /^\s+\S/.test(raw)) {
      list[list.length - 1].push(line.trim()); // wrapped list item
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara(); flushList();
  return out.join("\n");
}

function page(body) {
  return `<!DOCTYPE html>
<!-- Generated from PRIVACY.md by scripts/build-privacy.js. Edit PRIVACY.md, then run npm run build:privacy. -->
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Privacy Policy – Guidr</title>
  <meta name="description" content="What data the Guidr Chrome extension handles, where it is stored, and where it goes." />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root { --bg: #0d1117; --card: #161b22; --border: #30363d; --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg); color: var(--text); line-height: 1.65; font-size: 16px; }
    a { color: var(--accent); }
    nav { display: flex; align-items: center; justify-content: space-between; padding: 0 1.25rem; height: 60px;
      border-bottom: 1px solid var(--border); max-width: 100%; }
    .logo { display: flex; align-items: center; gap: 0.5rem; font-weight: 700; color: var(--text); text-decoration: none; }
    main { max-width: 760px; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
    h1 { font-size: 2rem; line-height: 1.2; margin-bottom: 0.5rem; }
    h2 { font-size: 1.25rem; margin: 2.25rem 0 0.75rem; padding-top: 1.25rem; border-top: 1px solid var(--border); }
    p, ul { margin-bottom: 1rem; }
    ul { padding-left: 1.4rem; }
    li { margin-bottom: 0.5rem; }
    h1 + p em { color: var(--muted); font-style: normal; font-size: 0.9rem; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85em;
      background: var(--card); border: 1px solid var(--border); border-radius: 4px; padding: 0.1em 0.35em;
      overflow-wrap: anywhere; }
    footer { border-top: 1px solid var(--border); padding: 1.5rem 1.25rem; text-align: center; color: var(--muted); font-size: 0.875rem; }
  </style>
</head>
<body>
<nav>
  <a class="logo" href="../">
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <rect width="22" height="22" rx="5" fill="#7c6af7"/>
      <rect x="4" y="4" width="14" height="3" fill="white"/>
      <rect x="4" y="4" width="3" height="14" fill="white"/>
      <rect x="4" y="15" width="14" height="3" fill="white"/>
      <rect x="11" y="10" width="7" height="3" fill="white"/>
    </svg>
    Guidr
  </a>
  <a href="../">← Back to Guidr</a>
</nav>
<main>
${body}
</main>
<footer>
  Questions about this policy? <a href="https://github.com/michaelfburke/guidr/issues">Open an issue on GitHub</a>.
</footer>
</body>
</html>
`;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const html = page(markdownToHtml(readFileSync(SRC, "utf8")));
  if (process.argv.includes("--check")) {
    if (!existsSync(OUT) || readFileSync(OUT, "utf8") !== html) {
      console.error("✘ docs/privacy/index.html is out of date. Run: npm run build:privacy");
      process.exit(1);
    }
    console.log("✔ docs/privacy/index.html matches PRIVACY.md");
  } else {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, html);
    console.log("✔ wrote docs/privacy/index.html");
  }
}
