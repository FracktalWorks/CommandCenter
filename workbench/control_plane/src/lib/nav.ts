// ── Navigation structure for CommandCenter Control Plane ─────────────────
//
// The sidebar is organised into three sections:
//   1. Apps      — end-user AI-powered applications (Chat, Email, Tasks, etc.)
//   2. Configure — low-level platform configuration (Models, Agents, Integrations)
//   3. Build     — extend the platform (Agent Workbench, Custom Apps)
//
// Used by the desktop Sidebar and the mobile navigation drawer so both stay in sync.
// `PANES` (flat list) is kept for backward-compatible consumers that don't need sections.

export type NavPane = {
  href: string;
  label: string;
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
        icon: "C",
        note: "AI conversations · sessions · memory",
      },
      {
        href: "/email",
        label: "Email",
        icon: "E",
        note: "AI-powered inbox",
      },
      {
        href: "/memory",
        label: "Memories",
        icon: "~",
        note: "Facts · episodic · knowledge graph",
      },
      {
        href: "/tasks",
        label: "Tasks",
        icon: "T",
        note: "AI task manager",
      },
      {
        href: "/notes",
        label: "Notes",
        icon: "N",
        note: "AI note taker",
      },
      {
        href: "/dashboard",
        label: "Dashboard",
        icon: "D",
        note: "Company overview",
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
        icon: "M",
        note: "LLMs · tiers · providers",
      },
      {
        href: "/agents",
        label: "Agents",
        icon: "A",
        note: "Register · manage · commits · remove",
      },
      {
        href: "/integrations",
        label: "Integrations",
        icon: "I",
        note: "Connected services · credentials",
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
        icon: "W",
        note: "MAF agents & skills",
      },
      {
        href: "/build/apps",
        label: "Custom Apps",
        icon: "+",
        note: "User-created applications",
      },
    ],
  },
];

/** Flat list of all nav panes — kept for backward compatibility. */
export const PANES: NavPane[] = NAV_SECTIONS.flatMap((s) => s.items);
