// Shared primary navigation config.
// Used by the desktop Sidebar and the mobile navigation drawer so both stay in sync.

export type Pane = { href: string; label: string; icon: string; note: string };

export const PANES: Pane[] = [
  { href: "/chat",            label: "Chat",         icon: "C", note: "CommandCenter · sessions · memory" },
  { href: "/agents",          label: "Agents",       icon: "A", note: "Register · manage · commits · remove" },
  { href: "/memory",          label: "Memory",       icon: "~", note: "Facts · episodic · knowledge graph" },
  { href: "/integrations",    label: "Integrations", icon: "I", note: "Connected services · credentials" },
  { href: "/settings/models", label: "Models",       icon: "M", note: "LLMs · tiers · providers" },
];
