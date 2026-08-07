/**
 * "Why can't I see that pane?" — the answer, as data.
 *
 * A hidden nav item is the platform's least debuggable failure. Four different
 * causes render as exactly the same nothing:
 *
 *   1. your roles do not grant the feature;
 *   2. a deny override cancels a grant you appear to hold;
 *   3. the slug is registered but the pane has no nav entry;
 *   4. you are signed out, or the gateway is unreachable, so access resolved
 *      to NO_ACCESS.
 *
 * Every one of them looks like "the app doesn't have that". This module turns
 * the server's own answer into a sentence per pane, so the next person who says
 * "I don't have access to this" can read the reason off the screen instead of
 * someone querying the database to find out.
 *
 * Nothing here decides anything. `Access` is the gateway's resolved answer, and
 * the gateway's `require_permission()` is the real boundary — this is a
 * renderer for a decision already made.
 */

import type { Access } from "./access";
import { NAV_SECTIONS } from "./nav";

export type PaneStatus = "granted" | "denied" | "signed-out";

export interface PaneReport {
  href: string;
  label: string;
  /** The feature slug guarding it, or null for an ungated pane. */
  feature: string | null;
  status: PaneStatus;
  /** The permission needed, when it is missing. */
  permission?: string;
  /** One sentence a person can act on. */
  reason: string;
}

/** Every pane the navigation can show, flattened, in sidebar order. */
export function allPanes(): Array<{ href: string; label: string; feature: string | null }> {
  return NAV_SECTIONS.flatMap((section) =>
    section.items.map((item) => ({
      href: item.href,
      label: item.label,
      feature: item.feature ?? null,
    })),
  );
}

/**
 * A per-pane verdict for this viewer.
 *
 * Deliberately reports on **every** pane, not only the hidden ones: a list that
 * shows just the failures cannot answer "is it hidden, or does it not exist" —
 * the question somebody actually has when a pane they were told about is
 * absent.
 */
export function paneReport(access: Access): PaneReport[] {
  const granted = new Set(access.features);
  const deniedBy = new Map(
    access.features_denied.map((d) => [d.slug, d.permission]),
  );

  return allPanes().map(({ href, label, feature }) => {
    if (!access.authenticated) {
      return {
        href,
        label,
        feature,
        status: "signed-out" as const,
        reason: "Not signed in — nothing is resolved yet.",
      };
    }
    if (!feature) {
      return {
        href,
        label,
        feature,
        status: "granted" as const,
        reason: "Open to every signed-in member.",
      };
    }
    if (granted.has(feature)) {
      return {
        href,
        label,
        feature,
        status: "granted" as const,
        reason: `Granted by \`feature:${feature}\`.`,
      };
    }
    const permission = deniedBy.get(feature) ?? `feature:${feature}`;
    // A deny override is worth calling out by name: it is the one case where
    // adding the grant changes nothing, so "ask an admin to grant it" would be
    // advice that cannot work.
    const explicitlyDenied = access.denied.some(
      (d) => d === permission || d === "feature:*" || d === "*",
    );
    return {
      href,
      label,
      feature,
      status: "denied" as const,
      permission,
      reason: explicitlyDenied
        ? `Blocked by a deny override on \`${permission}\` — removing that is the only fix; adding the grant will not help.`
        : `Needs \`${permission}\`, which your roles (${access.roles.join(", ") || "none"}) do not grant.`,
    };
  });
}

/** The short headline above the list. */
export function summarise(report: PaneReport[]): string {
  if (report.some((r) => r.status === "signed-out")) {
    return "Signed out — no access is resolved.";
  }
  const denied = report.filter((r) => r.status === "denied").length;
  if (denied === 0) return `All ${report.length} panes are available to you.`;
  return `${report.length - denied} of ${report.length} panes available · ${denied} need a grant.`;
}

/**
 * Slugs the SERVER knows about but the sidebar has no entry for.
 *
 * The fourth failure mode, and the only one invisible from the pane list: a
 * feature registered in `feature_catalog` and granted to you, that no nav item
 * points at. It is reachable by URL and undiscoverable in the UI — which reads,
 * again, as "the app doesn't have that".
 */
export function unmappedFeatures(access: Access): string[] {
  const navSlugs = new Set(
    allPanes()
      .map((p) => p.feature)
      .filter((f): f is string => Boolean(f)),
  );
  return access.features.filter((f) => !navSlugs.has(f)).sort();
}
