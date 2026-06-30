"use client";

import { useMemo, useState } from "react";
import {
  Sparkles,
  Check,
  Trash2,
  Lightbulb,
  FileText,
  Zap,
  UserPlus,
  ListChecks,
  CalendarClock,
  ArrowRight,
} from "lucide-react";
import {
  useTaskStore,
  suggestClarification,
  type ClarifyDecision,
} from "../lib/taskStore";
import { Energy, GtdItem, Person } from "../lib/types";
import { initials } from "../lib/utils";
import { SourceBadge } from "./SourceBadge";

// F2 — Clarify. The GTD decision tree applied to an inbox item: actionable? →
// next action → do-now / delegate / defer / schedule, or non-actionable →
// trash / someday / reference. The "assistant suggestion" is mocked here
// (suggestClarification); the real agent gets wired with the gateway later.

type ActionPath = "next" | "delegate" | "calendar" | "do-now";

export function ClarifyPanel({ item }: { item: GtdItem }) {
  const clarify = useTaskStore((s) => s.clarify);
  const contexts = useTaskStore((s) => s.contexts);
  const people = useTaskStore((s) => s.people);

  const suggestion = useMemo(() => suggestClarification(item), [item]);

  // wizard state
  const [actionable, setActionable] = useState<boolean | null>(null);
  const [path, setPath] = useState<ActionPath | null>(null);
  const [nextAction, setNextAction] = useState(suggestion.nextAction);
  const [context, setContext] = useState(suggestion.context ?? "@computer");
  const [energy, setEnergy] = useState<Energy>(suggestion.energy ?? "low");
  const [person, setPerson] = useState<Person | null>(null);
  const [dueAt, setDueAt] = useState("");

  // Wizard state resets when the parent remounts this with a new key (item.id).

  const acceptSuggestion = () => {
    if (suggestion.disposition === "SOMEDAY") clarify(item.id, { kind: "someday" });
    else if (suggestion.disposition === "REFERENCE") clarify(item.id, { kind: "reference" });
    else
      clarify(item.id, {
        kind: "next",
        nextAction: suggestion.nextAction,
        context: suggestion.context ?? "@computer",
        energy: suggestion.energy,
      });
  };

  const applyPath = () => {
    let decision: ClarifyDecision | null = null;
    if (path === "do-now") decision = { kind: "do-now" };
    else if (path === "delegate" && person)
      decision = { kind: "delegate", person, nextAction };
    else if (path === "next")
      decision = { kind: "next", nextAction, context, energy };
    else if (path === "calendar" && dueAt)
      decision = { kind: "calendar", nextAction, dueAt: new Date(dueAt).toISOString(), context };
    if (decision) clarify(item.id, decision);
  };

  const canApply =
    (path === "do-now") ||
    (path === "next" && nextAction.trim().length > 0) ||
    (path === "delegate" && !!person && nextAction.trim().length > 0) ||
    (path === "calendar" && !!dueAt && nextAction.trim().length > 0);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="border-b border-border bg-card px-5 py-4">
        <div className="mb-2 flex items-center gap-2">
          <span className="rounded bg-primary/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
            Clarify
          </span>
          <SourceBadge source={item.source} provider={item.provider} />
        </div>
        <h1 className="text-lg font-bold leading-snug text-foreground">{item.title}</h1>
        <p className="mt-1 text-[11px] text-muted-foreground">
          What is it, and what&apos;s the next action? Process it out of the inbox.
        </p>
      </header>

      <div className="flex flex-col gap-5 px-5 py-4">
        {/* Mocked assistant proposal — the one-click fast path (F2) */}
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-primary">
            <Sparkles className="h-3.5 w-3.5" />
            Assistant suggestion
          </div>
          <p className="text-sm text-foreground">{suggestion.nextAction}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span className="rounded bg-secondary px-1.5 py-0.5 font-medium uppercase">
              {suggestion.disposition === "NEXT" ? "Next action" : suggestion.disposition}
            </span>
            {suggestion.context && (
              <span className="font-mono text-primary/80">{suggestion.context}</span>
            )}
            <span className="italic">{suggestion.rationale}</span>
          </div>
          <button
            type="button"
            onClick={acceptSuggestion}
            className="tech-transition mt-2.5 inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-[12px] font-medium text-primary-foreground hover:opacity-90"
          >
            <Check className="h-3.5 w-3.5" />
            Accept suggestion
          </button>
        </div>

        <div className="text-center text-[11px] uppercase tracking-wide text-muted-foreground">
          — or clarify it yourself —
        </div>

        {/* Step 1 — actionable? */}
        <Step n={1} label="Is it actionable?">
          <div className="flex gap-2">
            <Choice active={actionable === true} onClick={() => { setActionable(true); setPath(null); }}>
              Yes
            </Choice>
            <Choice active={actionable === false} onClick={() => { setActionable(false); setPath(null); }}>
              No
            </Choice>
          </div>
        </Step>

        {/* Non-actionable branch */}
        {actionable === false && (
          <Step n={2} label="Then file it as">
            <div className="grid grid-cols-3 gap-2">
              <BigChoice icon={Trash2} label="Trash" onClick={() => clarify(item.id, { kind: "trash" })} />
              <BigChoice icon={Lightbulb} label="Someday" onClick={() => clarify(item.id, { kind: "someday" })} />
              <BigChoice icon={FileText} label="Reference" onClick={() => clarify(item.id, { kind: "reference" })} />
            </div>
          </Step>
        )}

        {/* Actionable branch */}
        {actionable === true && (
          <>
            <Step n={2} label="What's the very next action?">
              <input
                value={nextAction}
                onChange={(e) => setNextAction(e.target.value)}
                className="w-full rounded-md border border-border bg-background/60 px-3 py-2 text-sm text-foreground focus:border-primary/50 focus:outline-none"
                placeholder="The next physical, visible step…"
              />
            </Step>

            <Step n={3} label="What happens to it?">
              <div className="grid grid-cols-2 gap-2">
                <BigChoice icon={Zap} label="Do now (<2 min)" active={path === "do-now"} onClick={() => setPath("do-now")} />
                <BigChoice icon={UserPlus} label="Delegate" active={path === "delegate"} onClick={() => setPath("delegate")} />
                <BigChoice icon={ListChecks} label="Next action" active={path === "next"} onClick={() => setPath("next")} />
                <BigChoice icon={CalendarClock} label="Schedule" active={path === "calendar"} onClick={() => setPath("calendar")} />
              </div>
            </Step>

            {/* Path-specific fields */}
            {path === "delegate" && (
              <Step n={4} label="Delegate to">
                <div className="flex flex-wrap gap-2">
                  {people.map((p) => (
                    <button
                      key={p.name}
                      type="button"
                      onClick={() => setPerson(p)}
                      className={[
                        "tech-transition inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px]",
                        person?.name === p.name
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border text-muted-foreground hover:bg-secondary",
                      ].join(" ")}
                    >
                      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-primary/15 text-[8px] font-bold text-primary">
                        {initials(p.name)}
                      </span>
                      {p.name}
                    </button>
                  ))}
                </div>
              </Step>
            )}

            {path === "next" && (
              <Step n={4} label="Context & energy">
                <div className="flex flex-wrap gap-1.5">
                  {contexts.map((c) => (
                    <Pill key={c.name} active={context === c.name} mono onClick={() => setContext(c.name)}>
                      {c.name}
                    </Pill>
                  ))}
                </div>
                <div className="mt-2 flex gap-1.5">
                  {(["low", "medium", "high"] as Energy[]).map((e) => (
                    <Pill key={e} active={energy === e} onClick={() => setEnergy(e)}>
                      {e} energy
                    </Pill>
                  ))}
                </div>
              </Step>
            )}

            {path === "calendar" && (
              <Step n={4} label="On which day? (hard landscape)">
                <input
                  type="date"
                  value={dueAt}
                  onChange={(e) => setDueAt(e.target.value)}
                  className="rounded-md border border-border bg-background/60 px-3 py-2 text-sm text-foreground focus:border-primary/50 focus:outline-none"
                />
              </Step>
            )}

            {path && (
              <button
                type="button"
                disabled={!canApply}
                onClick={applyPath}
                className={[
                  "tech-transition inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2.5 text-sm font-medium",
                  canApply
                    ? "bg-primary text-primary-foreground hover:opacity-90"
                    : "cursor-not-allowed bg-secondary text-muted-foreground",
                ].join(" ")}
              >
                Organize it <ArrowRight className="h-4 w-4" />
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Step({ n, label, children }: { n: number; label: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold text-foreground">
        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-secondary text-[10px] text-muted-foreground">
          {n}
        </span>
        {label}
      </h3>
      {children}
    </div>
  );
}

function Choice({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "tech-transition flex-1 rounded-lg border px-3 py-2 text-sm font-medium",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:bg-secondary hover:text-foreground",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function BigChoice({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: typeof Zap;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "tech-transition flex flex-col items-center gap-1.5 rounded-lg border px-2 py-3 text-[12px] font-medium",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:bg-secondary hover:text-foreground",
      ].join(" ")}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}

function Pill({
  active,
  mono,
  onClick,
  children,
}: {
  active: boolean;
  mono?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "tech-transition rounded-full border px-2.5 py-1 text-[12px]",
        mono ? "font-mono" : "",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:bg-secondary",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
