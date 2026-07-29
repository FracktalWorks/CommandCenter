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
  category: "apps" | "configure" | "build";
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
