"use client";

/**
 * AppShell — responsive application shell.
 *
 *   • Desktop (or "Request desktop" on a phone): the classic persistent Sidebar
 *     alongside the scrollable main content area.
 *   • Mobile: a minimal top bar (hamburger + centered title + overflow menu),
 *     and a unified slide-in drawer.  Child pages inject their own content
 *     (e.g. conversation list) into the drawer via useMobileDrawer().
 *
 * Layout decisions come from useViewMode(); component-level tweaks elsewhere can
 * rely on plain Tailwind responsive prefixes (kept in sync via the viewport meta).
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useSession, signOut } from "next-auth/react";
import { X, Monitor, Smartphone, MoreHorizontal, LogOut, Command, Mail, Zap, Inbox, ListChecks, Plus, Sparkles } from "lucide-react";
import Sidebar from "@/components/Sidebar";
import { useViewMode } from "@/components/ViewModeProvider";
import { useActiveSessions } from "@/hooks/useActiveSessions";
import { NAV_SECTIONS } from "@/lib/nav";import { ThemeToggleMenuItem } from "@/components/ThemeToggle";
// ---------------------------------------------------------------------------
// Mobile drawer context — lets child pages inject content into the hamburger
// drawer without AppShell needing to know about sessions or filters.
// ---------------------------------------------------------------------------

type MobileDrawerCtx = {
  /** True when the drawer is currently open. */
  isOpen: boolean;
  /** Open the drawer with the given React content. */
  open: (content: ReactNode) => void;
  /** Close the drawer. */
  close: () => void;
};

const MobileDrawerCtx = createContext<MobileDrawerCtx>({
  isOpen: false,
  open: () => {},
  close: () => {},
});

export function useMobileDrawer(): MobileDrawerCtx {
  return useContext(MobileDrawerCtx);
}

// ---------------------------------------------------------------------------
// AppShell
// ---------------------------------------------------------------------------

export default function AppShell({ children }: { children: React.ReactNode }) {
  const { isMobile, isNarrow, forceDesktop, toggleView } = useViewMode();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerContent, setDrawerContent] = useState<ReactNode>(null);
  const pathname = usePathname();

  const openDrawer = useCallback((content: ReactNode) => {
    setDrawerContent(content);
    setDrawerOpen(true);
  }, []);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

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
            className="fixed bottom-4 right-4 z-[60] flex items-center gap-1.5 rounded-full border border-border bg-popover/95 px-3 py-2 text-xs text-muted-foreground shadow-lg backdrop-blur hover:border-primary/50 tech-transition"
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
    <MobileDrawerCtx.Provider
      value={{ isOpen: drawerOpen, open: openDrawer, close: closeDrawer }}
    >
      <div className="flex flex-col overflow-hidden bg-background" style={{ height: "100dvh" }}>
        {/* Top app bar — just title + overflow, no hamburger. Safe-area padded for notch */}
        <header className="flex h-11 shrink-0 items-center border-b border-border bg-card/80 px-2 backdrop-blur pt-safe">
          {/* Centered title */}
          <Link href="/" className="absolute left-1/2 -translate-x-1/2 flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Command size={12} strokeWidth={2.5} />
            </span>
            <span className="text-sm font-semibold tracking-tight text-foreground">
              CommandCenter
            </span>
          </Link>

          {/* Overflow menu (desktop toggle + sign out) */}
          <div className="ml-auto">
            <OverflowMenu toggleView={toggleView} />
          </div>
        </header>

        {/* Page content — pb-safe protects bottom content from iOS rounded corners */}
        <main className="flex-1 min-h-0 overflow-y-auto pb-14">{children}</main>

        {/* Bottom navigation bar — fixed at viewport bottom, never scrolls. pb-safe lifts it above the iOS home indicator */}
        <div className="fixed bottom-0 inset-x-0 z-50 border-t border-border bg-card/90 backdrop-blur pb-safe">
          <MobileBottomNavInner pathname={pathname} toggleView={toggleView} />
        </div>

        {/* Unified drawer (slide-up panel for bottom-nav tab content) */}
        {drawerOpen && (
          <div className="fixed inset-0 z-[70]">
            <div
              className="absolute inset-0 bg-black/60"
              onClick={closeDrawer}
            />
            <aside className="absolute inset-x-0 bottom-0 flex max-h-[85%] flex-col rounded-t-2xl border-t border-border bg-card shadow-2xl chat-fade-in tech-glass-subtle">
              {/* Drag handle */}
              <div className="flex justify-center pt-2 pb-1">
                <div className="w-10 h-1 rounded-full bg-muted-foreground/30" />
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto pb-safe">
                {drawerContent}
              </div>
            </aside>
          </div>
        )}
      </div>
    </MobileDrawerCtx.Provider>
  );
}

