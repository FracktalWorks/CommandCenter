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

// The billing console under every theme — the check I flagged last session as
// needing eyes. Renders each tone (ok / warning / danger / BYOK) so the colour
// vocabulary is exercised, not just the happy path.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const DIR = process.env.THEME_SHOTS ?? "/tmp/cc-theme-shots";
mkdirSync(DIR, { recursive: true });

const ACCESS = { email: "vjvarada@fracktal.in", is_admin: true, features: [], permissions: ["*"], roles: ["admin"] };

const SUMMARIES = {
  // 300/30 = 10 a day; balances chosen to land in each tone band.
  ok: { balanceCredits: 5000, burnThisCycle: 300, windowDays: 30, isByok: false },
  warning: { balanceCredits: 80, burnThisCycle: 300, windowDays: 30, isByok: false },
  danger: { balanceCredits: 0, burnThisCycle: 300, windowDays: 30, isByok: false },
  byok: { balanceCredits: 1200, burnThisCycle: 300, windowDays: 30, isByok: true },
};

const INVOICES = [
  { id: "1", kind: "subscription", serial: "CC/26-27/0007", issuedOn: "2026-08-01", periodLabel: "Aug 2026", amountInr: 41300, status: "paid", downloadUrl: "/x.pdf" },
  { id: "2", kind: "credits", serial: "CC/26-27/0006", issuedOn: "2026-07-18", periodLabel: null, amountInr: 59000, status: "paid", downloadUrl: "/x.pdf" },
  { id: "3", kind: "subscription", serial: "CC/26-27/0005", issuedOn: "2026-07-01", periodLabel: "Jul 2026", amountInr: 41300, status: "failed", downloadUrl: null },
  { id: "4", kind: "credits", serial: "CC/26-27/0004", issuedOn: "2026-06-20", periodLabel: null, amountInr: -11800, status: "credit_note", downloadUrl: "/x.pdf" },
];

const THEMES = ["rapidtool", "fluent", "material", "graphite"];
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const results = [];

for (const theme of THEMES) {
  for (const mode of ["dark", "light"]) {
    for (const [tone, credits] of Object.entries(SUMMARIES)) {
      // Only sweep every tone on one theme; the rest get the representative
      // "warning" state. Sixteen more screenshots of the same layout is not
      // sixteen more checks.
      if (theme !== "rapidtool" && tone !== "warning") continue;

      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await ctx.addInitScript(([t, m]) => {
        localStorage.setItem("cc-theme", t);
        localStorage.setItem("theme", m);
      }, [theme, mode]);

      const page = await ctx.newPage();
      // Catch-all FIRST: Playwright tries the last-registered handler first.
      await page.route("**/api/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
      await page.route("**/api/auth/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ACCESS) }));
      await page.route("**/api/settings/branding", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ logo: null, updatedBy: "", updatedAt: "" }) }));
      await page.route("**/api/billing/summary", (r) => r.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ credits, invoices: INVOICES, purchaseEnabled: false }),
      }));

      await page.goto("http://localhost:3001/settings/billing", { waitUntil: "networkidle", timeout: 45_000 });
      await page.waitForTimeout(600);

      const tag = `billing-${theme}-${mode}-${tone}`;
      await page.screenshot({ path: `${DIR}/${tag}.png` });

      const m = await page.evaluate(() => {
        const root = document.querySelector("main") ?? document.body;
        const text = root.textContent ?? "";
        const table = root.querySelector("table");
        const scroller = table?.closest("div");
        return {
          text: text.replace(/\s+/g, " ").slice(0, 400),
          rows: root.querySelectorAll("tbody tr").length,
          // Wide content must scroll inside its own container, never the page.
          pageScrollsX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          tableOverflows: scroller ? scroller.scrollWidth > scroller.clientWidth : false,
          tableClipped: table && scroller ? Math.round(table.getBoundingClientRect().right) > Math.round(scroller.getBoundingClientRect().right) + 1 : false,
        };
      });

      const problems = [];
      if (/Loading|Could not load|admin-only/i.test(m.text)) problems.push(`page did not render: "${m.text.slice(0, 90)}"`);
      if (m.rows !== INVOICES.length) problems.push(`${m.rows} invoice rows, expected ${INVOICES.length}`);
      if (m.pageScrollsX) problems.push("the page scrolls horizontally");
      if (m.tableClipped && !m.tableOverflows) problems.push("the table is clipped without a scroller");
      if (!/₹/.test(m.text)) problems.push("no rupee symbol rendered");
      if (tone === "byok" && !/not billed/i.test(m.text)) problems.push("BYOK notice missing");
      if (tone === "danger" && !/Out of credits/i.test(m.text)) problems.push("empty-balance wording missing");

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
  console.log(`${ok ? "PASS" : "FAIL"}  ${r.tag.padEnd(36)} rows=${r.rows} pageScrollsX=${r.pageScrollsX}` + (ok ? "" : `\n        ${r.problems.join("; ")}`));
}
console.log(`\n${results.length - failed}/${results.length} passed.`);
process.exit(failed ? 1 : 0);
