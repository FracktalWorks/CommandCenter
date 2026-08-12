/**
 * How an activity reads on screen — one vocabulary, one place.
 *
 * Spec: `ProjectApp_Plan.md` §17.3. The plan's warning is the reason this is a
 * module rather than a `switch` inside a component: *"Rendered from
 * `pm_activities` through ONE formatter shared with the project Activity tab.
 * Two renderers for one event stream will drift."*
 *
 * The gateway's `ACTIVITY_TYPES` has fifteen verbs. Ten predate Project
 * Operations and carry their sentence in `body`; the five WS-27bg added put the
 * specifics in `meta` and use `meta.action` to say WHICH thing happened —
 * `work_session` covers started, paused, resumed and completed rather than
 * minting four synonyms.
 */

export interface ActivityLike {
  type: string;
  body?: string | null;
  meta?: Record<string, unknown> | null;
  created_by?: string | null;
  created_at?: string | null;
}

export interface ActivityLook {
  /** Lucide icon NAME — the active theme picks the pack. Never a component. */
  icon: string;
  /** A shared-vocabulary hue name, resolved by the caller through statusAccent. */
  hue: string;
  /** What the row says. */
  text: string;
}

/** Per-verb icon and tone. `meta.action` refines the ones that need it. */
const LOOK: Record<string, { icon: string; hue: string }> = {
  comment: { icon: "MessageSquare", hue: "gray" },
  status_change: { icon: "CircleDot", hue: "blue" },
  field_change: { icon: "Pencil", hue: "gray" },
  link: { icon: "GitBranch", hue: "gray" },
  assignment: { icon: "UserPlus", hue: "violet" },
  agent_run: { icon: "Bot", hue: "violet" },
  sync: { icon: "RefreshCw", hue: "gray" },
  system: { icon: "Info", hue: "gray" },
  attachment: { icon: "Paperclip", hue: "gray" },
  mention: { icon: "AtSign", hue: "violet" },
  // WS-27bg's five.
  work_session: { icon: "Play", hue: "green" },
  stage_change: { icon: "Milestone", hue: "blue" },
  blocker: { icon: "OctagonAlert", hue: "red" },
  next_action: { icon: "ArrowRight", hue: "amber" },
  handoff: { icon: "ArrowRightLeft", hue: "violet" },
};

/** `work_session` and `blocker` mean different things per `meta.action`. */
const ACTION_LOOK: Record<string, { icon: string; hue: string }> = {
  started: { icon: "Play", hue: "green" },
  resumed: { icon: "Play", hue: "green" },
  paused: { icon: "Pause", hue: "amber" },
  blocked: { icon: "OctagonAlert", hue: "red" },
  completed: { icon: "Check", hue: "green" },
  raised: { icon: "OctagonAlert", hue: "red" },
  resolved: { icon: "CircleCheck", hue: "green" },
  cleared: { icon: "X", hue: "gray" },
};

/**
 * The look and the sentence for one activity.
 *
 * **`body` is preferred over anything reconstructed from `meta`.** The server
 * wrote that sentence at the moment it happened, with the names as they were
 * then — a stage renamed next month must not rewrite the history that already
 * happened. `meta` is for refining the ICON, and for the cases where the
 * server wrote no body.
 */
export function describeActivity(activity: ActivityLike): ActivityLook {
  const meta = (activity.meta ?? {}) as Record<string, unknown>;
  const action = typeof meta.action === "string" ? meta.action : null;
  const base = LOOK[activity.type] ?? { icon: "Circle", hue: "gray" };
  const refined = action ? ACTION_LOOK[action] : null;

  return {
    icon: refined?.icon ?? base.icon,
    hue: refined?.hue ?? base.hue,
    text: activity.body?.trim() || fallbackText(activity.type, action),
  };
}

/** Used only when the server wrote no body — never in place of one. */
function fallbackText(type: string, action: string | null): string {
  if (action) return `${type.replace(/_/g, " ")}: ${action}`;
  return type.replace(/_/g, " ");
}

/**
 * Whether an entry is DISCUSSION rather than history.
 *
 * The brief §32 is explicit that the two are different: comments are talk,
 * activities are the audit record. A filter that cannot separate them makes the
 * timeline unreadable on a busy project.
 */
export function isDiscussion(activity: ActivityLike): boolean {
  return activity.type === "comment" || activity.type === "mention";
}

/** Whether an entry was written by automation rather than a person (WS-27z). */
export function isAutomated(activity: ActivityLike): boolean {
  const meta = (activity.meta ?? {}) as Record<string, unknown>;
  return meta.automation === true || (activity.created_by ?? "").startsWith("system:");
}
