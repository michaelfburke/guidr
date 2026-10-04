#!/usr/bin/env node
/**
 * scripts/package.js
 * Builds dist/guidr-<version>.zip for upload to the Chrome Web Store.
 *
 * Only the files the extension loads at runtime are included — no
 * node_modules, tests, docs, or tooling config. Before zipping, file
 * references are checked to resolve to a shipped file: manifest entries, ES
 * imports, HTML src/href, CSS url(), chrome.runtime.getURL, scripting
 * `files: [...]`, and path-like string literals (e.g. the offscreen document
 * URL). This is a heuristic scan, not a parser: it catches a renamed or
 * un-INCLUDEd file before review, not every possible reference.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const INCLUDE = [
  "manifest.json",
  "service_worker.js",
  "content_script.js",
  "db.js",
  "draft.js",
  "llm.js",
  "openrouter.js",
  "export.js",
  "utils.js",
  "sidepanel",
  "options",
  "editor",
  "offscreen",
  "vendor",
  "icons",
  "fonts",
  "LICENSE",
];

function walk(rel) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) fail(`Missing: ${rel}`);
  if (!statSync(abs).isDirectory()) return [rel];
  return readdirSync(abs).flatMap((name) => walk(join(rel, name)));
}

function fail(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

const files = INCLUDE.flatMap(walk).filter((f) => !f.split("/").pop().startsWith("."));
const shipped = new Set(files.map((f) => normalize(f)));

// ─── Manifest checks ─────────────────────────────────────────────────────────

const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
if (manifest.version !== pkg.version) {
  fail(`manifest.json version (${manifest.version}) != package.json version (${pkg.version})`);
}

const manifestRefs = [
  manifest.background?.service_worker,
  manifest.side_panel?.default_path,
  manifest.options_page,
  manifest.options_ui?.page,
  manifest.action?.default_popup,
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
  ...(manifest.content_scripts || []).flatMap((cs) => [...(cs.js || []), ...(cs.css || [])]),
  ...(manifest.web_accessible_resources || []).flatMap((r) => r.resources || []).filter((r) => !r.includes("*")),
].filter(Boolean);

// ─── Reference checks ────────────────────────────────────────────────────────
//
// Each pattern says how its matches resolve: "file" = relative to the
// referencing file (root-absolute "/x" = extension root), "root" = always
// from the extension root (chrome.runtime.getURL, scripting `files`,
// offscreen document paths).

const ASSET_EXT = "html|js|mjs|css|json|png|jpe?g|gif|svg|webp|woff2?|ttf|wasm";

const JS_PATTERNS = [
  [/^\s*(?:import|export)\b[^;'"]*?\bfrom\s*["']([^"']+)["']/gm, "file"],
  [/^\s*import\s*["']([^"']+)["']/gm, "file"],
  [/\bimport\(\s*["']([^"']+)["']\s*\)/g, "file"],
  [/chrome\.runtime\.getURL\(\s*["']([^"']+)["']\s*\)/g, "root"],
  [/\bfiles\s*:\s*\[([^\]]*)\]/g, "root-list"],
  // Any other string literal that looks like an extension path, e.g.
  // OFFSCREEN_PATH = "offscreen/voice.html".
  // Relative ("./", "../") specifiers are covered by the import patterns.
  [new RegExp(`["'\`](\\w[\\w.-]*(?:/[\\w.-]+)+\\.(?:${ASSET_EXT}))["'\`]`, "g"), "root"],
];
const HTML_PATTERNS = [
  [/\b(?:src|href)\s*=\s*["']([^"'$#{}]+)["']/g, "file"],
  [/url\(\s*["']?([^"')$]+)["']?\s*\)/g, "file"],
];
const CSS_PATTERNS = [[/url\(\s*["']?([^"')$]+)["']?\s*\)/g, "file"]];

// Drop comments so prose like `// from "upstream"` isn't read as a reference.
// Only `//` at line start or after whitespace counts, so "https://…" survives.
function stripJsComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

function resolveRef(file, ref, mode) {
  const path = ref.replace(/[?#].*$/, "");
  if (mode === "root" || path.startsWith("/")) return normalize(path.replace(/^\/+/, ""));
  return normalize(join(dirname(file), path));
}

const missing = [];
for (const ref of manifestRefs) {
  if (!shipped.has(normalize(ref))) missing.push(`manifest.json → ${ref}`);
}
for (const file of files) {
  let patterns;
  let text = readFileSync(join(ROOT, file), "utf8");
  if (/\.m?js$/.test(file)) {
    if (file.startsWith("vendor/")) continue; // minified third-party code
    patterns = JS_PATTERNS;
    text = stripJsComments(text);
  } else if (file.endsWith(".html")) {
    patterns = HTML_PATTERNS;
    text = text.replace(/<!--[\s\S]*?-->/g, "");
  } else if (file.endsWith(".css")) {
    patterns = CSS_PATTERNS;
    text = text.replace(/\/\*[\s\S]*?\*\//g, "");
  } else {
    continue;
  }
  for (const [re, mode] of patterns) {
    for (const [, captured] of text.matchAll(re)) {
      const refs = mode === "root-list"
        ? [...captured.matchAll(/["']([^"']+)["']/g)].map((m) => m[1])
        : [captured];
      for (const ref of refs) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("//")) continue; // absolute URL / data:
        const target = resolveRef(file, ref, mode === "root-list" ? "root" : mode);
        if (target.startsWith("..") || !shipped.has(target)) missing.push(`${file} → ${ref}`);
      }
    }
  }
}
if (missing.length) fail(`Unresolved references:\n  ${missing.join("\n  ")}`);

// ─── Zip ─────────────────────────────────────────────────────────────────────

const outDir = join(ROOT, "dist");
const outFile = join(outDir, `guidr-${manifest.version}.zip`);
mkdirSync(outDir, { recursive: true });
rmSync(outFile, { force: true });
execFileSync("zip", ["-q", "-X", outFile, ...files], { cwd: ROOT, stdio: "inherit" });

const kb = (statSync(outFile).size / 1024).toFixed(0);
console.log(`✔ ${relative(ROOT, outFile)} — ${files.length} files, ${kb} KB`);
