/**
 * The branding rules that decide what a customer sees at the top of the app.
 *
 * The cases worth pinning are the ones a plausible implementation gets wrong
 * quietly: an org with no logo rendering an empty box instead of our mark, an
 * SVG rejected with a message that does not say what to do instead, and a
 * square logo allotted a wordmark's width.
 */
import { describe, expect, it } from "vitest";

import {
  LOGO_MAX_BYTES,
  LOGO_ACCEPT,
  POWERED_BY,
  formatBytes,
  lockup,
  logoBoxWidth,
  precheckLogoFile,
  type OrgLogo,
} from "./orgBranding";

const logo = (over: Partial<OrgLogo> = {}): OrgLogo => ({
  dataUri: "data:image/png;base64,AAAA",
  mime: "image/png",
  width: 600,
  height: 160,
  byteSize: 4096,
  ...over,
});

describe("the file pre-check", () => {
  it("accepts the three raster formats", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp"]) {
      expect(precheckLogoFile({ type, size: 20_000 })).toBeNull();
    }
  });

  it("tells an SVG uploader what to do instead of just refusing", () => {
    // SVG is what a designer hands over, so this is the likeliest rejection.
    // "Unsupported file type" sends someone back to guess.
    const msg = precheckLogoFile({ type: "image/svg+xml", size: 4_000 });
    expect(msg).toMatch(/SVG/);
    expect(msg).toMatch(/PNG/);
  });

  it("never lists SVG as acceptable to the picker", () => {
    expect(LOGO_ACCEPT).not.toContain("svg");
  });

  it("rejects an oversized file and says by how much", () => {
    const msg = precheckLogoFile({ type: "image/png", size: LOGO_MAX_BYTES + 1 });
    expect(msg).toMatch(/128 KB/);
  });

  it("rejects an empty file", () => {
    expect(precheckLogoFile({ type: "image/png", size: 0 })).toMatch(/empty/i);
  });

  it("accepts a file exactly at the limit", () => {
    expect(precheckLogoFile({ type: "image/png", size: LOGO_MAX_BYTES })).toBeNull();
  });
});

describe("formatBytes", () => {
  it("reads in the unit a person would use", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(128 * 1024)).toBe("128 KB");
    expect(formatBytes(4 * 1024 * 1024)).toBe("4.0 MB");
  });
});

describe("the lockup", () => {
  it("falls back to our own mark when nothing is uploaded", () => {
    // The failure this guards is an empty box where a logo would be.
    const l = lockup(null, "Control Plane");
    expect(l.kind).toBe("default");
    expect(l).toMatchObject({ title: "CommandCenter", caption: "Control Plane" });
  });

  it("falls back when the row exists but carries no logo", () => {
    const l = lockup({ logo: null, updatedBy: "a@b.c", updatedAt: "" }, "Home");
    expect(l.kind).toBe("default");
  });

  it("falls back when a stored logo has an empty data URI", () => {
    // A half-written row must not render a broken <img>.
    const l = lockup(
      { logo: logo({ dataUri: "" }), updatedBy: "", updatedAt: "" },
      "Home",
    );
    expect(l.kind).toBe("default");
  });

  it("shows the customer's logo over our attribution", () => {
    const l = lockup({ logo: logo(), updatedBy: "", updatedAt: "" }, "Home");
    expect(l.kind).toBe("org");
    expect(l.caption).toBe(POWERED_BY);
    if (l.kind === "org") expect(l.logo.dataUri).toContain("base64");
  });

  it("keeps the attribution wording in exactly one place", () => {
    expect(POWERED_BY).toBe("powered by CommandCenter");
  });
});

describe("logoBoxWidth", () => {
  it("gives a wordmark the width its aspect ratio earns", () => {
    // 600×160 at 28px tall wants 105px.
    expect(logoBoxWidth(logo(), 28, 160)).toBe(105);
  });

  it("does not hand a square mark a wordmark's width", () => {
    // The visible defect: a 1:1 logo floating in the left third of a wide box.
    expect(logoBoxWidth(logo({ width: 200, height: 200 }), 28, 160)).toBe(28);
  });

  it("clamps a very wide mark so it cannot push the nav off the edge", () => {
    expect(logoBoxWidth(logo({ width: 1600, height: 200 }), 28, 160)).toBe(160);
  });

  it("degrades to the full box on nonsense dimensions rather than dividing by zero", () => {
    expect(logoBoxWidth(logo({ width: 0, height: 0 }), 28, 160)).toBe(160);
  });
});
