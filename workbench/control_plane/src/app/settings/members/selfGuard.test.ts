import { describe, expect, it } from "vitest";
import { isSelf, rowActions } from "./selfGuard";
import type { Member } from "./types";

function member(over: Partial<Member> = {}): Member {
  return {
    email: "priya@fracktal.in",
    display_name: "Priya",
    status: "active",
    roles: ["member"],
    ...over,
  };
}

describe("isSelf", () => {
  it("matches regardless of how the directory cased the address", () => {
    // The row and the session come from the same IdP, which is free to change
    // UPN casing between sessions. A literal comparison is one quirk away
    // from switching the guard off.
    expect(isSelf("Owner@Fracktal.IN", "owner@fracktal.in")).toBe(true);
    expect(isSelf("owner@fracktal.in", "OWNER@FRACKTAL.IN")).toBe(true);
    expect(isSelf(" owner@fracktal.in ", "owner@fracktal.in")).toBe(true);
  });

  it("does not match two different people", () => {
    expect(isSelf("owner@fracktal.in", "priya@fracktal.in")).toBe(false);
  });

  it("treats an absent identity as nobody, never as everybody", () => {
    // The signed-out shell resolves to NO_ACCESS, whose email is "".
    expect(isSelf("", "priya@fracktal.in")).toBe(false);
    expect(isSelf("owner@fracktal.in", "")).toBe(false);
    expect(isSelf("", "")).toBe(false);
  });
});

describe("rowActions", () => {
  it("offers nothing destructive on the viewer's own row", () => {
    const a = rowActions("Owner@Fracktal.IN", member({ email: "owner@fracktal.in" }));
    expect(a.isSelf).toBe(true);
    expect(a.canSuspend).toBe(false);
    expect(a.canRemove).toBe(false);
  });

  it("offers both on somebody else's active row", () => {
    const a = rowActions("owner@fracktal.in", member());
    expect(a.isSelf).toBe(false);
    expect(a.canSuspend).toBe(true);
    expect(a.canRemove).toBe(true);
    expect(a.canActivate).toBe(false);
  });

  it("offers Activate — not Suspend — on a dormant row", () => {
    for (const status of ["suspended", "invited"] as const) {
      const a = rowActions("owner@fracktal.in", member({ status }));
      expect(a.canActivate).toBe(true);
      expect(a.canSuspend).toBe(false);
      expect(a.canRemove).toBe(true);
    }
  });

  it("does not offer to re-remove somebody already off-boarded", () => {
    const a = rowActions("owner@fracktal.in", member({ status: "removed" }));
    expect(a.canRemove).toBe(false);
    expect(a.canSuspend).toBe(false);
  });

  it("still offers to re-activate the viewer's own dormant row", () => {
    // Not destructive, and the gateway allows it: `active` is the one status
    // that gives access rather than taking it.
    const a = rowActions(
      "owner@fracktal.in",
      member({ email: "owner@fracktal.in", status: "suspended" })
    );
    expect(a.isSelf).toBe(true);
    expect(a.canActivate).toBe(true);
    expect(a.canSuspend).toBe(false);
  });
});
