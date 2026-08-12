"use client";

/**
 * The operations state of a project — stage, health, next action, blocker, time.
 *
 * Spec: `ProjectApp_Plan.md` §17 (project detail) · data: WS-27bg + WS-27bn.
 *
 * ## Why this is a block inside `TaskPanel` and not a new detail PAGE
 *
 * The plan's §17 describes a full-page project detail with six tabs, and
 * building one would mean **a second detail surface** — the same trap that
 * produced two things called "My Work" (D-OPEN-12). `TaskPanel` already IS the
 * project detail here: it is what the board, the list, the table, the calendar
 * and the timeline all open, it already carries description, assignees, tags,
 * custom fields, relations, recurrence and the comment timeline, and it is
 * already reachable at `?task=<id>` as a deep link.
 *
 * So the operations data lands where people already look. Everything migration
 * 171 added was, until this file, visible only to SQL.
 *
 * The tabbed page is not refused, just not built twice: if a full page is
 * wanted later it should render this block, not re-implement it.
 */

import { useCallback, useEffect, useState } from "react";

import { Select } from "@/components/ui/Input";
import Progress from "@/components/ui/Progress";
import { type AccentHue, accentForHue } from "@/lib/statusAccent";

import { SIGNAL_LABELS, shortName } from "../home/lib/dashboard";
import { StageGantt } from "./StageGantt";

interface Stage { id: string; name: string; position: number }
interface Blocker {
  id: string; kind: string; title: string; waiting_on: string | null;
  owner: string | null; created_at: string; open: boolean;
}
interface Sessions {
  total_seconds: number; total_elapsed: string;
  rows: Array<{ id: string; actor: string; elapsed: string; running: boolean }>;
}

export interface OperationsBlockProps {
  taskId: string;
  rootProjectId: string;
  stageId: string | null;
  health: string | null;
  nextAction: string | null;
  nextActionOwner: string | null;
  estimateMins: number | null;
  /** Fired after any mutation so the panel can refetch the task. */
  onChanged?: () => void;
}

/** Model values → display labels. The model keeps `at_risk`; humans read "At risk". */
const HEALTH: Array<{ value: string; label: string; hue: AccentHue }> = [
  { value: "", label: "Not assessed", hue: "gray" },
  { value: "healthy", label: "Healthy", hue: "green" },
  { value: "at_risk", label: "At risk", hue: "amber" },
  { value: "critical", label: "Critical", hue: "red" },
];

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 py-1">
      <span className="w-24 shrink-0 pt-0.5 text-[11px] text-muted-foreground">{label}</span>
      <div className="min-w-0 flex-1 text-xs text-foreground">{children}</div>
    </div>
  );
}

