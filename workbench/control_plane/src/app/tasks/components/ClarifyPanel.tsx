"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Sparkles,
  Check,
  ArrowRight,
  ListChecks,
  FolderKanban,
  UserPlus,
  CalendarClock,
  Zap,
  Lightbulb,
  FileText,
  Trash2,
  SlidersHorizontal,
  HardDrive,
  Cloud,
  Search,
  type LucideIcon,
} from "lucide-react";
import { useTaskStore, type ClarifyDecision } from "../lib/taskStore";
import {
  proposeClarification,
  defaultStatus,
  type ClarifyDisposition,
} from "../lib/clarify";
import type { ConnectedProvider } from "../lib/mockData";
import { Energy, GtdItem, GtdProject, Person, Target } from "../lib/types";
import { durationLabel, initials, snoozeOptions } from "../lib/utils";
import { SourceBadge } from "./SourceBadge";

// F2 — Clarify. AI proposes a full disposition (what it is · next action · where
// it's stored · who owns it · which stage); you confirm in one tap or adjust any
// part. Proposal is a local heuristic today; the agent replaces it later (§2.2).

const DISP: Record<
  ClarifyDisposition,
  { label: string; icon: LucideIcon; danger?: boolean }
> = {
  NEXT: { label: "Next action", icon: ListChecks },
  PROJECT: { label: "Project", icon: FolderKanban },
  WAITING: { label: "Delegate", icon: UserPlus },
  CALENDAR: { label: "Schedule", icon: CalendarClock },
  DO_NOW: { label: "Do now · 2 min", icon: Zap },
  SOMEDAY: { label: "Someday", icon: Lightbulb },
  REFERENCE: { label: "Reference", icon: FileText },
  TRASH: { label: "Trash", icon: Trash2, danger: true },
};
const DISP_ORDER: ClarifyDisposition[] = [
  "NEXT", "PROJECT", "WAITING", "CALENDAR", "DO_NOW", "SOMEDAY", "REFERENCE", "TRASH",
];
const ACTIONABLE = new Set<ClarifyDisposition>(["NEXT", "PROJECT", "WAITING", "CALENDAR"]);
const short = (s: string, n = 26) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const destEntry = (t: Target, providers: ConnectedProvider[]) =>
  t.source === "LOCAL"
    ? providers.find((p) => p.source === "LOCAL")
    : providers.find((p) =>
        t.accountId ? p.id === t.accountId : p.provider === t.provider,
      );
const providerStatuses = (t: Target, providers: ConnectedProvider[]): string[] =>
  destEntry(t, providers)?.statuses ?? [];

