/**
 * Projects · the ClickUp import wizard's pure half.
 *
 * The claim that carries real risk is `initialMapping`: a Space→Center mapping
 * decides who can see a department's work, and getting it wrong silently is the
 * one error class this app cannot make. Everything else here is about not
 * lying to the person about to press Import.
 */

import { describe, expect, it } from "vitest";

import {
  type ImportPlan,
  type ImportSummary,
  centerChoices,
  confidenceLabel,
  describeSummary,
  initialMapping,
  toMappings,
  totals,
  unmappedCount,
  unmappedNotice,
} from "./importPlan";

const space = (over: Partial<ImportPlan["spaces"][0]> = {}) => ({
  space_id: "s1",
  name: "Operations",
  list_count: 3,
  folder_count: 1,
  task_count: 42,
  assignee_count: 5,
  ...over,
});

const plan = (spaces: ImportPlan["spaces"]): ImportPlan => ({
  account_id: "a1",
  workspace_id: "w1",
  spaces,
  total: spaces.length,
});

describe("initialMapping", () => {
  it("a confirmed mapping wins over a fresh suggestion", () => {
    // An owner decision must not be re-litigated by a later plan — otherwise
    // re-running the import quietly re-maps a Space they already ruled on.
    const p = plan([
      space({
        current_mapping: "operations",
        suggestion: { center: "sales", confidence: 0.9 },
      }),
    ]);
    expect(initialMapping(p).s1).toBe("operations");
  });

  it("falls back to the suggestion when nothing was confirmed", () => {
    expect(
      initialMapping(plan([space({ suggestion: { center: "sales" } })])).s1,
    ).toBe("sales");
  });

  it("leaves a Space with no signal unmapped rather than guessing", () => {
    // "" is a real answer — import it, map it to nothing — and it is the safe
    // one. Inventing a Center here would grant somebody sight of it.
    expect(initialMapping(plan([space({ suggestion: null })])).s1).toBe("");
  });

  it("treats a null confirmed mapping as absent, not as a decision", () => {
    expect(
      initialMapping(
        plan([space({ current_mapping: null, suggestion: { center: "finance" } })]),
      ).s1,
    ).toBe("finance");
  });
});

describe("toMappings", () => {
  it("sends null, not an empty string, for map-to-nothing", () => {
    // The API models `center` as `str | None`; "" would be a Center slug that
    // does not exist rather than the absence of one.
    expect(toMappings({ s1: "", s2: "sales" })).toEqual([
      { space_id: "s1", center: null },
      { space_id: "s2", center: "sales" },
    ]);
  });
});

describe("centerChoices", () => {
  it("offers map-to-nothing first, and it is the empty value", () => {
    const [first] = centerChoices();
    expect(first.value).toBe("");
    expect(first.label).toMatch(/nothing/i);
  });

  it("offers every Center", () => {
    expect(centerChoices().length).toBeGreaterThan(1);
  });
});

describe("confidenceLabel", () => {
  it("says 'check it' for anything the machine is unsure about", () => {
    // A bare 0.45 invites acceptance without looking; the words are the point.
    expect(confidenceLabel(0.45)).toMatch(/check it/);
    expect(confidenceLabel(0.1)).toMatch(/check it/);
  });

  it("marks a previously confirmed mapping as such", () => {
    expect(confidenceLabel(1)).toMatch(/confirmed/);
  });

  it("has a word for no signal at all", () => {
    expect(confidenceLabel(undefined)).toMatch(/no signal/);
  });
});

describe("totals", () => {
  it("adds up what is actually in ClickUp", () => {
    const t = totals(
      plan([space(), space({ space_id: "s2", list_count: 2, task_count: 8, folder_count: 0 })]),
    );
    expect(t).toEqual({ spaces: 2, lists: 5, folders: 1, tasks: 50 });
  });
});

describe("unmapped", () => {
  it("counts the Spaces heading for no Center", () => {
    expect(unmappedCount({ a: "", b: "sales", c: "" })).toBe(2);
  });

  it("says nothing when every Space is mapped", () => {
    expect(unmappedNotice({ a: "sales" })).toBeNull();
  });

  it("reads as a notice, not a blocker", () => {
    // Unmapped Spaces import in full. Wording it as an error would be a lie
    // about what the next click does.
    const notice = unmappedNotice({ a: "", b: "" })!;
    expect(notice).toMatch(/2 Spaces will import/);
    expect(notice).toMatch(/map them later without re-importing/);
  });
});

describe("describeSummary", () => {
  const summary = (over: Partial<ImportSummary> = {}): ImportSummary => ({
    projects: { created: 4, already_present: 0 },
    tasks: { created: 120, already_present: 0 },
    statuses_created: 12,
    grants_applied: [],
    unmapped_spaces: [],
    parity: [],
    ...over,
  });

  it("says 'would create' for a dry run and 'created' for a real one", () => {
    expect(describeSummary(summary({ dry_run: true }))).toMatch(/would create/);
    expect(describeSummary(summary())).toMatch(/^created/);
  });

  it("reports what was already there instead of hiding it", () => {
    // Re-running is the normal case — the upsert is idempotent — and "0
    // created" with no mention of the 400 rows it matched reads as a failure.
    const text = describeSummary(
      summary({
        projects: { created: 0, already_present: 4 },
        tasks: { created: 0, already_present: 400 },
      }),
    );
    expect(text).toMatch(/404 already present, left alone/);
  });

  it("agrees with itself about number", () => {
    expect(
      describeSummary(
        summary({ projects: { created: 1, already_present: 0 }, tasks: { created: 1, already_present: 0 } }),
      ),
    ).toMatch(/1 project, 1 task/);
  });

  it("mentions status lanes only when some were created", () => {
    expect(describeSummary(summary({ statuses_created: 0 }))).not.toMatch(/lanes/);
    expect(describeSummary(summary())).toMatch(/12 status lanes/);
  });
});
