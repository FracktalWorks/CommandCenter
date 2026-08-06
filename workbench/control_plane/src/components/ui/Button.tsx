"use client";

/**
 * Button — the shared action primitive.
 *
 * Replaces the class recipe that DESIGN_SYSTEM.md used to document as a string
 * to copy. That worked for colour and radius, which are tokens, but a design
 * system's *behaviour* has nowhere to live in a copied class list: Material's
 * hover is a translucent state layer, Fluent strokes even its solid buttons,
 * and Graphite upper-cases its labels. Those come from the control tokens and
 * need one component to apply them.
 *
 *     <Button onClick={save}>Save</Button>
 *     <Button variant="secondary" size="sm">Cancel</Button>
 *     <Button variant="destructive" icon="Trash2" loading={deleting}>Delete</Button>
 *     <Button variant="ghost" size="icon" icon="X" aria-label="Close" />
 *
 * The default variant and size reproduce the previous recipe exactly, so the
 * RapidTool theme is unchanged by adoption.
 */

import Icon from "@/components/Icon";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";
export type ButtonSize = "sm" | "md" | "lg" | "icon";

/**
 * Colour per variant. `cc-button-filled` adds the theme's stroke on solid
 * variants — no-op at 0px, a real border on Fluent.
 */
const VARIANTS: Record<ButtonVariant, string> = {
  primary: "cc-button-filled bg-primary text-primary-foreground hover:opacity-90",
  secondary:
    "border border-border text-muted-foreground hover:text-foreground hover:border-primary/30",
  ghost: "text-muted-foreground hover:bg-secondary hover:text-foreground",
  destructive: "bg-destructive/10 text-destructive hover:bg-destructive/20",
};

/** Geometry per size — the three shapes that already existed in the app. */
const SIZES: Record<ButtonSize, string> = {
  sm: "gap-1 px-2.5 py-1.5 text-[12px]",
  md: "gap-1.5 px-3 py-1.5 text-xs",
  lg: "gap-1.5 px-3 sm:px-4 py-2 text-sm",
  icon: "p-2",
};

export type ButtonProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Lucide icon name rendered before the label; follows the active pack. */
  icon?: string;
  /**
   * Swaps the icon for a spinner and disables the button. Kept as a prop
   * rather than left to call sites because "disabled while pending" is the
   * part everyone forgets, and a double-submit is a real bug.
   */
  loading?: boolean;
  /** Extra classes for layout only — never for colour, radius or weight. */
  className?: string;
  children?: React.ReactNode;
};

export default function Button({
  variant = "primary",
  size = "md",
  icon,
  loading = false,
  disabled,
  className = "",
  children,
  ...rest
}: ButtonProps) {
  const iconSize = size === "lg" ? 15 : 14;
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={`cc-control cc-button inline-flex items-center justify-center disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
    >
      {loading ? (
        <Icon name="Loader2" size={iconSize} className="animate-spin" />
      ) : icon ? (
        <Icon name={icon} size={iconSize} />
      ) : null}
      {children}
    </button>
  );
}
