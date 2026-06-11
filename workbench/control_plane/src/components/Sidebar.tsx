"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useSession, signOut } from "next-auth/react";
import { PANES } from "@/lib/nav";

export default function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const { data: session } = useSession();

  return (
    <aside
      className={`shrink-0 border-r border-zinc-800 bg-zinc-900/60 flex flex-col transition-all duration-200 ${
        collapsed ? "w-14" : "w-64"
      }`}
    >
      {/* Header */}
      <div className={`flex items-center border-b border-zinc-800 ${collapsed ? "justify-center p-3" : "justify-between px-4 py-4"}`}>
        {!collapsed && (
          <Link href="/" className="block min-w-0">
            <div className="text-lg font-semibold tracking-tight truncate">CommandCenter</div>
            <div className="text-xs text-zinc-500">Control Plane</div>
          </Link>
        )}
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="shrink-0 rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 transition-colors"
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M6 3l5 5-5 5" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M10 3L5 8l5 5" />
            </svg>
          )}
        </button>
      </div>

      {/* Nav */}
      <nav className="flex flex-col gap-1 p-2 flex-1">
        {PANES.map((p) => {
          const active = pathname?.startsWith(p.href);
          return (
            <Link
              key={p.href}
              href={p.href}
              title={collapsed ? p.label : undefined}
              className={`rounded-md transition-colors ${
                collapsed ? "flex items-center justify-center px-2 py-2.5" : "px-3 py-2"
              } text-sm ${
                active
                  ? "bg-zinc-800 text-white"
                  : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-100"
              }`}
            >
              {collapsed ? (
                <span className="font-mono text-sm font-semibold">{p.icon}</span>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-zinc-500">[{p.icon}]</span>
                    <span className="font-medium">{p.label}</span>
                  </div>
                  <div className="ml-7 text-xs text-zinc-500">{p.note}</div>
                </>
              )}
            </Link>
          );
        })}
      </nav>

      {!collapsed && (
        <div className="border-t border-zinc-800 px-4 py-3">
          {session?.user ? (
            <div className="flex items-center justify-between">
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-zinc-300">
                  {session.user.name ?? session.user.email ?? "Signed in"}
                </div>
                <div className="truncate text-xs text-zinc-500">
                  {session.user.email}
                </div>
              </div>
              <button
                onClick={() => signOut({ callbackUrl: "/signin" })}
                className="ml-2 shrink-0 rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 transition-colors"
                title="Sign out"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M6 2H3v12h3M11 11l3-3-3-3M14 8H6" />
                </svg>
              </button>
            </div>
          ) : session === undefined ? (
            <div className="text-xs text-zinc-600">Loading session…</div>
          ) : (
            <div className="text-xs text-zinc-600">Phase 1 &middot; Self-Mutation Loop</div>
          )}
        </div>
      )}
    </aside>
  );
}