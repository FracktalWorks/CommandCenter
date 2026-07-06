"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  Mail as MailIcon,
  ChevronRight,
  Plus,
  Loader2,
  type LucideIcon,
} from "lucide-react";
import { useTaskStore, type ClarifyDecision } from "../lib/taskStore";
import {
  proposeClarification,
  defaultStatus,
  type ClarifyDisposition,
  type ClarifyProposal,
} from "../lib/clarify";
import { apiClarifyPropose } from "../lib/api";
import type { ConnectedProvider } from "../lib/mockData";
import { Energy, GtdItem, GtdProject, Person, Target, WorkspaceHierarchySpace } from "../lib/types";
import type { TaskAccount } from "../lib/api";
import { durationLabel, initials, originEmailHref, snoozeOptions } from "../lib/utils";
import { SourceBadge } from "./SourceBadge";
import { AttachmentChips } from "./AttachmentComposer";

// F2 — Clarify. AI proposes a full disposition (what it is · next action · where
// it's stored · who owns it · which stage); you confirm in one tap or adjust any
// part. The local heuristic renders INSTANTLY; on a live backend the server
// proposal (org-knowledge capability match + server project auto-match +
// destination/stage defaults, §2.2 agent seam) upgrades it in place — but only
// while the form is still untouched (the human's edits always win).

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
  const backend = useTaskStore((s) => s.backend);
  const contexts = useTaskStore((s) => s.contexts);
  const people = useTaskStore((s) => s.people);
  const projects = useTaskStore((s) => s.projects);
  const providers = useTaskStore((s) => s.providers);
  const accounts = useTaskStore((s) => s.accounts);
  const refreshAccountMembers = useTaskStore((s) => s.refreshAccountMembers);
  const createWorkspaceProject = useTaskStore((s) => s.createWorkspaceProject);

  const localProposal = useMemo(
    () => proposeClarification(item, people, projects),
    [item, people, projects],
  );
  // The proposal shown in the header (rationale/confidence/assignee chip):
  // starts as the instant local heuristic, upgraded by the server's when it
  // arrives (richer people/project knowledge lives behind the gateway).
  const [proposal, setProposal] = useState<ClarifyProposal>(localProposal);
  // True once the user changed ANY field — a late server proposal must never
  // stomp on human edits.
  const dirtyRef = useRef(false);

  const [disposition, setDisposition] = useState<ClarifyDisposition>(proposal.disposition);
  const [nextAction, setNextAction] = useState(proposal.nextAction);
  const [outcome, setOutcome] = useState(proposal.outcome ?? `${item.title} — done`);
  const [context, setContext] = useState(proposal.context ?? "@computer");
  const [energy, setEnergy] = useState<Energy>(proposal.energy ?? "medium");
  const [assignee, setAssignee] = useState<Person | null>(proposal.suggestedAssignee ?? null);
  const [dueAt, setDueAt] = useState("");
  const [dest, setDest] = useState<Target>(proposal.target ?? { source: "LOCAL", provider: "local" });
  const [projectId, setProjectId] = useState<string | undefined>(proposal.projectId);
  // Subtasks the user chose to break this task into (NEXT only). Seeded from the
  // assistant's suggestion when it read the task as "needs subtasks".
  const [subtasks, setSubtasks] = useState<string[]>(
    proposal.complexity === "subtasks" ? proposal.suggestedSubtasks ?? [] : [],
  );
  const [status, setStatus] = useState<string | undefined>(
    defaultStatus(proposal.disposition, providerStatuses(proposal.target ?? { source: "LOCAL" }, providers)),
  );
  const [adjust, setAdjust] = useState(false);
  // "Where it goes" details stay collapsed by default — the assistant already
  // filled them in, so most items are a single tap. Expand only to fine-tune.
  const [showDetails, setShowDetails] = useState(false);

  // ── Server proposal upgrade (live backend only) ──────────────────────
  // The panel opened instantly on the local heuristic; swap in the server's
  // richer proposal when it lands — unless the user already touched the form
  // (dirtyRef, set by any interaction inside the panel root below).
  useEffect(() => {
    if (backend !== "live") return;
    let cancelled = false;
    apiClarifyPropose(item.id)
      .then((sp) => {
        if (cancelled || dirtyRef.current) return;
        setProposal(sp);
        setDisposition(sp.disposition);
        setNextAction(sp.nextAction);
        setOutcome(sp.outcome ?? `${item.title} — done`);
        setContext(sp.context ?? "@computer");
        setEnergy(sp.energy ?? "medium");
        setAssignee(sp.suggestedAssignee ?? null);
        if (sp.target) setDest(sp.target);
        setProjectId(sp.projectId);
        setSubtasks(
          sp.complexity === "subtasks" ? sp.suggestedSubtasks ?? [] : [],
        );
        setStatus(
          sp.status ??
            defaultStatus(
              sp.disposition,
              providerStatuses(sp.target ?? { source: "LOCAL" }, providers),
            ),
        );
      })
      .catch(() => {
        /* server proposal is an upgrade, not a dependency — keep the local one */
      });
    return () => {
      cancelled = true;
    };
    // Per-item effect: the panel remounts per item (key={item.id}), and the
    // upgrade must run exactly once per mount — not re-fire on store churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, item.id]);

  const selectedProject = projectId
    ? projects.find((p) => p.id === projectId)
    : undefined;
  const statusesForDest = useMemo(() => providerStatuses(dest, providers), [dest, providers]);
  const destAccount: TaskAccount | undefined = useMemo(
    () => (dest.source === "SYNCED"
      ? accounts.find((a) => a.id === (dest.accountId ?? destEntry(dest, providers)?.id))
      : undefined),
    [dest, accounts, providers],
  );

  // ── LIVE delegate list ────────────────────────────────────────────────
  // When the destination is a workspace, pull its CURRENT members once per
  // account per mount — someone removed in ClickUp disappears from the
  // picker right here, not at the next full schema refresh.
  const refreshedAccountsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const aid = destAccount?.id;
    if (!aid || refreshedAccountsRef.current.has(aid)) return;
    refreshedAccountsRef.current.add(aid);
    void refreshAccountMembers(aid);
  }, [destAccount?.id, refreshAccountMembers]);

  // Delegate options: the workspace's CURRENT members (enriched with the org
  // layer's skills-bearing Person when it matches) for a SYNCED destination;
  // the org list only for LOCAL.
  const peopleForDelegate: Person[] = useMemo(() => {
    if (!destAccount) return people;
    return destAccount.members.map((m) => {
      const org = people.find(
        (op) =>
          (m.providerUserId && op.providerUserId === m.providerUserId) ||
          (m.email && op.email && op.email.toLowerCase() === m.email.toLowerCase()) ||
          op.name.toLowerCase() === m.name.toLowerCase(),
      );
      return org ?? m;
    });
  }, [destAccount, people]);

  // A picked assignee who is no longer a member (removed in the tool) is
  // cleared — never delegate to someone who can't receive the task.
  // Reset-during-render (React's adjust-state-on-change pattern, keeps the
  // set-state-in-effect lint rule happy and avoids a cascading render).
  if (destAccount && assignee) {
    const still = peopleForDelegate.some(
      (m) =>
        (assignee.providerUserId && m.providerUserId === assignee.providerUserId) ||
        m.name.toLowerCase() === assignee.name.toLowerCase(),
    );
    if (!still) setAssignee(null);
  }
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
            ? { kind: "next", nextAction: na, context, energy, dest, projectId, status, dueAt: dueIso, assignee: assignee ?? undefined, subtasks: subtasks.length ? subtasks : undefined }
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
    [nextAction, outcome, context, energy, assignee, dueAt, dest, projectId, status, subtasks],
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
    <div
      className="flex h-full flex-col overflow-y-auto"
      // Any click/keystroke inside the panel = the human is editing; a late
      // server proposal must no longer re-seed the form (capture phase so it
      // fires before the child handler mutates state).
      onPointerDownCapture={() => { dirtyRef.current = true; }}
      onKeyDownCapture={() => { dirtyRef.current = true; }}
    >
      <header className="border-b border-border bg-card px-5 py-4">
        <div className="mb-2 flex items-center gap-2">
          <span className="rounded bg-primary/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
            Clarify
          </span>
          <SourceBadge source={item.source} provider={item.provider} />
        </div>
        <h1 className="text-lg font-bold leading-snug text-foreground">{item.title}</h1>
        {item.origin?.kind === "email" && (
          <p className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
            <MailIcon className="h-3 w-3 shrink-0" />
            <span className="truncate">
              Captured from email — {item.origin.fromName || item.origin.fromEmail}
              {item.origin.subject ? ` · “${item.origin.subject}”` : ""}
            </span>
            <a
              href={originEmailHref(item.origin) ?? "/email"}
              className="tech-transition shrink-0 font-medium text-primary hover:underline"
            >
              Open
            </a>
          </p>
        )}
        {item.attachments && item.attachments.length > 0 && (
          <div className="mt-1">
            <AttachmentChips attachments={item.attachments} />
          </div>
        )}
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
            {/* Trash is a first-class outcome of clarifying — surface it here
                instead of burying it as one pill inside Adjust. */}
            <button
              type="button"
              onClick={() => clarify(item.id, { kind: "trash" })}
              title="Trash this — it's not actionable"
              className="tech-transition ml-auto inline-flex items-center gap-1.5 rounded-md border border-transparent px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Trash
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

            {disposition === "NEXT" && (
              <Field label="Break into subtasks (optional)">
                <SubtaskEditor value={subtasks} onChange={setSubtasks} />
              </Field>
            )}

            {disposition === "WAITING" && (
              <Field label="Delegate to">
                <PeoplePicker people={peopleForDelegate} value={assignee} onChange={setAssignee} />
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
                        {destAccount && destAccount.hierarchy.length > 0 ? (
                          <WorkspaceProjectAccordion
                            hierarchy={destAccount.hierarchy}
                            projects={projectsForDest}
                            suggestedId={
                              proposal.projectInferred ? proposal.projectId : undefined
                            }
                            value={projectId}
                            onChange={setProjectId}
                            onCreate={async (spaceId, folderId, name) => {
                              const created = await createWorkspaceProject(
                                destAccount.id,
                                { name, spaceId, folderId },
                              );
                              setProjectId(created.projectId);
                            }}
                          />
                        ) : (
                          <ProjectPicker
                            projects={projectsForDest}
                            suggestedId={
                              proposal.projectInferred ? proposal.projectId : undefined
                            }
                            value={projectId}
                            onChange={setProjectId}
                          />
                        )}
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
                        <PeoplePicker people={peopleForDelegate} value={assignee} onChange={setAssignee} allowNone />
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

// A small add/remove list for breaking a NEXT task into concrete subtasks.
// Seeded from the assistant's suggestion; the user edits before applying.
function SubtaskEditor({
  value,
  onChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const t = draft.trim();
    if (!t) return;
    onChange([...value, t]);
    setDraft("");
  };
  const remove = (idx: number) => onChange(value.filter((_, i) => i !== idx));
  const edit = (idx: number, text: string) =>
    onChange(value.map((s, i) => (i === idx ? text : s)));

  return (
    <div className="flex flex-col gap-1.5">
      {value.map((s, idx) => (
        <div key={idx} className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary/50" />
          <input
            value={s}
            onChange={(e) => edit(idx, e.target.value)}
            onBlur={() => { if (!s.trim()) remove(idx); }}
            className="min-w-0 flex-1 rounded-md border border-border bg-background/60 px-2 py-1.5 text-[13px] text-foreground focus:border-primary/50 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => remove(idx)}
            aria-label="Remove subtask"
            className="tech-transition shrink-0 rounded p-1 text-muted-foreground/60 hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-1.5 rounded-md border border-dashed border-border px-2 py-1.5">
        <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); add(); }
          }}
          placeholder={value.length ? "Add another step…" : "Add a step…"}
          className="min-w-0 flex-1 bg-transparent px-0.5 py-0.5 text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
        {draft.trim() && (
          <button
            type="button"
            onClick={add}
            className="tech-transition shrink-0 rounded-md bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground hover:opacity-90"
          >
            Add
          </button>
        )}
      </div>
      {value.length > 0 && (
        <p className="text-[10px] text-muted-foreground">
          {value.length} subtask{value.length === 1 ? "" : "s"} — created under
          this task when you file it.
        </p>
      )}
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
/**
 * Workspace project picker — mirrors ClickUp's own navigation exactly:
 * Space → Folder → List as nested accordions, so finding the project feels
 * like finding it in ClickUp. Every level offers "+ New list here" (an
 * explicit user-approved provider write). Selecting a list resolves to the
 * mirrored gtd project (matched by providerRef).
 */
function WorkspaceProjectAccordion({
  hierarchy,
  projects,
  suggestedId,
  value,
  onChange,
  onCreate,
}: {
  hierarchy: WorkspaceHierarchySpace[];
  projects: GtdProject[];
  suggestedId?: string;
  value?: string;
  onChange: (id: string | undefined) => void;
  onCreate: (spaceId: string, folderId: string | undefined, name: string) => Promise<void>;
}) {
  const [q, setQ] = useState("");
  const [openSpaces, setOpenSpaces] = useState<Set<string>>(() => {
    // Open the space containing the current/suggested selection by default.
    const target = value ?? suggestedId;
    const ref = target ? projects.find((p) => p.id === target)?.providerRef : undefined;
    const open = new Set<string>();
    if (ref) {
      for (const sp of hierarchy) {
        const inSpace =
          sp.lists.some((l) => l.id === ref) ||
          sp.folders.some((f) => f.lists.some((l) => l.id === ref));
        if (inSpace) open.add(sp.id);
      }
    }
    if (!open.size && hierarchy.length === 1) open.add(hierarchy[0].id);
    return open;
  });
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set());
  /** Where the inline "new list" input is open: space id or `folder:<id>`. */
  const [creatingAt, setCreatingAt] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const byRef = useMemo(() => {
    const m = new Map<string, GtdProject>();
    for (const pr of projects) if (pr.providerRef) m.set(pr.providerRef, pr);
    return m;
  }, [projects]);

  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  const submitCreate = async (spaceId: string, folderId?: string) => {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      await onCreate(spaceId, folderId, name);
      setCreatingAt(null);
      setNewName("");
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Could not create the project");
    } finally {
      setCreating(false);
    }
  };

  const listRow = (l: { id: string; name: string }, depth: number) => {
    const proj = byRef.get(l.id);
    const active = !!proj && proj.id === value;
    const isSuggested = !!proj && proj.id === suggestedId;
    return (
      <button
        key={l.id}
        type="button"
        onClick={() => onChange(proj?.id)}
        disabled={!proj}
        title={proj ? undefined : "Not mirrored yet — refresh the workspace schema"}
        className={[
          "tech-transition flex w-full items-center gap-2 rounded-md border px-3 py-1.5 text-left text-[13px]",
          depth === 2 ? "ml-8 w-[calc(100%-2rem)]" : "ml-4 w-[calc(100%-1rem)]",
          active
            ? "border-primary bg-primary/10 text-primary"
            : "border-transparent text-foreground hover:bg-secondary disabled:opacity-40",
        ].join(" ")}
      >
        <FolderKanban className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{l.name}</span>
        {isSuggested && <Sparkles className="h-3 w-3 shrink-0 text-primary" />}
        {active && <Check className="h-3.5 w-3.5 shrink-0" />}
      </button>
    );
  };

  const createRow = (spaceId: string, folderId: string | undefined, depth: number) => {
    const key = folderId ? `folder:${folderId}` : spaceId;
    if (creatingAt !== key) {
      return (
        <button
          key={`new-${key}`}
          type="button"
          onClick={() => {
            setCreatingAt(key);
            setNewName("");
            setCreateError(null);
          }}
          className={[
            "tech-transition flex items-center gap-1.5 rounded-md px-3 py-1 text-left text-[12px] text-primary hover:underline",
            depth === 2 ? "ml-8" : "ml-4",
          ].join(" ")}
        >
          <Plus className="h-3 w-3" /> New project here
        </button>
      );
    }
    return (
      <div key={`new-${key}`} className={depth === 2 ? "ml-8" : "ml-4"}>
        <div className="flex items-center gap-1.5">
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitCreate(spaceId, folderId);
              if (e.key === "Escape") setCreatingAt(null);
            }}
            placeholder="New project (ClickUp list) name…"
            className="flex-1 rounded-md border border-border bg-background/60 px-2.5 py-1.5 text-base text-foreground focus:border-primary/50 focus:outline-none sm:text-[13px]"
          />
          <button
            type="button"
            disabled={!newName.trim() || creating}
            onClick={() => void submitCreate(spaceId, folderId)}
            className="tech-transition inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-[12px] font-medium text-primary-foreground disabled:opacity-50"
          >
            {creating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
            Create
          </button>
        </div>
        {createError && (
          <p className="mt-1 text-[11px] text-destructive">{createError}</p>
        )}
      </div>
    );
  };

  // Search mode: flat filtered list across every space/folder.
  const ql = q.trim().toLowerCase();
  if (ql) {
    const hits: { id: string; name: string; path: string }[] = [];
    for (const sp of hierarchy) {
      for (const l of sp.lists)
        if (l.name.toLowerCase().includes(ql))
          hits.push({ ...l, path: sp.name });
      for (const f of sp.folders)
        for (const l of f.lists)
          if (l.name.toLowerCase().includes(ql))
            hits.push({ ...l, path: `${sp.name} / ${f.name}` });
    }
    return (
      <div className="flex flex-col gap-1.5">
        <SearchBox q={q} setQ={setQ} />
        {hits.slice(0, 10).map((h) => (
          <div key={h.id}>
            <p className="ml-4 text-[10px] uppercase tracking-wide text-muted-foreground/70">{h.path}</p>
            {listRow(h, 1)}
          </div>
        ))}
        {!hits.length && (
          <p className="px-1 py-1 text-[11px] text-muted-foreground">No matching projects.</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <SearchBox q={q} setQ={setQ} />
      <button
        type="button"
        onClick={() => onChange(undefined)}
        className={[
          "tech-transition flex w-full items-center gap-2 rounded-md border px-3 py-1.5 text-left text-[13px]",
          value === undefined
            ? "border-primary bg-primary/10 text-primary"
            : "border-transparent text-foreground hover:bg-secondary",
        ].join(" ")}
      >
        <FolderKanban className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="flex-1">No project</span>
        {value === undefined && <Check className="h-3.5 w-3.5 shrink-0" />}
      </button>
      <div className="max-h-56 overflow-y-auto pr-0.5">
        {hierarchy.map((sp) => (
          <div key={sp.id}>
            <button
              type="button"
              onClick={() => setOpenSpaces((cur) => toggle(cur, sp.id))}
              className="tech-transition flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12px] font-semibold text-foreground hover:bg-secondary"
            >
              <ChevronRight
                className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${openSpaces.has(sp.id) ? "rotate-90" : ""}`}
              />
              {sp.name}
              <span className="ml-auto text-[10px] font-normal text-muted-foreground">
                {sp.lists.length + sp.folders.reduce((n, f) => n + f.lists.length, 0)}
              </span>
            </button>
            {openSpaces.has(sp.id) && (
              <div className="flex flex-col gap-0.5 pb-1">
                {sp.lists.map((l) => listRow(l, 1))}
                {sp.folders.map((f) => (
                  <div key={f.id}>
                    <button
                      type="button"
                      onClick={() => setOpenFolders((cur) => toggle(cur, f.id))}
                      className="tech-transition ml-4 flex w-[calc(100%-1rem)] items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] font-medium text-muted-foreground hover:bg-secondary"
                    >
                      <ChevronRight
                        className={`h-3 w-3 shrink-0 transition-transform ${openFolders.has(f.id) ? "rotate-90" : ""}`}
                      />
                      {f.name}
                      <span className="ml-auto text-[10px] font-normal">{f.lists.length}</span>
                    </button>
                    {openFolders.has(f.id) && (
                      <div className="flex flex-col gap-0.5">
                        {f.lists.map((l) => listRow(l, 2))}
                        {createRow(sp.id, f.id, 2)}
                      </div>
                    )}
                  </div>
                ))}
                {createRow(sp.id, undefined, 1)}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function SearchBox({ q, setQ }: { q: string; setQ: (v: string) => void }) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search projects…"
        className="w-full rounded-md border border-border bg-background/60 py-1.5 pl-8 pr-3 text-base text-foreground focus:border-primary/50 focus:outline-none sm:text-[13px]"
      />
    </div>
  );
}

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
