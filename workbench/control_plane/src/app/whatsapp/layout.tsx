"use client";

// Shared WhatsApp app shell — a persistent sub-navigation across EVERY WhatsApp
// route (inbox + Pulse + settings + Numbers). Previously each sub-app was a
// dead-end route with only a "← Queue" link, so opening one dropped the app's
// own navigation; this layout keeps it in view everywhere. Icons are the native
// lucide set the rest of CommandCenter uses.

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
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex h-12 shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-3">
        <Link
          href="/whatsapp"
          className="mr-2 flex shrink-0 items-center gap-2 pr-1"
        >
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-500/15 text-emerald-500">
            <MessageSquare className="h-3.5 w-3.5" />
          </span>
          <span className="text-[13px] font-semibold">WhatsApp</span>
        </Link>

        <nav className="flex items-center gap-0.5">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = isActive(t);
            return (
              <Link
                key={t.href}
                href={t.href}
                className={`flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12.5px] transition ${
                  active
                    ? "bg-muted font-semibold text-foreground"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                <span>{t.label}</span>
              </Link>
            );
          })}
        </nav>

        <Link
          href="/whatsapp/connect"
          className="ml-auto flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground hover:opacity-90"
        >
          <Plus className="h-3.5 w-3.5" /> Connect
        </Link>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
