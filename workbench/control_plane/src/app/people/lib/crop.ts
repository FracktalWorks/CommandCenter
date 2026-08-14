/**
 * People Center · the cropper's arithmetic (WS-28q).
 *
 * Spec: `project-docs/specs/people_center_app.md` §3.1a.
 *
 * Pure, so the part that is easy to get subtly wrong — which region of the
 * source a pan-and-zoom viewport is actually showing — is testable as numbers
 * rather than by looking at a picture and deciding it seems about right.
 *
 * **The crop is expressed as FRACTIONS of the source, never pixels.** A
 * 1000x400 image opens server-side as a 750x300 *point* page, so a pixel
 * rectangle would crop the wrong region; fractions cancel the units and the
 * client never needs the DPI. That was measured, not guessed.
 *
 * ⚠️ Nothing here is a control. The server squares and resizes whatever it is
 * sent (D-PC-17), so a bug in this file makes somebody's picture land wrong —
 * it cannot make the stored image the wrong shape.
 */

/** What the cropper holds: a zoom, and where the image sits under the window. */
export interface CropState {
  /** 1 = the whole shortest edge fills the square. Above 1 zooms in. */
  zoom: number;
  /** Pan, as a fraction of the *visible* square, from its centre. */
  offsetX: number;
  offsetY: number;
}

export interface SourceSize {
  width: number;
  height: number;
}

/** The rectangle the server is asked for: `(x, y, side)` in `[0, 1]`. */
export interface CropRect {
  x: number;
  y: number;
  size: number;
}

export const INITIAL_CROP: CropState = { zoom: 1, offsetX: 0, offsetY: 0 };

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

/** Accepted by the file picker AND re-checked by the server (D-PC-17). */
export const ACCEPT = "image/jpeg,image/png,image/webp";

/** Refused before upload — the server refuses it again, this is the courtesy. */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return MIN_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/**
 * The viewport → the crop rectangle the server understands.
 *
 * The square selection is `shortest / zoom` of the source. Panning moves it,
 * and it is **clamped inside the image** — so a person who drags past the edge
 * gets the edge, not a band of background baked into their picture.
 */
export function toCropRect(state: CropState, source: SourceSize): CropRect {
  const { width, height } = source;
  if (!(width > 0) || !(height > 0)) return { x: 0, y: 0, size: 1 };

  const zoom = clampZoom(state.zoom);
  const shortest = Math.min(width, height);
  const side = shortest / zoom;

  // Offsets are fractions of the visible square, so a drag of half a viewport
  // means the same thing at every zoom level — which is what makes the control
  // feel like it is moving the image rather than a number.
  const centreX = width / 2 - (state.offsetX || 0) * side;
  const centreY = height / 2 - (state.offsetY || 0) * side;

  const x = clamp(centreX - side / 2, 0, width - side);
  const y = clamp(centreY - side / 2, 0, height - side);

  return { x: x / width, y: y / height, size: side / shortest };
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(Math.max(value, low), Math.max(low, high));
}

/**
 * The CSS the preview needs to show exactly what `toCropRect` will ask for.
 *
 * Derived from the same state, so the preview and the request cannot disagree
 * — a cropper whose preview is computed separately from its output is one that
 * lies at the edges, and only at the edges, which is the hardest kind to
 * notice.
 */
export function previewStyle(
  state: CropState,
  source: SourceSize,
  viewport: number
): { width: number; height: number; left: number; top: number } {
  const rect = toCropRect(state, source);
  const shortest = Math.min(source.width, source.height) || 1;
  const scale = viewport / (rect.size * shortest);
  return {
    width: source.width * scale,
    height: source.height * scale,
    left: -rect.x * source.width * scale,
    top: -rect.y * source.height * scale,
  };
}

/** Why this file cannot be uploaded, or null. The server checks again. */
export function rejectReason(file: File): string | null {
  if (!ACCEPT.split(",").includes(file.type)) {
    return `${file.name} is not a JPEG, PNG or WebP.`;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return (
      `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit ` +
      `is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB — it is resized to 256×256 either way.`
    );
  }
  return null;
}
