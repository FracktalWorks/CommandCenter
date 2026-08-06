"use client";

/**
 * Badge — small status pill.
 *
 * Carries the theme's label weight, tracking and transform, so a Graphite
 * badge upper-cases and a Material one picks up its tracking without any call
 * site knowing. Deliberately NOT a button: it takes no click handler, because
 * a clickable badge should be a `<Button size="sm">`.
 *
 *     <Badge tone="success" icon="Check">Connected</Badge>
 *     <Badge>{count}</Badge>
 */

import Icon from "@/components/Icon";

export type BadgeTone = "neutral" | "primary" | "success" | "warning" | "destructive";

const TONES: Record<BadgeTone, string> = {
  neutral: "bg-secondary text-muted-foreground",
  primary: "bg-primary/10 text-primary",
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  destructive: "bg-destructive/10 text-destructive",
};

export type BadgeProps = {
  tone?: BadgeTone;
  /** Lucide icon name rendered before the label. */
  icon?: string;
  /** Renders a filled dot instead of an icon — the app's status convention. */
  dot?: boolean;
  className?: string;
  children?: React.ReactNode;
};

export default function Badge({
  tone = "neutral",
  icon,
  dot = false,
  className = "",
  children,
}: BadgeProps) {
  return (
    <span
      className={`cc-control inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] ${TONES[tone]} ${className}`}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {icon && <Icon name={icon} size={11} />}
      {children}
    </span>
  );
}
