// ─────────────────────────────────────────────────────────────────────────────
// The theme check, as a program.
//
// DESIGN_SYSTEM.md §8 says the real gate on any UI change is: switch the theme
// to Fluent, then Material, then Graphite, and LOOK at the surface you changed
// and at its neighbour. AGENTS.md is blunt that nothing in this tree tests
// layout or cross-app continuity — the conformance suite checks eight regexes
// and stops. So that gate has always been a human with four browser tabs, and
// on a headless branch it simply did not happen.
//
// This runs it. Every theme x mode x state, measured rather than eyeballed,
// with a screenshot of each so the eyeball pass is still possible and is now
// cheap.
//
// It is NOT a substitute for looking. It caught the bug it was written to look
// for (see below) only because a screenshot was read afterwards; the assertion
// came second. Treat the measurements as the regression net and the shots as
// the review.
//
// WHAT IT ALREADY CAUGHT
//   The sidebar's attribution rendered as "powered by Co..." with a customer
//   logo installed. Every box measurement passed -- the lockup did not overrun
//   the collapse control, the rail was 256px, the logo was 105x28 -- because
//   `truncate` clips text without changing any bounding box. That is the exact
//   class of defect no regex and no unit test in this tree can see, and it is
//   why `clipped` is read off scrollWidth rather than getBoundingClientRect.
//
// RUNNING IT (currently manual -- see the fence note)
//   npm run dev            # in one shell; the script expects :3001
//   npm i --no-save playwright
//   node scripts/theme-check.mjs
//   node scripts/theme-check-billing.mjs
//
// R7 -- NAME THE FENCE: this is **advisory**. Nothing runs it in CI, because
// wiring a browser into the PR job is a cost the owner should choose, not one
// a branch should impose. Until that decision is taken it is a tool you run,
// not a gate that runs you. Do not describe it as coverage.
//
// The browser is the one preinstalled in the container. On a machine with
// Playwright's own download, drop `executablePath`.
// ─────────────────────────────────────────────────────────────────────────────

// Renders the surfaces changed by this branch under every theme and measures
// the one thing no unit test in this tree can: geometry.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { deflateSync, crc32 } from "node:zlib";

const DIR = process.env.THEME_SHOTS ?? "/tmp/cc-theme-shots";
mkdirSync(DIR, { recursive: true });

// A 600x160 solid PNG (3.75:1, the shape of a real wordmark) in a colour that
// belongs to no theme, so its bounds are obvious in any of them. Generated
// inline rather than committed as a fixture: 568 bytes of zlib is easier to
// audit than a binary blob, and the aspect ratio is the part under test.
const logoB64 = (() => {
  const w = 600, h = 160, rgb = [232, 74, 138];
  const raw = Buffer.concat(
    Array.from({ length: h }, () =>
      Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]),
    ),
  );
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
})();

const BRANDING_WITH_LOGO = {
  logo: {
    dataUri: `data:image/png;base64,${logoB64}`,
    mime: "image/png",
    width: 600,
    height: 160,
    byteSize: 568,
  },
  updatedBy: "vjvarada@fracktal.in",
  updatedAt: "2026-08-14T00:00:00+00:00",
};

const ACCESS = {
  email: "vjvarada@fracktal.in",
  is_admin: true,
  features: [],
  permissions: ["*"],
  roles: ["admin"],
};

const THEMES = ["rapidtool", "fluent", "material", "graphite"];
const MODES = ["dark", "light"];

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const results = [];

