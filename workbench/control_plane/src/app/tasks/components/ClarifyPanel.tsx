"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Sparkles,
  Check,
  ArrowRight,
  ListChecks,
  ListTree,
  FolderKanban,
  UserPlus,
  User,
  CalendarClock,
  CalendarDays,
  Lightbulb,
  FileText,
  Trash2,
  Zap,
  HardDrive,
  Cloud,
  Search,
  Mail as MailIcon,
  ChevronRight,
  Plus,
  Loader2,
  Lock,
  AlertTriangle,
  Wand2,
  Pencil,
  X,
  type LucideIcon,
} from "lucide-react";
import { useTaskStore, type ClarifyDecision } from "../lib/taskStore";
import {
  proposeClarification,
  defaultStatus,
  type ClarifyDisposition,
  type ClarifyProposal,
} from "../lib/clarify";
import { apiClarifyPropose, apiSuggestTitle } from "../lib/api";
import type { ConnectedProvider } from "../lib/mockData";
import { Energy, GtdItem, GtdProject, Person, Target } from "../lib/types";
import type { TaskAccount } from "../lib/api";
import { durationLabel, initials, originEmailHref, snoozeOptions } from "../lib/utils";
import { SourceBadge } from "./SourceBadge";
import { AttachmentChips } from "./AttachmentComposer";

// F2 — Clarify, redesigned as SORT → SHAPE.
//
// The old card asked ONE 8-way question ("what is it: Next / Project /
// Delegate / Schedule / ...") that silently forced disposition, size, owner,
// and timing into a single mutually-exclusive pick — a task that was a
// PROJECT, DELEGATED, with a DEADLINE, broken into STEPS had no way to be
// expressed. Sort→Shape splits that into:
//
//   STEP 1 — Sort: the one true single-pick (is this even actionable?)
//            Do now · Actionable · Reference · Someday · Trash
//   STEP 2 — Shape (only when Sort=Actionable): four INDEPENDENT axes that
//            combine freely —
//              Size:  single | subtasks | project
//              Owner: me | delegate → person
//              When:  anytime | a date
//              Where: a Space→Folder→List tree, target level driven by Size
//                     (single/subtasks pick a LIST; project picks a
//                     SPACE or FOLDER the new list is created under)
//
// A vague-title gate: the AI's cognition (owner/context/subtasks) is only as
// good as the title. When the title reads as too unclear, a soft-gate banner
// offers a clearer rewrite; the recommend block dims ("best-effort") until
// accepted, but never blocks — you can also press "Improve" on any title.

type Sort = "do-now" | "actionable" | "reference" | "someday" | "trash";
type Size = "single" | "subtasks" | "project";
type Owner = "me" | "delegate";
type When = "anytime" | "date";

const SORT_META: Record<Sort, { label: string; icon: LucideIcon; danger?: boolean }> = {
  "do-now": { label: "Do now · 2 min", icon: Zap },
  actionable: { label: "Actionable", icon: ListChecks },
  reference: { label: "Reference", icon: FileText },
  someday: { label: "Someday", icon: Lightbulb },
  trash: { label: "Trash", icon: Trash2, danger: true },
};
const SORT_ORDER: Sort[] = ["do-now", "actionable", "reference", "someday", "trash"];

const SIZE_META: Record<Size, { label: string; icon: LucideIcon }> = {
  single: { label: "Single action", icon: ListChecks },
  subtasks: { label: "Break into steps", icon: ListTree },
  project: { label: "Project", icon: FolderKanban },
};

/** Map a disposition (server proposal / current item state) → the Sort bucket. */
function sortOf(d: ClarifyDisposition): Sort {
  if (d === "DO_NOW") return "do-now";
  if (d === "REFERENCE") return "reference";
  if (d === "SOMEDAY") return "someday";
  if (d === "TRASH") return "trash";
  return "actionable"; // NEXT / PROJECT / WAITING / CALENDAR
}
/** Map a disposition → the Size bucket (only meaningful when Sort=actionable). */
function sizeOf(d: ClarifyDisposition, complexity?: string): Size {
  if (d === "PROJECT") return "project";
  if (complexity === "subtasks") return "subtasks";
  if (complexity === "project") return "project";
  return "single";
}

const short = (s: string, n = 26) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const destEntry = (t: Target, providers: ConnectedProvider[]) =>
  t.source === "LOCAL"
    ? providers.find((p) => p.source === "LOCAL")
    : providers.find((p) =>
        t.accountId ? p.id === t.accountId : p.provider === t.provider,
      );
const providerStatuses = (t: Target, providers: ConnectedProvider[]): string[] =>
  destEntry(t, providers)?.statuses ?? [];

