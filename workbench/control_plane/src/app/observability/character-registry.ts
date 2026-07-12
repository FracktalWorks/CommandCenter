/**
 * Unified assignable-character registry.
 *
 * Two generations of Pixel Lab characters exist:
 *  - CHARACTER_LIBRARY — the newer reusable role library (exec/engineer/designer/
 *    sales × m/f), built by scripts/characters/build_library.py.
 *  - OFFICE_CAST — the ORIGINAL per-agent office avatars (orchestrator, strategy,
 *    email-assistant, …), built by scripts/characters/build_sheets.py.
 *
 * They render from the same fields (seated / working / sleeping / standing /
 * breathing), so we normalize the office cast into the `LibChar` shape and merge
 * both into ONE registry. The Agent Settings avatar picker and the office's
 * `castFor()` both read this, so every previously-generated character is now
 * selectable AND resolves correctly when assigned to any agent.
 */
import { CHARACTER_LIBRARY, type LibChar } from "./character-library.generated";
import { OFFICE_CAST, type OfficeChar } from "./office-cast.generated";

// Friendly display names for the original office cast (id -> label). These are the
// app's built-in agents; all share one broad "agent" picker category.
const OFFICE_LABELS: Record<string, string> = {
  orchestrator: "Orchestrator",
  "apis-config": "API Config",
  sales: "Sales Rep",
  "task-manager": "Task Manager",
  "email-assistant": "Email Assistant",
  reconciler: "Reconciler",
  delivery: "Delivery",
  billing: "Billing",
  strategy: "Strategy",
};

function officeToLib(id: string, c: OfficeChar): LibChar {
  const label = OFFICE_LABELS[id] ?? labelize(id);
  return {
    id,
    gender: "",
    role: "agent",
    // `description` doubles as the tile's friendly name in the picker.
    description: `Original office avatar — ${label}`,
    portrait: c.standing?.south ?? c.seated,
    standing: c.standing ?? {},
    seated: c.seated,
    working: c.working,
    workingFrames: c.workingFrames,
    sleeping: c.sleeping,
    breathing: c.breathing,
    breathingFrames: c.breathingFrames,
  };
}

function labelize(id: string): string {
  return id
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

const OFFICE_AS_LIB: Record<string, LibChar> = Object.fromEntries(
  Object.entries(OFFICE_CAST).map(([id, c]) => [id, officeToLib(id, c)]),
);

/** Every assignable character: the polished role library first, then the original
 *  per-agent office cast. Keyed by id (ids are disjoint across the two sets). */
export const ALL_CHARACTERS: Record<string, LibChar> = {
  ...CHARACTER_LIBRARY,
  ...OFFICE_AS_LIB,
};

export const ALL_CHARACTER_IDS = Object.keys(ALL_CHARACTERS);
