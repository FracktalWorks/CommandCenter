// ── Navigation structure for CommandCenter Control Plane ─────────────────
//
// The sidebar is organised into three sections:
//   1. Apps      — end-user AI-powered applications (Chat, Email, Tasks, etc.)
//   2. Configure — low-level platform configuration (Models, Agents, Integrations)
//   3. Build     — extend the platform (Agent Workbench, Custom Apps)
//
// Used by the desktop Sidebar and the mobile navigation drawer so both stay in sync.
// `PANES` (flat list) is kept for backward-compatible consumers that don't need sections.
//
// icon = Lucide icon name (rendered via dynamic import in Sidebar / AppShell).

export type NavPane = {
  href: string;
  label: string;
  /** Lucide icon name, e.g. "MessageCircle", "Zap", "Wrench" */
  icon: string;
  note: string;
  badge?: string;
  /**
   * Feature slug guarding this pane (org access control). Matches
   * `feature_catalog.slug` in infra/postgres/128_org_access_control.sql. A
   * pane without one is visible to every signed-in member.
   */
  feature?: string;
};

export type NavSection = {
  id: string;
  label: string;
  /** When true the section heading is rendered as a smaller, muted subheading
   *  (like Configure / Build) instead of a prominent section header like Apps. */
  sub?: boolean;
  items: NavPane[];
};

export const NAV_SECTIONS: NavSection[] = [
  // ── Apps ──────────────────────────────────────────────────────────────
  {
    id: "apps",
    label: "Apps",
    items: [
      {
        href: "/chat",
        label: "Chat",
        icon: "MessageCircle",
        note: "AI conversations · sessions · memory",
        feature: "chat",
      },
      {
        href: "/email",
        label: "Email",
        icon: "Mail",
        note: "AI-powered inbox",
        feature: "email",
      },
      {
        href: "/whatsapp",
        label: "WhatsApp",
        icon: "MessageSquare",
        note: "AI-powered WhatsApp inbox",
        feature: "whatsapp",
      },
      {
        href: "/memory",
        label: "Memories",
        icon: "Brain",
        note: "Facts · episodic · knowledge graph",
        feature: "memory",
      },
      {
        href: "/tasks",
        label: "Tasks",
        icon: "CheckSquare",
        note: "AI task manager",
        feature: "tasks",
      },
      {
        href: "/notes",
        label: "Notes",
        icon: "StickyNote",
        note: "AI note taker",
        feature: "notes",
      },
      {
        href: "/dashboard",
        label: "Dashboard",
        icon: "LayoutDashboard",
        note: "Company overview",
        feature: "dashboard",
      },
      {
        href: "/observability",
        label: "Live Activity",
        icon: "Activity",
        note: "Agent & model activations in real time",
        feature: "observability",
      },
      {
        href: "/artifacts",
        label: "Artifacts",
        icon: "FolderOpen",
        note: "All agent files · inputs · outputs · data",
        feature: "artifacts",
      },
    ],
  },

  // ── Configure ─────────────────────────────────────────────────────────
  {
    id: "configure",
    label: "Configure",
    sub: true,
    items: [
      {
        href: "/settings/models",
        label: "Models",
        icon: "Cpu",
        note: "LLMs · tiers · providers",
        feature: "models",
      },
      {
        href: "/agents",
        label: "Agents",
        icon: "Bot",
        note: "Register · manage · commits · remove",
        feature: "agents",
      },
      {
        href: "/approvals",
        label: "Approvals",
        icon: "ShieldCheck",
        note: "Action Broker · outward writes awaiting review",
        feature: "approvals",
      },
      {
        href: "/integrations",
        label: "Integrations",
        icon: "Plug",
        note: "APIs · MCP servers · plugins",
        feature: "integrations",
      },
    ],
  },

  // ── Build ─────────────────────────────────────────────────────────────
  {
    id: "build",
    label: "Build",
    sub: true,
    items: [
      {
        href: "/build/agents",
        label: "Agent Workbench",
        icon: "Wrench",
        note: "MAF agents & skills",
        feature: "build.agents",
      },
      {
        href: "/build/apps",
        label: "Custom Apps",
        icon: "PlusSquare",
        note: "User-created applications",
        feature: "build.apps",
      },
    ],
  },
];

/** Flat list of all nav panes — kept for backward compatibility. */
export const PANES: NavPane[] = NAV_SECTIONS.flatMap((s) => s.items);

/**
 * Drop panes the member cannot reach, and any section left empty.
 *
 * Presentation only — the gateway authorizes every request regardless of what
 * the sidebar shows. Passing `null` (access not yet resolved) returns the full
 * list so the nav does not flicker from complete to filtered on first paint.
 */
export function visibleSections(
  allowedFeatures: string[] | null
): NavSection[] {
  if (allowedFeatures === null) return NAV_SECTIONS;
  const allowed = new Set(allowedFeatures);
  return NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((p) => !p.feature || allowed.has(p.feature)),
  })).filter((section) => section.items.length > 0);
}
