"use client";

/**
 * The operations views — Blocked · Awaiting · Paused · Active.
 *
 * Spec: `ProjectApp_Plan.md` §19 · data: `GET /projects/ops/list?state=`.
 *
 * **One route, four states, not four pages.** The plan calls them "filtered
 * projections of the same list", and building four would give four tables that
 * drift apart on column order and spacing — which is what stops a set of views
 * being scannable as a set. The differences that are real (which columns
 * matter, how it is sorted, what the empty state says) are DATA below, not
 * four components.
 *
 * ## The distinction the whole screen exists to make
 *
 * **Paused is our choice. Awaiting is our dependency.** A paused project is one
 * we stopped; an awaiting one is stalled on a customer, a supplier or an
 * approval. Management chases those two completely differently, and a board
 * that shows both as "not moving" is the reason the source spreadsheet had six
 * different words for stopped.
 */

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";

import Icon from "@/components/Icon";
import Button from "@/components/ui/Button";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { type AccentHue, accentForHue } from "@/lib/statusAccent";

import { SIGNAL_LABELS, shortName } from "../../home/lib/dashboard";

interface Row {
  id: string; title: string; parent: string | null; status: string;
  health: string | null; due_at: string | null; assignees: string[];
  next_action: string | null; next_action_owner: string | null;
  blocker_kind: string | null; blocker_title: string | null;
  waiting_on: string | null; blocked_since: string | null;
  blocked_days: number | null;
}

/** What each view is, in one place. */
const VIEWS = {
  blocked: {
    title: "Blocked",
    lede: "Work that has stopped, why, and how long it has been stopped.",
    icon: "OctagonAlert",
    hue: "red" as AccentHue,
    empty: "Nothing is blocked. Everything is moving.",
    showAge: true,
  },
  awaiting: {
    title: "Awaiting",
    lede: "Stalled on somebody outside the team — a client, a supplier, an approval.",
    icon: "Clock",
    hue: "red" as AccentHue,
    empty: "Nothing is waiting on anyone outside the team.",
    showAge: true,
  },
  paused: {
    title: "Paused",
    lede: "Work we chose to stop. Distinct from Awaiting, which is somebody else's hold.",
    icon: "Pause",
    hue: "amber" as AccentHue,
    empty: "Nothing is paused.",
    showAge: false,
  },
  active: {
    title: "Active",
    lede: "Everything currently in progress.",
    icon: "Play",
    hue: "blue" as AccentHue,
    empty: "No work is in progress.",
    showAge: false,
  },
} as const;

type ViewKey = keyof typeof VIEWS;
const isViewKey = (s: string): s is ViewKey => s in VIEWS;

