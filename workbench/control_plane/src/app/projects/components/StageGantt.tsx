"use client";

/**
 * The stage Gantt — how long a project actually spent in each stage.
 *
 * Spec: `ProjectApp_Plan.md` §21 (S15) · data: `/tasks/{id}/stage-history`.
 *
 * ## Actual, not planned
 *
 * Plan §26 lists `pm_stages.planned_start` / `planned_end` as the schema this
 * needs. **It was not added**, and the endpoint explains why: a planned date is
 * a column somebody must maintain, and the first week nobody does, the chart
 * shows a plan that never happened and stops being read. `stage_change`
 * activities already record every real transition, so the chart IS the history
 * and cannot go stale.
 *
 * ## Deliberately not a Gantt library
 *
 * §21: "Do not create an unnecessarily complicated Gantt implementation."
 * This is a proportional flex row — one segment per stage, width by share of
 * the elapsed total. No dependencies, no drag, no time axis. `/projects`
 * already has a real task timeline (`TimelineView`) for dependency work; this
 * answers the different question of where the time went.
 */

import { useCallback, useEffect, useState } from "react";

import { SkeletonRows } from "@/components/ui/Skeleton";

interface Segment {
  stage: string; from: string; to: string | null; days: number; current: boolean;
}

/** Stage colour is an IDENTITY, not a measurement — the `--cat-N` ramp by
 *  position, matching the Control Center's pipeline ring (AGENTS.md rule 7). */
const slot = (i: number) => `var(--cat-${(i % 8) + 1})`;

export function StageGantt({ taskId }: { taskId: string }) {
  const [rows, setRows] = useState<Segment[]>([]);
  const [basis, setBasis] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const res = await fetch(`/api/projects/tasks/${taskId}/stage-history`, { cache: "no-store" });
    if (res.ok) {
      const d = await res.json();
      setRows(d.rows ?? []);
      setBasis(d.basis ?? "");
    }
    setLoading(false);
  }, [taskId]);

  useEffect(() => {
    const run = async () => { await load(); };
    void run();
  }, [load]);

  if (loading) return <SkeletonRows rows={1} height="h-12" />;
  if (!rows.length) {
    return <p className="text-[11px] text-muted-foreground">No stage history yet.</p>;
  }

  const total = rows.reduce((n, r) => n + r.days, 0);

  return (
    <div>
      {/* ⚠️ Width falls back to an EQUAL share when nothing has elapsed yet.
          Every segment is 0 days on the day a project is created, and
          `days / 0` is NaN — which renders as a collapsed bar and looks like a
          bug rather than like a new project. Measured on the seeded data,
          where every stage legitimately reads 0d. */}
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted" role="img"
        aria-label={`Stage history: ${rows.map((r) => `${r.stage} ${r.days} days`).join(", ")}`}>
        {rows.map((r, i) => (
          <div
            key={`${r.stage}-${i}`}
            title={`${r.stage} · ${r.days}d`}
            style={{
              width: total > 0 ? `${(r.days / total) * 100}%` : `${100 / rows.length}%`,
              background: slot(i),
              // The open segment reads as unfinished rather than as a stage
              // that simply ended here.
              opacity: r.current ? 0.55 : 1,
            }}
          />
        ))}
      </div>

      <ul className="mt-1.5 space-y-0.5">
        {rows.map((r, i) => (
          <li key={`${r.stage}-legend-${i}`} className="flex items-center gap-1.5 text-[11px]">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: slot(i) }} />
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {r.stage}
              {r.current ? " · now" : ""}
            </span>
            <span className="tabular-nums text-foreground">{r.days}d</span>
          </li>
        ))}
      </ul>

      {basis ? <p className="mt-1 text-[10px] leading-tight text-muted-foreground">{basis}</p> : null}
    </div>
  );
}

export default StageGantt;
