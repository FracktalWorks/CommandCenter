import Link from "next/link";
import { NAV_SECTIONS } from "@/lib/nav";
import { resolveIcon } from "@/lib/icons";

// The landing page mirrors the sidebar: every app (and the Configure / Build
// panes) comes from NAV_SECTIONS, so adding an app there surfaces it here too.

export default function Home() {
  const apps = NAV_SECTIONS.find((s) => s.id === "apps")?.items ?? [];
  const secondary = NAV_SECTIONS.filter((s) => s.id !== "apps");

  return (
    <div className="p-6 sm:p-10 max-w-5xl">
      <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">Welcome back</h1>
      <p className="mt-2 text-muted-foreground">
        Chat with CommandCenter or observe what the agents are doing.
      </p>

      {/* ── Apps ─────────────────────────────────────────────────────────── */}
      <div className="mt-8 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Apps
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {apps.map((p) => {
          const Icon = resolveIcon(p.icon);
          return (
            <Link
              key={p.href}
              href={p.href}
              className="rounded-xl border border-border bg-card/50 p-4 hover:border-primary/40 hover:bg-card tech-transition"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Icon size={18} />
              </span>
              <div className="mt-3 text-sm font-semibold">{p.label}</div>
              <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{p.note}</p>
            </Link>
          );
        })}
      </div>

      {/* ── Configure / Build ────────────────────────────────────────────── */}
      {secondary.map((section) => (
        <section key={section.id}>
          <div className="mt-8 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {section.label}
          </div>
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {section.items.map((p) => {
              const Icon = resolveIcon(p.icon);
              return (
                <Link
                  key={p.href}
                  href={p.href}
                  className="flex items-center gap-3 rounded-xl border border-border bg-card/30 px-4 py-3 hover:border-primary/40 hover:bg-card tech-transition"
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
                    <Icon size={16} />
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{p.label}</div>
                    <div className="truncate text-[11px] text-muted-foreground">{p.note}</div>
                  </div>
                </Link>
              );
            })}
          </div>
        </section>
      ))}

      <div className="mt-12 rounded-lg border border-border bg-card/30 p-4 text-sm text-muted-foreground">
        <b>Phase 1:</b> Self-Mutation Loop. Sign in with your Microsoft 365 account via the sidebar.
      </div>
    </div>
  );
}