export default function OpsViewPage() {
  const params = useParams<{ state: string }>();
  const router = useRouter();
  const state: ViewKey = isViewKey(params.state) ? params.state : "blocked";
  const view = VIEWS[state];

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [basis, setBasis] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/projects/ops/list?state=${state}&limit=200`, {
      cache: "no-store",
    });
    if (res.ok) {
      const d = await res.json();
      setRows(d.rows ?? []);
      setBasis(d.basis ?? "");
    }
    setLoading(false);
  }, [state]);

  useEffect(() => {
    const run = async () => { await load(); };
    void run();
    const onChange = () => load();
    window.addEventListener("cc-work-session-changed", onChange);
    window.addEventListener("focus", onChange);
    return () => {
      window.removeEventListener("cc-work-session-changed", onChange);
      window.removeEventListener("focus", onChange);
    };
  }, [load]);

  const accent = accentForHue(view.hue);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
        <Icon name={view.icon} size={14} className={accent.text} />
        <h1 className="shrink-0 text-xs font-medium text-foreground">{view.title}</h1>
        <span className="min-w-0 truncate text-xs text-muted-foreground">{view.lede}</span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="sm" icon="LayoutDashboard"
            onClick={() => router.push("/projects/home")}>
            Control Center
          </Button>
        </div>
      </div>

      {/* The four views as one control, so switching between them is a click
          rather than a trip through the dashboard. */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-1.5">
        {(Object.keys(VIEWS) as ViewKey[]).map((key) => (
          <Button
            key={key}
            variant={key === state ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={key === state}
            onClick={() => router.push(`/projects/ops/${key}`)}
          >
            {VIEWS[key].title}
          </Button>
        ))}
        <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
          {loading ? "—" : `${rows.length} project${rows.length === 1 ? "" : "s"}`}
        </span>
      </div>

      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="p-4"><SkeletonRows rows={6} height="h-11" /></div>
        ) : rows.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-8">
            <Icon name="CircleCheck" size={22} className="text-muted-foreground" />
            <p className="text-xs text-muted-foreground">{view.empty}</p>
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-background">
              <tr className="border-b border-border text-left text-[11px] text-muted-foreground">
                <th className="px-3 py-2 font-medium">Project</th>
                <th className="px-3 py-2 font-medium">Owner</th>
                {state !== "active" && state !== "paused" ? (
                  <>
                    <th className="px-3 py-2 font-medium">Blocker</th>
                    <th className="px-3 py-2 font-medium">Waiting on</th>
                  </>
                ) : null}
                {view.showAge ? <th className="px-3 py-2 font-medium">Days</th> : null}
                <th className="px-3 py-2 font-medium">Due</th>
                <th className="px-3 py-2 font-medium">Next action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const overdue = r.due_at ? new Date(r.due_at) < new Date() : false;
                return (
                  <tr
                    key={r.id}
                    onClick={() => router.push(`/projects?task=${r.id}`)}
                    className="cursor-pointer border-b border-border last:border-0 hover:bg-muted tech-transition"
                  >
                    <td className="max-w-[260px] px-3 py-2">
                      <p className="truncate text-foreground">{r.title}</p>
                      {r.parent ? (
                        <p className="truncate text-[11px] text-muted-foreground">{r.parent}</p>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                      {r.assignees.length
                        ? r.assignees.map(shortName).join(", ")
                        : <span className="text-warning">Unassigned</span>}
                    </td>
                    {state !== "active" && state !== "paused" ? (
                      <>
                        <td className="px-3 py-2">
                          {r.blocker_kind ? (
                            <span className={`rounded px-1.5 py-0.5 text-[10px] ${accentForHue((SIGNAL_LABELS[r.blocker_kind]?.hue ?? "gray") as AccentHue).soft} ${accentForHue((SIGNAL_LABELS[r.blocker_kind]?.hue ?? "gray") as AccentHue).text}`}>
                              {SIGNAL_LABELS[r.blocker_kind]?.label ?? r.blocker_kind}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                          {r.waiting_on ?? "—"}
                        </td>
                      </>
                    ) : null}
                    {view.showAge ? (
                      <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                        {r.blocked_days === null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          // Past a working week it is a management problem, not
                          // a wait — the same threshold `operations.py` uses for
                          // `blocked_long`, so the table and the attention score
                          // cannot disagree about what "long" means.
                          <span className={r.blocked_days >= 7 ? "text-destructive" : "text-foreground"}>
                            {r.blocked_days}d
                          </span>
                        )}
                      </td>
                    ) : null}
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                      {r.due_at ? (
                        <span className={overdue ? "text-destructive" : "text-muted-foreground"}>
                          {new Date(r.due_at).toLocaleDateString(undefined, {
                            day: "numeric", month: "short",
                          })}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="max-w-[260px] px-3 py-2">
                      {r.next_action ? (
                        <span className="truncate text-muted-foreground">{r.next_action}</span>
                      ) : (
                        <span className="text-warning">None set</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {basis ? (
        <p className="shrink-0 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
          {basis}
        </p>
      ) : null}
    </div>
  );
}
