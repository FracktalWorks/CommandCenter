/**
 * People Center · the person editor's pure half (WS-28b-write).
 *
 * The first block is the one that matters. Everything else here is shape;
 * `buildWriteBody` under a restricted viewer is a data-loss guard, and the
 * failure it prevents is invisible — an admin edits a job title and somebody's
 * skills quietly disappear, with a 200 and no error anywhere.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_STATUS,
  type PersonForm,
  addSkill,
  buildWriteBody,
  emptyForm,
  formFromPerson,
  mergeResumeSkills,
  removeSkill,
  resumeNotice,
  validate,
} from "./form";

const filled = (over: Partial<PersonForm> = {}): PersonForm => ({
  ...emptyForm(),
  name: "Priya",
  email: "priya@fracktal.in",
  title: "Lead",
  skills: ["firmware", "rtos"],
  capacity_hours_per_week: "40",
  current_load_hours_per_week: "10",
  ...over,
});

describe("buildWriteBody and the HR projection", () => {
  it("omits the HR half when the viewer could not see it", () => {
    // Not "sends empty" — OMITS. The gateway's PATCH uses `exclude_unset`, so
    // a key that is absent is a column the UPDATE never names. A key present
    // and empty is a column set to empty, which is the deletion.
    const body = buildWriteBody(filled({ skills: [] }), { hrVisible: false });
    expect(body).not.toHaveProperty("skills");
    expect(body).not.toHaveProperty("capacity_hours_per_week");
    expect(body).not.toHaveProperty("current_load_hours_per_week");
  });

  it("still sends the basic half when the HR half is restricted", () => {
    // The point of the permission split: an editor who may not read skills can
    // still fix a job title, and that edit has to actually land.
    const body = buildWriteBody(filled(), { hrVisible: false });
    expect(body.title).toBe("Lead");
    expect(body.name).toBe("Priya");
    expect(body.status).toBe(DEFAULT_STATUS);
  });

  it("sends the HR half when the viewer can see it", () => {
    const body = buildWriteBody(filled(), { hrVisible: true });
    expect(body.skills).toEqual(["firmware", "rtos"]);
    expect(body.capacity_hours_per_week).toBe(40);
    expect(body.current_load_hours_per_week).toBe(10);
  });

  it("a cleared box clears the column instead of writing an empty string", () => {
    const body = buildWriteBody(filled({ email: "  ", title: "" }), {
      hrVisible: true,
    });
    expect(body.email).toBeNull();
    expect(body.title).toBeNull();
  });

  it("a cleared number is null, and a non-number is left out entirely", () => {
    const body = buildWriteBody(
      filled({ capacity_hours_per_week: "", current_load_hours_per_week: "abc" }),
      { hrVisible: true },
    );
    expect(body.capacity_hours_per_week).toBeNull();
    // Sending NaN would serialise to `null` and silently clear the column;
    // omitting it leaves the stored value alone, which is what an unparseable
    // box should mean.
    expect(body.current_load_hours_per_week).toBeUndefined();
  });

  it("trims the name it sends", () => {
    expect(buildWriteBody(filled({ name: "  Ravi " }), { hrVisible: true }).name)
      .toBe("Ravi");
  });
});

describe("formFromPerson", () => {
  it("translates the ClickUp link across its two names", () => {
    // The gateway reads it as `provider_user_id` and writes it as
    // `clickup_user_id`. One of the two has to be translated somewhere.
    const form = formFromPerson({ name: "Priya", provider_user_id: "1234" });
    expect(form.clickup_user_id).toBe("1234");
  });

  it("renders a missing value as an empty box, not as 'null'", () => {
    const form = formFromPerson({ name: "Priya", title: null, team: undefined });
    expect(form.title).toBe("");
    expect(form.team).toBe("");
  });

  it("keeps a zero rather than treating it as absent", () => {
    // `0` is falsy: capacity 0 is a real statement about somebody on leave and
    // must not render as a blank box that then saves as null.
    const form = formFromPerson({ name: "Priya", capacity_hours_per_week: 0 });
    expect(form.capacity_hours_per_week).toBe("0");
  });

  it("copies the skills array instead of aliasing it", () => {
    const person = { name: "Priya", skills: ["firmware"] };
    const form = formFromPerson(person);
    form.skills.push("rtos");
    expect(person.skills).toEqual(["firmware"]);
  });

  it("falls back to a legal status when the row carries none", () => {
    expect(formFromPerson({ name: "Priya" }).status).toBe(DEFAULT_STATUS);
  });
});

describe("emptyForm", () => {
  it("opens on the vocabulary's first status, whatever it is", () => {
    // Passed in from `/people/facets` so migration 148's CHECK stays the one
    // source of truth — a hardcoded "active" here would be a fifth copy.
    expect(emptyForm("contractor").status).toBe("contractor");
  });
});

describe("skills", () => {
  it("folds to lower case, matching how the résumé merge compares", () => {
    expect(addSkill([], "Firmware")).toEqual(["firmware"]);
  });

  it("refuses a duplicate regardless of case", () => {
    expect(addSkill(["firmware"], "FIRMWARE")).toEqual(["firmware"]);
  });

  it("ignores a blank", () => {
    expect(addSkill(["firmware"], "   ")).toEqual(["firmware"]);
  });

  it("removes exactly one", () => {
    expect(removeSkill(["firmware", "rtos"], "rtos")).toEqual(["firmware"]);
  });
});

describe("mergeResumeSkills", () => {
  it("appends only what is genuinely new", () => {
    expect(mergeResumeSkills(["firmware"], ["rtos", "firmware"])).toEqual([
      "firmware",
      "rtos",
    ]);
  });

  it("compares case-insensitively", () => {
    expect(mergeResumeSkills(["Firmware"], ["firmware"])).toEqual(["Firmware"]);
  });
});

describe("resumeNotice", () => {
  it("says plainly when a résumé added nothing", () => {
    // The honest empty case. Silence after an upload reads as a failure.
    expect(resumeNotice([])).toMatch(/no new skills/i);
  });

  it("agrees with itself about number", () => {
    expect(resumeNotice(["rtos"])).toContain("1 skill:");
    expect(resumeNotice(["rtos", "can"])).toContain("2 skills:");
  });

  it("names what it added", () => {
    expect(resumeNotice(["rtos", "can"])).toContain("rtos, can");
  });
});

describe("validate", () => {
  it("requires a name, because the gateway does", () => {
    expect(validate(filled({ name: "  " }))).toMatch(/name/i);
  });

  it("passes an otherwise empty form with a name", () => {
    expect(validate({ ...emptyForm(), name: "Ravi" })).toBeNull();
  });
});
