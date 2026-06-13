"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useSession, signOut } from "next-auth/react";
import { ChevronLeft, ChevronRight, LogOut, Command } from "lucide-react";
import { NAV_SECTIONS, type NavPane, type NavSection } from "@/lib/nav";
import { resolveIcon } from "@/lib/icons";
import ThemeToggle from "@/components/ThemeToggle";

// ---------------------------------------------------------------------------
// Sidebar — sectioned navigation (Apps / Configure / Build)
// RapidTool design language — refined dark theme with blue primary accent.
// ---------------------------------------------------------------------------

export default function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const { data: session } = useSession();

  return (
    <aside
      className={`shrink-0 border-r flex flex-col transition-all duration-200 bg-sidebar border-sidebar-border ${
        collapsed ? "w-14" : "w-64"
      }`}
    >
      {/* Header */}
      <div className={`flex items-center border-b border-sidebar-border ${collapsed ? "justify-center p-3" : "justify-between px-4 py-4"}`}>
        {!collapsed && (
          <Link href="/" className="block min-w-0">
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <Command size={15} strokeWidth={2.5} />
              </span>
              <div>
                <div className="text-sm font-semibold tracking-tight text-sidebar-foreground leading-tight">CommandCenter</div>
                <div className="text-[10px] text-muted-foreground leading-tight">Control Plane</div>
              </div>
            </div>
          </Link>
        )}
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="shrink-0 rounded-lg p-1.5 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground tech-transition"
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>
      </div>

      {/* Nav sections */}
      <nav className="flex flex-col flex-1 overflow-y-auto">
        {NAV_SECTIONS.map((section) => (
          <NavSectionBlock
            key={section.id}
            section={section}
            pathname={pathname}
            collapsed={collapsed}
          />
        ))}
      </nav>

      {/* User / sign-out footer */}
      {!collapsed && (
        <div className="border-t border-sidebar-border px-4 py-3">
          {session?.user ? (
            <div className="flex items-center justify-between">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[11px] font-medium text-sidebar-foreground/90">
                  {session.user.name ?? session.user.email ?? "Signed in"}
                </div>
                <div className="truncate text-[10px] text-muted-foreground">
                  {session.user.email}
                </div>
              </div>
              <button
                onClick={() => signOut({ callbackUrl: "/signin" })}
                className="ml-2 shrink-0 rounded-lg p-1.5 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground tech-transition"
                title="Sign out"
              >
                <LogOut size={14} />
              </button>
              <ThemeToggle />
            </div>
          ) : session === undefined ? (
            <div className="text-[11px] text-muted-foreground">Loading session…</div>
          ) : (
            <div className="text-[11px] text-muted-foreground">Phase 1 &middot; Self-Mutation Loop</div>
          )}
        </div>
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Section block
// ---------------------------------------------------------------------------

function NavSectionBlock({
  section,
  pathname,
  collapsed,
}: {
  section: NavSection;
  pathname: string | null;
  collapsed: boolean;
}) {
  if (collapsed) {
    return (
      <div>
        <div className="flex flex-col gap-1 p-2">
          {section.items.map((p) => (
            <NavLink key={p.href} pane={p} pathname={pathname} collapsed />
          ))}
        </div>
        <div className="mx-3 border-t border-sidebar-border/50" />
      </div>
    );
  }

  return (
    <div className="px-2 py-1.5">
      {/* Section heading */}
      <div
        className={
          section.sub
            ? "px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70"
            : "px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
        }
      >
        {section.label}
      </div>

      {/* Section items */}
      <div className="flex flex-col gap-0.5">
        {section.items.map((p) => (
          <NavLink key={p.href} pane={p} pathname={pathname} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Individual nav link
// ---------------------------------------------------------------------------

function NavLink({
  pane,
  pathname,
  collapsed = false,
}: {
  pane: NavPane;
  pathname: string | null;
  collapsed?: boolean;
}) {
  const active = pathname?.startsWith(pane.href);
  const Icon = resolveIcon(pane.icon);

  if (collapsed) {
    return (
      <Link
        key={pane.href}
        href={pane.href}
        title={pane.label}
        className={`rounded-lg tech-transition flex items-center justify-center p-2.5 ${
          active
            ? "bg-primary/15 text-primary"
            : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
        }`}
      >
        <Icon size={18} strokeWidth={active ? 2.5 : 2} />
      </Link>
    );
  }

  return (
    <Link
      key={pane.href}
      href={pane.href}
      className={`rounded-lg tech-transition px-3 py-2 text-sm ${
        active
          ? "bg-primary/10 text-primary border-l-[3px] border-primary pl-[9px]"
          : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground border-l-[3px] border-transparent pl-[9px]"
      }`}
    >
      <div className="flex items-center gap-2.5">
        <Icon size={16} strokeWidth={active ? 2.5 : 2} />
        <span className="font-medium text-[13px]">{pane.label}</span>
      </div>
      <div className="ml-[26px] text-[11px] text-muted-foreground/60 leading-tight mt-0.5">{pane.note}</div>
    </Link>
  );
}