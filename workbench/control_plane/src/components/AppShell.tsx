"use client";

/**
 * AppShell — responsive application shell.
 *
 *   • Desktop (or "Request desktop" on a phone): the classic persistent Sidebar
 *     alongside the scrollable main content area.
 *   • Mobile: a compact top app bar with a hamburger that opens a slide-in
 *     navigation drawer, plus a "Desktop" toggle. The main content area is full
 *     width so individual pages can present their own clean mobile layout.
 *
 * Layout decisions come from useViewMode(); component-level tweaks elsewhere can
 * rely on plain Tailwind responsive prefixes (kept in sync via the viewport meta).
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useSession, signOut } from "next-auth/react";
import { Menu, X, Monitor, Smartphone, LogOut } from "lucide-react";
import Sidebar from "@/components/Sidebar";
import { useViewMode } from "@/components/ViewModeProvider";
import { PANES } from "@/lib/nav";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const { isMobile, isNarrow, forceDesktop, toggleView } = useViewMode();
  const [navOpen, setNavOpen] = useState(false);
  const pathname = usePathname();

  // ── Desktop layout ───────────────────────────────────────────────────────
  if (!isMobile) {
    return (
      <div className="flex h-screen overflow-hidden">
        <Sidebar />
        <main className="flex-1 min-w-0 overflow-auto">{children}</main>

        {/* Floating "Mobile view" pill — only when desktop is forced on a phone. */}
        {isNarrow && forceDesktop && (
          <button
            onClick={toggleView}
            className="fixed bottom-4 right-4 z-[60] flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-900/95 px-3 py-2 text-xs text-zinc-200 shadow-lg backdrop-blur hover:border-zinc-500"
          >
            <Smartphone size={14} />
            Mobile view
          </button>
        )}
      </div>
    );
  }

  // ── Mobile layout ────────────────────────────────────────────────────────
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* Top app bar */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-900/80 px-3 backdrop-blur">
        <button
          onClick={() => setNavOpen(true)}
          className="-ml-1 rounded p-2 text-zinc-300 hover:bg-zinc-800"
          aria-label="Open navigation"
        >
          <Menu size={20} />
        </button>
        <Link href="/" className="min-w-0">
          <span className="block truncate text-sm font-semibold tracking-tight text-zinc-100">
            CommandCenter
          </span>
        </Link>
        <button
          onClick={toggleView}
          className="ml-auto flex items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:border-zinc-500 hover:bg-zinc-800"
          title="Switch to desktop view"
        >
          <Monitor size={14} />
          Desktop
        </button>
      </header>

      {/* Page content */}
      <main className="flex-1 min-h-0 overflow-auto">{children}</main>

      {/* Navigation drawer */}
      {navOpen && (
        <MobileNavDrawer pathname={pathname} onClose={() => setNavOpen(false)} />
      )}
    </div>
  );
}

function MobileNavDrawer({
  pathname,
  onClose,
}: {
  pathname: string | null;
  onClose: () => void;
}) {
  const { data: session } = useSession();

  return (
    <div className="fixed inset-0 z-[70]">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      {/* Panel */}
      <aside className="absolute inset-y-0 left-0 flex w-[82%] max-w-xs flex-col border-r border-zinc-800 bg-zinc-900 shadow-2xl chat-fade-in">
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3.5">
          <div>
            <div className="text-base font-semibold tracking-tight text-zinc-100">
              CommandCenter
            </div>
            <div className="text-xs text-zinc-500">Control Plane</div>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            aria-label="Close navigation"
          >
            <X size={18} />
          </button>
        </div>

        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-2">
          {PANES.map((p) => {
            const active = pathname?.startsWith(p.href);
            return (
              <Link
                key={p.href}
                href={p.href}
                onClick={onClose}
                className={`rounded-md px-3 py-3 transition-colors ${
                  active
                    ? "bg-zinc-800 text-white"
                    : "text-zinc-300 hover:bg-zinc-800/60 hover:text-zinc-100"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-zinc-500">[{p.icon}]</span>
                  <span className="text-sm font-medium">{p.label}</span>
                </div>
                <div className="ml-7 mt-0.5 text-xs text-zinc-500">{p.note}</div>
              </Link>
            );
          })}
        </nav>

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
                className="ml-2 shrink-0 rounded p-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                title="Sign out"
              >
                <LogOut size={16} />
              </button>
            </div>
          ) : (
            <div className="text-xs text-zinc-600">Phase 1 · Self-Mutation Loop</div>
          )}
        </div>
      </aside>
    </div>
  );
}