// ---------------------------------------------------------------------------
// Mobile bottom navigation bar — ChatGPT/DeepSeek-style 3-tab bar
// ---------------------------------------------------------------------------

import { MessageCircle, FolderOpen, Menu as MenuIcon } from "lucide-react";
import { resolveIcon } from "@/lib/icons";

function MobileBottomNavInner({
  pathname,
  toggleView,
}: {
  pathname: string | null;
  toggleView: () => void;
}) {
  const { isOpen, open, close } = useMobileDrawer();
  const { data: session } = useSession();
  const activeRunIds = useActiveSessions();
  const activeCount = activeRunIds.size;

  const menuContent = (
    <>
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-foreground">Menu</div>
          <div className="text-[11px] text-muted-foreground">CommandCenter</div>
        </div>
        <button
          onClick={close}
          className="rounded-lg p-1.5 text-muted-foreground hover:bg-secondary"
          aria-label="Close"
        >
          <X size={16} />
        </button>
      </div>
      <nav className="flex flex-col overflow-y-auto">
        {NAV_SECTIONS.map((section) => (
          <div key={section.id} className="px-2 pt-1 pb-1.5">
            <div
              className={
                section.sub
                  ? "px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60"
                  : "px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
              }
            >
              {section.label}
            </div>
            <div className="flex flex-col gap-0.5">
              {section.items.map((p) => {
                const active = pathname?.startsWith(p.href);
                const Icon = resolveIcon(p.icon);
                return (
                  <Link
                    key={p.href}
                    href={p.href}
                    onClick={close}
                    className={`rounded-lg px-3 py-2.5 tech-transition flex items-center gap-2.5 ${
                      active
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                    }`}
                  >
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
                      <Icon size={15} strokeWidth={active ? 2.5 : 2} />
                    </span>
                    <span className="text-sm font-medium">{p.label}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
      <div className="mt-auto border-t border-border p-3 space-y-2">
        <ThemeToggleMenuItem onClick={close} />
        <button
          onClick={() => { toggleView(); close(); }}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-muted-foreground hover:bg-secondary hover:text-foreground tech-transition"
        >
          <Monitor size={16} className="shrink-0" />
          Desktop view
        </button>
        {session?.user && (
          <button
            onClick={() => signOut({ callbackUrl: "/signin" })}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-muted-foreground hover:bg-secondary hover:text-foreground tech-transition"
          >
            <LogOut size={16} className="shrink-0" />
            Sign out
          </button>
        )}
        {session?.user && (
          <div className="px-3 pt-1">
            <div className="truncate text-[11px] font-medium text-muted-foreground">
              {session.user.name ?? session.user.email}
            </div>
          </div>
        )}
      </div>
    </>
  );

  const isChatPage = pathname?.startsWith("/chat") ?? false;
  const isEmailPage = pathname?.startsWith("/email") ?? false;
  const isTasksPage = pathname?.startsWith("/tasks") ?? false;

  // Tasks: the bottom bar reflects which GTD section you're in. The page emits
  // `cc-tasks-section` whenever the active view changes.
  const [tasksSection, setTasksSection] = useState("inbox");
  useEffect(() => {
    const h = (e: Event) =>
      setTasksSection((e as CustomEvent<string>).detail || "inbox");
    window.addEventListener("cc-tasks-section", h);
    return () => window.removeEventListener("cc-tasks-section", h);
  }, []);

  const dispatchNav = (detail: string) => {
    window.dispatchEvent(new CustomEvent("cc-mobile-nav", { detail }));
  };

  return (
    <nav className="flex items-center justify-around py-1.5 px-2">
        <button
          onClick={() => { open(menuContent); }}
          className={`flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-lg transition-colors min-w-[52px] ${
            isOpen ? "text-primary" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <MenuIcon size={21} />
          <span className="text-[10px] font-medium leading-none">Menu</span>
        </button>
        {isEmailPage && (
          <>
            <button
              onClick={() => dispatchNav("email-accounts")}
              className="flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-lg transition-colors text-muted-foreground hover:text-foreground min-w-[52px]"
            >
              <Mail size={21} />
              <span className="text-[10px] font-medium leading-none">Inbox</span>
            </button>
            <button
              onClick={() => dispatchNav("email-automation")}
              className="flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-lg transition-colors text-muted-foreground hover:text-foreground min-w-[52px]"
            >
              <Zap size={21} />
              <span className="text-[10px] font-medium leading-none">Automation</span>
            </button>
            <button
              onClick={() => dispatchNav("email-ai")}
              className="flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-lg transition-colors text-muted-foreground hover:text-foreground min-w-[52px]"
            >
              <MessageCircle size={21} />
              <span className="text-[10px] font-medium leading-none">AI Chat</span>
            </button>
          </>
        )}
        {isChatPage && (
          <>
            <button
              onClick={() => dispatchNav("chats")}
              className="relative flex flex-col items-center gap-0.5 px-5 py-1.5 rounded-lg transition-colors text-muted-foreground hover:text-foreground min-w-[56px]"
            >
              <MessageCircle size={22} />
              {activeCount > 0 && (
                <span className="absolute -top-0.5 right-2 flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-success text-success-foreground text-[9px] font-bold animate-pulse">
                  {activeCount}
                </span>
              )}
              <span className="text-[10px] font-medium leading-none">Chats</span>
            </button>
            <button
              onClick={() => dispatchNav("files")}
              className="flex flex-col items-center gap-0.5 px-5 py-1.5 rounded-lg transition-colors text-muted-foreground hover:text-foreground min-w-[56px]"
            >
              <FolderOpen size={22} />
              <span className="text-[10px] font-medium leading-none">Files</span>
            </button>
          </>
        )}
        {isTasksPage && (
          <>
            <TaskTab
              active={tasksSection === "inbox"}
              onClick={() => dispatchNav("tasks-inbox")}
              icon={Inbox}
              label="Inbox"
            />
            <TaskTab
              active={tasksSection !== "inbox"}
              onClick={() => dispatchNav("tasks-lists")}
              icon={ListChecks}
              label="Lists"
            />
            <TaskTab
              onClick={() => dispatchNav("tasks-capture")}
              icon={Plus}
              label="Capture"
              accent
            />
            <TaskTab
              onClick={() => dispatchNav("tasks-assistant")}
              icon={Sparkles}
              label="Assistant"
            />
          </>
        )}
    </nav>
  );
}

function TaskTab({
  active,
  onClick,
  icon: Icon,
  label,
  accent,
}: {
  active?: boolean;
  onClick: () => void;
  icon: typeof Inbox;
  label: string;
  accent?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex min-w-[48px] flex-col items-center gap-0.5 rounded-lg px-2 py-1.5 transition-colors ${
        accent
          ? "text-primary"
          : active
            ? "text-primary"
            : "text-muted-foreground hover:text-foreground"
      }`}
    >
      <Icon size={accent ? 22 : 20} strokeWidth={active || accent ? 2.4 : 2} />
      <span className="text-[10px] font-medium leading-none">{label}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// "..." overflow menu (Desktop toggle + sign out, always accessible)
// ---------------------------------------------------------------------------

function OverflowMenu({ toggleView }: { toggleView: () => void }) {
  const [open, setOpen] = useState(false);
  const { data: session } = useSession();

  return (
    <div className="relative ml-auto">
      <button
        onClick={() => setOpen((v) => !v)}
        className="rounded-lg p-2 text-muted-foreground hover:bg-secondary hover:text-foreground tech-transition"
        aria-label="More options"
      >
        <MoreHorizontal size={18} />
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 top-full mt-1 z-50 w-48 rounded-xl border border-border bg-popover py-1 shadow-lg chat-fade-in tech-glass-subtle">
            <ThemeToggleMenuItem onClick={() => setOpen(false)} />
            <button
              onClick={() => {
                toggleView();
                setOpen(false);
              }}
              className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-sm text-muted-foreground hover:bg-secondary hover:text-foreground tech-transition"
            >
              <Monitor size={15} className="shrink-0" />
              Desktop view
            </button>
            {session?.user && (
              <button
                onClick={() => signOut({ callbackUrl: "/signin" })}
                className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-sm text-muted-foreground hover:bg-secondary hover:text-foreground tech-transition"
              >
                <LogOut size={15} className="shrink-0" />
                Sign out
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
