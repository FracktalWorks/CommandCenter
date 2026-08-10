/**
 * WS-27x — the shown-fields vocabulary and its value discipline.
 *
 * The claims worth pinning are the seams: the vocabulary this file exports is
 * the ONE source both the table's columns and the chip gate read, its keys
 * are mirrored by the gateway's `filters.SHOWN_FIELDS`, and "absent" must
 * stay distinguishable from "explicitly empty" or a deliberate hide-all view
 * un-hides itself on the next apply.
 */

import { describe, expect, it } from "vitest";

import {
  CUSTOM_FIELD_PREFIX,
  DEFAULT_SHOWN,
  FIELD_KEYS,
  FIELD_LABELS,
  customFieldKey,
  isFieldKey,
  sameFieldSet,
  sanitizeShownFields,
  toggleField,
} from "./shownFields";

describe("the vocabulary", () => {
  it("labels every core key, so the picker can never render a bare slug", () => {
    for (const key of FIELD_KEYS) {
      expect(FIELD_LABELS[key], `${key} has no label`).toBeTruthy();
    }
  });

  it("defaults to a subset of the vocabulary", () => {
    for (const key of DEFAULT_SHOWN) expect(isFieldKey(key)).toBe(true);
  });

  it("accepts custom fields by shape — and refuses the bare prefix", () => {
    expect(isFieldKey("custom.budget")).toBe(true);
    expect(isFieldKey(CUSTOM_FIELD_PREFIX)).toBe(false);
    expect(isFieldKey("customer")).toBe(false);
    expect(isFieldKey(7)).toBe(false);
  });

  it("spells a custom field the way the timeline already does", () => {
    // `patch_task` files a custom edit as `custom.<key>` — one spelling
    // across the app, not a second one invented here.
    expect(customFieldKey({ field_key: "budget" })).toBe("custom.budget");
  });
});

describe("sanitizeShownFields", () => {
  it("distinguishes absent from explicitly empty", () => {
    // Absent = the default set (the caller's to apply); [] = every column
    // hidden, a deliberate choice that must survive the round trip.
    expect(sanitizeShownFields(undefined)).toBeNull();
    expect(sanitizeShownFields("status,tags")).toBeNull();
    expect(sanitizeShownFields({})).toBeNull();
    expect(sanitizeShownFields([])).toEqual([]);
  });

  it("drops unknown and non-string keys, keeps the rest in order", () => {
    expect(
      sanitizeShownFields(["status", "phase", 7, null, "due_at", "custom.budget"]),
    ).toEqual(["status", "due_at", "custom.budget"]);
  });

  it("collapses duplicates to the first appearance", () => {
    expect(sanitizeShownFields(["tags", "status", "tags"])).toEqual([
      "tags",
      "status",
    ]);
  });
});

describe("sameFieldSet", () => {
  it("compares as a SET — order is the vocabulary's, not the list's", () => {
    expect(sameFieldSet(["status", "tags"], ["tags", "status"])).toBe(true);
    expect(sameFieldSet(["status"], ["status", "tags"])).toBe(false);
    expect(sameFieldSet([], [])).toBe(true);
  });
});

describe("toggleField", () => {
  it("adds an absent field and removes a present one", () => {
    expect(toggleField(["status"], "tags")).toEqual(["status", "tags"]);
    expect(toggleField(["status", "tags"], "tags")).toEqual(["status"]);
  });

  it("does not mutate the input", () => {
    const shown = ["status"];
    toggleField(shown, "tags");
    expect(shown).toEqual(["status"]);
  });
});
