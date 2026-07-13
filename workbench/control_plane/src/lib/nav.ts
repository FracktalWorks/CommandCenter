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
      },
      {
        href: "/email",
        label: "Email",
        icon: "Mail",
        note: "AI-powered inbox",
      },
      {
        href: "/memory",
        label: "Memories",
        icon: "Brain",
        note: "Facts · episodic · knowledge graph",
      },
      {
        href: "/tasks",
        label: "Tasks",
        icon: "CheckSquare",
        note: "AI task manager",
      },
      {
        href: "/notes",
        label: "Notes",
        icon: "StickyNote",
        note: "AI note taker",
      },
      {
        href: "/dashboard",
        label: "Dashboard",
        icon: "LayoutDashboard",
        note: "Company overview",
      },
      {
        href: "/observability",
        label: "Live Activity",
        icon: "Activity",
        note: "Agent & model activations in real time",
      },
      {
        href: "/artifacts",
        label: "Artifacts",
        icon: "FolderOpen",
        note: "All agent files · inputs · outputs · data",
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
      },
      {
        href: "/agents",
        label: "Agents",
        icon: "Bot",
        note: "Register · manage · commits · remove",
      },
      {
        href: "/approvals",
        label: "Approvals",
        icon: "ShieldCheck",
        note: "Action Broker · outward writes awaiting review",
      },
      {
        href: "/integrations",
        label: "Integrations",
        icon: "Plug",
        note: "APIs · MCP servers · plugins",
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
      },
      {
        href: "/build/apps",
        label: "Custom Apps",
        icon: "PlusSquare",
        note: "User-created applications",
      },
    ],
  },
];

/** Flat list of all nav panes — kept for backward compatibility. */
export const PANES: NavPane[] = NAV_SECTIONS.flatMap((s) => s.items);
