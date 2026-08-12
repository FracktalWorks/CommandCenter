"use client";

/**
 * Checkbox — the themed tick box (WS-27bh).
 *
 *     <Checkbox checked={done} onChange={…} />
 *     <Checkbox checked={all} indeterminate={some} onChange={…} label="Select all" />
 *
 * The tree carries raw `<input type="checkbox">` in 25 files. Unlike a raw
 * `<select>` — whose disclosure triangle is drawn by the OS and is unreachable
 * by any stylesheet — a raw checkbox is *mostly* themable with `accent-color`.
 * What it cannot do is match the theme's focus ring, its radius or its border,
 * so a row of them next to a themed Button reads as two different products on
 * Fluent and Material.
 *
 * ## Why this one is native and not Base UI
 *
 * D-PM-15 chose `@base-ui/react` as the one substrate, and `Modal` uses it —
 * because a dialog needs focus trapping, scroll locking, portalling and
 * `aria-hidden` on the rest of the document, none of which is expressible in
 * markup. **A checkbox needs none of that.** `<input type="checkbox">` already
 * has the role, the keyboard behaviour, the label association and the
 * indeterminate state; wrapping it in a substrate component would add a
 * dependency to reimplement what the platform ships correctly. The substrate is
 * for behaviour the platform lacks, not a house style.
 *
 * `appearance-none` plus a drawn tick, rather than `accent-color`: the accent
 * property colours the fill but leaves the browser's own border and radius, and
 * those are the parts that look wrong on a 0.125rem-radius theme.
 */

import { useEffect, useRef } from "react";

import Icon from "@/components/Icon";

export type CheckboxProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "type" | "className" | "size"
> & {
  /**
   * The third state. Not a value — `indeterminate` is a DOM *property* with no
   * HTML attribute, so it can only be set imperatively. That is the one reason
   * this component holds a ref.
   */
  indeterminate?: boolean;
  /** Renders a `<label>` around the box, so the text is a click target too. */
  label?: React.ReactNode;
  className?: string;
};

export function Checkbox({
  indeterminate = false,
  label,
  className = "",
  disabled,
  ...rest
}: CheckboxProps) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);

  const box = (
    <span className="relative inline-flex shrink-0 items-center justify-center">
      <input
        {...rest}
        ref={ref}
        type="checkbox"
        disabled={disabled}
        className={
          "cc-control peer h-4 w-4 cursor-pointer appearance-none rounded border " +
          "border-border bg-background outline-none " +
          "checked:border-primary checked:bg-primary " +
          "indeterminate:border-primary indeterminate:bg-primary " +
          "focus-visible:border-primary/50 " +
          "disabled:cursor-not-allowed disabled:opacity-60 " +
          className
        }
      />
      {/* The glyph rides ON the filled box, so it takes the `-foreground`
          partner rather than white — `text-white` on a pale primary is
          invisible, which DESIGN_SYSTEM §1 calls out as a real past bug. */}
      <Icon
        name={indeterminate ? "Minus" : "Check"}
        size={11}
        className={
          "pointer-events-none absolute text-primary-foreground opacity-0 " +
          (indeterminate ? "peer-indeterminate:opacity-100" : "peer-checked:opacity-100")
        }
      />
    </span>
  );

  if (!label) return box;
  return (
    <label
      className={
        "inline-flex items-center gap-2 text-xs text-foreground " +
        (disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer")
      }
    >
      {box}
      <span>{label}</span>
    </label>
  );
}

export default Checkbox;
