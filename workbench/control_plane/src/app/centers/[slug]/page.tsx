"use client";

// ── Center landing page — /centers/[slug] ─────────────────────────────────
//
// The scaffold for a departmental Center: one page per department showing its
// planned and live sub-apps, driven entirely by lib/centers.ts. Live items
// open a real surface today (sometimes unscoped — each carries its caveat);
// planned items make the buildout destination legible to the whole team.
//
// This page is presentation scaffolding. Real scoping (a Center showing only
// its team's tasks, mailbox, agents) arrives with access-control Phase 2
// (modules over org_group) — see project-docs/specs/org_access_control.md §5.

import Link from "next/link";
import { useParams } from "next/navigation";
import { centerBySlug } from "@/lib/centers";
import ThemedIcon from "@/components/Icon";

export default function CenterPage() {
  const params = useParams<{ slug: string }>();
  const center = centerBySlug(params?.slug ?? "");

  if (!center) {
    return (
      <div className="p-6 sm:p-10">
        <h1 className="text-xl font-semibold">Unknown Center</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          No Center is registered at this address. The available Centers are
          listed in the sidebar.
        </p>
      </div>
    );
  }

  const live = center.apps.filter((a) => a.status === "live");
  const planned = center.apps.filter((a) => a.status === "planned");

  return (
    <div className="p-6 sm:p-10 max-w-5xl">
      {/* Header */}
      <div className="flex items-start gap-4">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <ThemedIcon name={center.icon} size={24} />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{center.name}</h1>
            <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Scaffold
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{center.tagline}</p>
        </div>
      </div>

      {/* Live sub-apps */}
      {live.length > 0 && (
        <>
          <div className="mt-8 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Available now
          </div>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {live.map((app) => {
              return (
                <Link
                  key={app.label}
                  href={app.href ?? "#"}
                  className="rounded-xl border border-border bg-card/50 p-4 hover:border-primary/40 hover:bg-card tech-transition"
                >
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <ThemedIcon name={app.icon} size={18} />
                  </span>
                  <div className="mt-3 text-sm font-semibold">{app.label}</div>
                  <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{app.note}</p>
                  {app.caveat && (
                    <p className="mt-2 text-[11px] leading-snug text-warning">{app.caveat}</p>
                  )}
                </Link>
              );
            })}
          </div>
        </>
      )}

      {/* Planned sub-apps */}
      {planned.length > 0 && (
        <>
          <div className="mt-8 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Planned
          </div>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {planned.map((app) => {
              return (
                <div
                  key={app.label}
                  className="rounded-xl border border-dashed border-border bg-card/20 p-4"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
                      <ThemedIcon name={app.icon} size={18} />
                    </span>
                    <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                      Planned
                    </span>
                  </div>
                  <div className="mt-3 text-sm font-semibold text-muted-foreground">
                    {app.label}
                  </div>
                  <p className="mt-1 text-[11px] leading-snug text-muted-foreground/70">
                    {app.note}
                  </p>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Where this is going */}
      <div className="mt-10 rounded-lg border border-border bg-card/30 p-4 text-[13px] leading-relaxed text-muted-foreground">
        <b className="text-foreground">How Centers work.</b> A Center is a scoped
        view of the one platform — the {center.name.replace(" Center", "")} team&apos;s
        slice of apps, agents, memory, and workflows. Access is granted per Center
        (the <code className="rounded bg-secondary px-1 py-0.5 text-[11px]">{center.feature}</code>{" "}
        feature), and team scoping deepens as groups land: team-instanced agents,
        shared mailboxes, and department dashboards all key off the{" "}
        <code className="rounded bg-secondary px-1 py-0.5 text-[11px]">{center.group}</code> group.
      </div>
    </div>
  );
}
