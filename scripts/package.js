#!/usr/bin/env node
/**
 * scripts/package.js
 * Builds dist/guidr-<version>.zip for upload to the Chrome Web Store.
 *
 * Only the files the extension loads at runtime are included — no
 * node_modules, tests, docs, or tooling config. Before zipping, every
 * relative reference in the shipped files (ES imports, src/href attributes,
 * CSS url(), chrome.runtime.getURL) is checked to resolve to a shipped file,
 * so a missing entry in INCLUDE fails here instead of in review.
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
  "llm.js",
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
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
].filter(Boolean);

// ─── Reference checks ────────────────────────────────────────────────────────

const REF_PATTERNS = [
  /\bfrom\s+["']([^"']+)["']/g,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  /\b(?:src|href)=["']([^"'$#]+)["']/g,
  /url\(\s*["']?([^"')]+)["']?\s*\)/g,
  /chrome\.runtime\.getURL\(\s*["']([^"']+)["']\s*\)/g,
];

const missing = [];
for (const ref of manifestRefs) {
  if (!shipped.has(normalize(ref))) missing.push(`manifest.json → ${ref}`);
}
for (const file of files) {
  if (!/\.(js|html|css)$/.test(file)) continue;
  const text = readFileSync(join(ROOT, file), "utf8");
  for (const re of REF_PATTERNS) {
    for (const [, ref] of text.matchAll(re)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("//")) continue; // absolute URL / data:
      const path = ref.replace(/[?#].*$/, "");
      const isRuntimeUrl = re.source.startsWith("chrome");
      const target = isRuntimeUrl ? normalize(path.replace(/^\//, "")) : normalize(join(dirname(file), path));
      if (target.startsWith("..") || !shipped.has(target)) missing.push(`${file} → ${ref}`);
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