export function OperationsBlock({
  taskId, rootProjectId, stageId, health, nextAction, nextActionOwner,
  estimateMins, onChanged,
}: OperationsBlockProps) {
  const [stages, setStages] = useState<Stage[]>([]);
  const [blockers, setBlockers] = useState<Blocker[]>([]);
  const [sessions, setSessions] = useState<Sessions | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * The instant blocker ages are measured against.
   *
   * ⚠️ NOT `Date.now()` in the render body — that is an impure call
   * (`react-hooks/purity`), and it makes every row's age recompute on any
   * unrelated re-render, so two rows drawn a tick apart can disagree. Captured
   * once here and refreshed when the data reloads, which is the only moment
   * the ages can actually have changed.
   */
  const [at, setAt] = useState(() => Date.now());

  const load = useCallback(async () => {
    const j = (p: string) =>
      fetch(`/api/projects${p}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null));
    const [s, b, t] = await Promise.all([
      j(`/nodes/${rootProjectId}/stages`),
      j(`/tasks/${taskId}/blockers`),
      j(`/tasks/${taskId}/work/sessions`),
    ]);
    if (s?.rows) setStages(s.rows);
    if (b?.rows) setBlockers(b.rows);
    if (t) setSessions(t);
    setAt(Date.now());
  }, [taskId, rootProjectId]);

  useEffect(() => {
    const run = async () => { await load(); };
    void run();
    const onChange = () => load();
    window.addEventListener("cc-work-session-changed", onChange);
    return () => window.removeEventListener("cc-work-session-changed", onChange);
  }, [load]);

  const patch = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await fetch(`/api/projects/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  const open = blockers.filter((b) => b.open);
  const healthHue = HEALTH.find((h) => h.value === (health ?? ""))?.hue ?? "gray";
  const spentSecs = sessions?.total_seconds ?? 0;
  const estimateSecs = (estimateMins ?? 0) * 60;

  return (
    <div className="flex flex-col gap-1">
      {/* Stage — the second axis, and the only place in the UI it is editable.
          Sourced from `pm_stages` for THIS project's root, so a project with a
          different pipeline offers different stages. */}
      <Row label="Stage">
        <Select
          inputSize="sm"
          value={stageId ?? ""}
          disabled={busy || stages.length === 0}
          onChange={(e) => patch({ stage_id: e.target.value || null })}
        >
          <option value="">No stage</option>
          {stages.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </Select>
      </Row>

      {/* Health — NULL is "not assessed" and is deliberately distinct from
          healthy. A human's judgement always beats the derived rule
          (`operations.derive_health`), which is why this is editable at all. */}
      <Row label="Health">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${accentForHue(healthHue).dot}`} />
          <Select
            inputSize="sm"
            value={health ?? ""}
            disabled={busy}
            onChange={(e) => patch({ health: e.target.value || null })}
          >
            {HEALTH.map((h) => (
              <option key={h.value} value={h.value}>{h.label}</option>
            ))}
          </Select>
        </div>
      </Row>

      <Row label="Next action">
        {nextAction ? (
          <div>
            <p className="text-foreground">{nextAction}</p>
            {nextActionOwner ? (
              <p className="text-[11px] text-muted-foreground">
                {shortName(nextActionOwner)}
              </p>
            ) : null}
          </div>
        ) : (
          // Not a neutral dash: a project with no next move is a project that
          // stops silently, and the attention score already flags it.
          <span className="text-warning">None set</span>
        )}
      </Row>

      <Row label="Blocker">
        {open.length === 0 ? (
          <span className="text-muted-foreground">None</span>
        ) : (
          <ul className="space-y-1">
            {open.map((b) => {
              const hue = (SIGNAL_LABELS[b.kind]?.hue ?? "gray") as AccentHue;
              const a = accentForHue(hue);
              const days = Math.floor((at - new Date(b.created_at).getTime()) / 86_400_000);
              return (
                <li key={b.id} className="flex flex-wrap items-center gap-1.5">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] ${a.soft} ${a.text}`}>
                    {SIGNAL_LABELS[b.kind]?.label ?? b.kind}
                  </span>
                  <span className="min-w-0 truncate">{b.title}</span>
                  {b.waiting_on ? (
                    <span className="text-[11px] text-muted-foreground">
                      · waiting on {b.waiting_on}
                    </span>
                  ) : null}
                  <span className={`text-[11px] tabular-nums ${days >= 7 ? "text-destructive" : "text-muted-foreground"}`}>
                    · {days}d
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Row>

      {/* Time — actual against estimate. Actual is the SUM of closed sessions,
          which is the server's number; nothing here adds anything up. */}
      <Row label="Stage history">
        <StageGantt taskId={taskId} />
      </Row>

      <Row label="Time">
        <div>
          <p className="tabular-nums">
            {sessions?.total_elapsed ?? "0s"}
            {estimateMins ? (
              <span className="text-muted-foreground">
                {" "}of {Math.round(estimateMins / 60)}h estimated
              </span>
            ) : (
              <span className="text-muted-foreground"> · no estimate</span>
            )}
          </p>
          {estimateSecs > 0 ? (
            <Progress
              className="mt-1"
              value={(spentSecs / estimateSecs) * 100}
              hue={spentSecs > estimateSecs * 1.25 ? "amber" : "blue"}
            />
          ) : null}
          {sessions?.rows.length ? (
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {sessions.rows.length} session{sessions.rows.length === 1 ? "" : "s"}
              {" · "}
              {[...new Set(sessions.rows.map((r) => shortName(r.actor)))].join(", ")}
            </p>
          ) : null}
        </div>
      </Row>
    </div>
  );
}

/** The panel header's compact operations summary: stage · health · blocker age. */
export function OperationsChips({
  stageName, health, blockedDays,
}: {
  stageName: string | null;
  health: string | null;
  blockedDays: number | null;
}) {
  const items: Array<{ key: string; label: string; hue: AccentHue }> = [];
  if (stageName) items.push({ key: "stage", label: stageName, hue: "blue" });
  if (health) {
    const h = HEALTH.find((x) => x.value === health);
    if (h) items.push({ key: "health", label: h.label, hue: h.hue });
  }
  if (blockedDays !== null) {
    items.push({
      key: "blocked",
      label: `Blocked ${blockedDays}d`,
      hue: blockedDays >= 7 ? "red" : "amber",
    });
  }
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {items.map((i) => {
        const a = accentForHue(i.hue);
        return (
          <span key={i.key} className={`rounded px-1.5 py-0.5 text-[10px] ${a.soft} ${a.text}`}>
            {i.label}
          </span>
        );
      })}
    </div>
  );
}

export default OperationsBlock;
