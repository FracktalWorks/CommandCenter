// GTD Task Manager — canonical client types.
//
// These mirror the canonical Postgres model in
// `ai-company-brain/specs/task_manager_app.md` §4 (gtd_items / gtd_projects /
// gtd_contexts), trimmed to what the UI needs. The app is built UI-first
// against mock data (see mockData.ts); when the gateway `/tasks` API lands,
// these types stay and only the data source swaps.

/** Where a task/project lives and who is the source of truth. */
export type Source = "LOCAL" | "SYNCED";

/** Which connected backend a SYNCED item mirrors (LOCAL items have none). */
export type ProviderKind = "clickup" | "asana" | "jira" | "linear" | "local";

/** The GTD disposition — the bucket an item lands in after Clarify.
 *  (No CALENDAR bucket: the Calendar is a VIEW over date-specific actions.) */
export type Disposition =
  | "INBOX"
  | "NEXT"
  | "WAITING"
  | "SOMEDAY"
  | "PROJECT"
  | "REFERENCE"
  | "DONE"
  | "TRASH";

/** Energy required — one of the four GTD engage criteria. */
export type Energy = "low" | "medium" | "high";

/** A GTD context (the `@` list): grouped by what you need to act. */
export interface GtdContext {
  /** e.g. "@computer" */
  name: string;
  /** lucide-react icon name */
  icon: string;
}

export interface Person {
  name: string;
  email?: string;
  /** a stable tailwind-ish accent for the avatar chip, e.g. "primary" */
  accent?: string;
  /** the person's id in the connected PM tool (for real assignment) */
  providerUserId?: string;
}

/** A GTD project — a first-class outcome needing >1 action (§5.1). */
export interface GtdProject {
  id: string;
  source: Source;
  provider?: ProviderKind;
  /** which connected workspace account a SYNCED project mirrors */
  accountId?: string;
  /** native project/list id in the tool (ClickUp list id) — the accordion
   *  picker selects by this */
  providerRef?: string;
  /** the desired outcome / "wild success" statement (the title) */
  outcome: string;
  /** natural-planning: why this matters */
  purpose?: string;
  status: "ACTIVE" | "SOMEDAY" | "DONE" | "DROPPED";
  /** the cardinal GTD health check — does it have a defined next action? */
  hasNextAction: boolean;
  /** link up to an Area of Focus (Horizon H2) */
  areaId?: string;
}

/** A GTD item — an inbox capture or a clarified action. */
export interface GtdItem {
  id: string;
  source: Source;
  provider?: ProviderKind;
  /** which connected workspace account a SYNCED item targets/mirrors */
  accountId?: string;
  /** deep link to the task in the connected PM tool (once pushed) */
  providerUrl?: string;
  title: string;
  notes?: string;

  // GTD overlay
  disposition: Disposition;
  /** the clarified physical next action (set once it leaves the inbox) */
  nextAction?: string;
  /** "@computer" | "@calls" | … (matches a GtdContext.name) */
  context?: string;
  energy?: Energy;
  timeEstimateMins?: number;
  isTwoMinute?: boolean;
  projectId?: string;

  // people / delegation
  isMine: boolean;
  /** who I'm waiting on (WAITING disposition) */
  waitingOn?: Person;
  delegatedAt?: string;
  /** assignee/owner in the connected PM tool */
  assignee?: Person;
  /** the item's stage/status in the connected PM tool (e.g. "Backlog", "To-do") */
  providerStatus?: string;
  /** the task's stage on the local Kanban board (configured in settings) */
  workflowStage?: string;
  /** manual (drag) rank within a group/column; unset → created-at ordering */
  sortKey?: number;
  /** set → this item is a subtask of another gtd_item (its parent). */
  parentItemId?: string;
  /** number of child subtasks (roll-up badge on the card/detail). */
  subtaskCount?: number;
  /** when set, the task is archived (hidden from active views) */
  archivedAt?: string;
  /** sync lifecycle: 'local' (ours) · 'pending' (queued to push to the PM tool,
   *  Action-Broker-gated) · 'synced' (written back). Lets you clarify now and
   *  finish/push to ClickUp/Jira later. */
  syncState?: "local" | "pending" | "synced";

  // hard landscape
  /** ISO date string */
  dueAt?: string;
  /** true → must happen on dueAt; surfaces in the Calendar view */
  isHardDate?: boolean;

  createdAt: string;
  /** Context attachments captured with the item (photo/file/link). */
  attachments?: TaskAttachment[];
  /** Source linkage when the capture came from another app (email, etc.). */
  origin?: {
    kind: string;
    accountId?: string;
    emailId?: string;
    subject?: string;
    fromName?: string;
    fromEmail?: string;
  };
  updatedAt: string;
  /** set when disposition becomes DONE (e.g. the 2-minute rule) */
  completedAt?: string;
  /** set when the item leaves the inbox (clarified) */
  clarifiedAt?: string;
  /** GTD tickler — hidden from the active inbox until this date, then resurfaces */
  deferUntil?: string;
}

/** Where a clarified item should be stored (dual-source model, §5.1). */
export interface Target {
  source: Source;
  /** which connected PM tool for a SYNCED target; 'local' for LOCAL */
  provider?: ProviderKind;
  /** the specific workspace account (live mode: several workspaces of the
   *  same provider can be connected side by side) */
  accountId?: string;
}

/** The left-rail views. */
export type ViewKey =
  | "inbox"
  | "next"
  | "waiting"
  | "calendar"
  | "projects"
  | "someday"
  | "reference"
  | "archive"
  | "engage"
  | "horizons";

/** A context reference kept with a capture. Files/images are served from the
 *  gateway attachment store; links are references only. */
export interface TaskAttachment {
  kind: "file" | "image" | "link";
  name: string;
  url: string;
  attachmentId?: string;
  mime?: string;
  size?: number;
}

/** ClickUp-shaped navigation node for the project picker accordion. */
export interface WorkspaceHierarchySpace {
  id: string;
  name: string;
  lists: { id: string; name: string }[];
  folders: { id: string; name: string; lists: { id: string; name: string }[] }[];
}
