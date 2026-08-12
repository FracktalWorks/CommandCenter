"use client";

/**
 * Tooltip — the themed hover/focus hint (WS-27ak item 2).
 *
 *     <Tooltip content="Start work">
 *       <Button icon="Play" aria-label="Start work" />
 *     </Tooltip>
 *
 * ## Why a component and not the native `title` attribute
 *
 * 130 `.tsx` files reach for `title="…"`. The browser's tooltip cannot be
 * themed — it draws in the OS's font, the OS's colours and the OS's timing, so
 * it is the one piece of chrome that looks identical under RapidTool, Fluent,
 * Material and Graphite and therefore wrong under at least three of them. It
 * also takes roughly a second to appear, vanishes after a few, and **never
 * appears on keyboard focus at all**, which is the case that matters most.
 *
 * ## ⚠️ A tooltip is never the only source of anything
 *
 * Two failure modes this wrapper cannot fix, and callers must respect:
 *
 * 1. **Touch has no hover.** On a phone this content is unreachable. Base UI
 *    deliberately does not open tooltips on tap, because a tap is an
 *    activation. So a tooltip may carry a *hint* ("Start work") and never a
 *    fact the user cannot get another way.
 * 2. **It is NOT wired to the trigger, so it is not a name OR a description.**
 *    🔴 Measured against `@base-ui/react@1.7.0`, not assumed: the trigger
 *    receives `id`, `data-base-ui-tooltip-trigger` and `data-popup-open` — and
 *    **no `aria-describedby`**. The popup element carries no `id` for one to
 *    point at. So a screen-reader user gets NOTHING from this component.
 *
 *    `role="tooltip"` below is set by this wrapper (the substrate does not set
 *    it either) so the hint is at least reachable, but the association is
 *    missing. **An icon-only trigger therefore MUST carry its own
 *    `aria-label`** — that is mandatory here, not a recommendation, and it is
 *    the whole accessible name.
 *
 *    Closing that gap means generating an id, putting it on the popup and
 *    passing `aria-describedby` to the trigger while open. That is a real
 *    slice, deliberately not smuggled into this one; `describeOnly` is the
 *    prop it will hang off, and until then it only documents intent.
 *
 * ## The delay lives on the Provider, not here
 *
 * ⚠️ Re-derived from `@base-ui/react@1.7.0`, not from notes:
 * `tooltip/root/TooltipRoot.d.ts` has **no `delay` prop**. It exposes
 * `defaultOpen`, `open`, `onOpenChange`, `onOpenChangeComplete`,
 * `disableHoverablePopup`, `trackCursorAxis`, `actionsRef`, `disabled`,
 * `handle` and the id props — and nothing else. Delay and the group timeout
 * are `Tooltip.Provider`'s (`delay`, `timeout`).
 *
 * That is not a limitation, it is the better model: a `Provider` makes a row of
 * icon buttons behave as one group, so the first hover waits and moving along
 * the row does not re-wait. `TooltipProvider` below is mounted once in
 * `src/app/layout.tsx`, beside `ToastProvider`. Without it every tooltip still works, just independently —
 * so this component is safe to use anywhere and gets nicer inside the app
 * shell.
 */

import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";

/** Which side of the trigger the bubble prefers. It flips on collision. */
export type TooltipSide = "top" | "right" | "bottom" | "left";

export type TooltipProps = {
  /**
   * The hint. `null`/`undefined`/`""` renders the child ALONE, with no trigger
   * and no wrapper — so `<Tooltip content={maybe}>` is safe in a map and does
   * not leave an empty bubble that opens on hover and shows nothing.
   */
  content?: React.ReactNode;
  /** The element the hint describes. Must accept a ref and spread props. */
  children: React.ReactElement<Record<string, unknown>>;
  side?: TooltipSide;
  /** Gap between trigger and bubble, in px. */
  sideOffset?: number;
  /**
   * ⚠️ **Currently inert** — reserved, and documented as such rather than
   * quietly doing nothing. The substrate wires no ARIA association at all (see
   * the header), so there is no wiring for this to switch between yet. It is
   * the prop the follow-up slice will hang `aria-describedby` vs
   * `aria-labelledby` off. Give the child an `aria-label` today.
   */
  describeOnly?: boolean;
  /** Suppress without unmounting — e.g. a hint that only applies when disabled. */
  disabled?: boolean;
};

export function Tooltip({
  content,
  children,
  side = "top",
  sideOffset = 6,
  describeOnly = true,
  disabled = false,
}: TooltipProps) {
  // No content, no tooltip. Returning the child untouched (rather than an
  // empty Root) keeps the DOM identical to the un-tooltipped case.
  if (content === null || content === undefined || content === "") return children;

  return (
    <BaseTooltip.Root disabled={disabled}>
      {/* `render` hands the trigger's props and ref to the CHILD rather than
          wrapping it in a span. A wrapper element would break flex/grid
          layouts, swallow the trigger's own margins, and give the hint a
          hit-target that is not the control. */}
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} sideOffset={sideOffset} className="z-50">
          {/* ⚠️ `role` is set HERE, by us, and it is load-bearing.
              Measured against @base-ui/react@1.7.0: `Tooltip.Popup` renders a
              bare `<div data-open data-side data-align tabindex="-1">` with
              NO role and NO id — the role sits on the Positioner instead.
              Dropping this line makes the hint invisible to assistive tech and
              to `getByRole("tooltip")`, which is how the gap was found. */}
          <BaseTooltip.Popup
            role="tooltip"
            // `popover`, not `card`: a tooltip floats above the surface the way
            // a menu does, and `--popover` is the token that already means
            // that. Using `card` would make it disappear into any card it
            // happens to open over.
            className={
              "cc-control max-w-xs rounded-md border border-border bg-popover " +
              "px-2 py-1 text-[11px] text-popover-foreground shadow-md"
            }
          >
            {content}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}

/**
 * Mount once, high in the tree. Groups every tooltip beneath it: the first
 * hover waits `delay`, and moving to another trigger within `timeout` opens
 * immediately instead of waiting again.
 *
 * 600ms is the pause that reads as "you hesitated", not as lag; 300ms of grace
 * is long enough to cross a toolbar gap and short enough that a tooltip does
 * not chase the cursor across the page.
 */
export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return (
    <BaseTooltip.Provider delay={600} timeout={300}>
      {children}
    </BaseTooltip.Provider>
  );
}

export default Tooltip;
