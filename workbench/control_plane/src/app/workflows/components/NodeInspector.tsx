"use client";

/**
 * The inspector pane — typed config fields for the selected node (RFC §5.3).
 * Fields that accept upstream data take `{{node.field}}` references; the
 * available roots are shown as hint chips (trigger, vars, upstream node ids).
 */

import { useCallback } from "react";
import { Trash2 } from "lucide-react";
import type {
  Catalog,
  GraphIssue,
  NodeType,
  TriggerKind,
  WorkflowGraphNode,
} from "../lib/types";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
        {label}
      </span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

const inputCls =
  "w-full rounded-lg border border-input bg-background px-2.5 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring";

function JsonField({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (v: Record<string, unknown>) => void;
}) {
  return (
    <textarea
      defaultValue={JSON.stringify(value ?? {}, null, 2)}
      onBlur={(e) => {
        try {
          const parsed = JSON.parse(e.target.value || "{}");
          if (parsed && typeof parsed === "object") onChange(parsed);
        } catch {
          /* keep the previous value on bad JSON; the field shows the draft */
        }
      }}
      rows={5}
      spellCheck={false}
      className={`${inputCls} font-mono text-[11px]`}
    />
  );
}

const WAIT_UNITS: { id: string; label: string; secs: number }[] = [
  { id: "seconds", label: "seconds", secs: 1 },
  { id: "minutes", label: "minutes", secs: 60 },
  { id: "hours", label: "hours", secs: 3600 },
  { id: "days", label: "days", secs: 86400 },
];

/** Duration editor over a single `seconds` config value: the unit is display
 * only (the largest that divides evenly), so the graph stays one number. */
