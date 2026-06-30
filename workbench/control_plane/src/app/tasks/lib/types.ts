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
}

/** A GTD project — a first-class outcome needing >1 action (§5.1). */
export interface GtdProject {
  id: string;
  source: Source;
  provider?: ProviderKind;
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

  // hard landscape
  /** ISO date string */
  dueAt?: string;
  /** true → must happen on dueAt; surfaces in the Calendar view */
  isHardDate?: boolean;

  createdAt: string;
  updatedAt: string;
  /** set when disposition becomes DONE (e.g. the 2-minute rule) */
  completedAt?: string;
  /** set when the item leaves the inbox (clarified) */
  clarifiedAt?: string;
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
  | "engage"
  | "horizons";
