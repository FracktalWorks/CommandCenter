/**
 * Projects · the app is registered in every place that must know about it.
 *
 * Spec: `project-docs/specs/project_management_app.md` §5 · ticket WS-27d
 * done-whens 3 and 4.
 *
 * The failure this exists to catch is the one `department_centers.md` §2
 * documents for Centers and migration 140 shipped for real: a surface seeded in
 * one place and missing from another is **unreachable, silently, for everybody
 * including the owner** — and every other test still passes, because nothing
 * else reads the registry that was skipped.
 *
 * The Python side (`FEATURES` ↔ `feature_catalog`) is fenced in
 * `tests/unit/test_org_access_control.py`. This is the frontend half.
 */
import { describe, expect, it } from "vitest";

import { CENTERS } from "@/lib/centers";
import { NAV_SECTIONS } from "@/lib/nav";
import { featureForPath } from "@/lib/access";

const PROJECTS_HREF = "/projects";
const PROJECTS_FEATURE = "projects";

describe("the Projects app is reachable", () => {
  it("has a nav pane gated on its own feature", () => {
    const items = NAV_SECTIONS.flatMap((s) => s.items);
    const pane = items.find((i) => i.href === PROJECTS_HREF);

    expect(pane, "/projects has no nav entry — the pane would never render").toBeTruthy();
    expect(pane?.feature).toBe(PROJECTS_FEATURE);
  });

  it("maps its route to the same feature slug", () => {
    // A pane gated on one slug and a route guarded by another is how a member
    // sees a link that then refuses them.
    expect(featureForPath(PROJECTS_HREF)).toBe(PROJECTS_FEATURE);
  });

  it("gates the Center slice on `projects`, never on a Center's own feature", () => {
    // A Center's slice must not require `center.sales`: a member granted the
    // Projects app but not that Center would otherwise be refused their own
    // app by following a link the sidebar showed them.
    //
    // The guard is fed `usePathname()`, which in Next.js is the path WITHOUT
    // the query string — measured, not assumed: `featureForPath` matches on
    // `===` or a `/` prefix, so `/projects?center=sales` resolves to null and
    // never reaches it in practice. So the contract to pin is the bare path.
    expect(featureForPath("/projects")).toBe(PROJECTS_FEATURE);
    expect(featureForPath("/projects")).not.toBe("center.sales");
  });

  it("is ONE pane, not one per Center", () => {
    // department_centers.md §1 rule 2 — a Center item is (app + scope), and
    // forking the app per department is the bloat failure mode to refuse in
    // review. This is that rule, made mechanical.
    const items = NAV_SECTIONS.flatMap((s) => s.items);
    const projectPanes = items.filter((i) => i.href?.startsWith(PROJECTS_HREF));
    expect(projectPanes).toHaveLength(1);
  });
});

describe("the Center projections", () => {
  it("gives the People Center a live link to the app's home", () => {
    const people = CENTERS.find((c) => c.slug === "people");
    const app = people?.apps.find((a) => a.href === PROJECTS_HREF);

    expect(app?.status).toBe("live");
  });

  it("points every other Center's slice at its own group", () => {
    for (const slug of ["sales", "marketing", "finance", "operations"]) {
      const center = CENTERS.find((c) => c.slug === slug);
      const app = center?.apps.find((a) => a.href?.startsWith(PROJECTS_HREF));

      expect(app, `${slug} Center has no Projects slice`).toBeTruthy();
      expect(app?.status).toBe("live");
      expect(app?.href).toBe(`${PROJECTS_HREF}?center=${slug}`);
    }
  });

  it("never links a Center at a forked route", () => {
    // The refusal, stated as a test: every Center reaches the SAME path and
    // differs only by query string.
    const linked = CENTERS.flatMap((c) => c.apps)
      .map((a) => a.href)
      .filter((href): href is string => Boolean(href?.startsWith(PROJECTS_HREF)));

    expect(linked.length).toBeGreaterThan(1);
    for (const href of linked) {
      expect(href.split("?")[0]).toBe(PROJECTS_HREF);
    }
  });
});
