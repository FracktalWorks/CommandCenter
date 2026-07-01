// AI clarify proposal — the structured recommendation the assistant makes for an
// inbox item during the Process/Clarify stage. Today this is a local heuristic
// (proposeClarification); when the gateway lands, `POST /tasks/items/{id}/clarify`
// returns the same shape from the `task-manager` agent. The human always
// reviews/edits before it's applied (GTD: AI proposes, you decide).

import { Energy, GtdItem, Person, Target } from "./types";

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
  /** an existing project to file it under, if any */
  projectId?: string;
  /** short why, shown under the proposal */
  rationale: string;
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

const has = (t: string, ...words: string[]) => words.some((w) => t.includes(w));
const CAP = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

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
      rationale: "Reads like an idea to incubate, not a commitment yet.",
    };
  }
  if (has(t, ...REFERENCE_HINTS)) {
    return {
      actionable: false,
      disposition: "REFERENCE",
      nextAction: item.title,
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
    rationale: `Actionable now — a next action for ${ctx}.`,
  };
}

/** Local heuristic proposal — a stand-in for the AI clarify call. Adds a
 *  suggested storage **target** (Local vs a connected PM tool) and project:
 *  delegated/already-synced work → the team tool; solo work → Local (§5.1). */
export function proposeClarification(
  item: GtdItem,
  people: Person[] = [],
): ClarifyProposal {
  const core = coreProposal(item, people);
  const baseTarget: Target =
    item.source === "SYNCED"
      ? { source: "SYNCED", provider: item.provider ?? "clickup" }
      : { source: "LOCAL", provider: "local" };
  // Delegation is inherently collaborative → default it to the team tool.
  const target: Target =
    core.disposition === "WAITING"
      ? {
          source: "SYNCED",
          provider:
            item.provider && item.provider !== "local" ? item.provider : "clickup",
        }
      : baseTarget;
  return { ...core, target, projectId: item.projectId };
}