export function ClarifyPanel({
  item,
  reclarify = false,
  onDone,
}: {
  item: GtdItem;
  /** Re-clarifying an already-processed task: seed from its CURRENT state, ask
   *  the server to preserve a SYNCED task's ClickUp binding, and lock the
   *  destination picker so the two-way sync target can't be moved. */
  reclarify?: boolean;
  /** Called after a decision is applied (the reclarify modal closes on this). */
  onDone?: () => void;
}) {
  const clarify = useTaskStore((s) => s.clarify);
  const backend = useTaskStore((s) => s.backend);
  const contexts = useTaskStore((s) => s.contexts);
  const people = useTaskStore((s) => s.people);
  const projects = useTaskStore((s) => s.projects);
  const providers = useTaskStore((s) => s.providers);
  const accounts = useTaskStore((s) => s.accounts);
  const refreshAccountMembers = useTaskStore((s) => s.refreshAccountMembers);
  const createWorkspaceProject = useTaskStore((s) => s.createWorkspaceProject);
  const localHierarchy = useTaskStore((s) => s.localHierarchy);
  const loadLocalHierarchy = useTaskStore((s) => s.loadLocalHierarchy);
  const createLocalSpace = useTaskStore((s) => s.createLocalSpace);
  const createLocalFolder = useTaskStore((s) => s.createLocalFolder);
  const createLocalProject = useTaskStore((s) => s.createLocalProject);
  const renameItem = useTaskStore((s) => s.renameItem);
  const mergeIntoExisting = useTaskStore((s) => s.mergeIntoExisting);
  const renameExistingFromCapture = useTaskStore((s) => s.renameExistingFromCapture);
  const fileUnderParent = useTaskStore((s) => s.fileUnderParent);

  // Re-clarify seeds the form from the task's CURRENT clarified state (an edit,
  // not a fresh decision). The item's own target is reconstructed so a SYNCED
  // task opens on its ClickUp destination.
  const currentTarget: Target = useMemo(
    () =>
      item.source === "SYNCED"
        ? { source: "SYNCED", provider: item.provider, accountId: item.accountId }
        : { source: "LOCAL", provider: "local" },
    [item.source, item.provider, item.accountId],
  );
  const localProposal = useMemo(
    () =>
      reclarify
        ? {
            ...proposeClarification(item, people, projects),
            disposition:
              item.disposition === "WAITING"
                ? ("WAITING" as ClarifyDisposition)
                : ("NEXT" as ClarifyDisposition),
            nextAction: item.nextAction || item.title,
            context: item.context ?? undefined,
            energy: item.energy,
            target: currentTarget,
            projectId: item.projectId,
            rationale:
              "Re-clarify — adjust the details or break this into next actions.",
          }
        : proposeClarification(item, people, projects),
    [item, people, projects, reclarify, currentTarget],
  );
  // The proposal shown in the AI block: starts as the instant local heuristic,
  // upgraded by the server's when it arrives (richer people/project knowledge
  // lives behind the gateway).
  const [proposal, setProposal] = useState<ClarifyProposal>(localProposal);
  // True once the user changed ANY field — a late server proposal must never
  // stomp on human edits.
  const dirtyRef = useRef(false);

  // ── Local title state (vague-title gate) ────────────────────────────────
  const [title, setTitle] = useState(item.title);
  const [vagueOpen, setVagueOpen] = useState(false);
  const [suggestedTitle, setSuggestedTitle] = useState<string | undefined>(undefined);
  const [titleBusy, setTitleBusy] = useState(false);
  const titleCleared = useRef(false); // user explicitly dismissed/accepted → don't re-show
  // Dismiss the "already on ClickUp?" banner to file this capture anyway.
  const [dupDismissed, setDupDismissed] = useState(false);
  // Dismiss the "file into this project" suggestion to choose a place manually.
  const [projectDismissed, setProjectDismissed] = useState(false);
  // Dismiss the "this is a step of an existing task" suggestion.
  const [parentDismissed, setParentDismissed] = useState(false);

  // ── Sort → Shape state ────────────────────────────────────────────────────
  const [sort, setSort] = useState<Sort>(sortOf(proposal.disposition));
  const [size, setSize] = useState<Size>(sizeOf(proposal.disposition, proposal.complexity));
  const [owner, setOwner] = useState<Owner>(proposal.suggestedAssignee ? "delegate" : "me");
  const [when, setWhen] = useState<When>("anytime");

  const [nextAction, setNextAction] = useState(proposal.nextAction);
  const [outcome, setOutcome] = useState(proposal.outcome ?? `${item.title} — done`);
  const [context, setContext] = useState(proposal.context ?? "@computer");
  const [energy, setEnergy] = useState<Energy>(proposal.energy ?? "medium");
  const [assignee, setAssignee] = useState<Person | null>(proposal.suggestedAssignee ?? null);
  const [dueAt, setDueAt] = useState("");
  const [dest, setDest] = useState<Target>(proposal.target ?? { source: "LOCAL", provider: "local" });
  const [projectId, setProjectId] = useState<string | undefined>(proposal.projectId);
  // The Where-axis TARGET when Size=project: create the new list under this
  // space (and optional folder). Independent of `projectId` (the existing-list
  // pick used for single/subtasks).
  const [targetSpaceId, setTargetSpaceId] = useState<string | undefined>(undefined);
  const [targetFolderId, setTargetFolderId] = useState<string | undefined>(undefined);
  const [newListName, setNewListName] = useState(item.title);
  // Subtasks the user chose to break this task into. Seeded from the
  // assistant's suggestion when it read the task as "needs subtasks".
  const [subtasks, setSubtasks] = useState<string[]>(
    proposal.complexity === "subtasks" || proposal.complexity === "project"
      ? proposal.suggestedSubtasks ?? []
      : [],
  );
  const [status, setStatus] = useState<string | undefined>(
    defaultStatus(proposal.disposition, providerStatuses(proposal.target ?? { source: "LOCAL" }, providers)),
  );

  // ── Server proposal upgrade (live backend only) ──────────────────────
  // The panel opened instantly on the local heuristic; swap in the server's
  // richer proposal when it lands — unless the user already touched the form
  // (dirtyRef, set by any interaction inside the panel root below).
  useEffect(() => {
    if (backend !== "live") return;
    let cancelled = false;
    apiClarifyPropose(item.id, reclarify)
      .then((sp) => {
        if (cancelled || dirtyRef.current) return;
        setProposal(sp);
        setSort(sortOf(sp.disposition));
        setSize(sizeOf(sp.disposition, sp.complexity));
        setOwner(sp.suggestedAssignee ? "delegate" : "me");
        setNextAction(sp.nextAction);
        setOutcome(sp.outcome ?? `${item.title} — done`);
        setContext(sp.context ?? "@computer");
        setEnergy(sp.energy ?? "medium");
        setAssignee(sp.suggestedAssignee ?? null);
        if (sp.target) setDest(sp.target);
        setProjectId(sp.projectId);
        setSubtasks(
          sp.complexity === "subtasks" || sp.complexity === "project"
            ? sp.suggestedSubtasks ?? []
            : [],
        );
        setStatus(
          sp.status ??
            defaultStatus(
              sp.disposition,
              providerStatuses(sp.target ?? { source: "LOCAL" }, providers),
            ),
        );
        if (sp.dueDate) {
          setWhen("date");
          setDueAt(sp.dueDate);
        }
        if (sp.isVague && !titleCleared.current) {
          setVagueOpen(true);
          setSuggestedTitle(sp.suggestedTitle);
        } else if (sp.suggestedTitle) {
          setSuggestedTitle(sp.suggestedTitle);
        }
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

  // Load the local hierarchy once (Where axis, local destination) if it hasn't
  // been fetched yet — the Projects view normally triggers this, but Clarify
  // can open first.
  useEffect(() => {
    if (backend === "live" && !localHierarchy) void loadLocalHierarchy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend]);

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
  const refreshedAccountsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const aid = destAccount?.id;
    if (!aid || refreshedAccountsRef.current.has(aid)) return;
    refreshedAccountsRef.current.add(aid);
    void refreshAccountMembers(aid);
  }, [destAccount?.id, refreshAccountMembers]);

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
  // cleared — reset-during-render, keeps the set-state-in-effect lint happy.
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

  const isSynced = dest.source === "SYNCED";
  // A re-clarified SYNCED task is two-way bound to its ClickUp list — the
  // destination (workspace + project) can't move, only the local cognition and
  // the break-down can change. The server flags this; lock the picker.
  const destLocked = reclarify && !!proposal.lockedDestination;

  const chooseDest = (t: Target) => {
    setDest(t);
    setProjectId(undefined);
    setTargetSpaceId(undefined);
    setTargetFolderId(undefined);
    setStatus(defaultStatus(sort === "actionable" ? "NEXT" : proposal.disposition, providerStatuses(t, providers)));
  };

  const chooseSize = (s: Size) => {
    setSize(s);
    // The Where target level changes with size — clear the picks so the tree
    // doesn't show a stale selection for the wrong node type.
    setProjectId(undefined);
    setTargetSpaceId(undefined);
    setTargetFolderId(undefined);
  };

  // ── Build the decision from the current Sort→Shape state ────────────────
  const buildDecision = useCallback((): ClarifyDecision | null => {
    if (sort === "do-now") return { kind: "do-now" };
    if (sort === "reference") return { kind: "reference" };
    if (sort === "trash") return { kind: "trash" };
    if (sort === "someday") return { kind: "someday", dest, projectId, status };

    // Actionable — Shape applies.
    const na = nextAction.trim();
    if (!na) return null;
    const dueIso = when === "date" && dueAt ? new Date(dueAt).toISOString() : undefined;
    const delegateTo = owner === "delegate" ? (assignee ?? undefined) : undefined;
    if (owner === "delegate" && !delegateTo) return null; // must pick someone

    if (size === "project") {
      if (!outcome.trim()) return null;
      return {
        kind: "project",
        outcome: outcome.trim(),
        nextAction: na,
        context,
        energy,
        dest,
        status,
        dueAt: dueIso,
        assignee: delegateTo,
        subtasks: subtasks.length ? subtasks : undefined,
      };
    }
    if (when === "date") {
      return {
        kind: "calendar",
        nextAction: na,
        dueAt: dueIso ?? snoozeOptions()[0].iso,
        context,
        dest,
        status,
        assignee: delegateTo,
      };
    }
    return {
      kind: "next",
      nextAction: na,
      context,
      energy,
      dest,
      projectId,
      status,
      dueAt: dueIso,
      assignee: delegateTo,
      subtasks: size === "subtasks" && subtasks.length ? subtasks : undefined,
    };
  }, [sort, size, owner, when, nextAction, outcome, context, energy, assignee,
      dueAt, dest, projectId, status, subtasks]);

  // A pending "create the project under this space/folder" is applied FIRST
  // (mints a real project), then the decision files into it.
  const [creatingTarget, setCreatingTarget] = useState(false);
  const [createTargetError, setCreateTargetError] = useState<string | null>(null);

  const apply = useCallback(async () => {
    // Size=project with no existing project picked but a Where target chosen:
    // create the new list/local-project under that space/folder first.
    if (sort === "actionable" && size === "project" && !projectId) {
      const name = newListName.trim() || nextAction.trim() || item.title;
      if (dest.source === "SYNCED" && targetSpaceId && destAccount) {
        setCreatingTarget(true);
        setCreateTargetError(null);
        try {
          const created = await createWorkspaceProject(destAccount.id, {
            name, spaceId: targetSpaceId, folderId: targetFolderId,
          });
          setProjectId(created.projectId);
        } catch (err) {
          setCreateTargetError(err instanceof Error ? err.message : "Could not create the project");
          setCreatingTarget(false);
          return;
        }
        setCreatingTarget(false);
      } else if (dest.source === "LOCAL" && (targetSpaceId || targetFolderId)) {
        setCreatingTarget(true);
        setCreateTargetError(null);
        try {
          await createLocalProject({ outcome: name, spaceId: targetSpaceId, folderId: targetFolderId });
        } catch (err) {
          setCreateTargetError(err instanceof Error ? err.message : "Could not create the project");
          setCreatingTarget(false);
          return;
        }
        setCreatingTarget(false);
      }
    }
    const decision = buildDecision();
    if (decision) {
      clarify(item.id, decision);
      onDone?.();
    }
  }, [sort, size, projectId, newListName, nextAction, item.id, item.title, dest,
      targetSpaceId, targetFolderId, destAccount, createWorkspaceProject,
      createLocalProject, buildDecision, clarify, onDone]);

  const canApply =
    sort !== "actionable"
      ? true
      : size === "project"
        ? !!(projectId || targetSpaceId) && !!buildDecision()
        : !!buildDecision();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable))
        return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Enter" && canApply) {
        e.preventDefault();
        void apply();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [apply, canApply]);

  // ── Title: "Improve" (always available) + the vague-title gate ─────────
  const runSuggestTitle = useCallback(async () => {
    if (backend !== "live") return;
    setTitleBusy(true);
    try {
      const r = await apiSuggestTitle(item.id, title);
      setSuggestedTitle(r.suggestedTitle);
      if (r.suggestedTitle) setVagueOpen(true);
    } catch {
      /* best-effort */
    } finally {
      setTitleBusy(false);
    }
  }, [backend, item.id, title]);

  const acceptTitle = () => {
    if (suggestedTitle) {
      setTitle(suggestedTitle);
      renameItem(item.id, suggestedTitle);
    }
    titleCleared.current = true;
    setVagueOpen(false);
  };
  const keepTitle = () => {
    titleCleared.current = true;
    setVagueOpen(false);
  };

  const trashNow = () => {
    clarify(item.id, { kind: "trash" });
    onDone?.();
  };

  const Meta = SORT_META[sortOf(proposal.disposition)];
  const SizeIcon = SIZE_META[sizeOf(proposal.disposition, proposal.complexity)].icon;
  const proposedDestLabel = proposal.target
    ? destEntry(proposal.target!, providers)?.label
    : undefined;
  const proposedProject = proposal.projectId ? projects.find((p) => p.id === proposal.projectId) : undefined;
  const dimmed = vagueOpen; // best-effort: the recommend block dims until the title is clear
  const bigSuggestion = proposal.complexity === "subtasks" || proposal.complexity === "project";

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
            {reclarify ? "Re-clarify" : "Clarify"}
          </span>
          <SourceBadge source={item.source} provider={item.provider} />
        </div>
        <div className="flex items-start gap-2">
          <h1 className="flex-1 text-lg font-bold leading-snug text-foreground">{title}</h1>
          <button
            type="button"
            onClick={() => void runSuggestTitle()}
            disabled={titleBusy || backend !== "live"}
            title="Rephrase this title with AI"
            className="tech-transition mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-md border border-primary/30 bg-primary/5 px-2 py-1 text-[11px] font-medium text-primary hover:bg-primary/10 disabled:opacity-40"
          >
            {titleBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}
            Improve
          </button>
        </div>
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
          {reclarify
            ? "Refine this — or break it into next actions."
            : "What is it — and what needs to happen next?"}
        </p>
      </header>

      <div className="flex flex-col gap-4 px-5 py-4">
        {/* Possible duplicate already on the PM tool — offer to merge into it or
            drop this capture before we file a second copy. Only on a fresh
            inbox clarify (a reclarified task IS the synced task). */}
        {!reclarify && proposal.duplicate && !dupDismissed && (
          <DuplicateBanner
            dup={proposal.duplicate}
            captureTitle={item.title}
            onMerge={async () => {
              await mergeIntoExisting(item.id, proposal.duplicate!.itemId);
              onDone?.();
            }}
            onRename={async (newTitle) => {
              await renameExistingFromCapture(
                item.id, proposal.duplicate!.itemId, newTitle,
              );
              onDone?.();
            }}
            onDrop={() => { clarify(item.id, { kind: "trash" }); onDone?.(); }}
            onDismiss={() => setDupDismissed(true)}
          />
        )}

        {/* Vague-title banner (soft gate) */}
        {vagueOpen && (
          <div className="flex flex-col gap-2 rounded-lg border border-warning/45 bg-warning/10 p-3">
            <div className="flex items-start gap-2 text-[13px] font-semibold text-foreground">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <span>
                {proposal.isVague
                  ? "This title is vague — clarify it so the assistant can clarify the rest"
                  : "A clearer title is available"}
              </span>
            </div>
            {proposal.isVague && (
              <p className="text-[11.5px] text-muted-foreground">
                A specific title makes the owner, context, and next steps far more accurate.
              </p>
            )}
            {suggestedTitle && (
              <div className="flex flex-col gap-1">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Assistant suggests
                </span>
                <input
                  value={suggestedTitle}
                  onChange={(e) => setSuggestedTitle(e.target.value)}
                  className="w-full rounded-md border border-border bg-background/60 px-3 py-2 text-base text-foreground focus:border-primary/50 focus:outline-none sm:text-sm"
                />
              </div>
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={acceptTitle}
                disabled={!suggestedTitle}
                className="tech-transition inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-[12px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
              >
                <Check className="h-3.5 w-3.5" />
                Use this title
              </button>
              <button
                type="button"
                onClick={keepTitle}
                className="tech-transition rounded-md px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                Keep original
              </button>
            </div>
          </div>
        )}

        {/* Sub-step of an existing task — file this as a subtask under it
            rather than a standalone (clarify-only, scoped to the matched
            project). Takes priority over the project suggestion (filing under
            a parent already places it in that project). */}
        {!reclarify && !proposal.duplicate && proposal.parentSuggestion &&
          !parentDismissed && (
          <ParentSuggestBanner
            parentTitle={proposal.parentSuggestion.title}
            onFileUnder={async () => {
              await fileUnderParent(item.id, proposal.parentSuggestion!.itemId);
              onDone?.();
            }}
            onDismiss={() => setParentDismissed(true)}
          />
        )}

        {/* Suggested project — file this into an existing local/ClickUp project
            it logically belongs to (parallel to the duplicate check). Hidden
            when a duplicate is already flagged (that decision comes first) or
            when a parent-task suggestion is active (that files it too). */}
        {!reclarify && !proposal.duplicate && proposal.projectInferred &&
          proposal.projectId && proposedProject && !projectDismissed &&
          (!proposal.parentSuggestion || parentDismissed) && (
          <ProjectSuggestBanner
            project={proposedProject}
            providerLabel={
              proposedProject.source !== "LOCAL" && proposal.target
                ? destEntry(proposal.target, providers)?.label
                : undefined
            }
            assignee={owner === "delegate" ? assignee : null}
            onFile={() => void apply()}
            onDismiss={() => setProjectDismissed(true)}
          />
        )}

        {/* AI proposal — review & confirm. Leads with SIZE + concrete steps. */}
        <div
          className={[
            "relative rounded-lg border border-primary/30 bg-primary/5 p-3 transition-opacity",
            dimmed ? "opacity-60" : "",
          ].join(" ")}
        >
          {dimmed && (
            <span className="absolute -top-2 right-3 rounded bg-card px-1.5 text-[9px] font-semibold uppercase tracking-wide text-warning">
              Improves once the title is clear
            </span>
          )}
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
            {Meta.label}
            {Meta.label === "Actionable" && (
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                · <SizeIcon className="h-3.5 w-3.5" />
                {SIZE_META[sizeOf(proposal.disposition, proposal.complexity)].label}
              </span>
            )}
            {proposal.suggestedAssignee && (
              <span className="text-muted-foreground">→ {proposal.suggestedAssignee.name}</span>
            )}
          </div>
          {proposal.disposition === "PROJECT" && proposal.outcome && (
            <p className="mt-1.5 text-[13px] text-muted-foreground">
              Outcome: <span className="text-foreground">{proposal.outcome}</span>
            </p>
          )}
          {sortOf(proposal.disposition) === "actionable" && !bigSuggestion && (
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
            {proposal.dueDate && (
              <span className="inline-flex items-center gap-1">
                <CalendarDays className="h-3 w-3" /> by {proposal.dueDate}
              </span>
            )}
            {sortOf(proposal.disposition) === "actionable" && proposedDestLabel && (
              <span className="inline-flex items-center gap-1 rounded bg-secondary px-1.5 py-0.5 font-medium">
                {proposal.target?.source === "LOCAL" ? (
                  <HardDrive className="h-3 w-3" />
                ) : (
                  <Cloud className="h-3 w-3" />
                )}
                {proposedDestLabel}
                {proposedProject ? ` · ${short(proposedProject.outcome, 16)}` : ""}
              </span>
            )}
          </div>

          {/* The assistant's break-down — numbered, editable, created on accept. */}
          {bigSuggestion && (
            <div className="mt-2.5 flex flex-col gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Next actions to create
              </span>
              <SubtaskEditor value={subtasks} onChange={setSubtasks} numbered />
            </div>
          )}

          <p className="mt-1.5 text-[11px] italic text-muted-foreground">{proposal.rationale}</p>
          <div className="mt-2.5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void apply()}
              disabled={creatingTarget}
              className="tech-transition inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-[12px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
            >
              {creatingTarget ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              {bigSuggestion
                ? `Accept & create all ${subtasks.length || 1} step${subtasks.length === 1 ? "" : "s"}`
                : "Accept & next"}
            </button>
            <button
              type="button"
              onClick={trashNow}
              title="Trash this — it's not actionable"
              className="tech-transition ml-auto inline-flex items-center gap-1.5 rounded-md border border-transparent px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Trash
            </button>
          </div>
        </div>

        {/* STEP 1 — Sort */}
        <Field label="Sort it — what kind of thing is this?">
          <div className="flex flex-wrap gap-1.5">
            {SORT_ORDER.map((s) => {
              const M = SORT_META[s];
              const active = sort === s;
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSort(s)}
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

        {/* STEP 2 — Shape (only when Sort=Actionable) */}
        {sort === "actionable" && (
          <div className="flex flex-col gap-3.5 border-t border-border pt-3.5">
            <Field label="Shape it — these combine freely">
              <div className="flex flex-col gap-3">
                <SubField label="Size">
                  <div className="flex flex-wrap gap-1.5">
                    {(["single", "subtasks", "project"] as Size[]).map((s) => {
                      const M = SIZE_META[s];
                      const active = size === s;
                      return (
                        <button
                          key={s}
                          type="button"
                          onClick={() => chooseSize(s)}
                          className={[
                            "tech-transition inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px]",
                            active ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-secondary",
                          ].join(" ")}
                        >
                          <M.icon className="h-3.5 w-3.5" />
                          {M.label}
                        </button>
                      );
                    })}
                  </div>
                </SubField>

                {(size === "project" ? "outcome" : "next-action") === "outcome" && (
                  <SubField label="Outcome">
                    <input
                      value={outcome}
                      onChange={(e) => setOutcome(e.target.value)}
                      className="w-full rounded-md border border-border bg-background/60 px-3 py-2 text-base text-foreground focus:border-primary/50 focus:outline-none sm:text-sm"
                      placeholder="What does 'done' look like?"
                    />
                  </SubField>
                )}

                <SubField label={size === "project" ? "First next action" : "Next action"}>
                  <input
                    value={nextAction}
                    onChange={(e) => setNextAction(e.target.value)}
                    className="w-full rounded-md border border-border bg-background/60 px-3 py-2 text-base text-foreground focus:border-primary/50 focus:outline-none sm:text-sm"
                    placeholder="The next physical, visible step…"
                  />
                </SubField>

                {(size === "subtasks" || size === "project") && (
                  <SubField label="Steps">
                    <SubtaskEditor value={subtasks} onChange={setSubtasks} />
                  </SubField>
                )}

                <SubField label="Owner">
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => setOwner("me")}
                      className={[
                        "tech-transition inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px]",
                        owner === "me" ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-secondary",
                      ].join(" ")}
                    >
                      <User className="h-3.5 w-3.5" /> Me
                    </button>
                    <button
                      type="button"
                      onClick={() => setOwner("delegate")}
                      className={[
                        "tech-transition inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px]",
                        owner === "delegate" ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-secondary",
                      ].join(" ")}
                    >
                      <UserPlus className="h-3.5 w-3.5" /> Delegate →
                    </button>
                  </div>
                  {owner === "delegate" && (
                    <div className="mt-2">
                      <PeoplePicker people={peopleForDelegate} value={assignee} onChange={setAssignee} />
                    </div>
                  )}
                </SubField>

                <SubField label="When">
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => setWhen("anytime")}
                      className={[
                        "tech-transition inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px]",
                        when === "anytime" ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-secondary",
                      ].join(" ")}
                    >
                      Anytime
                    </button>
                    <button
                      type="button"
                      onClick={() => setWhen("date")}
                      className={[
                        "tech-transition inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px]",
                        when === "date" ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-secondary",
                      ].join(" ")}
                    >
                      <CalendarClock className="h-3.5 w-3.5" /> By a date →
                    </button>
                  </div>
                  {when === "date" && (
                    <input
                      type="date"
                      value={dueAt}
                      onChange={(e) => setDueAt(e.target.value)}
                      className="mt-2 rounded-md border border-border bg-background/60 px-3 py-2 text-base text-foreground focus:border-primary/50 focus:outline-none sm:text-sm"
                    />
                  )}
                </SubField>

                <SubField label="Energy">
                  <div className="flex gap-1.5">
                    {(["low", "medium", "high"] as Energy[]).map((e) => (
                      <Pill key={e} active={energy === e} onClick={() => setEnergy(e)}>
                        {e}
                      </Pill>
                    ))}
                  </div>
                </SubField>

                <SubField label="Context">
                  <div className="flex flex-wrap gap-1.5">
                    {contexts.map((c) => (
                      <Pill key={c.name} mono active={context === c.name} onClick={() => setContext(c.name)}>
                        {c.name}
                      </Pill>
                    ))}
                  </div>
                </SubField>

                {/* Where — present for EVERY actionable task, single or broken-down.
                    Target level follows Size: list (single/subtasks) vs space/folder (project). */}
                <SubField label="Where">
                  {destLocked ? (
                    <LockedWhere dest={dest} providers={providers} selectedProject={selectedProject}
                      statuses={statusesForDest} status={status} setStatus={setStatus} />
                  ) : (
                    <div className="flex flex-col gap-2.5">
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

                      {size === "project" ? (
                        <ProjectTargetTree
                          dest={dest}
                          destAccount={destAccount}
                          localHierarchy={localHierarchy}
                          value={{ spaceId: targetSpaceId, folderId: targetFolderId }}
                          onChange={(v) => { setTargetSpaceId(v.spaceId); setTargetFolderId(v.folderId); }}
                          onCreateSpace={createLocalSpace}
                          onCreateFolder={createLocalFolder}
                        />
                      ) : (
                        <ProjectListTree
                          dest={dest}
                          destAccount={destAccount}
                          localHierarchy={localHierarchy}
                          projectsForDest={projectsForDest}
                          suggestedId={proposal.projectInferred ? proposal.projectId : undefined}
                          value={projectId}
                          onChange={setProjectId}
                          onCreate={async (spaceId, folderId, name) => {
                            if (dest.source === "SYNCED" && destAccount) {
                              const created = await createWorkspaceProject(destAccount.id, { name, spaceId, folderId });
                              setProjectId(created.projectId);
                            } else {
                              await createLocalProject({ outcome: name, spaceId, folderId });
                            }
                          }}
                        />
                      )}

                      {size === "project" && (targetSpaceId || targetFolderId) && (
                        <SubField label="New project name">
                          <input
                            value={newListName}
                            onChange={(e) => setNewListName(e.target.value)}
                            className="w-full rounded-md border border-border bg-background/60 px-3 py-2 text-base text-foreground focus:border-primary/50 focus:outline-none sm:text-sm"
                          />
                        </SubField>
                      )}
                      {createTargetError && (
                        <p className="text-[11px] text-destructive">{createTargetError}</p>
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
                      {!isSynced && (
                        <p className="text-[10px] text-muted-foreground">
                          Private to you. File it in a local space/list, or leave it loose.
                        </p>
                      )}
                    </div>
                  )}
                </SubField>
              </div>
            </Field>

            <button
              type="button"
              disabled={!canApply || creatingTarget}
              onClick={() => void apply()}
              className={[
                "tech-transition inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2.5 text-sm font-medium",
                canApply && !creatingTarget
                  ? "bg-primary text-primary-foreground hover:opacity-90"
                  : "cursor-not-allowed bg-secondary text-muted-foreground",
              ].join(" ")}
            >
              {creatingTarget ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Organize it <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// The "belongs in an existing project?" banner shown during inbox processing
// when the assistant infers this capture logically fits a local or ClickUp
// project. One tap files it there as a next action; the outcome line spells out
// where it will surface (mine → My Next Actions; delegated → under that person
// in Projects, and on ClickUp).
function ProjectSuggestBanner({
  project,
  providerLabel,
  assignee,
  onFile,
  onDismiss,
}: {
  project: GtdProject;
  providerLabel?: string;
  assignee: Person | null;
  onFile: () => void;
  onDismiss: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const synced = project.source !== "LOCAL";
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-primary/35 bg-primary/5 p-3">
      <div className="flex items-start gap-2 text-[13px] font-semibold text-foreground">
        <FolderKanban className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <span>Looks like it belongs in an existing project</span>
      </div>
      <div className="rounded-md border border-border bg-background/50 px-3 py-2">
        <div className="flex items-center gap-1.5 text-[12.5px] text-foreground">
          {synced ? (
            <Cloud className="h-3.5 w-3.5 shrink-0 text-primary/70" />
          ) : (
            <HardDrive className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate" title={project.outcome}>{project.outcome}</span>
        </div>
        <div className="mt-0.5 pl-5 text-[10.5px] text-muted-foreground">
          {synced ? (providerLabel ?? "ClickUp") : "Local project"}
        </div>
      </div>
      <p className="flex items-start gap-1.5 text-[11.5px] text-muted-foreground">
        <ArrowRight className="mt-0.5 h-3 w-3 shrink-0 text-primary/70" />
        {assignee
          ? `Assigned to ${assignee.name} — it'll show under them in Projects${synced ? ", and stays on ClickUp" : ""}.`
          : `Assigned to you — it'll show up in My Next Actions${synced ? ", and on ClickUp" : ""}.`}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => { setBusy(true); onFile(); }}
          className="tech-transition inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-[12px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          File it here
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="tech-transition ml-auto rounded-md px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          Choose another place
        </button>
      </div>
    </div>
  );
}

// The "looks like a step of an existing task" banner shown during inbox
// processing when the assistant infers this capture is a sub-step of a task in
// the matched project. One tap files it as a subtask under that task.
function ParentSuggestBanner({
  parentTitle,
  onFileUnder,
  onDismiss,
}: {
  parentTitle: string;
  onFileUnder: () => Promise<void>;
  onDismiss: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-primary/35 bg-primary/5 p-3">
      <div className="flex items-start gap-2 text-[13px] font-semibold text-foreground">
        <ListTree className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <span>Looks like a step of an existing task</span>
      </div>
      <div className="rounded-md border border-border bg-background/50 px-3 py-2">
        <div className="flex items-center gap-1.5 text-[12.5px] text-foreground">
          <FolderKanban className="h-3.5 w-3.5 shrink-0 text-primary/70" />
          <span className="min-w-0 flex-1 truncate" title={parentTitle}>{parentTitle}</span>
        </div>
      </div>
      <p className="flex items-start gap-1.5 text-[11.5px] text-muted-foreground">
        <ArrowRight className="mt-0.5 h-3 w-3 shrink-0 text-primary/70" />
        File it as a subtask under this task instead of a standalone one.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={async () => { setBusy(true); try { await onFileUnder(); } finally { setBusy(false); } }}
          className="tech-transition inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-[12px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ListTree className="h-3.5 w-3.5" />}
          File as subtask
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="tech-transition ml-auto rounded-md px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          It&apos;s its own task
        </button>
      </div>
    </div>
  );
}

// The "already on ClickUp?" banner shown during inbox processing when a
// token-free lexical match finds a likely-existing PM-tool task. Offers four
// exits: fold this capture INTO the existing task (merge), rename the existing
// task to this capture's clearer title (rename — back-syncs for a SYNCED
// target, then drops the capture), drop this capture (it's a duplicate), or
// dismiss and file it anyway (keep both).
function DuplicateBanner({
  dup,
  captureTitle,
  onMerge,
  onRename,
  onDrop,
  onDismiss,
}: {
  dup: NonNullable<ClarifyProposal["duplicate"]>;
  captureTitle: string;
  onMerge: () => Promise<void>;
  onRename: (newTitle: string) => Promise<void>;
  onDrop: () => void;
  onDismiss: () => void;
}) {
  const [busy, setBusy] = useState<null | "merge" | "drop" | "rename">(null);
  // Inline rename editor: seeded with the capture's (usually more descriptive)
  // title so one tap makes the existing task clearer.
  const [renaming, setRenaming] = useState(false);
  const [renameTitle, setRenameTitle] = useState(captureTitle);
  const run = async (
    which: "merge" | "drop" | "rename",
    fn: () => void | Promise<void>,
  ) => {
    setBusy(which);
    try { await fn(); } finally { setBusy(null); }
  };
  const canRename = renameTitle.trim().length > 0
    && renameTitle.trim() !== dup.title.trim();
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-warning/45 bg-warning/10 p-3">
      <div className="flex items-start gap-2 text-[13px] font-semibold text-foreground">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <span>
          {dup.verdict === "duplicate"
            ? "This looks like a task that's already on ClickUp"
            : "A similar task may already be on ClickUp"}
        </span>
      </div>
      <div className="rounded-md border border-border bg-background/50 px-3 py-2">
        <div className="flex items-center gap-1.5 text-[12.5px] text-foreground">
          <Cloud className="h-3.5 w-3.5 shrink-0 text-primary/70" />
          <span className="min-w-0 flex-1 truncate" title={dup.title}>{dup.title}</span>
          {dup.providerUrl && (
            <a
              href={dup.providerUrl}
              target="_blank"
              rel="noreferrer"
              className="tech-transition shrink-0 text-[11px] font-medium text-primary hover:underline"
            >
              Open
            </a>
          )}
        </div>
        {(dup.projectName || dup.providerStatus) && (
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 pl-5 text-[10.5px] text-muted-foreground">
            {dup.projectName && <span>{dup.projectName}</span>}
            {dup.providerStatus && <span>· {dup.providerStatus}</span>}
          </div>
        )}
      </div>
      {renaming ? (
        // Rename the EXISTING task to a clearer title from this capture, then
        // drop the capture. Back-syncs upstream for a SYNCED target.
        <div className="flex flex-col gap-2 rounded-md border border-primary/30 bg-background/50 p-2.5">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Rename the existing task to
          </span>
          <input
            value={renameTitle}
            onChange={(e) => setRenameTitle(e.target.value)}
            autoFocus
            className="w-full rounded-md border border-border bg-background/60 px-3 py-2 text-base text-foreground focus:border-primary/50 focus:outline-none sm:text-sm"
          />
          <p className="text-[10.5px] text-muted-foreground">
            Updates the task everywhere it lives (including ClickUp) and drops this inbox item.
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy !== null || !canRename}
              onClick={() => void run("rename", () => onRename(renameTitle))}
              className="tech-transition inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-[12px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {busy === "rename" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              Save name
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => { setRenaming(false); setRenameTitle(captureTitle); }}
              className="tech-transition rounded-md px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void run("merge", onMerge)}
            className="tech-transition inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-[12px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {busy === "merge" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            Add to existing task
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => setRenaming(true)}
            className="tech-transition inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px] font-medium text-foreground hover:border-primary/40 hover:bg-primary/10 disabled:opacity-50"
          >
            <Pencil className="h-3.5 w-3.5" />
            Update its name
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void run("drop", onDrop)}
            className="tech-transition inline-flex items-center gap-1.5 rounded-md border border-transparent px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
          >
            {busy === "drop" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            Delete this inbox item
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={onDismiss}
            className="tech-transition ml-auto rounded-md px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50"
          >
            Not a duplicate
          </button>
        </div>
      )}
    </div>
  );
}

function LockedWhere({
  dest, providers, selectedProject, statuses, status, setStatus,
}: {
  dest: Target;
  providers: ConnectedProvider[];
  selectedProject?: GtdProject;
  statuses: string[];
  status?: string;
  setStatus: (s: string) => void;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 rounded-md border border-border bg-background/40 px-3 py-2">
        <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[12px] text-foreground">
          <Cloud className="h-3.5 w-3.5 text-primary/70" />
          {destEntry(dest, providers)?.label ?? "ClickUp"}
          {selectedProject && (
            <>
              <span className="text-border">·</span>
              <FolderKanban className="h-3 w-3 text-muted-foreground" />
              {short(selectedProject.outcome, 22)}
            </>
          )}
        </span>
      </div>
      {statuses.length > 0 && (
        <div className="mt-2">
          <SubField label="Stage">
            <div className="flex flex-wrap gap-1.5">
              {statuses.map((s) => (
                <Pill key={s} plain active={status === s} onClick={() => setStatus(s)}>
                  {s}
                </Pill>
              ))}
            </div>
          </SubField>
        </div>
      )}
      <p className="mt-1.5 text-[10px] text-muted-foreground">
        Two-way synced with ClickUp — the workspace and list stay put. You can
        still change size, owner, timing, stage, and break it into steps.
      </p>
    </div>
  );
}

// A small add/remove list for breaking a task into concrete subtasks. Seeded
// from the assistant's suggestion; the user edits before applying.
function SubtaskEditor({
  value,
  onChange,
  numbered,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  numbered?: boolean;
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
          {numbered ? (
            <span className="flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded bg-primary/15 text-[10px] font-bold text-primary">
              {idx + 1}
            </span>
          ) : (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary/50" />
          )}
          <input
            value={s}
            onChange={(e) => edit(idx, e.target.value)}
            onBlur={() => { if (!s.trim()) remove(idx); }}
            className="min-w-0 flex-1 rounded-md border border-border bg-background/60 px-2 py-1.5 text-[13px] text-foreground focus:border-primary/50 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => remove(idx)}
            aria-label="Remove step"
            className="tech-transition shrink-0 rounded p-1 text-muted-foreground/60 hover:bg-destructive/10 hover:text-destructive"
          >
            <X className="h-3.5 w-3.5" />
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
    </div>
  );
}

function PeoplePicker({
  people,
  value,
  onChange,
}: {
  people: Person[];
  value: Person | null;
  onChange: (p: Person | null) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
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
      {!people.length && (
        <p className="text-[11px] text-muted-foreground">No teammates available yet.</p>
      )}
    </div>
  );
}

// ── Where: a normalized Space→Folder→List tree, shared by both picker modes ──

interface TNode {
  id: string;
  type: "space" | "folder" | "list";
  name: string;
  children?: TNode[];
  /** the mirrored gtd project id, for LIST nodes only. */
  projectId?: string;
}

/** Build one normalized tree from either a ClickUp account's hierarchy or the
 *  LOCAL space/folder/project tables — so both picker modes share one render. */
function buildTree(
  dest: Target,
  destAccount: TaskAccount | undefined,
  localHierarchy: import("../lib/api").LocalHierarchy | null,
  projectsForDest: GtdProject[],
): TNode[] {
  if (dest.source === "SYNCED") {
    if (!destAccount || !destAccount.hierarchy.length) return [];
    const byRef = new Map<string, GtdProject>();
    for (const p of projectsForDest) if (p.providerRef) byRef.set(p.providerRef, p);
    return destAccount.hierarchy.map((sp) => ({
      id: sp.id, type: "space" as const, name: sp.name,
      children: [
        ...sp.lists.map((l) => ({
          id: l.id, type: "list" as const, name: l.name, projectId: byRef.get(l.id)?.id,
        })),
        ...sp.folders.map((f) => ({
          id: f.id, type: "folder" as const, name: f.name,
          children: f.lists.map((l) => ({
            id: l.id, type: "list" as const, name: l.name, projectId: byRef.get(l.id)?.id,
          })),
        })),
      ],
    }));
  }
  if (!localHierarchy) return [];
  const foldersBySpace = new Map<string, typeof localHierarchy.folders>();
  for (const f of localHierarchy.folders) {
    foldersBySpace.set(f.spaceId, [...(foldersBySpace.get(f.spaceId) ?? []), f]);
  }
  const projByFolder = new Map<string, GtdProject[]>();
  const projBySpaceOnly = new Map<string, GtdProject[]>();
  for (const p of projectsForDest) {
    if (p.folderId) projByFolder.set(p.folderId, [...(projByFolder.get(p.folderId) ?? []), p]);
    else if (p.spaceId) projBySpaceOnly.set(p.spaceId, [...(projBySpaceOnly.get(p.spaceId) ?? []), p]);
  }
  return localHierarchy.spaces.map((sp) => ({
    id: sp.id, type: "space" as const, name: sp.name,
    children: [
      ...(projBySpaceOnly.get(sp.id) ?? []).map((p) => ({
        id: p.id, type: "list" as const, name: p.outcome, projectId: p.id,
      })),
      ...(foldersBySpace.get(sp.id) ?? []).map((f) => ({
        id: f.id, type: "folder" as const, name: f.name,
        children: (projByFolder.get(f.id) ?? []).map((p) => ({
          id: p.id, type: "list" as const, name: p.outcome, projectId: p.id,
        })),
      })),
    ],
  }));
}

/** The value-space id of a node. A LIST leaf is selected by its MIRRORED gtd
 *  project id (what the card stores + sends to organize), not its own id — for
 *  a SYNCED list `id` is the ClickUp list id while `projectId` is the local
 *  mirror. (For LOCAL lists projectId === id, so this is a no-op there.) Every
 *  other node is selected by its own id. Comparing against this — instead of
 *  raw `n.id` — is what makes a picked/suggested ClickUp list actually light
 *  up and the tree auto-expand to it. */
const selId = (n: TNode): string | undefined => (n.type === "list" ? n.projectId : n.id);

/** Where picker for Size=single/subtasks: navigate the tree, select a LIST
 *  (leaf) — the task is created INTO it. Mirrors ClickUp's own navigation. */
function ProjectListTree({
  dest,
  destAccount,
  localHierarchy,
  projectsForDest,
  suggestedId,
  value,
  onChange,
  onCreate,
}: {
  dest: Target;
  destAccount: TaskAccount | undefined;
  localHierarchy: import("../lib/api").LocalHierarchy | null;
  projectsForDest: GtdProject[];
  suggestedId?: string;
  value?: string;
  onChange: (id: string | undefined) => void;
  onCreate: (spaceId: string, folderId: string | undefined, name: string) => Promise<void>;
}) {
  const tree = useMemo(
    () => buildTree(dest, destAccount, localHierarchy, projectsForDest),
    [dest, destAccount, localHierarchy, projectsForDest],
  );
  return (
    <TreePicker
      tree={tree}
      pickTypes={["list"]}
      value={value}
      suggestedId={suggestedId}
      newLabel={dest.source === "SYNCED" ? "New list here…" : "New project here…"}
      emptyLabel="No project"
      onSelectLeaf={(node) => onChange(node?.projectId)}
      onCreate={onCreate}
    />
  );
}

/** Where picker for Size=project: navigate the tree, select a SPACE **or**
 *  FOLDER (either is valid) — the new list/local project is created under it. */
function ProjectTargetTree({
  dest,
  destAccount,
  localHierarchy,
  value,
  onChange,
  onCreateSpace,
  onCreateFolder,
}: {
  dest: Target;
  destAccount: TaskAccount | undefined;
  localHierarchy: import("../lib/api").LocalHierarchy | null;
  value: { spaceId?: string; folderId?: string };
  onChange: (v: { spaceId?: string; folderId?: string }) => void;
  onCreateSpace: (name: string) => Promise<void>;
  onCreateFolder: (spaceId: string, name: string) => Promise<void>;
}) {
  const tree = useMemo(
    () => buildTree(dest, destAccount, localHierarchy, []),
    [dest, destAccount, localHierarchy],
  );
  const selectedId = value.folderId ?? value.spaceId;
  return (
    <div className="flex flex-col gap-1.5">
      <TreePicker
        tree={tree}
        pickTypes={["space", "folder"]}
        value={selectedId}
        newLabel={dest.source === "SYNCED" ? "New space…" : "New space…"}
        emptyLabel="Choose a space or folder"
        onSelectTarget={(node) => {
          if (!node) return onChange({});
          if (node.type === "space") onChange({ spaceId: node.id });
          else onChange({ spaceId: findParentSpace(tree, node.id), folderId: node.id });
        }}
        onCreate={async (spaceId, folderId, name) => {
          if (folderId) return; // folders are created inline below, not via row-create
          if (!spaceId) {
            // top-level "new space" row.
            await onCreateSpace(name);
            return;
          }
          await onCreateFolder(spaceId, name);
        }}
      />
      {dest.source === "LOCAL" && value.spaceId && !value.folderId && (
        <InlineCreateFolder spaceId={value.spaceId} onCreate={onCreateFolder} />
      )}
    </div>
  );
}

function findParentSpace(tree: TNode[], folderId: string): string | undefined {
  for (const sp of tree) {
    if (sp.children?.some((c) => c.id === folderId && c.type === "folder")) return sp.id;
  }
  return undefined;
}

function InlineCreateFolder({
  spaceId,
  onCreate,
}: {
  spaceId: string;
  onCreate: (spaceId: string, name: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="tech-transition ml-4 flex items-center gap-1.5 text-left text-[12px] text-primary hover:underline"
      >
        <Plus className="h-3 w-3" /> New folder here
      </button>
    );
  }
  return (
    <div className="ml-4 flex items-center gap-1.5">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Folder name…"
        className="flex-1 rounded-md border border-border bg-background/60 px-2.5 py-1.5 text-base text-foreground focus:border-primary/50 focus:outline-none sm:text-[13px]"
      />
      <button
        type="button"
        disabled={!name.trim() || busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onCreate(spaceId, name.trim());
            setOpen(false);
            setName("");
          } finally {
            setBusy(false);
          }
        }}
        className="tech-transition inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-[12px] font-medium text-primary-foreground disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
        Create
      </button>
    </div>
  );
}

/** Generic tree renderer shared by both picker modes. In "leaf" mode only LIST
 *  nodes are selectable; in "target" mode SPACE and FOLDER nodes are (lists
 *  are shown but disabled — navigation only). */
function TreePicker({
  tree,
  pickTypes,
  value,
  suggestedId,
  newLabel,
  emptyLabel,
  onSelectLeaf,
  onSelectTarget,
  onCreate,
}: {
  tree: TNode[];
  pickTypes: ("space" | "folder" | "list")[];
  value?: string;
  suggestedId?: string;
  newLabel: string;
  emptyLabel: string;
  onSelectLeaf?: (node: TNode | undefined) => void;
  onSelectTarget?: (node: TNode | undefined) => void;
  onCreate: (spaceId: string, folderId: string | undefined, name: string) => Promise<void>;
}) {
  const [q, setQ] = useState("");
  const [openIds, setOpenIds] = useState<Set<string>>(() => {
    const open = new Set<string>();
    if (tree.length === 1) open.add(tree[0].id);
    // Auto-expand the ancestor of the current/suggested selection.
    const target = value ?? suggestedId;
    if (target) {
      for (const sp of tree) {
        const hasIt = (n: TNode): boolean =>
          selId(n) === target || (n.children?.some(hasIt) ?? false);
        if (hasIt(sp)) open.add(sp.id);
        for (const c of sp.children ?? []) {
          if (c.type === "folder" && (c.children?.some((l) => selId(l) === target) ?? false)) {
            open.add(c.id);
          }
        }
      }
    }
    return open;
  });
  const [creatingAt, setCreatingAt] = useState<string | "top" | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const toggle = (id: string) =>
    setOpenIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const select = (n: TNode) => {
    if (!pickTypes.includes(n.type)) return;
    // A LIST with no mirrored gtd project id can't be a target yet (its schema
    // refresh hasn't landed) — don't bind the task to nothing.
    if (n.type === "list" && selId(n) === undefined) return;
    if (onSelectLeaf) onSelectLeaf(n);
    if (onSelectTarget) onSelectTarget(n);
  };

  const submitCreate = async (spaceId: string | undefined, folderId: string | undefined) => {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      await onCreate(spaceId ?? "", folderId, name);
      setCreatingAt(null);
      setNewName("");
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Could not create it");
    } finally {
      setCreating(false);
    }
  };

  const row = (n: TNode, depth: number, ancestorSpaceId?: string) => {
    const selectable = pickTypes.includes(n.type);
    const sid = selId(n);
    // A LIST whose mirrored gtd project hasn't loaded yet (schema still
    // syncing) is shown but disabled — picking it would bind to nothing.
    const unmirrored = n.type === "list" && sid === undefined;
    const canSelect = selectable && !unmirrored;
    const active = canSelect && sid === value;
    const isSuggested = canSelect && sid === suggestedId;
    const hasKids = !!n.children?.length;
    const isOpen = openIds.has(n.id);
    const Icon = n.type === "space" ? HardDrive : n.type === "folder" ? FolderKanban : ListChecks;
    return (
      <div key={n.id}>
        <button
          type="button"
          onClick={() => (hasKids && !canSelect ? toggle(n.id) : select(n))}
          disabled={!canSelect && !hasKids}
          title={unmirrored ? "Still syncing from ClickUp — available in a moment" : undefined}
          className={[
            "tech-transition flex w-full items-center gap-2 rounded-md border px-3 py-1.5 text-left text-[13px]",
            depth === 3 ? "ml-8 w-[calc(100%-2rem)]" : depth === 2 ? "ml-4 w-[calc(100%-1rem)]" : "",
            active
              ? "border-primary bg-primary/10 text-primary"
              : unmirrored
                ? "cursor-not-allowed border-transparent text-muted-foreground/50"
                : selectable
                  ? "border-transparent text-foreground hover:bg-secondary"
                  : "border-transparent text-foreground/80 hover:bg-secondary",
          ].join(" ")}
        >
          {hasKids ? (
            <ChevronRight
              onClick={(e) => { e.stopPropagation(); toggle(n.id); }}
              className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${isOpen ? "rotate-90" : ""}`}
            />
          ) : (
            <span className="w-3.5 shrink-0" />
          )}
          <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{n.name}</span>
          {unmirrored && (
            <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground/70">
              <Loader2 className="h-3 w-3 animate-spin" /> syncing…
            </span>
          )}
          {isSuggested && <Sparkles className="h-3 w-3 shrink-0 text-primary" />}
          {active && <Check className="h-3.5 w-3.5 shrink-0" />}
        </button>
        {hasKids && isOpen && (
          <div className="flex flex-col gap-0.5 pb-1 pt-0.5">
            {n.children!.map((c) => row(c, depth + 1, n.type === "space" ? n.id : ancestorSpaceId))}
            {/* "New X here" only where it's meaningful: a new list inside a
                space/folder (leaf mode), handled by the caller's onCreate. */}
            {onSelectLeaf && (creatingAt === n.id ? (
              <div className={depth === 2 ? "ml-8" : "ml-4"}>
                <div className="flex items-center gap-1.5">
                  <input
                    autoFocus
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void submitCreate(n.type === "space" ? n.id : ancestorSpaceId, n.type === "folder" ? n.id : undefined);
                      if (e.key === "Escape") setCreatingAt(null);
                    }}
                    placeholder="New list name…"
                    className="flex-1 rounded-md border border-border bg-background/60 px-2.5 py-1.5 text-base text-foreground focus:border-primary/50 focus:outline-none sm:text-[13px]"
                  />
                  <button
                    type="button"
                    disabled={!newName.trim() || creating}
                    onClick={() => void submitCreate(n.type === "space" ? n.id : ancestorSpaceId, n.type === "folder" ? n.id : undefined)}
                    className="tech-transition inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-[12px] font-medium text-primary-foreground disabled:opacity-50"
                  >
                    {creating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                    Create
                  </button>
                </div>
                {createError && <p className="mt-1 text-[11px] text-destructive">{createError}</p>}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => { setCreatingAt(n.id); setNewName(""); setCreateError(null); }}
                className={`tech-transition flex items-center gap-1.5 text-left text-[12px] text-primary hover:underline ${depth === 2 ? "ml-8" : "ml-4"}`}
              >
                <Plus className="h-3 w-3" /> {newLabel}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  // Search mode: flat filtered list across every node.
  const ql = q.trim().toLowerCase();
  if (ql) {
    const hits: { node: TNode; path: string }[] = [];
    const walk = (nodes: TNode[], path: string) => {
      for (const n of nodes) {
        if (n.name.toLowerCase().includes(ql)) hits.push({ node: n, path });
        if (n.children) walk(n.children, path ? `${path} / ${n.name}` : n.name);
      }
    };
    walk(tree, "");
    return (
      <div className="flex flex-col gap-1.5">
        <SearchBox q={q} setQ={setQ} />
        {hits.slice(0, 12).map(({ node, path }) => (
          <div key={node.id}>
            <p className="ml-4 text-[10px] uppercase tracking-wide text-muted-foreground/70">{path}</p>
            {row(node, 1)}
          </div>
        ))}
        {!hits.length && (
          <p className="px-1 py-1 text-[11px] text-muted-foreground">No matches.</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <SearchBox q={q} setQ={setQ} />
      {onSelectLeaf && (
        <button
          type="button"
          onClick={() => onSelectLeaf(undefined)}
          className={[
            "tech-transition flex w-full items-center gap-2 rounded-md border px-3 py-1.5 text-left text-[13px]",
            value === undefined
              ? "border-primary bg-primary/10 text-primary"
              : "border-transparent text-foreground hover:bg-secondary",
          ].join(" ")}
        >
          <FolderKanban className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="flex-1">{emptyLabel}</span>
          {value === undefined && <Check className="h-3.5 w-3.5 shrink-0" />}
        </button>
      )}
      <div className="max-h-56 overflow-y-auto pr-0.5">
        {tree.map((sp) => row(sp, 1))}
        {onSelectTarget && (
          creatingAt === "top" ? (
            <div className="flex items-center gap-1.5">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitCreate(undefined, undefined);
                  if (e.key === "Escape") setCreatingAt(null);
                }}
                placeholder="New space name…"
                className="flex-1 rounded-md border border-border bg-background/60 px-2.5 py-1.5 text-base text-foreground focus:border-primary/50 focus:outline-none sm:text-[13px]"
              />
              <button
                type="button"
                disabled={!newName.trim() || creating}
                onClick={() => void submitCreate(undefined, undefined)}
                className="tech-transition inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-[12px] font-medium text-primary-foreground disabled:opacity-50"
              >
                {creating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                Create
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => { setCreatingAt("top"); setNewName(""); setCreateError(null); }}
              className="tech-transition flex items-center gap-1.5 text-left text-[12px] text-primary hover:underline"
            >
              <Plus className="h-3 w-3" /> {newLabel}
            </button>
          )
        )}
        {createError && creatingAt === "top" && (
          <p className="mt-1 text-[11px] text-destructive">{createError}</p>
        )}
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
        placeholder="Search…"
        className="w-full rounded-md border border-border bg-background/60 py-1.5 pl-8 pr-3 text-base text-foreground focus:border-primary/50 focus:outline-none sm:text-[13px]"
      />
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
