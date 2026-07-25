"use client";

// Shared WhatsApp app shell — a persistent sub-navigation across every WhatsApp
// route (inbox + Pulse + settings + Numbers). Responsive, matching the rest of
// CommandCenter:
//   • Desktop: a persistent LEFT column (like email's AccountSidebar / tasks'
//     ListsSidebar) — icon rail that widens to labels at md.
//   • Mobile: a compact horizontal, scrollable tab strip at the top — the same
//     "no left rail on phones" posture the shell's other apps take.
// Icons are the native lucide set.

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  Inbox,
  MessageSquare,
  MessageSquareText,
  Plus,
  SlidersHorizontal,
  Smartphone,
  Tags,
  type LucideIcon,
} from "lucide-react";
import { useViewMode } from "@/components/ViewModeProvider";

type Tab = { href: string; label: string; icon: LucideIcon; exact?: boolean };

const TABS: Tab[] = [
  { href: "/whatsapp", label: "Inbox", icon: Inbox, exact: true },
  { href: "/whatsapp/insights", label: "Pulse", icon: Activity },
  { href: "/whatsapp/settings/categories", label: "Categories", icon: Tags },
  { href: "/whatsapp/settings/replies", label: "Replies", icon: MessageSquareText },
  { href: "/whatsapp/settings/rules", label: "Rules", icon: SlidersHorizontal },
  { href: "/whatsapp/numbers", label: "Numbers", icon: Smartphone },
];

export default function WhatsAppLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { isMobile } = useViewMode();
  const isActive = (t: Tab) =>
    t.exact ? pathname === t.href : pathname?.startsWith(t.href) ?? false;

  // ── Mobile: horizontal, scrollable tab strip above the content ──────────
  if (isMobile) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col bg-background text-foreground">
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2 py-1.5">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = isActive(t);
            return (
              <Link
                key={t.href}
                href={t.href}
                className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] whitespace-nowrap transition ${
                  active
                    ? "bg-muted font-semibold text-foreground"
                    : "text-muted-foreground hover:bg-muted/50"
                }`}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                {t.label}
              </Link>
            );
          })}
          <Link
            href="/whatsapp/connect"
            className="ml-auto flex shrink-0 items-center gap-1 rounded-full bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground"
          >
            <Plus className="h-3.5 w-3.5 shrink-0" />
            Connect
          </Link>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </div>
    );
  }

  // ── Desktop: persistent left column ─────────────────────────────────────
  return (
    <div className="flex h-full min-h-0 bg-background text-foreground">
      <aside className="flex w-14 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:w-52">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-sidebar-border px-3">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-emerald-500/15 text-emerald-500">
            <MessageSquare className="h-3.5 w-3.5" />
          </span>
          <span className="hidden text-[13px] font-semibold md:block">WhatsApp</span>
        </div>

        <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = isActive(t);
            return (
              <Link
                key={t.href}
                href={t.href}
                title={t.label}
                className={`flex items-center justify-center gap-2.5 rounded-lg px-2.5 py-2 text-[12.5px] transition md:justify-start ${
                  active
                    ? "bg-muted font-semibold text-foreground"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="hidden md:inline">{t.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="shrink-0 border-t border-sidebar-border p-2">
          <Link
            href="/whatsapp/connect"
            title="Connect a number"
            className="flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-[12px] font-semibold text-primary-foreground hover:opacity-90"
          >
            <Plus className="h-3.5 w-3.5 shrink-0" />
            <span className="hidden md:inline">Connect</span>
          </Link>
        </div>
      </aside>

      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
