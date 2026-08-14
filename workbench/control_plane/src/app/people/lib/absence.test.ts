/**
 * WS-28k — absences, the pure half.
 *
 * Spec: `project-docs/specs/people_center_app.md` §5.8 · D-PC-7.
 *
 * Formatting and ordering. **The availability arithmetic is the server's** —
 * "how many hours before this deadline" needs the schedule, the org policy and
 * the spans together, and a second answer computed here would be a second
 * number for the same question.
 */

import { describe, expect, it } from "vitest";

import {
  ABSENCE_KINDS,
  describeAbsence,
  isPast,
  shortDate,
  sortAbsences,
} from "./absence";
import type { Absence } from "./api";

const TODAY = new Date("2026-08-13T00:00:00");

function absence(over: Partial<Absence> = {}): Absence {
  return {
    id: "a1",
    starts_on: "2026-08-10",
    ends_on: "2026-08-14",
    kind: "away",
    ...over,
  };
}

describe("the vocabulary", () => {
  it("is the three words the gateway and the CHECK agree on", () => {
    // A fourth kind here would be a save that fails at Postgres. Every
    // additional one is a policy question in disguise: "sick" invites "how
    // many days left" (D-PC-7).
    expect([...ABSENCE_KINDS]).toEqual(["away", "holiday", "partial"]);
  });
});

describe("sortAbsences", () => {
  it("puts the soonest first", () => {
    const rows = [
      absence({ id: "b", starts_on: "2026-09-01" }),
      absence({ id: "a", starts_on: "2026-08-10" }),
    ];
    expect(sortAbsences(rows).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("does not mutate what it is given", () => {
    const rows = [
      absence({ id: "b", starts_on: "2026-09-01" }),
      absence({ id: "a", starts_on: "2026-08-10" }),
    ];
    sortAbsences(rows);
    expect(rows[0].id).toBe("b");
  });
});

describe("describeAbsence", () => {
  // ⚠️ Asserted by PARTS, not as an exact string. `toLocaleDateString` renders
  // in the viewer's locale — "10 Aug" here, "Aug 10" there — and that is the
  // correct behaviour for a product used from more than one country. Pinning a
  // locale to make the assertion tidy would make the PRODUCT wrong to make the
  // TEST simple. Measured: this environment renders "Aug 10".
  it("reads as a range", () => {
    const line = describeAbsence(absence(), TODAY);
    expect(line).toMatch(/10/);
    expect(line).toMatch(/14/);
    expect(line).toMatch(/Aug/);
    expect(line).toContain("–");
    expect(line).toContain("· away");
  });

  it("collapses a single day", () => {
    // A range whose ends are equal is the same fact spelled so nobody reads
    // it, and a one-day absence is the commonest case.
    const line = describeAbsence(
      absence({ starts_on: "2026-08-10", ends_on: "2026-08-10" }),
      TODAY
    );
    expect(line).not.toContain("–");
    expect(line).toContain("· away");
  });

  it("shows the day length only for a partial", () => {
    expect(
      describeAbsence(absence({ kind: "partial", hours_per_day: 4 }), TODAY)
    ).toContain("4h/day");
    expect(describeAbsence(absence({ hours_per_day: 4 }), TODAY)).not.toContain(
      "4h/day"
    );
  });

  it("carries the note when there is one", () => {
    expect(describeAbsence(absence({ note: "conference" }), TODAY)).toContain(
      "conference"
    );
  });

  it("keeps the year when it is not this one", () => {
    expect(shortDate("2027-01-05", TODAY)).toContain("2027");
    expect(shortDate("2026-01-05", TODAY)).not.toContain("2026");
  });

  it("shows an unparseable date rather than swallowing it", () => {
    // Better a visible oddity than a row that renders as "Invalid Date" or
    // silently disappears.
    expect(shortDate("not-a-date")).toBe("not-a-date");
  });
});

describe("isPast", () => {
  it("knows what has already happened", () => {
    expect(isPast(absence({ ends_on: "2026-08-01" }), TODAY)).toBe(true);
    expect(isPast(absence({ ends_on: "2026-08-20" }), TODAY)).toBe(false);
  });

  it("counts today as not yet past", () => {
    expect(isPast(absence({ ends_on: "2026-08-13" }), TODAY)).toBe(false);
  });
});
