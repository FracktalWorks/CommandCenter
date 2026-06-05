"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type Pane = { href: string; label: string; emoji: string; note: string };

const PANES: Pane[] = [
  { href: "/chat",             label: "Chat",          emoji: "[C]", note: "CommandCenter · sessions · memory" },
  { href: "/agents",           label: "Agents",        emoji: "[A]", note: "Register · manage · remove" },
  { href: "/integrations",     label: "Integrations",  emoji: "[I]", note: "Connected services · credentials" },
  { href: "/observability",    label: "Observability", emoji: "[O]", note: "Audit log · escalations · traces" },
  { href: "/settings/models",  label: "Models",        emoji: "[M]", note: "LLMs · tiers · providers" },
];

export default function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="w-64 shrink-0 border-r border-zinc-800 bg-zinc-900/60 p-4 flex flex-col">
      <div className="px-2 pb-6">
        <Link href="/" className="block">
          <div className="text-lg font-semibold tracking-tight">CommandCenter</div>
          <div className="text-xs text-zinc-500">Control Plane</div>
        </Link>
      </div>
      <nav className="flex flex-col gap-1">
        {PANES.map((p) => {
          const active = pathname?.startsWith(p.href);
          return (
            <Link
              key={p.href}
              href={p.href}
              className={`rounded-md px-3 py-2 text-sm transition-colors ${
                active
                  ? "bg-zinc-800 text-white"
                  : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-100"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-zinc-500">{p.emoji}</span>
                <span className="font-medium">{p.label}</span>
              </div>
              <div className="ml-7 text-xs text-zinc-500">{p.note}</div>
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto px-2 pt-6 text-xs text-zinc-600">
        Phase 1 &middot; Self-Mutation Loop
      </div>
    </aside>
  );
}