"use client";

/**
 * Projects · the bulk-edit bar (WS-27n).
 *
 * Appears only when something is selected, and disappears the moment nothing
 * is — a permanently-present bar of controls that mostly do nothing is a bar
 * people learn to ignore.
 *
 * **Every control is add/remove or set-one-field; none is a replace.** "Assign
 * these to Priya" means *also* Priya, and a replace across a selection would
 * wipe every individual assignment the selected tasks already carried.
 *
 * **Status is offered by NAME**, from the statuses of the project on screen.
 * A selection can span projects, so the gateway resolves the name against each
 * task's own root and reports per task when a project has no such lane — which
 * is why the outcome line names failures rather than the button pretending.
 */

import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useState } from "react";

import type { StatusRow } from "../lib/api";
import { type BulkDraft, EMPTY_DRAFT, buildRequest } from "../lib/selection";

const SELECT =
  "cc-control rounded-lg border border-border bg-background px-2 py-1.5 " +
  "text-xs text-foreground outline-none focus:border-primary/50";

const IMPORTANCE = [
  ["", "Priority…"],
  ["3", "Urgent"],
  ["2", "High"],
  ["1", "Normal"],
  ["0", "Low"],
] as const;

interface Props {
  count: number;
  statuses: StatusRow[];
  busy: boolean;
  onClear: () => void;
  onApply: (request: ReturnType<typeof buildRequest>) => void;
  /** The last outcome sentence, or null. */
  notice: string | null;
}

export function BulkBar({ count, statuses, busy, onClear, onApply, notice }: Props) {
  const [draft, setDraft] = useState<BulkDraft>(EMPTY_DRAFT);
  const request = buildRequest(Array.from({ length: count }, (_, i) => `#${i}`), draft);

  const set = (patch: Partial<BulkDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));

  return (
    <div className="border-b border-border bg-muted px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="primary">{count} selected</Badge>

        <select
          aria-label="Set status"
          className={SELECT}
          value={draft.status}
          onChange={(e) => set({ status: e.target.value })}
        >
          <option value="">Status…</option>
          {/* De-duplicated by NAME: a selection can span projects whose lanes
              share names, and offering "Done" twice is a choice with no
              difference. */}
          {[...new Set(statuses.map((s) => s.name))].map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>

        <select
          aria-label="Set priority"
          className={SELECT}
          value={draft.importance}
          onChange={(e) => set({ importance: e.target.value })}
        >
          {IMPORTANCE.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>

        <Input
          inputSize="sm"
          className="w-40"
          aria-label="Assign to"
          placeholder="Assign to…"
          value={draft.assigneeAdd}
          onChange={(e) => set({ assigneeAdd: e.target.value })}
        />
        <Input
          inputSize="sm"
          className="w-40"
          aria-label="Unassign"
          placeholder="Unassign…"
          value={draft.assigneeRemove}
          onChange={(e) => set({ assigneeRemove: e.target.value })}
        />
        <Input
          inputSize="sm"
          className="w-32"
          aria-label="Add tags"
          placeholder="Add tags…"
          value={draft.tagAdd}
          onChange={(e) => set({ tagAdd: e.target.value })}
        />
        <Input
          inputSize="sm"
          className="w-32"
          aria-label="Remove tags"
          placeholder="Remove tags…"
          value={draft.tagRemove}
          onChange={(e) => set({ tagRemove: e.target.value })}
        />

        <Button
          size="sm"
          loading={busy}
          // Disabled rather than firing and being told 422: the gateway
          // refuses a no-op, and a button that can only fail is worse than one
          // that says it is not ready.
          disabled={!request}
          title={request ? undefined : "Choose something to change first"}
          onClick={() => {
            onApply(request);
            setDraft(EMPTY_DRAFT);
          }}
        >
          Apply to {count}
        </Button>
        <Button variant="ghost" size="sm" icon="X" onClick={onClear}>
          Clear
        </Button>
      </div>

      {notice ? (
        <p className="mt-1 text-xs text-muted-foreground">{notice}</p>
      ) : null}
    </div>
  );
}
