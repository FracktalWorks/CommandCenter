#!/usr/bin/env node
// App Workshop · T2 (React) build — platform-owned, not authored by the
// builder agent (docs/app-workshop/README.md §4.1/§9). Bundles a T2 app's
// `src/main.tsx` against the shared, deploy-provisioned vendor cache
// (react/react-dom/esbuild — never a per-app `npm install`, RFC §7 point 6:
// no package.json/node_modules footprint inside any app workspace) and
// injects the result into the workspace's `index.html` template, producing
// `dist/bundle.html` — the file `entry` points at and every existing
// publish/preview/durability path already reads dynamically.
//
// Usage: node build_t2.mjs <workspace-dir>
// Exit 0 + byte size on stdout on success; exit 1 + esbuild diagnostics on
// stderr on failure. Never touches dist/bundle.html on a failed build — the
// last-known-good bundle keeps serving until the next successful build.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const BUNDLE_MARKER = "<!-- CC_T2_BUNDLE -->";

function vendorDir() {
  const override = (process.env.CUSTOM_APPS_T2_VENDOR_DIR || "").trim();
  if (override) return override;
  const clone = (process.env.AGENTS_CLONE_DIR || "").trim() || join(homedir(), ".acb", "agents");
  return join(clone, "vendor", "t2-react");
}

function fail(message) {
  process.stderr.write(`build_t2: ${message}\n`);
  process.exit(1);
}

const workspace = resolve(process.argv[2] || "");
if (!workspace || !existsSync(workspace)) {
  fail(`workspace not found: ${workspace || "(none given)"}`);
}

const entryPoint = join(workspace, "src", "main.tsx");
if (!existsSync(entryPoint)) {
  fail(`missing entry point: src/main.tsx`);
}

const templatePath = join(workspace, "index.html");
if (!existsSync(templatePath)) {
  fail(`missing build template: index.html (must contain ${BUNDLE_MARKER})`);
}
const template = readFileSync(templatePath, "utf-8");
if (!template.includes(BUNDLE_MARKER)) {
  fail(`index.html is missing the ${BUNDLE_MARKER} marker`);
}

const vendor = vendorDir();
const vendorModules = join(vendor, "node_modules");
if (!existsSync(join(vendorModules, "esbuild"))) {
  fail(
    `esbuild not found in vendor cache (${vendorModules}) — ` +
      `has the T2 vendor cache been provisioned (deploy.yml)?`,
  );
}

const require = createRequire(import.meta.url);
let esbuild;
try {
  esbuild = require(join(vendorModules, "esbuild"));
} catch (err) {
  fail(`failed to load esbuild from vendor cache: ${err.message}`);
}

let result;
try {
  result = esbuild.buildSync({
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    target: ["es2020"],
    minify: true,
    legalComments: "none",
    logLevel: "silent",
    // Required: React's bundled code reads process.env.NODE_ENV at runtime.
    // Without this it throws "process is not defined" in the sandboxed
    // browser frame (no Node globals there) — also dead-code-eliminates
    // most React dev-mode diagnostic strings, keeping the bundle small.
    define: { "process.env.NODE_ENV": '"production"' },
    nodePaths: [vendorModules],
  });
} catch (err) {
  const diagnostics = (err.errors || [])
    .map((e) => `  ${e.text}${e.location ? ` (${e.location.file}:${e.location.line})` : ""}`)
    .join("\n");
  fail(`esbuild failed:\n${diagnostics || err.message}`);
}

const outputFiles = result.outputFiles || [];
if (outputFiles.length === 0) {
  fail("esbuild produced no output");
}
const bundledJs = outputFiles[0].text;
if (!bundledJs || !bundledJs.trim()) {
  fail("esbuild produced an empty bundle");
}

const finalHtml = template.replace(BUNDLE_MARKER, `<script>${bundledJs}</script>`);

const distDir = join(workspace, "dist");
mkdirSync(distDir, { recursive: true });
const finalPath = join(distDir, "bundle.html");
const tmpPath = join(distDir, ".bundle.html.tmp");

try {
  writeFileSync(tmpPath, finalHtml, "utf-8");
  renameSync(tmpPath, finalPath);
} catch (err) {
  try {
    rmSync(tmpPath, { force: true });
  } catch {
    // best-effort cleanup only
  }
  fail(`failed to write dist/bundle.html: ${err.message}`);
}

process.stdout.write(`build_t2: ok, dist/bundle.html (${finalHtml.length} bytes)\n`);
