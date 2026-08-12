"use client";

/**
 * Team workload — who is carrying what, and against what capacity.
 *
 * Spec: `ProjectApp_Plan.md` §18 (SCREEN 5) · data: `/ops/workload`.
 *
 * ## Why `/projects/workload` and not `/projects/people`
 *
 * **`/people` already exists** — the People Center (WS-28): directory, org
 * chart, skills. A second surface called People would be D-OPEN-12 repeating,
 * and this one answers a different question: not *who works here* but *who is
 * over capacity this week*. Named for the question it answers.
 *
 * ## The number and its basis, never the number alone
 *
 * Every row says whether its capacity was STATED or ASSUMED (migration 173).
 * A percentage over an invented denominator is the thing this screen exists to
 * stop being, so a row falling back to the default says so in place rather
 * than in a footnote — acceptance 39.
 *
 * Nothing is computed here. `/ops/workload` counts open, overdue and blocked in
 * one SQL pass so the three cannot disagree.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import Icon from "@/components/Icon";
import Button from "@/components/ui/Button";
import Progress from "@/components/ui/Progress";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { type AccentHue, accentForHue } from "@/lib/statusAccent";

import { personLabel } from "../home/lib/dashboard";

interface PersonRow {
  actor: string; name?: string | null; seconds: number; tracked: string;
  capacity_hours: number; capacity_assumed: boolean;
  percent: number; band: string; hue: string;
  open_projects: number; overdue: number; blocked: number;
}

const BAND_LABEL: Record<string, string> = {
  over: "Over capacity",
  high: "High",
  healthy: "Healthy",
  light: "Light",
  // Distinct from Light on purpose — see `operations.UNTRACKED`. Saying "no
  // time logged" is a fact; saying "Light" about somebody carrying nine
  // projects is a claim the data does not support.
  untracked: "No time logged",
};

export default function WorkloadPage() {
  const [rows, setRows] = useState<PersonRow[]>([]);
  const [basis, setBasis] = useState("");
  const [period, setPeriod] = useState<"day" | "week">("week");
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/projects/ops/workload?period=${period}`, { cache: "no-store" });
    if (res.ok) {
      const d = await res.json();
      setRows(d.rows ?? []);
      setBasis(d.basis ?? "");
    }
    setLoading(false);
  }, [period]);

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

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
        <h1 className="shrink-0 text-xs font-medium text-muted-foreground">Workload</h1>
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          Who is carrying what, against the capacity they have
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {(["day", "week"] as const).map((p) => (
            <Button key={p} variant={period === p ? "secondary" : "ghost"} size="sm"
              aria-pressed={period === p} onClick={() => setPeriod(p)}>
              {p === "day" ? "Today" : "This week"}
            </Button>
          ))}
          <Button variant="ghost" size="sm" icon="LayoutDashboard"
            onClick={() => router.push("/projects/home")}>Control Center</Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {loading ? (
          <SkeletonRows rows={5} height="h-20" />
        ) : rows.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2">
            <Icon name="Users" size={22} className="text-muted-foreground" />
            <p className="text-xs text-muted-foreground">Nobody has work assigned.</p>
          </div>
        ) : (
          <ul className="space-y-2">
            {rows.map((p) => {
              const tone = accentForHue(p.hue as AccentHue);
              return (
                <li key={p.actor} className="rounded-lg border border-border bg-card p-3">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-sm font-medium text-foreground">{personLabel(p)}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] ${tone.soft} ${tone.text}`}>
                      {BAND_LABEL[p.band] ?? p.band}
                    </span>
                    <span className="ml-auto text-sm tabular-nums text-foreground">
                      {p.percent}%
                    </span>
                  </div>

                  <Progress className="mt-1.5" value={p.percent} hue={p.hue as AccentHue} height="h-2" />

                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    <span className="tabular-nums">
                      {p.tracked} of {p.capacity_hours}h
                    </span>
                    {/* The basis, per row. A guessed denominator that does not
                        say so is what this screen exists to stop being. */}
                    {p.capacity_assumed ? (
                      <span className="flex items-center gap-1 text-warning">
                        <Icon name="TriangleAlert" size={11} />
                        capacity assumed — none set for this person
                      </span>
                    ) : (
                      <span className="text-success">stated capacity</span>
                    )}
                    <span className="tabular-nums">· {p.open_projects} open</span>
                    {p.overdue > 0 ? (
                      <span className="tabular-nums text-destructive">· {p.overdue} overdue</span>
                    ) : null}
                    {p.blocked > 0 ? (
                      <span className="tabular-nums text-destructive">· {p.blocked} blocked</span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {basis ? <p className="mt-3 text-[11px] text-muted-foreground">{basis}</p> : null}
      </div>
    </div>
  );
}
