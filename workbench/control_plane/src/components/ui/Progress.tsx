"use client";

/**
 * Progress — a themed determinate bar (WS-27bh).
 *
 *     <Progress value={62} />
 *     <Progress value={7} max={12} label="Prototype" hue="amber" />
 *
 * Needed by the Project Operations screens: stage progress on the project
 * header, workload percentage on the People table, effort-against-estimate in
 * the Overview time summary.
 *
 * ## Two rules it enforces so call sites cannot get them wrong
 *
 * 1. **The value is clamped and the percentage is computed here.** Three
 *    surfaces want a bar and each would otherwise divide by its own
 *    denominator; a workload of 104% then either overflows its track or is
 *    silently truncated to 100 depending on which one you are looking at.
 *    Clamping happens for the DRAWING only — `aria-valuenow` reports the real
 *    number, because a screen reader should hear "104" when the person is
 *    overloaded, not a comfortable lie.
 * 2. **Colour is a `hue`, never a class string.** It resolves through
 *    `statusAccent`, the one status colour vocabulary (AGENTS.md rule 4), so a
 *    bar and the badge beside it cannot disagree about what amber means.
 */

import { type AccentHue, accentForHue } from "@/lib/statusAccent";

export type ProgressProps = {
  value: number;
  max?: number;
  /** Resolved through the shared vocabulary — never a raw colour class. */
  hue?: AccentHue;
  /** Accessible name. Rendered only when `showLabel` is set. */
  label?: string;
  showLabel?: boolean;
  /** Tailwind height utility. `h-1.5` reads as a meter; `h-2.5` as a bar. */
  height?: string;
  /**
   * Draw a reference tick at this value (same units as `value`).
   *
   * Exists because a clamped bar cannot express "over". Workload rows at 103%
   * and at exactly 100% drew an identical full track, so the one fact the
   * panel exists to report — this person is beyond their capacity — was the one
   * it could not show. Pass `max` above 100 to leave room, and `marker={100}`
   * to say where the line is. Without both, a full bar is ambiguous.
   */
  marker?: number;
  className?: string;
};

export function Progress({
  value,
  max = 100,
  hue = "blue",
  label,
  showLabel = false,
  height = "h-1.5",
  marker,
  className = "",
}: ProgressProps) {
  const safeMax = max > 0 ? max : 100;
  const raw = (value / safeMax) * 100;
  // Drawn width only. See rule 1 — the reported value below is unclamped.
  const width = Math.max(0, Math.min(100, Number.isFinite(raw) ? raw : 0));
  const accent = accentForHue(hue);
  // Only meaningful strictly inside the track — a tick at 0% or 100% is
  // indistinguishable from the track's own end and just looks like a glitch.
  const markerRaw = marker === undefined ? null : (marker / safeMax) * 100;
  const markerPct =
    markerRaw !== null && Number.isFinite(markerRaw) && markerRaw > 0 && markerRaw < 100
      ? markerRaw
      : null;

  return (
    <div className={className}>
      {showLabel && label ? (
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <span className="truncate text-[11px] text-muted-foreground">{label}</span>
          <span className="shrink-0 text-[11px] tabular-nums text-foreground">
            {Math.round(raw)}%
          </span>
        </div>
      ) : null}
      <div
        role="progressbar"
        aria-valuenow={Math.round(raw)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
        className={`relative w-full overflow-hidden rounded-full bg-muted ${height}`}
      >
        <div
          className={`${height} rounded-full ${accent.dot} tech-transition`}
          style={{ width: `${width}%` }}
        />
        {markerPct !== null ? (
          // Sits ON the fill, not behind it, so an over-capacity bar visibly
          // crosses the line rather than hiding it. `bg-card` rather than a
          // border colour: this is a gap punched through the bar, and it has
          // to read against BOTH the muted track and the coloured fill.
          <span
            aria-hidden
            className="absolute inset-y-0 w-0.5 rounded-full bg-card/90"
            style={{ left: `${markerPct}%` }}
          />
        ) : null}
      </div>
    </div>
  );
}

export default Progress;
