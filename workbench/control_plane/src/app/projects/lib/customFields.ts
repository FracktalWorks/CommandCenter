/**
 * Projects · custom fields in the browser (WS-27l).
 *
 * Definitions come from `GET /projects/nodes/{id}/fields`; values ride on the
 * task as `custom_fields`, keyed by `field_key`.
 *
 * **The gateway is the authority on what a value may be** — `custom_fields.py`
 * coerces or refuses every one, and this file does not duplicate that judgement.
 * What it does own is the *shape*: an `<input>` hands back a string for every
 * type, so "2500" has to become the number `2500` before it is sent, or a
 * number field would be refused for every value anybody types into it.
 *
 * Pure functions only. What a form does with an empty box, a `0`, and a
 * half-typed date is easy to get subtly wrong, and each of those is one
 * assertion in the test beside this.
 */

export type FieldType =
  | "text"
  | "number"
  | "date"
  | "select"
  | "multi_select"
  | "boolean"
  | "url";

/** Mirrors the gateway's `FIELD_TYPES`. */
export const FIELD_TYPES: FieldType[] = [
  "text",
  "number",
  "date",
  "select",
  "multi_select",
  "boolean",
  "url",
];

export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: "Text",
  number: "Number",
  date: "Date",
  select: "Select one",
  multi_select: "Select many",
  boolean: "Checkbox",
  url: "Link",
};

export interface FieldDef {
  id: string;
  project_id: string;
  field_key: string;
  name: string;
  description?: string | null;
  field_type: FieldType;
  options: string[];
  position: number;
}

/** The types that choose from `options`. Mirrors the gateway's `CHOICE_TYPES`. */
export const CHOICE_TYPES: FieldType[] = ["select", "multi_select"];

export const needsOptions = (type: FieldType): boolean =>
  CHOICE_TYPES.includes(type);

/**
 * The key the gateway will derive from a name.
 *
 * Mirrors `custom_fields.slugify_key` so the form can show it *before* the
 * field is created. The key is permanent — it cannot be renamed, because every
 * stored value is filed under it — so somebody should see it while they can
 * still change their mind about the name.
 */
export function keyPreview(name: string): string {
  const lowered = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!lowered) return "field";
  if (!/^[a-z]/.test(lowered)) return `f_${lowered}`.slice(0, 63);
  return lowered.slice(0, 63);
}

/** What an empty control holds for each type, before anybody touches it. */
export function emptyValue(type: FieldType): unknown {
  if (type === "boolean") return false;
  if (type === "multi_select") return [];
  return "";
}

/**
 * One control's raw output → the JSON value to send, or `null` to clear.
 *
 * `null` is the wire's "unset this": the gateway removes the key rather than
 * storing a null, so "never filled in" and "deliberately emptied" stay
 * distinguishable in every filter downstream.
 */
export function toWire(type: FieldType, raw: unknown): unknown {
  if (type === "boolean") return Boolean(raw);

  if (type === "multi_select") {
    const list = Array.isArray(raw) ? raw.filter((v) => typeof v === "string") : [];
    // An empty multi-select is *cleared*, not an empty list: a stored `[]` and
    // a missing key would both render as "nothing chosen" while filtering
    // differently, and only one of them can be right.
    return list.length ? list : null;
  }

  const text = typeof raw === "string" ? raw.trim() : raw;
  if (text === "" || text === undefined || text === null) return null;

  if (type === "number") {
    // `Number("")` is 0 — which is why the empty check above comes first, and
    // why this cannot be folded into it. A blank number box means "no value",
    // never zero.
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : String(text);
  }

  return text;
}

/** A stored value → what the control should show. */
export function toInput(type: FieldType, value: unknown): unknown {
  if (type === "boolean") return value === true;
  if (type === "multi_select") return Array.isArray(value) ? value : [];
  if (value === null || value === undefined) return "";
  // `0` and `false` are values, not absences — `value || ""` would blank both.
  if (type === "date" && typeof value === "string") return value.slice(0, 10);
  return String(value);
}

/** A stored value → one line of read-only text. */
export function displayValue(def: FieldDef, value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (def.field_type === "boolean") return value ? "Yes" : "No";
  if (def.field_type === "multi_select") {
    return Array.isArray(value) && value.length ? value.join(", ") : "—";
  }
  if (def.field_type === "date" && typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString();
  }
  const text = String(value);
  return text === "" ? "—" : text;
}

/**
 * A `field_change` entry's field name → what the timeline should say.
 *
 * `patch_task` files a custom edit as `custom.<key>`. Rendering that raw would
 * put a database key in front of somebody reading their own history, so the
 * definition's label is used when it is loaded — and the key, de-underscored,
 * when it is not, because a field can be deleted after the change that names it
 * and the timeline still has to say something.
 */
export function changeLabel(field: string, defs: FieldDef[]): string {
  if (!field.startsWith("custom.")) return field;
  const key = field.slice("custom.".length);
  const def = defs.find((d) => d.field_key === key);
  return def ? def.name : key.replace(/_/g, " ");
}

/** Definitions in the order a form should render them. */
export function ordered(defs: FieldDef[]): FieldDef[] {
  return [...defs].sort(
    (a, b) => a.position - b.position || a.name.localeCompare(b.name)
  );
}

/**
 * Which keys differ between what the form holds and what the task stores.
 *
 * Only these are sent. A PATCH carrying every field would make each save a
 * write to all of them — and on the timeline, a single edit would read as
 * eight, burying the one that mattered.
 */
export function changedValues(
  defs: FieldDef[],
  stored: Record<string, unknown>,
  draft: Record<string, unknown>
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const def of defs) {
    const next = toWire(def.field_type, draft[def.field_key]);
    // A checkbox has no "unset" state to render — an unticked box and a field
    // nobody has ever answered look identical — so `false` is the baseline for
    // a boolean rather than `null`. Comparing against `null` made every save on
    // a task with an unanswered checkbox write `false` and post a timeline
    // entry for an edit nobody made.
    const fallback = def.field_type === "boolean" ? false : null;
    const before = stored[def.field_key] ?? fallback;
    if (JSON.stringify(next) !== JSON.stringify(before)) {
      patch[def.field_key] = next;
    }
  }
  return patch;
}
