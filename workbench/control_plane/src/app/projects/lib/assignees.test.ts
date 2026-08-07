import { describe, expect, it } from "vitest";

import {
  assigneeLabel,
  classify,
  normalize,
  parseAssignees,
  withAssignee,
  withoutAssignee,
} from "./assignees";

describe("normalize", () => {
  it("matches the server: trimmed and lowercased", () => {
    expect(normalize("  Priya@X.com ")).toBe("priya@x.com");
  });
});

describe("classify", () => {
  it("recognises the agent prefix", () => {
    expect(classify("agent:researcher")).toBe("agent");
    expect(classify("Agent:Researcher")).toBe("agent");
  });

  it("does not call a bare prefix an agent", () => {
    // `agent:` names nobody, and treating it as an agent would show a chip for
    // a dispatch target that cannot exist.
    expect(classify("agent:")).toBe("unknown");
  });

  it("recognises an email", () => {
    expect(classify("priya@fracktal.in")).toBe("person");
  });

  it("flags something that is neither, without rejecting it", () => {
    // A hint, not a rule — the server accepts any non-empty string, and the
    // failure worth surfacing is a typo that assigns work to nobody.
    expect(classify("priya")).toBe("unknown");
    expect(classify("priya@fracktal")).toBe("unknown");
  });
});

describe("parseAssignees", () => {
  it("splits on commas, semicolons and newlines", () => {
    expect(parseAssignees("a@x.com, b@x.com; c@x.com\nd@x.com")).toEqual([
      "a@x.com",
      "b@x.com",
      "c@x.com",
      "d@x.com",
    ]);
  });

  it("does NOT split on spaces", () => {
    // A pasted list arrives as `Priya <priya@x.com>` often enough that
    // splitting on whitespace would shred it into tokens assigning nobody.
    expect(parseAssignees("priya <priya@x.com>")).toEqual(["priya <priya@x.com>"]);
  });

  it("drops empties left by trailing separators", () => {
    expect(parseAssignees("a@x.com,,  ,\n")).toEqual(["a@x.com"]);
  });

  it("dedupes after normalising, keeping first-seen order", () => {
    expect(parseAssignees("B@x.com, a@x.com, b@X.com")).toEqual([
      "b@x.com",
      "a@x.com",
    ]);
  });

  it("keeps agent targets alongside people", () => {
    expect(parseAssignees("agent:Researcher, priya@x.com")).toEqual([
      "agent:researcher",
      "priya@x.com",
    ]);
  });
});

describe("withAssignee", () => {
  it("appends a new assignee", () => {
    expect(withAssignee(["a@x.com"], "B@x.com")).toEqual(["a@x.com", "b@x.com"]);
  });

  it("returns the SAME array when the assignee is already there", () => {
    // Identity is the signal a caller uses to skip the PUT — and skipping it
    // is what stops a re-assert emitting pm.task.assigned and re-dispatching
    // an agent run.
    const current = ["a@x.com"];
    expect(withAssignee(current, "A@X.com")).toBe(current);
  });

  it("ignores blank input", () => {
    const current = ["a@x.com"];
    expect(withAssignee(current, "   ")).toBe(current);
  });
});

describe("withoutAssignee", () => {
  it("removes case-insensitively", () => {
    expect(withoutAssignee(["a@x.com", "b@x.com"], "A@X.com")).toEqual(["b@x.com"]);
  });

  it("is a no-op for somebody absent", () => {
    expect(withoutAssignee(["a@x.com"], "z@x.com")).toEqual(["a@x.com"]);
  });
});

describe("assigneeLabel", () => {
  it("shows an agent by name, without the prefix", () => {
    expect(assigneeLabel("agent:Researcher")).toBe("researcher");
  });

  it("shows a person by address", () => {
    expect(assigneeLabel("Priya@x.com")).toBe("priya@x.com");
  });
});