for (const theme of THEMES) {
  for (const mode of MODES) {
    for (const withLogo of [true, false]) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await ctx.addInitScript(
        ([t, m]) => {
          localStorage.setItem("cc-theme", t);
          localStorage.setItem("theme", m);
        },
        [theme, mode],
      );

      const page = await ctx.newPage();
      // Everything else the shell polls: answer emptily so nothing hangs and
      // nothing renders a spurious error into the screenshot.
      await page.route("**/api/**", (r) =>
        r.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
      );

      await page.route("**/api/settings/branding", (r) =>
        r.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(withLogo ? BRANDING_WITH_LOGO : { logo: null, updatedBy: "", updatedAt: "" }),
        }),
      );
      await page.route("**/api/auth/me", (r) =>
        r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ACCESS) }),
      );
      await page.goto("http://localhost:3001/settings/organization", {
        waitUntil: "networkidle",
        timeout: 45_000,
      });
      await page.waitForTimeout(700);

      const tag = `${theme}-${mode}-${withLogo ? "logo" : "fallback"}`;
      await page.screenshot({ path: `${DIR}/${tag}.png` });

      // ── The measurements ────────────────────────────────────────────────
      // A screenshot proves nothing on its own; these are the assertions the
      // eyeball check is actually making.
      const m = await page.evaluate(() => {
        const rail = document.querySelector("aside");
        const link = rail?.querySelector("a[href='/']");
        const img = link?.querySelector("img");
        const collapse = rail?.querySelector("button[title]");
        const box = (el) => (el ? el.getBoundingClientRect() : null);
        const r = box(rail), l = box(link), c = box(collapse), i = box(img);
        return {
          railWidth: r?.width ?? 0,
          lockupRight: l ? Math.round(l.right) : 0,
          collapseLeft: c ? Math.round(c.left) : 0,
          collapseRight: c ? Math.round(c.right) : 0,
          logo: i ? { w: Math.round(i.width), h: Math.round(i.height) } : null,
          caption: link?.textContent?.trim() ?? "",
          // Graphite uppercases labels via CSS; read the COMPUTED case so the
          // attribution is checked as rendered, not as authored.
          // The bug a geometry-only check missed: the attribution rendered as
          // "powered by Co…" while every box measurement passed. `truncate`
          // makes clipping invisible to getBoundingClientRect, so it has to be
          // read off scrollWidth.
          clipped: (() => {
            // LEAF spans only. The first version of this searched every span and
            // `startsWith` matched the OUTER flex container before the caption
            // inside it — a container is never truncated, so the probe reported
            // `clipped:false` for a caption that WAS clipped, in precisely the
            // case this assertion was written for. Verified after the fix by
            // forcing a truncation and watching it go red.
            const leaves = link
              ? [...link.querySelectorAll("span")].filter((e) => !e.querySelector("span"))
              : [];
            const cap = leaves.find((e) => {
              const t = e.textContent?.trim() ?? "";
              return t.startsWith("powered by CommandCenter") || t === "Control Plane" || t === "Home";
            });
            return cap ? cap.scrollWidth > cap.clientWidth + 1 : null;
          })(),
          bodyScrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        };
      });

      const problems = [];
      if (m.railWidth !== 256) problems.push(`rail is ${m.railWidth}px, expected 256`);
      if (m.lockupRight > m.collapseLeft) {
        problems.push(`lockup overruns the collapse control by ${m.lockupRight - m.collapseLeft}px`);
      }
      if (m.collapseRight > m.railWidth) problems.push("collapse control is off the rail");
      if (withLogo) {
        if (!m.logo) problems.push("no <img> rendered for an org with a logo");
        else if (m.logo.h !== 28) problems.push(`logo is ${m.logo.h}px tall, expected 28`);
        else if (m.logo.w !== 105) problems.push(`logo is ${m.logo.w}px wide, expected 105 (3.75:1 at 28px)`);
        if (!m.caption.includes("powered by CommandCenter")) problems.push("attribution missing");
        if (m.caption.includes("CommandCenter") && m.caption.includes("Control Plane")) {
          problems.push("fallback title rendered alongside the logo");
        }
      } else {
        if (m.logo) problems.push("<img> rendered for an org with no logo");
        if (!m.caption.includes("CommandCenter")) problems.push("fallback mark missing");
      }
      if (m.bodyScrollX) problems.push("page scrolls horizontally");
      if (m.clipped === null) problems.push("caption element not found");
      else if (m.clipped) problems.push("the attribution is truncated");

      results.push({ tag, ...m, problems });
      await ctx.close();
    }
  }
}

await browser.close();

let failed = 0;
for (const r of results) {
  const ok = r.problems.length === 0;
  if (!ok) failed++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${r.tag.padEnd(28)} logo=${r.logo ? `${r.logo.w}x${r.logo.h}` : "—"}` +
      ` lockupRight=${r.lockupRight} collapseLeft=${r.collapseLeft} clipped=${r.clipped}` +
      (ok ? "" : `\n        ${r.problems.join("; ")}`),
  );
}
console.log(`\n${results.length - failed}/${results.length} passed. Screenshots in ${DIR}`);
process.exit(failed ? 1 : 0);
