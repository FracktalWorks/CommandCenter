/**
 * WS-28q — the cropper's arithmetic.
 *
 * Spec: `project-docs/specs/people_center_app.md` §3.1a.
 *
 * Which region of the source a pan-and-zoom viewport is actually showing is
 * easy to get subtly wrong and hard to notice by looking, so it is tested as
 * numbers. **None of it is a control** — the server squares and resizes
 * whatever it receives (D-PC-17) — so what these lock is that somebody's face
 * lands where they put it, not that the stored image is the right shape.
 */

import { describe, expect, it } from "vitest";

import {
  INITIAL_CROP,
  MAX_ZOOM,
  MIN_ZOOM,
  clampZoom,
  previewStyle,
  rejectReason,
  toCropRect,
} from "./crop";

const WIDE = { width: 1000, height: 400 };
const TALL = { width: 400, height: 1000 };
const SQUARE = { width: 600, height: 600 };

describe("toCropRect", () => {
  it("takes the centre square at rest", () => {
    const rect = toCropRect(INITIAL_CROP, WIDE);
    expect(rect.size).toBe(1);                       // the whole short edge
    expect(rect.x).toBeCloseTo(0.3);                 // (1000-400)/2 / 1000
    expect(rect.y).toBe(0);
  });

  it("is fractional, so the server never needs the DPI", () => {
    // A 1000x400 image opens server-side as a 750x300 POINT page; a pixel
    // rectangle would crop the wrong region. Measured, not guessed.
    const rect = toCropRect(INITIAL_CROP, WIDE);
    for (const value of [rect.x, rect.y, rect.size]) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it("works the same way on a tall image", () => {
    const rect = toCropRect(INITIAL_CROP, TALL);
    expect(rect.x).toBe(0);
    expect(rect.y).toBeCloseTo(0.3);
  });

  it("zooming shrinks the selection", () => {
    expect(toCropRect({ ...INITIAL_CROP, zoom: 2 }, SQUARE).size).toBeCloseTo(0.5);
  });

  it("panning moves it", () => {
    const rest = toCropRect({ ...INITIAL_CROP, zoom: 2 }, SQUARE);
    const moved = toCropRect({ zoom: 2, offsetX: -0.25, offsetY: 0 }, SQUARE);
    expect(moved.x).toBeGreaterThan(rest.x);
  });

  it("clamps the selection inside the image", () => {
    // Dragging past the edge gives the edge — not a band of background baked
    // into somebody's picture.
    const far = toCropRect({ zoom: 2, offsetX: -99, offsetY: -99 }, SQUARE);
    expect(far.x + far.size).toBeLessThanOrEqual(1.0001);
    expect(far.y + far.size).toBeLessThanOrEqual(1.0001);
    const near = toCropRect({ zoom: 2, offsetX: 99, offsetY: 99 }, SQUARE);
    expect(near.x).toBeGreaterThanOrEqual(0);
    expect(near.y).toBeGreaterThanOrEqual(0);
  });

  it("survives an image whose size is not known yet", () => {
    // `onLoad` has not fired: the request must still be well formed rather
    // than NaN, which would reach the server as an unparseable form field.
    const rect = toCropRect(INITIAL_CROP, { width: 0, height: 0 });
    expect(rect).toEqual({ x: 0, y: 0, size: 1 });
  });

  it("survives a state full of nonsense", () => {
    const rect = toCropRect(
      { zoom: Number.NaN, offsetX: Number.POSITIVE_INFINITY, offsetY: Number.NaN },
      SQUARE
    );
    for (const value of [rect.x, rect.y, rect.size]) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });
});

describe("clampZoom", () => {
  it("holds the range", () => {
    expect(clampZoom(0.1)).toBe(MIN_ZOOM);
    expect(clampZoom(99)).toBe(MAX_ZOOM);
    expect(clampZoom(2)).toBe(2);
  });

  it("treats nonsense as no zoom", () => {
    expect(clampZoom(Number.NaN)).toBe(MIN_ZOOM);
  });
});

describe("previewStyle", () => {
  it("is derived from the SAME state as the request", () => {
    // A preview computed separately from the output lies at the edges, and
    // only at the edges — the hardest kind of wrong to notice.
    const style = previewStyle(INITIAL_CROP, SQUARE, 200);
    expect(style.width).toBeCloseTo(200);
    expect(style.left).toBeCloseTo(0);
  });

  it("scales the image up as the crop shrinks", () => {
    const zoomed = previewStyle({ ...INITIAL_CROP, zoom: 2 }, SQUARE, 200);
    expect(zoomed.width).toBeCloseTo(400);
  });

  it("offsets the image so the chosen region fills the viewport", () => {
    const style = previewStyle(INITIAL_CROP, WIDE, 200);
    // The centre square of a 1000x400 starts 30% in, so the image is pulled
    // left by 30% of its scaled width.
    expect(style.left).toBeCloseTo(-0.3 * style.width, 1);
  });
});

describe("rejectReason", () => {
  const file = (type: string, size: number, name = "p.jpg") =>
    ({ type, size, name }) as File;

  it("accepts the three formats the server decodes", () => {
    for (const type of ["image/jpeg", "image/png", "image/webp"]) {
      expect(rejectReason(file(type, 1000))).toBeNull();
    }
  });

  it("refuses an SVG here as well as at the server", () => {
    expect(rejectReason(file("image/svg+xml", 1000))).toContain("not a JPEG");
  });

  it("refuses something too large, and says the size", () => {
    const reason = rejectReason(file("image/jpeg", 9 * 1024 * 1024));
    expect(reason).toContain("9.0 MB");
    expect(reason).toContain("resized");
  });

  it("is a courtesy, not the control — it names the same formats", () => {
    // The server sniffs the bytes and refuses again; this only saves the round
    // trip. What matters is that the two lists agree.
    expect(rejectReason(file("application/pdf", 100))).toContain("WebP");
  });
});
