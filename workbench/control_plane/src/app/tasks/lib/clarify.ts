// AI clarify proposal — the structured recommendation the assistant makes for an
// inbox item during the Process/Clarify stage. Today this is a local heuristic
// (proposeClarification); when the gateway lands, `POST /tasks/items/{id}/clarify`
// returns the same shape from the `task-manager` agent. The human always
// reviews/edits before it's applied (GTD: AI proposes, you decide).

import { Energy, GtdItem, GtdProject, Person, Target } from "./types";

/** The disposition the assistant recommends (superset of the GTD outcomes). */
export type ClarifyDisposition =
  | "NEXT" // defer → next action (by context)
  | "PROJECT" // outcome needs >1 action
  | "WAITING" // delegate → waiting for
  | "CALENDAR" // day/time-specific action
  | "DO_NOW" // 2-minute rule
  | "SOMEDAY" // incubate
  | "REFERENCE" // file, non-actionable
  | "TRASH"; // no longer needed

/** How sure the assistant is — drives how loudly the UI nudges a one-tap accept. */
export type Confidence = "high" | "medium" | "low";

export interface ClarifyProposal {
  actionable: boolean;
  disposition: ClarifyDisposition;
  /** the very next physical, visible action (GTD's pivotal question) */
  nextAction: string;
  /** the successful outcome — most important for projects (GTD's other key question) */
  outcome?: string;
  context?: string;
  energy?: Energy;
  timeEstimateMins?: number;
  isTwoMinute?: boolean;
  /** who to hand off to, for a delegation */
  suggestedAssignee?: Person;
  /** where it should be stored — Local vs a connected PM tool (§5.1) */
  target?: Target;
  /** an existing project to file it under, if any (auto-matched) */
  projectId?: string;
  /** true when the project was inferred by the assistant (vs already set on the item) */
  projectInferred?: boolean;
  /** how sure the assistant is about this disposition */
  confidence: Confidence;
  /** short why, shown under the proposal */
  rationale: string;
  /** provider stage default for the destination (server proposal only) */
  status?: string;
  /** the assistant's read of how big this is: one action, a task with
   *  subtasks, or a full project (server proposal only). */
  complexity?: "single" | "subtasks" | "project";
  /** concrete child steps the assistant suggests, when complexity="subtasks". */
  suggestedSubtasks?: string[];
}

/** Map a GTD disposition to a sensible provider stage/status.
 *  e.g. a project item that's really "someday" → Backlog; an actioned/delegated
 *  item → To-do. Falls back gracefully to whatever statuses the tool has. */
export function defaultStatus(
  disposition: ClarifyDisposition,
  statuses: string[],
): string | undefined {
  if (!statuses.length) return undefined;
  const find = (re: RegExp) => statuses.find((s) => re.test(s));
  if (disposition === "SOMEDAY") return find(/backlog|someday|icebox/i) ?? statuses[0];
  if (disposition === "PROJECT") return find(/backlog|to.?do|selected/i) ?? statuses[0];
  // actionable (next / delegate / calendar) → the "to-do" column
  return find(/to.?do|selected|to do/i) ?? statuses[1] ?? statuses[0];
}

// Word-boundary hint match (mirror of gateway ai.py `_has`): bare substring
// matching misfiled captures - "profile..." tripped the "file" reference hint.
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const has = (t: string, ...words: string[]) =>
  words.some((w) => {
    const hint = w.trim();
    return !!hint && new RegExp(`(?<![a-z0-9])${esc(hint)}(?![a-z0-9])`).test(t);
  });