export function ClarifyPanel({ item }: { item: GtdItem }) {
  const clarify = useTaskStore((s) => s.clarify);
  const contexts = useTaskStore((s) => s.contexts);
  const people = useTaskStore((s) => s.people);
  const projects = useTaskStore((s) => s.projects);
  const providers = useTaskStore((s) => s.providers);

  const proposal = useMemo(
    () => proposeClarification(item, people, projects),
    [item, people, projects],
  );

  const [disposition, setDisposition] = useState<ClarifyDisposition>(proposal.disposition);
  const [nextAction, setNextAction] = useState(proposal.nextAction);
  const [outcome, setOutcome] = useState(proposal.outcome ?? `${item.title} — done`);
  const [context, setContext] = useState(proposal.context ?? "@computer");
  const [energy, setEnergy] = useState<Energy>(proposal.energy ?? "medium");
  const [assignee, setAssignee] = useState<Person | null>(proposal.suggestedAssignee ?? null);
  const [dueAt, setDueAt] = useState("");
  const [dest, setDest] = useState<Target>(proposal.target ?? { source: "LOCAL", provider: "local" });
  const [projectId, setProjectId] = useState<string | undefined>(proposal.projectId);
  const [status, setStatus] = useState<string | undefined>(
    defaultStatus(proposal.disposition, providerStatuses(proposal.target ?? { source: "LOCAL" }, providers)),
  );
  const [adjust, setAdjust] = useState(false);
  // "Where it goes" details stay collapsed by default — the assistant already
  // filled them in, so most items are a single tap. Expand only to fine-tune.
  const [showDetails, setShowDetails] = useState(false);

  const selectedProject = projectId
    ? projects.find((p) => p.id === projectId)
    : undefined;
  const statusesForDest = useMemo(() => providerStatuses(dest, providers), [dest, providers]);
  const projectsForDest = useMemo(
    () =>
      projects.filter(
        (p) =>
          p.status === "ACTIVE" &&
          (dest.source === "LOCAL"
            ? p.source === "LOCAL"
            : dest.accountId
              ? p.accountId === dest.accountId
              : p.provider === dest.provider),
      ),
    [projects, dest],
  );

  const chooseDest = (t: Target) => {
    setDest(t);
    setProjectId(undefined);
    setStatus(defaultStatus(disposition, providerStatuses(t, providers)));
  };
  const chooseDisposition = (d: ClarifyDisposition) => {
    setDisposition(d);
    let t = dest;
    if (d === "WAITING" && dest.source === "LOCAL") {
      const cu = providers.find((p) => p.source === "SYNCED");
      if (cu) {
        t = { source: cu.source, provider: cu.provider, accountId: cu.id };
        setDest(t);
        setProjectId(undefined);
      }
    }
    setStatus(defaultStatus(d, providerStatuses(t, providers)));
  };

  const buildDecision = useCallback(
    (d: ClarifyDisposition): ClarifyDecision | null => {
      const na = nextAction.trim();
      const dueIso = dueAt ? new Date(dueAt).toISOString() : undefined;
      switch (d) {
        case "NEXT":
          return na
            ? { kind: "next", nextAction: na, context, energy, dest, projectId, status, dueAt: dueIso, assignee: assignee ?? undefined }
            : null;
        case "PROJECT":
          return na && outcome.trim()
            ? { kind: "project", outcome: outcome.trim(), nextAction: na, context, energy, dest, status, dueAt: dueIso, assignee: assignee ?? undefined }
            : null;
        case "WAITING":
          return na && assignee
            ? { kind: "delegate", person: assignee, nextAction: na, dest, projectId, status, dueAt: dueIso }
            : null;
        case "CALENDAR":
          return na
            ? { kind: "calendar", nextAction: na, dueAt: dueIso ?? snoozeOptions()[0].iso, context, dest, status, assignee: assignee ?? undefined }
            : null;
        case "SOMEDAY":
          return { kind: "someday", dest, projectId, status };
        case "DO_NOW":
          return { kind: "do-now" };
        case "REFERENCE":
          return { kind: "reference" };
        case "TRASH":
          return { kind: "trash" };
      }
    },
    [nextAction, outcome, context, energy, assignee, dueAt, dest, projectId, status],
  );

  const apply = useCallback(() => {
    const decision = buildDecision(disposition);
    if (decision) clarify(item.id, decision);
  }, [buildDecision, disposition, clarify, item.id]);

  const canApply = !!buildDecision(disposition);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable))
        return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Enter" && canApply) {
        e.preventDefault();
        apply();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [apply, canApply]);

  const Meta = DISP[proposal.disposition];
  const proposedDestLabel = proposal.target
    ? destEntry(proposal.target!, providers)?.label
    : undefined;
  const proposedProject = proposal.projectId ? projects.find((p) => p.id === proposal.projectId) : undefined;
  const proposedStatus =
    proposal.target && proposal.target.source === "SYNCED"
      ? defaultStatus(proposal.disposition, providerStatuses(proposal.target, providers))
      : undefined;
  const isSynced = dest.source === "SYNCED";
  const showWhere = ACTIONABLE.has(disposition) || disposition === "SOMEDAY";

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
          What is it, what&apos;s the next action, and where does it go?
        </p>
      </header>

      <div className="flex flex-col gap-4 px-5 py-4">
        {/* AI proposal — review & confirm */}
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-primary">
              <Sparkles className="h-3.5 w-3.5" />
              Assistant recommends
            </div>
            <span
              className={[
                "rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
                proposal.confidence === "high"
                  ? "bg-primary/15 text-primary"
                  : "bg-secondary text-muted-foreground",
              ].join(" ")}
              title={
                proposal.confidence === "high"
                  ? "The assistant is confident — accept in one tap."
                  : "A best guess — glance and confirm, or adjust."
              }
            >
              {proposal.confidence === "high" ? "Confident" : "Best guess"}
            </span>
          </div>
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Meta.icon className="h-4 w-4 text-primary" />
            {DISP[proposal.disposition].label}
            {proposal.suggestedAssignee && (
              <span className="text-muted-foreground">→ {proposal.suggestedAssignee.name}</span>
            )}
          </div>
          {proposal.disposition === "PROJECT" && proposal.outcome && (
            <p className="mt-1.5 text-[13px] text-muted-foreground">
              Outcome: <span className="text-foreground">{proposal.outcome}</span>
            </p>
          )}
          {ACTIONABLE.has(proposal.disposition) && (
            <p className="mt-1.5 text-sm text-foreground">
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {proposal.disposition === "PROJECT" ? "First action" : "Next action"}
              </span>
              <br />
              {proposal.nextAction}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            {proposal.context && <span className="font-mono text-primary/80">{proposal.context}</span>}
            {proposal.energy && <span>{proposal.energy} energy</span>}
            {proposal.timeEstimateMins ? <span>{durationLabel(proposal.timeEstimateMins)}</span> : null}
            {ACTIONABLE.has(proposal.disposition) && proposedDestLabel && (
              <span className="inline-flex items-center gap-1 rounded bg-secondary px-1.5 py-0.5 font-medium">
                {proposal.target?.source === "LOCAL" ? (
                  <HardDrive className="h-3 w-3" />
                ) : (
                  <Cloud className="h-3 w-3" />
                )}
                {proposedDestLabel}
                {proposedProject ? ` · ${short(proposedProject.outcome, 16)}` : ""}
                {proposedStatus ? ` · ${proposedStatus}` : ""}
              </span>
            )}
          </div>
          <p className="mt-1.5 text-[11px] italic text-muted-foreground">{proposal.rationale}</p>
          <div className="mt-2.5 flex items-center gap-2">
            <button
              type="button"
              onClick={apply}
              className="tech-transition inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-[12px] font-medium text-primary-foreground hover:opacity-90"
            >
              <Check className="h-3.5 w-3.5" />
              Accept &amp; next
            </button>
            <button
              type="button"
              onClick={() => setAdjust((v) => !v)}
              className={[
                "tech-transition inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium",
                adjust ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground",
              ].join(" ")}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              Adjust
            </button>
          </div>
        </div>

        {/* Adjust */}
        {adjust && (
          <div className="flex flex-col gap-3">
            <Field label="What is it?">
              <div className="flex flex-wrap gap-1.5">
                {DISP_ORDER.map((d) => {
                  const M = DISP[d];
                  const active = disposition === d;
                  return (
                    <button
                      key={d}
                      type="button"
                      onClick={() => chooseDisposition(d)}
                      className={[
                        "tech-transition inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px]",
                        active
                          ? M.danger
                            ? "border-destructive bg-destructive/10 text-destructive"
                            : "border-primary bg-primary/10 text-primary"
                          : "border-border text-muted-foreground hover:bg-secondary",
                      ].join(" ")}
                    >
                      <M.icon className="h-3.5 w-3.5" />
                      {M.label}
                    </button>
                  );
                })}
              </div>
            </Field>

            {disposition === "PROJECT" && (
              <Field label="Successful outcome">
                <input
                  value={outcome}
                  onChange={(e) => setOutcome(e.target.value)}
                  className="w-full rounded-md border border-border bg-background/60 px-3 py-2 text-base text-foreground focus:border-primary/50 focus:outline-none sm:text-sm"
                  placeholder="What does 'done' look like?"
                />
              </Field>
            )}

            {ACTIONABLE.has(disposition) && (
              <Field label={disposition === "PROJECT" ? "First next action" : "Next action"}>
                <input
                  value={nextAction}
                  onChange={(e) => setNextAction(e.target.value)}
                  className="w-full rounded-md border border-border bg-background/60 px-3 py-2 text-base text-foreground focus:border-primary/50 focus:outline-none sm:text-sm"
                  placeholder="The next physical, visible step…"
                />
              </Field>
            )}

            {disposition === "WAITING" && (
              <Field label="Delegate to">
                <PeoplePicker people={people} value={assignee} onChange={setAssignee} />
              </Field>
            )}

            {(disposition === "NEXT" || disposition === "PROJECT" || disposition === "CALENDAR") && (
              <Field label="Context">
                <div className="flex flex-wrap gap-1.5">
                  {contexts.map((c) => (
                    <Pill key={c.name} mono active={context === c.name} onClick={() => setContext(c.name)}>
                      {c.name}
                    </Pill>
                  ))}
                </div>
              </Field>
            )}

            {(disposition === "NEXT" || disposition === "PROJECT") && (
              <Field label="Energy">
                <div className="flex gap-1.5">
                  {(["low", "medium", "high"] as Energy[]).map((e) => (
                    <Pill key={e} active={energy === e} onClick={() => setEnergy(e)}>
                      {e}
                    </Pill>
                  ))}
                </div>
              </Field>
            )}

            {disposition === "CALENDAR" && (
              <Field label="On which day?">
                <input
                  type="date"
                  value={dueAt}
                  onChange={(e) => setDueAt(e.target.value)}
                  className="rounded-md border border-border bg-background/60 px-3 py-2 text-base text-foreground focus:border-primary/50 focus:outline-none sm:text-sm"
                />
              </Field>
            )}

            {/* Where it goes — dual-source + the connected tool's project/stage/owner/due (§5.1) */}
            {showWhere && (
              <Field label="Where it goes">
                <div className="flex flex-wrap gap-1.5">
                  {providers.map((cp) => {
                    const active = destEntry(dest, providers)?.id === cp.id;
                    return (
                      <button
                        key={cp.id}
                        type="button"
                        onClick={() =>
                          chooseDest({
                            source: cp.source,
                            provider: cp.provider,
                            accountId: cp.source === "SYNCED" ? cp.id : undefined,
                          })
                        }
                        className={[
                          "tech-transition inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px]",
                          active ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-secondary",
                        ].join(" ")}
                      >
                        {cp.source === "LOCAL" ? <HardDrive className="h-3.5 w-3.5" /> : <Cloud className="h-3.5 w-3.5" />}
                        {cp.label}
                      </button>
                    );
                  })}
                </div>

                {!isSynced ? (
                  <p className="mt-1.5 text-[10px] text-muted-foreground">
                    Private to you. Delegated or collaborative work belongs on a connected tool.
                  </p>
                ) : !showDetails ? (
                  // Collapsed: one compact line of what the assistant already set.
                  // Keeps processing calm — expand only when you want to fine-tune.
                  <button
                    type="button"
                    onClick={() => setShowDetails(true)}
                    className="tech-transition mt-2.5 flex w-full items-center justify-between gap-2 rounded-md border border-border bg-background/40 px-3 py-2 text-left hover:border-primary/40"
                  >
                    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground">
                      {disposition !== "PROJECT" && (
                        <span className="inline-flex items-center gap-1 text-foreground">
                          <FolderKanban className="h-3 w-3 text-primary/70" />
                          {selectedProject ? short(selectedProject.outcome, 20) : "No project"}
                          {proposal.projectInferred && projectId === proposal.projectId && (
                            <Sparkles className="h-2.5 w-2.5 text-primary" />
                          )}
                        </span>
                      )}
                      {status && (
                        <>
                          <span className="text-border">·</span>
                          <span>{status}</span>
                        </>
                      )}
                      {assignee && disposition !== "PROJECT" && (
                        <>
                          <span className="text-border">·</span>
                          <span>{assignee.name}</span>
                        </>
                      )}
                      {dueAt && (
                        <>
                          <span className="text-border">·</span>
                          <span>{dueAt}</span>
                        </>
                      )}
                    </span>
                    <span className="shrink-0 text-[11px] font-medium text-primary">Edit</span>
                  </button>
                ) : (
                  <div className="mt-2.5 flex flex-col gap-2.5">
                    {disposition !== "PROJECT" && (
                      <SubField label="Project">
                        <ProjectPicker
                          projects={projectsForDest}
                          suggestedId={
                            proposal.projectInferred ? proposal.projectId : undefined
                          }
                          value={projectId}
                          onChange={setProjectId}
                        />
                      </SubField>
                    )}

                    {statusesForDest.length > 0 && (
                      <SubField label="Stage">
                        <div className="flex flex-wrap gap-1.5">
                          {statusesForDest.map((s) => (
                            <Pill key={s} plain active={status === s} onClick={() => setStatus(s)}>
                              {s}
                            </Pill>
                          ))}
                        </div>
                      </SubField>
                    )}

                    {disposition !== "WAITING" && (
                      <SubField label="Assignee (optional)">
                        <PeoplePicker people={people} value={assignee} onChange={setAssignee} allowNone />
                      </SubField>
                    )}

                    {disposition !== "CALENDAR" && (
                      <SubField label="Due · timeline (optional)">
                        <input
                          type="date"
                          value={dueAt}
                          onChange={(e) => setDueAt(e.target.value)}
                          className="rounded-md border border-border bg-background/60 px-3 py-1.5 text-base text-foreground focus:border-primary/50 focus:outline-none sm:text-sm"
                        />
                      </SubField>
                    )}
                  </div>
                )}
              </Field>
            )}

            <button
              type="button"
              disabled={!canApply}
              onClick={apply}
              className={[
                "tech-transition inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2.5 text-sm font-medium",
                canApply ? "bg-primary text-primary-foreground hover:opacity-90" : "cursor-not-allowed bg-secondary text-muted-foreground",
              ].join(" ")}
            >
              Organize it <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function PeoplePicker({
  people,
  value,
  onChange,
  allowNone,
}: {
  people: Person[];
  value: Person | null;
  onChange: (p: Person | null) => void;
  allowNone?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {allowNone && (
        <Pill plain active={!value} onClick={() => onChange(null)}>
          Unassigned
        </Pill>
      )}
      {people.map((p) => (
        <button
          key={p.name}
          type="button"
          onClick={() => onChange(p)}
          className={[
            "tech-transition inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px]",
            value?.name === p.name ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-secondary",
          ].join(" ")}
        >
          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-primary/15 text-[8px] font-bold text-primary">
            {initials(p.name)}
          </span>
          {p.name}
        </button>
      ))}
    </div>
  );
}

// Scales to many projects: shows the assistant's match first, then a filter box
// so you never scan a wall of pills. Type to search; tap to file.
function ProjectPicker({
  projects,
  suggestedId,
  value,
  onChange,
}: {
  projects: GtdProject[];
  suggestedId?: string;
  value?: string;
  onChange: (id: string | undefined) => void;
}) {
  const [q, setQ] = useState("");
  const suggested = suggestedId ? projects.find((p) => p.id === suggestedId) : undefined;
  const ql = q.trim().toLowerCase();
  const matches = projects
    .filter((p) => p.id !== suggestedId && (!ql || p.outcome.toLowerCase().includes(ql)))
    .slice(0, ql ? 8 : 4);

  const renderRow = (p: GtdProject | undefined, hint: boolean) => {
    const active = (p?.id ?? undefined) === value;
    return (
      <button
        key={p?.id ?? "__none"}
        type="button"
        onClick={() => onChange(p?.id)}
        className={[
          "tech-transition flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-[13px]",
          active
            ? "border-primary bg-primary/10 text-primary"
            : "border-border text-foreground hover:bg-secondary",
        ].join(" ")}
      >
        {hint ? (
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" />
        ) : (
          <FolderKanban className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate">{p ? p.outcome : "No project"}</span>
        {active && <Check className="h-3.5 w-3.5 shrink-0" />}
      </button>
    );
  };

  return (
    <div className="flex flex-col gap-1.5">
      {projects.length > 4 && (
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search projects…"
            className="w-full rounded-md border border-border bg-background/60 py-1.5 pl-8 pr-3 text-base text-foreground focus:border-primary/50 focus:outline-none sm:text-[13px]"
          />
        </div>
      )}
      {suggested &&
        (!ql || suggested.outcome.toLowerCase().includes(ql)) &&
        renderRow(suggested, true)}
      {renderRow(undefined, false)}
      {matches.map((p) => renderRow(p, false))}
      {ql && !matches.length && !suggested && (
        <p className="px-1 py-1 text-[11px] text-muted-foreground">No matching projects.</p>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-1.5 text-xs font-semibold text-foreground">{label}</h3>
      {children}
    </div>
  );
}

function SubField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      {children}
    </div>
  );
}

function Pill({
  active,
  mono,
  plain,
  onClick,
  children,
}: {
  active: boolean;
  mono?: boolean;
  plain?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "tech-transition rounded-full border px-2.5 py-1 text-[12px]",
        mono ? "font-mono" : plain ? "" : "capitalize",
        active ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-secondary",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
