import { describe, expect, it } from "vitest";

import { clockFace } from "./WorkTimerDock";

/**
 * The dock's one piece of arithmetic. R7 — a rule names its fence.
 *
 * The dock itself is a rendering concern and stays review-only until the
 * browser sweep (D-PM-21 refused jsdom), but the clock is pure and is the part
 * a reader stares at for an hour, so it is tested here.
 */
describe("clockFace", () => {
  it("shows mm:ss under an hour, with seconds always moving", () => {
    expect(clockFace(0)).toBe("00:00");
    expect(clockFace(9)).toBe("00:09");
    expect(clockFace(59)).toBe("00:59");
    expect(clockFace(60)).toBe("01:00");
    expect(clockFace(3599)).toBe("59:59");
  });

  it("grows an hours field rather than rolling over", () => {
    expect(clockFace(3600)).toBe("1:00:00");
    expect(clockFace(6137)).toBe("1:42:17");
    expect(clockFace(36000)).toBe("10:00:00");
  });

  it("pads minutes and seconds but not hours", () => {
    // `1:05:03`, not `01:05:03` — a leading zero on the hour reads as a clock
    // time rather than a duration.
    expect(clockFace(3903)).toBe("1:05:03");
  });

  it("floors fractional seconds instead of showing 00:0NaN", () => {
    expect(clockFace(12.7)).toBe("00:12");
  });

  it("never renders a negative duration", () => {
    // Clock skew between the browser and the server is real: if the client's
    // clock is behind, `now - started_at` is negative and a raw format would
    // render "-1:59:-59". Zero is the only honest answer.
    expect(clockFace(-1)).toBe("00:00");
    expect(clockFace(-99999)).toBe("00:00");
  });
});
