#!/usr/bin/env node
/**
 * `npm run test:e2e` — Playwright, with the browser it can actually find.
 *
 * ## Why this exists (WS-27ak)
 *
 * `test:e2e` used to be `npm run build && playwright test`, and in this
 * environment it **failed every time**: `playwright-core/browsers.json` pins
 * revision `chromium_headless_shell-1223`, the image ships `chromium-1194` at
 * `/opt/pw-browsers`, and `npx playwright install` is not available here. So
 * the script that was supposed to be the one-liner for running the suite was
 * the one thing that did not run it, while the documented invocation — two env
 * vars in front of `npx playwright test` — worked. A script nobody can run is a
 * suite nobody runs.
 *
 * `playwright.config.ts:27-29` already reads `PLAYWRIGHT_EXECUTABLE_PATH` into
 * `launchOptions`, so nothing here patches config; this only fills the two
 * variables in, and only when they are unset and the path is really there.
 *
 * ## Why a Node script and not a shell prefix
 *
 * `PLAYWRIGHT_BROWSERS_PATH=… playwright test` in `package.json` is a POSIX-ism
 * that `cmd.exe` runs as a literal command name, and Windows is the primary dev
 * box here (root `CLAUDE.md` §6). This spawns with an explicit env instead, so
 * one script works on both.
 *
 * On a machine with a normal Playwright install, `PLAYWRIGHT_EXECUTABLE_PATH`
 * stays unset and `playwright.config.ts` resolves its own bundled browser
 * exactly as before — this changes nothing by default.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

/** Pre-installed browsers we know about, most specific first. */
const KNOWN = [
  {
    browsers: "/opt/pw-browsers",
    executable: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  },
];

const env = { ...process.env };

if (!env.PLAYWRIGHT_EXECUTABLE_PATH) {
  const found = KNOWN.find((c) => existsSync(c.executable));
  if (found) {
    env.PLAYWRIGHT_BROWSERS_PATH ??= found.browsers;
    env.PLAYWRIGHT_EXECUTABLE_PATH = found.executable;
    console.log(`[e2e] using pre-installed Chromium at ${found.executable}`);
  }
}

const child = spawn(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["playwright", "test", ...process.argv.slice(2)],
  { stdio: "inherit", env },
);
child.on("exit", (code, signal) => {
  // A signal death must not be reported as success — `?? 0` on a null code is
  // exactly how a killed run becomes a green job.
  process.exit(code ?? (signal ? 1 : 0));
});
