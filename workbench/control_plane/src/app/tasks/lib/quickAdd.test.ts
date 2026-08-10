/**
 * /tasks · group-context quick-add prefill.
 *
 * What is pinned: every settable axis maps to the field that files the task
 * into that group; every unset bucket maps to a bare create (which already
 * lands there); and the computed axes refuse (`null`) rather than offering an
 * add that would visibly land in a sibling group.
 */

import { describe, expect, it } from "vitest";

import { NO_CONTEXT_GROUP } from "./priority";
import { quickAddPrefill } from "./quickAdd";

describe("quickAddPrefill", () => {
  it("files a status-axis add into its stage — board column or list section", () => {
    expect(quickAddPrefill("", "IN PROCESS")).toEqual({ workflowStage: "IN PROCESS" });
  });

  it("files a context-group add under that @context", () => {
    expect(quickAddPrefill("context", "@computer")).toEqual({ context: "@computer" });
  });

  it("lets the no-context bucket stay a bare create — a bare item already lands there", () => {
    expect(quickAddPrefill("context", NO_CONTEXT_GROUP)).toEqual({});
  });

  it("files an energy-group add at that energy, and the unset bucket bare", () => {
    expect(quickAddPrefill("energy", "high")).toEqual({ energy: "high" });
    expect(quickAddPrefill("energy", "none")).toEqual({});
  });

  it("marks a deep-work-group add deep, and shallow bare", () => {
    expect(quickAddPrefill("depth", "deep")).toEqual({ deepWork: true });
    expect(quickAddPrefill("depth", "shallow")).toEqual({});
  });

  it("treats the flat list as a plain add", () => {
    expect(quickAddPrefill("none", "all")).toEqual({});
  });

  it("refuses the computed axes — no payload can promise the landing", () => {
    expect(quickAddPrefill("priority", "critical")).toBeNull();
    expect(quickAddPrefill("mode", "do")).toBeNull();
  });
});
