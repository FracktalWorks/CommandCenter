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
  useState,
  type ReactNode,
} from "react";
import { useSession, signOut } from "next-auth/react";
import { X, Monitor, Smartphone, MoreHorizontal, LogOut } from "lucide-react";
import Sidebar from "@/components/Sidebar";
import { useViewMode } from "@/components/ViewModeProvider";
import { useActiveSessions } from "@/hooks/useActiveSessions";
import { PANES } from "@/lib/nav";

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
    <MobileDrawerCtx.Provider
      value={{ isOpen: drawerOpen, open: openDrawer, close: closeDrawer }}
    >
      <div className="flex h-screen flex-col overflow-hidden bg-zinc-950">
        {/* Top app bar — just title + overflow, no hamburger */}
        <header className="flex h-11 shrink-0 items-center border-b border-zinc-800 bg-zinc-900/80 px-2 backdrop-blur">
          {/* Centered title */}
          <Link href="/" className="absolute left-1/2 -translate-x-1/2">
            <span className="text-sm font-semibold tracking-tight text-zinc-100">
              CommandCenter
            </span>
          </Link>

          {/* Overflow menu (desktop toggle + sign out) */}
          <div className="ml-auto">
            <OverflowMenu toggleView={toggleView} />
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 min-h-0 overflow-y-auto">{children}</main>

        {/* Bottom navigation bar — always visible on mobile */}
        <MobileBottomNav pathname={pathname} toggleView={toggleView} />

        {/* Unified drawer (slide-up panel for bottom-nav tab content) */}
        {drawerOpen && (
          <div className="fixed inset-0 z-[70]">
            <div
              className="absolute inset-0 bg-black/60"
              onClick={closeDrawer}
            />
            <aside className="absolute inset-x-0 bottom-0 flex max-h-[85%] flex-col rounded-t-2xl border-t border-zinc-800 bg-zinc-900 shadow-2xl chat-fade-in">
              {/* Drag handle */}
              <div className="flex justify-center pt-2 pb-1">
                <div className="w-10 h-1 rounded-full bg-zinc-700" />
              </div>
              {drawerContent}
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

function MobileBottomNav({
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
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-zinc-200">Menu</div>
          <div className="text-[11px] text-zinc-500">CommandCenter</div>
        </div>
        <button
          onClick={close}
          className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800"
          aria-label="Close"
        >
          <X size={16} />
        </button>
      </div>
      <nav className="flex flex-col gap-0.5 overflow-y-auto p-2">
        {PANES.map((p) => {
          const active = pathname?.startsWith(p.href);
          return (
            <Link
              key={p.href}
              href={p.href}
              onClick={close}
              className={`rounded-lg px-3 py-2.5 transition-colors flex items-center gap-2.5 ${
                active
                  ? "bg-zinc-800 text-white"
                  : "text-zinc-300 hover:bg-zinc-800/50 hover:text-zinc-100"
              }`}
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-zinc-800 text-xs font-semibold text-zinc-400">
                {p.icon}
              </span>
              <span className="text-sm font-medium">{p.label}</span>
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto border-t border-zinc-800 p-3 space-y-2">
        <button
          onClick={() => { toggleView(); close(); }}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
        >
          <Monitor size={16} className="shrink-0" />
          Desktop view
        </button>
        {session?.user && (
          <button
            onClick={() => signOut({ callbackUrl: "/signin" })}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          >
            <LogOut size={16} className="shrink-0" />
            Sign out
          </button>
        )}
        {session?.user && (
          <div className="px-3 pt-1">
            <div className="truncate text-[11px] font-medium text-zinc-500">
              {session.user.name ?? session.user.email}
            </div>
          </div>
        )}
      </div>
    </>
  );

  const isChatPage = pathname?.startsWith("/chat") ?? false;

  return (
    <nav className="shrink-0 border-t border-zinc-800 bg-zinc-900/95 backdrop-blur">
      <div className="flex items-center justify-around py-1.5 px-2">
        <button
          onClick={() => { open(menuContent); }}
          className={`flex flex-col items-center gap-0.5 px-4 py-1 rounded-lg transition-colors ${
            isOpen ? "text-sky-400" : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          <MenuIcon size={20} />
          <span className="text-[9px] font-medium">Menu</span>
        </button>
        {isChatPage && (
          <>
            <button
              onClick={() => {
                const ev = new CustomEvent("cc-mobile-nav", { detail: "chats" });
                window.dispatchEvent(ev);
              }}
              className="relative flex flex-col items-center gap-0.5 px-4 py-1 rounded-lg transition-colors text-zinc-500 hover:text-zinc-300"
            >
              <MessageCircle size={20} />
              {activeCount > 0 && (
                <span className="absolute -top-0.5 right-1.5 flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-emerald-500 text-[9px] font-bold text-white animate-pulse">
                  {activeCount}
                </span>
              )}
              <span className="text-[9px] font-medium">Chats</span>
            </button>
            <button
              onClick={() => {
                const ev = new CustomEvent("cc-mobile-nav", { detail: "files" });
                window.dispatchEvent(ev);
              }}
              className="flex flex-col items-center gap-0.5 px-4 py-1 rounded-lg transition-colors text-zinc-500 hover:text-zinc-300"
            >
              <FolderOpen size={20} />
              <span className="text-[9px] font-medium">Files</span>
            </button>
          </>
        )}
      </div>
    </nav>
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
        className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
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
          <div className="absolute right-0 top-full mt-1 z-50 w-48 rounded-xl border border-zinc-700 bg-zinc-900 py-1 shadow-xl chat-fade-in">
            <button
              onClick={() => {
                toggleView();
                setOpen(false);
              }}
              className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-sm text-zinc-300 hover:bg-zinc-800 transition-colors"
            >
              <Monitor size={15} className="shrink-0 text-zinc-500" />
              Desktop view
            </button>
            {session?.user && (
              <button
                onClick={() => signOut({ callbackUrl: "/signin" })}
                className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-sm text-zinc-300 hover:bg-zinc-800 transition-colors"
              >
                <LogOut size={15} className="shrink-0 text-zinc-500" />
                Sign out
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
