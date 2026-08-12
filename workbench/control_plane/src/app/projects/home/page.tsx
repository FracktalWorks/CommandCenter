"use client";

/**
 * Project Control Center — the management landing page.
 *
 * Spec: `ProjectApp_Plan.md` §14 (SCREEN 1) · data: WS-27bn's `/ops/*`.
 *
 * Answers §44's questions above the fold: what needs attention, what is
 * blocked, why, who we are waiting on, how long, who is overloaded.
 *
 * ## Three rules this screen is built under
 *
 * 1. **It computes nothing.** Every number arrives already aggregated from
 *    `/ops/*`; the browser never counts the portfolio (plan §28). If a figure
 *    is wrong the fix is in SQL, not here.
 * 2. **Every percentage states its basis.** Each card renders the `basis`
 *    string its endpoint returned — acceptance 39, and the reason the workload
 *    card can be quoted in a meeting without being indefensible.
 * 3. **No chart library.** Adding one would be a second substrate (plan §0.4).
 *    The ring is 20 lines of inline SVG and the bars are divs; both are less
 *    code than the import would be.
 *
 * ⚠️ **No KPI deltas.** The mock shows "▲12% vs last month" and nothing stores
 * yesterday's counts. D-OPEN-10: ship without them until the snapshot job lands
 * (S17). An invented delta is worse than an absent one.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import Icon from "@/components/Icon";
import Button from "@/components/ui/Button";
import Progress from "@/components/ui/Progress";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { type AccentHue, accentForHue } from "@/lib/statusAccent";

import { describeActivity } from "../lib/activity";
import { SIGNAL_LABELS, ringSegments, shortName } from "./lib/dashboard";

interface Summary {
  total: number; in_progress: number; blocked: number; paused: number;
  not_started: number; overdue: number; at_risk: number; critical: number;
  no_next_action: number; awaiting_client: number; basis: string;
}
interface AttentionRow {
  id: string; title: string; parent: string | null; status: string;
  health: string | null; due_at: string | null; next_action: string | null;
  next_action_owner: string | null; blocker_kind: string | null;
  waiting_on: string | null; blocked_days: number | null;
  signals: string[]; score: number;
}
interface StageRow { id: string; name: string; count: number }
interface BlockerRow { kind: string; blockers: number; projects: number; oldest_days: number | null }
interface ActivityRow {
  id: string; type: string; body: string | null; meta: Record<string, unknown>;
  created_by: string | null; created_at: string | null;
  task_id: string; title: string; parent: string | null;
}
interface PersonRow {
  actor: string; tracked: string; percent: number; band: string; hue: string;
  open_projects: number;
}

/** The four operations views, with labels already in sentence case. */
const OPS_VIEWS = [
  { state: "blocked", label: "Blocked" },
  { state: "awaiting", label: "Awaiting" },
  { state: "paused", label: "Paused" },
  { state: "active", label: "Active" },
] as const;

const HUES: Record<string, AccentHue> = {
  blocked: "red", awaiting: "red", paused: "amber", in_progress: "blue",
  at_risk: "amber", total: "gray", not_started: "gray",
};

