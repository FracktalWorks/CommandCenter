// Wire types for the org administration API (gateway routes/admin/*).
// Spec: ai-company-brain/specs/org_access_control.md §6.

export type Member = {
  email: string;
  display_name: string;
  avatar_url?: string;
  status: "invited" | "active" | "suspended" | "removed";
  roles: string[];
  invited_by?: string;
  joined_at?: string;
  last_login_at?: string;
};

/**
 * What `DELETE /admin/members/{email}/purge` reports back (N8).
 *
 * Both halves, per table. `deleted` because it is irreversible and the admin
 * has no other way to see how much it was; `kept` because "your audit trail
 * and their apps are still there" is the reassurance that makes the
 * irreversible half safe to click. Keys are the gateway's
 * (`members._PURGE_DELETES` / `_PURGE_KEEPS`) and are rendered as-is, so a
 * table added there shows up here without a UI change.
 */
export type PurgeResult = {
  status: "purged";
  email: string;
  deleted: Record<string, number>;
  kept: Record<string, number>;
};

/**
 * A sign-in request — somebody who authenticated against the directory and
 * found no `app_user` row (gateway `routes/admin/access_requests.py`,
 * migration 143; spec colleague_onboarding.md §6).
 *
 * This is deliberately NOT a `Member` with a fifth status: an `app_user` row is
 * the org's member record and a stranger who merely knocked must not acquire
 * one. Approving turns a request into a real member; until then it is just a
 * record that the door was tried.
 */
export type AccessRequest = {
  email: string;
  display_name: string;
  first_seen_at: string;
  last_seen_at: string;
  /** How many times they tried. "53" reads as stuck; "1" reads as curious. */
  attempt_count: number;
  status: "pending" | "approved" | "denied";
  /**
   * The address is outside the company's own sign-in domain
   * (`ALLOWED_EMAIL_DOMAIN`). Resolved by the gateway, never in the browser —
   * the domain is server policy.
   *
   * It is NOT a rejection: the gateway logs an off-domain identity and carries
   * on (`acb_auth/deps.py`, branch 1a), and an Entra B2B guest is a directory
   * member like anybody else, so the tenant pin does not exclude them. Approve
   * provisions `active` immediately, so this row is the last place the
   * difference is visible.
   */
  is_external: boolean;
};

/** org_group membership row, as the groups API returns it. */
export type GroupMember = {
  email: string;
  display_name: string;
  /** "lead" manages the group's membership; it is group-scoped, not a permission bundle. */
  role: "lead" | "member";
  added_by: string;
  added_at: string;
};

/**
 * org_group — the scoping primitive (groups_sessions_authority.md §1).
 * UI copy says "team" when addressing humans; the primitive is group, and
 * for the six Center groups the slug IS the center slug (department_centers.md §1).
 */
export type Group = {
  slug: string;
  display_name: string;
  description: string;
  /** Slug pairs with a `center.<slug>` feature: grant toggle shown, delete hidden. */
  is_center: boolean;
  member_count: number;
  members: GroupMember[];
};

export type Role = {
  slug: string;
  display_name: string;
  description: string;
  is_system: boolean;
  rank: number;
  permissions: string[];
  member_count: number;
};

export type Feature = {
  slug: string;
  label: string;
  description: string;
  nav_href: string;
  /** feature_catalog.category, passed through verbatim by the gateway.
   *  `centers` was added by 140_center_features.sql. */
  category: "apps" | "configure" | "build" | "centers";
  sort_order: number;
  is_default: boolean;
  permission: string;
};

/**
 * One resolved permission plus why it resolved that way. `source` is the whole
 * point of this screen: an admin should never have to replay the resolution
 * algorithm to understand what they're looking at.
 */
export type Decision = {
  permission: string;
  allowed: boolean;
  /** "role" | "deny-override" | "allow-override" | "default-deny" | "inactive" */
  source: string;
  /** The granted/denied pattern that decided it, e.g. "feature:*". */
  pattern: string;
  /** Which role contributed `pattern`, when source is "role". */
  via_role: string;
  /** Present on feature decisions. */
  slug?: string;
  /** Present on agent decisions. */
  name?: string;
};

export type MemberAccess = {
  email: string;
  display_name: string;
  status: Member["status"];
  roles: string[];
  granted: string[];
  denied: string[];
  features: Decision[];
  capabilities: Decision[];
  agents: Decision[];
  integrations: Decision[];
  overrides: {
    permission: string;
    effect: "allow" | "deny";
    reason: string;
    set_by: string;
    set_at: string;
  }[];
};

/** Human wording for a decision's provenance. */
export function explainSource(d: Decision): string {
  switch (d.source) {
    case "role":
      return d.via_role
        ? `granted by role “${d.via_role}”${d.pattern !== d.permission ? ` via ${d.pattern}` : ""}`
        : `granted by ${d.pattern}`;
    case "allow-override":
      return "allowed for this person specifically";
    case "deny-override":
      return d.pattern === d.permission
        ? "denied for this person specifically"
        : `denied for this person via ${d.pattern}`;
    case "inactive":
      return "no access — membership is not active";
    default:
      return "not granted by any role";
  }
}