function WaitDuration({
  seconds,
  onChange,
}: {
  seconds: unknown;
  onChange: (v: number) => void;
}) {
  const total = Number(seconds);
  const safe = Number.isFinite(total) && total > 0 ? total : 0;
  const unit =
    [...WAIT_UNITS].reverse().find((u) => safe >= u.secs && safe % u.secs === 0) ??
    WAIT_UNITS[0];
  const amount = safe ? safe / unit.secs : "";

  return (
    <div className="flex gap-1.5">
      <input
        type="number"
        min={1}
        value={amount}
        onChange={(e) => {
          const n = Number(e.target.value);
          onChange(Number.isFinite(n) && n > 0 ? n * unit.secs : 0);
        }}
        className={`${inputCls} w-24`}
      />
      <select
        value={unit.id}
        onChange={(e) => {
          const next = WAIT_UNITS.find((u) => u.id === e.target.value);
          if (next && amount) onChange(Number(amount) * next.secs);
        }}
        className={inputCls}
      >
        {WAIT_UNITS.map((u) => (
          <option key={u.id} value={u.id}>
            {u.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export default function NodeInspector({
  node,
  catalog,
  upstreamIds,
  issues,
  triggerKinds,
  onConfig,
  onLabel,
  onDelete,
}: {
  node: WorkflowGraphNode | null;
  catalog: Catalog | null;
  upstreamIds: string[];
  issues: GraphIssue[];
  triggerKinds: { kind: TriggerKind; hint: string }[];
  onConfig: (patch: Record<string, unknown>) => void;
  onLabel: (label: string) => void;
  onDelete: () => void;
}) {
  const set = useCallback(
    (key: string, value: unknown) => onConfig({ [key]: value }),
    [onConfig],
  );

  if (!node) {
    return (
      <div className="w-64 xl:w-72 shrink-0 border-l border-border p-4">
        <p className="text-xs text-muted-foreground">
          Select a node to configure it. Fields accept{" "}
          <code className="text-[10px] bg-secondary px-1 rounded">
            {"{{trigger.field}}"}
          </code>{" "}
          and{" "}
          <code className="text-[10px] bg-secondary px-1 rounded">
            {"{{node_id.field}}"}
          </code>{" "}
          references to upstream data.
        </p>
      </div>
    );
  }

  const cfg = node.data.config as Record<string, unknown>;
  const type = node.type as NodeType;
  const nodeIssues = issues.filter((i) => i.node_id === node.id);

  return (
    <div className="w-64 xl:w-72 shrink-0 border-l border-border overflow-y-auto scrollbar-thin">
      <div className="p-3 border-b border-border flex items-center justify-between">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-foreground truncate">
            {node.data.label || type}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {type} · <span className="font-mono">{node.id}</span>
          </div>
        </div>
        {type !== "trigger" && (
          <button
            onClick={onDelete}
            title="Delete node"
            className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-secondary tech-transition"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {nodeIssues.length > 0 && (
        <div className="p-3 border-b border-border space-y-1">
          {nodeIssues.map((issue, i) => (
            <p key={i} className="text-[10px] text-warning">
              ⚠ {issue.message}
            </p>
          ))}
        </div>
      )}

      <div className="p-3 space-y-3">
        <Field label="Label">
          <input
            value={node.data.label}
            onChange={(e) => onLabel(e.target.value)}
            className={inputCls}
          />
        </Field>

        {type === "trigger" && (
          <>
            <Field label="Trigger kinds">
              <p className="text-[10px] text-muted-foreground">
                Configure triggers (webhook URL, schedule, …) from the
                topbar&apos;s Triggers panel. The trigger&apos;s payload is
                available downstream as <code>{"{{trigger.*}}"}</code>.
              </p>
            </Field>
            <div className="space-y-1">
              {triggerKinds.map((t) => (
                <div key={t.kind} className="text-[10px] text-muted-foreground">
                  <span className="font-medium text-foreground">{t.kind}</span>{" "}
                  — {t.hint}
                </div>
              ))}
            </div>
          </>
        )}

        {type === "agent" && (
          <>
            <Field label="Agent">
              <select
                value={String(cfg.agent ?? "")}
                onChange={(e) => set("agent", e.target.value)}
                className={inputCls}
              >
                <option value="">Select an agent…</option>
                {(catalog?.agents ?? []).map((a) => (
                  <option key={a.name} value={a.name}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Message">
              <textarea
                value={String(cfg.message ?? "")}
                onChange={(e) => set("message", e.target.value)}
                rows={5}
                placeholder="Classify this email: {{trigger.body}}"
                className={inputCls}
              />
            </Field>
            <Field label="Model tier (optional)">
              <input
                value={String(cfg.model ?? "")}
                onChange={(e) => set("model", e.target.value)}
                placeholder="tier-balanced"
                className={inputCls}
              />
            </Field>
          </>
        )}

        {type === "tool" && (
          <>
            <Field label="Action">
              <select
                value={String(cfg.action ?? "")}
                onChange={(e) => set("action", e.target.value)}
                className={inputCls}
              >
                <option value="">Select an action…</option>
                {(catalog?.tools ?? []).map((t) => (
                  <option key={t.action} value={t.action}>
                    {t.label}
                    {t.destructive ? " (write)" : ""}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Arguments (JSON, {{refs}} allowed)">
              <JsonField
                key={`${node.id}:args`}
                value={cfg.args}
                onChange={(v) => set("args", v)}
              />
            </Field>
          </>
        )}

        {type === "module" && (
          <>
            <Field label="Module">
              <select
                value={String(cfg.module_id ?? "")}
                onChange={(e) => set("module_id", e.target.value)}
                className={inputCls}
              >
                <option value="">Select a module…</option>
                {(catalog?.modules ?? [])
                  .filter((m) => m.status === "ready")
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Inputs (JSON, {{refs}} allowed)">
              <JsonField
                key={`${node.id}:inputs`}
                value={cfg.inputs}
                onChange={(v) => set("inputs", v)}
              />
            </Field>
          </>
        )}

        {type === "condition" && (
          <>
            <Field label="Left value">
              <input
                value={String(cfg.left ?? "")}
                onChange={(e) => set("left", e.target.value)}
                placeholder="{{classify.result}}"
                className={inputCls}
              />
            </Field>
            <Field label="Operator">
              <select
                value={String(cfg.op ?? "equals")}
                onChange={(e) => set("op", e.target.value)}
                className={inputCls}
              >
                {(catalog?.condition_ops ?? ["equals"]).map((op) => (
                  <option key={op} value={op}>
                    {op}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Right value">
              <input
                value={String(cfg.right ?? "")}
                onChange={(e) => set("right", e.target.value)}
                placeholder="lead"
                className={inputCls}
              />
            </Field>
          </>
        )}

        {type === "set" && (
          <Field label="Assignments (name → value, {{refs}} allowed)">
            <JsonField
              key={`${node.id}:assignments`}
              value={cfg.assignments}
              onChange={(v) => set("assignments", v)}
            />
          </Field>
        )}

        {type === "approval" && (
          <Field label="Message for the approver">
            <textarea
              value={String(cfg.message ?? "")}
              onChange={(e) => set("message", e.target.value)}
              rows={3}
              placeholder="OK to create the CRM record for {{trigger.company}}?"
              className={inputCls}
            />
            <p className="text-[10px] text-muted-foreground mt-1">
              The run pauses here and appears in the Approvals inbox. Approving
              resumes it; rejecting cancels it.
            </p>
          </Field>
        )}

        {type === "wait" && (
          <Field label="Wait for">
            <WaitDuration
              seconds={cfg.seconds}
              onChange={(v) => set("seconds", v)}
            />
            <p className="text-[10px] text-muted-foreground mt-1">
              Up to a minute runs inline. Anything longer parks the run with a
              deadline — it survives a restart and resumes on schedule.
            </p>
          </Field>
        )}

        {type === "output" && (
          <Field label="Value ({{refs}} allowed)">
            <textarea
              value={String(cfg.value ?? "")}
              onChange={(e) => set("value", e.target.value)}
              rows={3}
              placeholder="{{final_step.result}}"
              className={inputCls}
            />
          </Field>
        )}

        {type !== "trigger" && (
          <div>
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
              Available references
            </span>
            <div className="mt-1 flex flex-wrap gap-1">
              {["trigger", "vars", ...upstreamIds].map((root) => (
                <code
                  key={root}
                  className="text-[9px] bg-secondary text-foreground px-1.5 py-0.5 rounded"
                >
                  {`{{${root}.*}}`}
                </code>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