export default function ControlCenterPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [attention, setAttention] = useState<{ rows: AttentionRow[]; total: number; basis: string } | null>(null);
  const [pipeline, setPipeline] = useState<{ rows: StageRow[]; unstaged: number; basis: string } | null>(null);
  const [blockers, setBlockers] = useState<{ rows: BlockerRow[]; blockers: number; projects: number; basis: string } | null>(null);
  const [workload, setWorkload] = useState<{ rows: PersonRow[]; basis: string } | null>(null);
  const [feed, setFeed] = useState<{ rows: ActivityRow[]; basis: string } | null>(null);
  /** History only by default — comments are talk, activities are the record (§32). */
  const [withTalk, setWithTalk] = useState(false);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  const load = useCallback(async () => {
    const j = (p: string) =>
      fetch(`/api/projects/ops/${p}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null));
    const [s, a, pl, b, w, f] = await Promise.all([
      j("summary"), j("attention?limit=8"), j("pipeline"),
      j("blockers/breakdown"), j("workload?period=week"),
      j(`activity?limit=12&discussion=${withTalk}`),
    ]);
    setSummary(s); setAttention(a); setPipeline(pl); setBlockers(b); setWorkload(w);
    setFeed(f);
    setLoading(false);
  }, [withTalk]);

  useEffect(() => {
    const run = async () => { await load(); };
    void run();
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const tiles = summary
    ? [
        { key: "total", label: "Active projects", value: summary.total },
        { key: "in_progress", label: "In progress", value: summary.in_progress },
        { key: "blocked", label: "Blocked", value: summary.blocked },
        { key: "awaiting", label: "Awaiting client", value: summary.awaiting_client },
        { key: "paused", label: "Paused", value: summary.paused },
        { key: "at_risk", label: "Overdue", value: summary.overdue },
      ]
    : [];

  const ring = ringSegments(pipeline?.rows ?? []);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
        <h1 className="shrink-0 text-xs font-medium text-muted-foreground">Control Center</h1>
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          What needs attention, and who is waiting
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="sm" icon="ListTodo" onClick={() => router.push("/projects/my-work")}>
            My work
          </Button>
          <Button variant="ghost" size="sm" icon="LayoutGrid" onClick={() => router.push("/projects")}>
            Board
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {/* ── KPI row ─────────────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          {loading
            ? Array.from({ length: 6 }, (_, i) => <SkeletonRows key={i} rows={1} height="h-[68px]" />)
            : tiles.map((t) => {
                const accent = accentForHue(HUES[t.key] ?? "gray");
                return (
                  <div key={t.key} className="rounded-lg border border-border bg-card p-3">
                    <div className="flex items-center gap-1.5">
                      <span className={`h-1.5 w-1.5 rounded-full ${accent.dot}`} />
                      <p className="truncate text-[11px] text-muted-foreground">{t.label}</p>
                    </div>
                    <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
                      {t.value}
                    </p>
                  </div>
                );
              })}
        </div>
        {summary ? (
          <p className="mt-1.5 text-[11px] text-muted-foreground">{summary.basis}</p>
        ) : null}

        {/* ── Attention ───────────────────────────────────────────────────── */}
        <section className="mt-4 rounded-lg border border-border bg-card">
          <header className="flex items-baseline gap-2 border-b border-border px-3 py-2">
            <h2 className="text-xs font-semibold text-foreground">Needs attention</h2>
            {attention ? (
              <span className="text-[11px] text-muted-foreground">
                {attention.total} of {summary?.total ?? "—"}
              </span>
            ) : null}
          </header>
          {loading ? (
            <div className="p-3"><SkeletonRows rows={4} height="h-10" /></div>
          ) : !attention?.rows.length ? (
            <p className="p-6 text-center text-xs text-muted-foreground">
              Nothing is flagged. Everything is moving.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] text-muted-foreground">
                    <th className="px-3 py-1.5 font-medium">Project</th>
                    <th className="px-3 py-1.5 font-medium">Why</th>
                    <th className="px-3 py-1.5 font-medium">Waiting on</th>
                    <th className="px-3 py-1.5 font-medium">Age</th>
                    <th className="px-3 py-1.5 font-medium">Next action</th>
                  </tr>
                </thead>
                <tbody>
                  {attention.rows.map((r) => (
                    <tr
                      key={r.id}
                      onClick={() => router.push(`/projects?task=${r.id}`)}
                      className="cursor-pointer border-b border-border last:border-0 hover:bg-muted tech-transition"
                    >
                      <td className="max-w-[240px] px-3 py-2">
                        <p className="truncate text-foreground">{r.title}</p>
                        {r.parent ? (
                          <p className="truncate text-[11px] text-muted-foreground">{r.parent}</p>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {r.signals.map((s) => {
                            const a = accentForHue(
                              (SIGNAL_LABELS[s]?.hue ?? "gray") as AccentHue,
                            );
                            return (
                              <span key={s} className={`rounded px-1.5 py-0.5 text-[10px] ${a.soft} ${a.text}`}>
                                {SIGNAL_LABELS[s]?.label ?? s}
                              </span>
                            );
                          })}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                        {r.waiting_on ?? "—"}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 tabular-nums text-muted-foreground">
                        {r.blocked_days === null ? "—" : `${r.blocked_days}d`}
                      </td>
                      <td className="max-w-[220px] px-3 py-2">
                        {r.next_action ? (
                          <span className="truncate text-muted-foreground">{r.next_action}</span>
                        ) : (
                          <span className="text-warning">None set</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <div className="mt-4 grid gap-3 lg:grid-cols-3">
          {/* ── Pipeline ──────────────────────────────────────────────────── */}
          <section className="rounded-lg border border-border bg-card p-3">
            <h2 className="mb-2 text-xs font-semibold text-foreground">Pipeline</h2>
            {loading ? (
              <SkeletonRows rows={1} height="h-32" />
            ) : (
              <div className="flex items-center gap-4">
                {/* Inline SVG ring — no chart library (plan §0.4). One circle
                    per segment, offset by the running total. */}
                <svg viewBox="0 0 42 42" className="h-24 w-24 shrink-0 -rotate-90">
                  <circle cx="21" cy="21" r="15.9" fill="none" strokeWidth="5"
                    className="stroke-muted" />
                  {ring.map((seg) => (
                    <circle
                      key={seg.id}
                      cx="21" cy="21" r="15.9" fill="none" strokeWidth="5"
                      // `currentColor` + the `--cat-N` slot below: the ramp is
                      // a custom property, and SVG `stroke` takes no Tailwind
                      // token class. `StatusAccent` has no stroke member and
                      // inventing one would be a second colour vocabulary.
                      stroke="currentColor"
                      strokeDasharray={`${seg.pct} ${100 - seg.pct}`}
                      strokeDashoffset={`${-seg.offset}`}
                      style={{ color: `var(--cat-${seg.slot})` }}
                    />
                  ))}
                </svg>
                <ul className="min-w-0 flex-1 space-y-0.5">
                  {/* Every stage, including empty ones — "nothing has reached
                      Validation" is information the ring cannot show. */}
                  {(pipeline?.rows ?? []).map((s, i) => (
                    <li key={s.id} className="flex items-center gap-1.5 text-[11px]">
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ background: `var(--cat-${(i % 8) + 1})` }}
                      />
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">{s.name}</span>
                      <span className="tabular-nums text-foreground">{s.count}</span>
                    </li>
                  ))}
                  {pipeline?.unstaged ? (
                    <li className="flex items-center gap-1.5 pt-0.5 text-[11px]">
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">No stage</span>
                      <span className="tabular-nums text-foreground">{pipeline.unstaged}</span>
                    </li>
                  ) : null}
                </ul>
              </div>
            )}
          </section>

          {/* ── Workload ──────────────────────────────────────────────────── */}
          <section className="rounded-lg border border-border bg-card p-3">
            <div className="mb-2 flex items-baseline gap-2">
              <h2 className="text-xs font-semibold text-foreground">Team workload</h2>
              <button type="button" onClick={() => router.push("/projects/workload")}
                className="ml-auto text-[11px] text-primary hover:underline">All</button>
            </div>
            {loading ? (
              <SkeletonRows rows={4} height="h-8" />
            ) : !workload?.rows.length ? (
              <p className="py-6 text-center text-xs text-muted-foreground">
                Nobody has work assigned.
              </p>
            ) : (
              <ul className="space-y-2">
                {workload.rows.slice(0, 6).map((p) => (
                  <li key={p.actor}>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="min-w-0 truncate text-[11px] text-foreground">
                        {shortName(p.actor)}
                      </span>
                      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                        {p.tracked} · {p.open_projects} open
                      </span>
                    </div>
                    <Progress value={p.percent} hue={p.hue as AccentHue} />
                  </li>
                ))}
              </ul>
            )}
            {workload ? (
              <p className="mt-2 text-[10px] leading-tight text-muted-foreground">{workload.basis}</p>
            ) : null}
          </section>

          {/* ── Blockers ──────────────────────────────────────────────────── */}
          <section className="rounded-lg border border-border bg-card p-3">
            <h2 className="mb-2 text-xs font-semibold text-foreground">Blocked by reason</h2>
            {loading ? (
              <SkeletonRows rows={3} height="h-8" />
            ) : !blockers?.rows.length ? (
              <p className="py-6 text-center text-xs text-muted-foreground">
                No blockers. Everything is moving.
              </p>
            ) : (
              <ul className="space-y-2">
                {blockers.rows.map((b) => {
                  const max = Math.max(...blockers.rows.map((x) => x.blockers), 1);
                  return (
                    <li key={b.kind}>
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="min-w-0 truncate text-[11px] text-foreground">
                          {SIGNAL_LABELS[b.kind]?.label ?? b.kind.replace(/_/g, " ")}
                        </span>
                        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                          {b.blockers}
                          {b.oldest_days !== null ? ` · oldest ${b.oldest_days}d` : ""}
                        </span>
                      </div>
                      <Progress value={(b.blockers / max) * 100} hue="red" />
                    </li>
                  );
                })}
              </ul>
            )}
            {blockers ? (
              <p className="mt-2 text-[10px] leading-tight text-muted-foreground">{blockers.basis}</p>
            ) : null}
          </section>
        </div>

        {/* ── Recent activity ─────────────────────────────────────────────
            Rendered through `describeActivity`, the SAME formatter the task
            panel uses. The plan §14 is explicit: two renderers over one event
            stream will drift, and this feed and the panel show the same rows. */}
        <section className="mt-4 rounded-lg border border-border bg-card">
          <header className="flex items-center gap-2 border-b border-border px-3 py-2">
            <h2 className="text-xs font-semibold text-foreground">Recent activity</h2>
            <Button
              variant="ghost" size="sm"
              aria-pressed={withTalk}
              onClick={() => setWithTalk((v) => !v)}
              className="ml-auto"
            >
              {withTalk ? "Hide comments" : "Show comments"}
            </Button>
          </header>
          {loading ? (
            <div className="p-3"><SkeletonRows rows={4} height="h-8" /></div>
          ) : !feed?.rows.length ? (
            <p className="p-6 text-center text-xs text-muted-foreground">
              No activity recorded yet.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {feed.rows.map((a) => {
                const look = describeActivity(a);
                const tone = accentForHue(look.hue as AccentHue);
                return (
                  <li key={a.id}>
                    <button
                      type="button"
                      onClick={() => router.push(`/projects?task=${a.task_id}`)}
                      className="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-muted tech-transition"
                    >
                      <Icon name={look.icon} size={12} className={`mt-0.5 shrink-0 ${tone.text}`} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs text-foreground">{look.text}</span>
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {a.parent ? `${a.parent} · ` : ""}{a.title}
                          {a.created_by ? ` · ${shortName(a.created_by)}` : ""}
                        </span>
                      </span>
                      {a.created_at ? (
                        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                          {new Date(a.created_at).toLocaleDateString(undefined, {
                            day: "numeric", month: "short",
                          })}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <div className="mt-4 flex flex-wrap gap-2">
          {/* ⚠️ The label is a plain string, NOT a `<span className="capitalize">`.
              `text-transform` does not cascade-merge: a `capitalize` on the child
              overrides Graphite's `uppercase` on the button, so these four
              rendered sentence-case beside an uppercase "MY WORK" and "BOARD".
              Caught by the four-theme sweep and by nothing else — the
              conformance suite checks eight regexes and none of them can see a
              control that quietly opted out of the theme's label treatment
              (DESIGN_SYSTEM §8). Capitalise the DATA, never the element. */}
          {OPS_VIEWS.map(({ state, label }) => (
            <Button
              key={state}
              variant="secondary"
              size="sm"
              icon="Filter"
              onClick={() => router.push(`/projects/ops/${state}`)}
            >
              {label}
            </Button>
          ))}
          <span className="self-center text-[11px] text-muted-foreground">
            <Icon name="Info" size={11} className="mr-1 inline" />
            Operations views
          </span>
        </div>
      </div>
    </div>
  );
}
