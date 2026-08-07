/**
 * People Center · the person editor's pure half (WS-28b-write).
 *
 * Everything here is a plain function over plain data, so the decisions that
 * actually carry risk — which fields a save is allowed to touch, what an empty
 * box means, how a résumé's skills merge — are provable without mounting a
 * component or standing up a gateway.
 *
 * The one that matters most is `buildWriteBody`'s `hrVisible` argument. See its
 * docstring: it is the difference between an edit and a silent deletion.
 */

/** The vocabulary's fallback, used only until `/people/facets` answers. */
export const DEFAULT_STATUS = "active";

/** Editor state — every field a string, because every field is an input. */
export interface PersonForm {
  name: string;
  email: string;
  role: string;
  title: string;
  department: string;
  team: string;
  manager_id: string;
  status: string;
  capacity_hours_per_week: string;
  current_load_hours_per_week: string;
  clickup_user_id: string;
  skills: string[];
}

/** The PATCH/POST payload — snake_case, matching `PersonWrite` on the gateway. */
export interface PersonWriteBody {
  name?: string;
  email?: string | null;
  role?: string | null;
  title?: string | null;
  department?: string | null;
  team?: string | null;
  manager_id?: string | null;
  status?: string;
  skills?: string[];
  capacity_hours_per_week?: number | null;
  current_load_hours_per_week?: number | null;
  clickup_user_id?: string | null;
}

/** What the editor knows about a person before it opens. */
export interface PersonLike {
  id?: string;
  name?: string;
  email?: string | null;
  role?: string | null;
  title?: string | null;
  department?: string | null;
  team?: string | null;
  manager_id?: string | null;
  status?: string;
  skills?: string[];
  capacity_hours_per_week?: number | null;
  current_load_hours_per_week?: number | null;
}

const str = (value: string | null | undefined): string => value ?? "";
const num = (value: number | null | undefined): string =>
  value === null || value === undefined ? "" : String(value);

export function emptyForm(status: string = DEFAULT_STATUS): PersonForm {
  return {
    name: "",
    email: "",
    role: "",
    title: "",
    department: "",
    team: "",
    manager_id: "",
    status,
    capacity_hours_per_week: "",
    current_load_hours_per_week: "",
    clickup_user_id: "",
    skills: [],
  };
}

/**
 * A person → editor state.
 *
 * `provider_user_id` is the READ name for the column the write payload calls
 * `clickup_user_id`; the gateway's own models disagree about it
 * (`OrgPersonModel.provider_user_id` vs `PersonWrite.clickup_user_id`), so the
 * translation has to happen somewhere and here is the only place it does.
 */
export function formFromPerson(
  person: PersonLike & { provider_user_id?: string | null },
): PersonForm {
  return {
    name: str(person.name),
    email: str(person.email),
    role: str(person.role),
    title: str(person.title),
    department: str(person.department),
    team: str(person.team),
    manager_id: str(person.manager_id),
    status: person.status || DEFAULT_STATUS,
    capacity_hours_per_week: num(person.capacity_hours_per_week),
    current_load_hours_per_week: num(person.current_load_hours_per_week),
    clickup_user_id: str(person.provider_user_id),
    skills: [...(person.skills ?? [])],
  };
}

/** A cleared box means "clear the column", not "leave it as the empty string". */
const orNull = (value: string): string | null => value.trim() || null;

/** A cleared number box is null; a non-number is left out rather than sent as NaN. */
const numOrNull = (value: string): number | null | undefined => {
  const clean = value.trim();
  if (!clean) return null;
  const parsed = Number(clean);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * Editor state → the write payload.
 *
 * **`hrVisible: false` omits the HR half, and that is not a nicety.** The two
 * permissions are independent: `admin:members:manage` lets you edit a person,
 * `admin:members:read` lets you *see* their skills, capacity and load. An admin
 * holding only the first opens a form whose skills strip and capacity boxes are
 * blank — not because the person has none, but because the gateway projected
 * them away on the way out. Sending that form back would write the blanks in,
 * and an edit to somebody's job title would silently erase their skills.
 *
 * The gateway's PATCH uses `exclude_unset`, so a field this function omits is a
 * field the update statement never mentions. Omission is the whole protection.
 */
export function buildWriteBody(
  form: PersonForm,
  opts: { hrVisible: boolean },
): PersonWriteBody {
  const body: PersonWriteBody = {
    name: form.name.trim(),
    email: orNull(form.email),
    role: orNull(form.role),
    title: orNull(form.title),
    department: orNull(form.department),
    team: orNull(form.team),
    manager_id: orNull(form.manager_id),
    status: form.status,
    clickup_user_id: orNull(form.clickup_user_id),
  };
  if (opts.hrVisible) {
    body.skills = form.skills;
    body.capacity_hours_per_week = numOrNull(form.capacity_hours_per_week);
    body.current_load_hours_per_week = numOrNull(
      form.current_load_hours_per_week,
    );
  }
  return body;
}

/** The one field the gateway refuses outright, checked before the round trip. */
export function validate(form: PersonForm): string | null {
  return form.name.trim() ? null : "Name is required.";
}

/**
 * Add a skill, folded to lower case and deduped case-insensitively.
 *
 * Lower case because the gateway's résumé merge compares that way
 * (`s.lower() not in cur_lower`): an editor that stored "Firmware" next to a
 * résumé's "firmware" would produce two chips for one skill and break the
 * capability search that reads them.
 */
export function addSkill(skills: string[], raw: string): string[] {
  const skill = raw.trim().toLowerCase();
  if (!skill || skills.some((s) => s.toLowerCase() === skill)) return skills;
  return [...skills, skill];
}

export function removeSkill(skills: string[], skill: string): string[] {
  return skills.filter((s) => s !== skill);
}

/** Fold a résumé's newly-extracted skills into the open form, without dupes. */
export function mergeResumeSkills(current: string[], added: string[]): string[] {
  const have = new Set(current.map((s) => s.toLowerCase()));
  return [...current, ...added.filter((s) => !have.has(s.toLowerCase()))];
}

/** What the résumé upload reports back — including the honest empty case. */
export function resumeNotice(added: string[]): string {
  if (added.length === 0) return "Résumé parsed — no new skills found.";
  return `Added ${added.length} skill${added.length === 1 ? "" : "s"}: ${added.join(", ")}`;
}
