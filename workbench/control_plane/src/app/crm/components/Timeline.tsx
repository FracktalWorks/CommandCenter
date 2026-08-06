"use client";

/**
 * The record timeline + its quick composer (specs/crm_app.md §5 surface 3).
 *
 * Newest first, with status changes and notes/tasks/calls inline — one
 * merged stream, because "what happened to this deal" is one question. A
 * deal's stream unions its originating lead's history, labelled: everything
 * said before conversion was said about this deal, and losing it at the
 * conversion boundary is what the `lead_id` provenance column exists to
 * prevent.
 *
 * `status_change` and `system` entries are read-only by construction — the
 * gateway refuses to edit or delete them (409), because a funnel with
 * editable history is not a record of anything.
 */

import {
  ArrowRight,
  CheckCircle2,
  Circle,
  ListTodo,
  MessageSquare,
  Phone,
  Users,
} from "lucide-react";
import { useState } from "react";
import { dateTime, dwellLabel } from "../lib/format";
import type { TimelineEntry } from "../lib/types";

type Composable = "note" | "call" | "meeting" | "task";

const COMPOSERS: { id: Composable; label: string; icon: typeof MessageSquare }[] = [
  { id: "note", label: "Note", icon: MessageSquare },
  { id: "task", label: "Task", icon: ListTodo },
  { id: "call", label: "Call", icon: Phone },
  { id: "meeting", label: "Meeting", icon: Users },
];

export default function Timeline({
  entries,
  onLog,
  onToggleTask,
  saving,
}: {
  entries: TimelineEntry[];
  onLog: (body: {
    type: Composable;
    subject?: string;
    body?: string;
    due_at?: string;
  }) => void;
  onToggleTask: (activityId: string, completed: boolean) => void;
  saving: boolean;
}) {
  const [kind, setKind] = useState<Composable>("note");
  const [draft, setDraft] = useState("");
  const [due, setDue] = useState("");

  function submit() {
    const value = draft.trim();
    if (!value) return;
    onLog({
      type: kind,
      // A note's text is its body; a task's is what you have to do, which is
      // the subject — that is the field the due-date list reads.
      ...(kind === "task"
        ? { subject: value, due_at: due ? new Date(due).toISOString() : undefined }
        : { body: value }),
    });
    setDraft("");
    setDue("");
  }

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border p-3">
        <div className="mb-2 flex items-center gap-1">
          {COMPOSERS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setKind(id)}
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs tech-transition ${
                kind === id
                  ? "bg-primary text-primary-foreground font-medium"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground"
              }`}
            >
              <Icon className="w-3 h-3" />
              {label}
            </button>
          ))}
        </div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          placeholder={
            kind === "task" ? "What needs doing?" : "What happened?"
          }
          className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary/40 focus:outline-none"
        />
        <div className="mt-2 flex items-center gap-2">
          {kind === "task" && (
            <input
              type="date"
              value={due}
              onChange={(e) => setDue(e.target.value)}
              className="rounded-lg border border-border bg-background px-2 py-1 text-xs text-foreground"
            />
          )}
          <button
            onClick={submit}
            disabled={saving || !draft.trim()}
            className="ml-auto rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40 tech-transition"
          >
            Log
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {entries.length === 0 && (
          <p className="py-8 text-center text-xs text-muted-foreground">
            Nothing logged yet.
          </p>
        )}
        <ol className="space-y-3">
          {entries.map((entry, index) => (
            <li key={`${entry.kind}-${entry.activity?.id ?? entry.status_change?.id ?? index}`}>
              {entry.kind === "status_change" ? (
                <StatusEntry entry={entry} />
              ) : (
                <ActivityEntry entry={entry} onToggleTask={onToggleTask} />
              )}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/** The inherited-history marker. A deal's own words and its lead's are both
 *  true; pretending the lead's happened to the deal is not. */
function Origin({ origin }: { origin: TimelineEntry["origin"] }) {
  if (origin !== "lead") return null;
  return (
    <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">
      from the lead
    </span>
  );
}

function StatusEntry({ entry }: { entry: TimelineEntry }) {
  const change = entry.status_change!;
  // dwell_seconds is the part a human actually reads off a timeline ("sat in
  // Proposal for 11 days"), which is why status changes come from the funnel
  // log rather than from the activity that mirrors them.
  const dwell = dwellLabel(change.dwell_seconds);
  return (
    <div className="flex items-start gap-2">
      <ArrowRight className="mt-0.5 w-3.5 h-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="text-xs text-foreground">
          {change.from_status ?? "—"} <span className="opacity-50">→</span>{" "}
          <span className="font-medium">{change.to_status}</span>
        </p>
        <p className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span>{dateTime(change.changed_at)}</span>
          <span>·</span>
          <span>{change.changed_by}</span>
          {dwell && (
            <>
              <span>·</span>
              <span>after {dwell}</span>
            </>
          )}
          <Origin origin={entry.origin} />
        </p>
      </div>
    </div>
  );
}

const ACTIVITY_ICONS = {
  note: MessageSquare,
  call: Phone,
  meeting: Users,
  task: ListTodo,
  status_change: ArrowRight,
  system: Circle,
} as const;

function ActivityEntry({
  entry,
  onToggleTask,
}: {
  entry: TimelineEntry;
  onToggleTask: (activityId: string, completed: boolean) => void;
}) {
  const activity = entry.activity!;
  const Icon = ACTIVITY_ICONS[activity.type] ?? Circle;
  const isTask = activity.type === "task";
  const done = Boolean(activity.completed_at);

  return (
    <div className="flex items-start gap-2">
      {isTask ? (
        <button
          onClick={() => onToggleTask(activity.id, !done)}
          className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground tech-transition"
          aria-label={done ? "Reopen task" : "Complete task"}
        >
          {done ? (
            <CheckCircle2 className="w-3.5 h-3.5 text-success" />
          ) : (
            <Circle className="w-3.5 h-3.5" />
          )}
        </button>
      ) : (
        <Icon className="mt-0.5 w-3.5 h-3.5 shrink-0 text-muted-foreground" />
      )}
      <div className="min-w-0 flex-1">
        {activity.subject && (
          <p
            className={`text-xs ${
              done ? "text-muted-foreground line-through" : "text-foreground"
            }`}
          >
            {activity.subject}
          </p>
        )}
        {activity.body && (
          <p className="whitespace-pre-wrap text-xs text-foreground">
            {activity.body}
          </p>
        )}
        <p className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="uppercase">{activity.type}</span>
          <span>·</span>
          <span>{dateTime(activity.occurred_at ?? activity.created_at)}</span>
          {activity.created_by && (
            <>
              <span>·</span>
              <span>{activity.created_by}</span>
            </>
          )}
          <Origin origin={entry.origin} />
        </p>
      </div>
    </div>
  );
}
