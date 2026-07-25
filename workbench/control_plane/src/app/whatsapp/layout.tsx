"use client";

// Shared WhatsApp app shell — a persistent LEFT sub-navigation column across
// every WhatsApp route (inbox + Pulse + settings + Numbers), matching the
// left-column pattern the other CommandCenter apps use (email's AccountSidebar,
// tasks' ListsSidebar) rather than a top bar. Icons are the native lucide set.
// Responsive: a compact icon rail on mobile, a labelled column on desktop.

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
  const isActive = (t: Tab) =>
    t.exact ? pathname === t.href : pathname?.startsWith(t.href) ?? false;

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