const CAP = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// Words too common to carry a project signal.
const STOP = new Set([
  "the", "and", "for", "with", "our", "out", "get", "set", "new", "you", "your",
  "this", "that", "from", "into", "about", "need", "want", "make", "have", "has",
  "ask", "put", "add", "let", "off", "day", "week", "next", "soon", "some", "any",
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/** Match an inbox item to the best-fit existing project by keyword overlap.
 *  Lets the assistant file captures under the right project automatically —
 *  even across many projects — instead of forcing you to hunt a long list.
 *  Only suggests when at least two meaningful words overlap. */
export function suggestProject(
  item: GtdItem,
  projects: GtdProject[],
): { projectId?: string; score: number } {
  const words = new Set([...tokenize(item.title), ...tokenize(item.notes ?? "")]);
  if (!words.size) return { score: 0 };
  let best: { projectId?: string; score: number } = { score: 0 };
  for (const p of projects) {
    if (p.status !== "ACTIVE") continue;
    const pt = new Set([...tokenize(p.outcome), ...tokenize(p.purpose ?? "")]);
    let score = 0;
    for (const w of words) if (pt.has(w)) score++;
    if (score > best.score) best = { projectId: p.id, score };
  }
  return best.score >= 2 ? best : { score: best.score };
}

/** Infer the GTD context from the wording. */
function inferContext(t: string): string {
  if (has(t, "call", "phone", "ring", "dial", "ring up")) return "@calls";
  if (has(t, "buy", "pick up", "pickup", "store", "errand", "drop off", "collect", "bank", "post office"))
    return "@errands";
  if (has(t, "ask ", "discuss", "1:1", "agenda", "raise with", "bring up", "talk to"))
    return "@agenda";
  return "@computer";
}

/** Turn a raw capture into a specific, verb-first next action. */
function draftNextAction(title: string, ctx: string, assignee?: Person): string {
  const t = title.trim();
  const lower = t.toLowerCase();
  if (assignee) return `Ask ${assignee.name} to ${lower.replace(/^(ask|get|have)\s+\w+\s+(to\s+)?/, "")}`.trim();
  // already imperative? keep it.
  if (/^(call|email|reply|draft|send|buy|pick|book|write|review|check|pay|sign|schedule|confirm|follow up|order|renew|research|plan|prepare)/.test(lower))
    return CAP(t);
  if (ctx === "@calls") return `Call about ${t}`;
  if (ctx === "@errands") return `Pick up / handle: ${t}`;
  if (ctx === "@agenda") return `Raise with the team: ${t}`;
  if (has(lower, "email", "reply", "message", "slack", "respond")) return `Reply re: ${t}`;
  return `Action: ${t}`;
}

const PROJECT_HINTS = [
  "plan", "organize", "organise", "launch", "set up", "setup", "build", "design",
  "research", "prepare", "roll out", "rollout", "migrate", "hire", "onboard",
  "campaign", "event", "trip", "strategy", "handbook", "write up", "fit-out",
  "process", "framework", "overhaul", "redesign",
];
const TWO_MIN_HINTS = ["reply", "confirm", "rsvp", "sign", "pay", "forward", "text", "send the", "quick", "approve", "reschedule"];
const REFERENCE_HINTS = ["receipt", "invoice", "statement", "fyi", "file", "for the record", "article", "read:", "link", "doc:", "reference"];
const SOMEDAY_HINTS = ["idea:", "someday", "maybe", "one day", "learn ", "explore", "evaluate", "wish", "consider "];
const CALENDAR_HINTS = ["today", "tomorrow", "tonight", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "deadline", "due ", " at ", "o'clock", "appointment", "meeting on", "next week"];

function coreProposal(item: GtdItem, people: Person[]): ClarifyProposal {
  const t = item.title.toLowerCase();

  // Non-actionable first.
  if (has(t, ...SOMEDAY_HINTS)) {
    return {
      actionable: false,
      disposition: "SOMEDAY",
      nextAction: item.title,
      confidence: "high",
      rationale: "Reads like an idea to incubate, not a commitment yet.",
    };
  }
  if (has(t, ...REFERENCE_HINTS)) {
    return {
      actionable: false,
      disposition: "REFERENCE",
      nextAction: item.title,
      confidence: "high",
      rationale: "Looks like information to keep, not an action.",
    };
  }

  // Delegation — a teammate's name in the text.
  const assignee = people.find((p) => t.includes(p.name.split(/\s+/)[0].toLowerCase()));
  const ctx = inferContext(t);

  if (assignee && has(t, "ask", "get ", "have ", "follow up with", "chase", "remind")) {
    return {
      actionable: true,
      disposition: "WAITING",
      nextAction: draftNextAction(item.title, ctx, assignee),
      suggestedAssignee: assignee,
      timeEstimateMins: 5,
      energy: "low",
      confidence: "high",
      rationale: `Someone else's to do — delegate to ${assignee.name} and track it.`,
    };
  }

  // Project — multi-step outcome.
  if (has(t, ...PROJECT_HINTS)) {
    return {
      actionable: true,
      disposition: "PROJECT",
      outcome: `${CAP(item.title)} — done`,
      nextAction: `Outline the first step for: ${item.title}`,
      context: "@computer",
      energy: "medium",
      confidence: "medium",
      rationale: "Needs more than one action — track it as a project with a next action.",
    };
  }

  // Calendar — day/time-specific.
  if (has(t, ...CALENDAR_HINTS)) {
    return {
      actionable: true,
      disposition: "CALENDAR",
      nextAction: draftNextAction(item.title, ctx),
      context: ctx,
      energy: "low",
      confidence: "high",
      rationale: "Time-specific — put it on the calendar (hard landscape).",
    };
  }

  // Two-minute rule — small & quick.
  if (has(t, ...TWO_MIN_HINTS) && item.title.length < 60) {
    return {
      actionable: true,
      disposition: "DO_NOW",
      nextAction: draftNextAction(item.title, ctx),
      isTwoMinute: true,
      timeEstimateMins: 2,
      energy: "low",
      confidence: "high",
      rationale: "Quick — under two minutes, so just do it now.",
    };
  }

  // Default — a deferred next action, by context.
  return {
    actionable: true,
    disposition: "NEXT",
    nextAction: draftNextAction(item.title, ctx),
    context: ctx,
    energy: ctx === "@errands" ? "low" : "medium",
    timeEstimateMins: ctx === "@calls" ? 10 : ctx === "@errands" ? 20 : 25,
    confidence: "medium",
    rationale: `Actionable now — a next action for ${ctx}.`,
  };
}

/** Local heuristic proposal — a stand-in for the AI clarify call. Fills in as
 *  much as it can so the common case is a single tap: it auto-matches an
 *  existing **project** by keyword, then picks the storage **target** to follow
 *  that project (delegated/collaborative → the team tool; solo → Local, §5.1). */
export function proposeClarification(
  item: GtdItem,
  people: Person[] = [],
  projects: GtdProject[] = [],
): ClarifyProposal {
  const core = coreProposal(item, people);

  // Match an existing project (skip for PROJECT — that creates a *new* one).
  const existing = item.projectId
    ? projects.find((p) => p.id === item.projectId)
    : undefined;
  const match =
    !existing && core.disposition !== "PROJECT"
      ? suggestProject(item, projects)
      : { score: 0 };
  const matched = match.projectId
    ? projects.find((p) => p.id === match.projectId)
    : undefined;
  const project = existing ?? matched;

  // Where it goes: follow the matched project's home; delegation is always
  // collaborative so it lands on a synced tool regardless.
  const baseTarget: Target =
    item.source === "SYNCED"
      ? { source: "SYNCED", provider: item.provider ?? "clickup", accountId: item.accountId }
      : { source: "LOCAL", provider: "local" };
  let target: Target = project
    ? {
        source: project.source,
        provider: project.provider ?? (project.source === "LOCAL" ? "local" : "clickup"),
        accountId: project.accountId,
      }
    : baseTarget;
  if (core.disposition === "WAITING") {
    target = {
      source: "SYNCED",
      provider:
        project?.source === "SYNCED" && project.provider
          ? project.provider
          : item.provider && item.provider !== "local"
            ? item.provider
            : "clickup",
      accountId:
        project?.source === "SYNCED" ? project.accountId : item.accountId,
    };
  }

  const projectInferred = !!matched;
  const rationale = matched
    ? `${core.rationale} Looks like it belongs to “${matched.outcome}”.`
    : core.rationale;

  return { ...core, target, projectId: project?.id, projectInferred, rationale };
}
