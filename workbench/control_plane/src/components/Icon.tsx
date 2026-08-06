"use client";

/**
 * Icon — the themed icon primitive.
 *
 * Renders a glyph from whichever pack the active theme asks for, using Lucide
 * names as the shared vocabulary:
 *
 *     <Icon name="Plus" size={16} className="text-primary" />
 *
 * On the RapidTool and Graphite themes that is Lucide's `Plus`; on Fluent it
 * is `fluent:add-20-regular`; on Material `material-symbols:add-rounded`. Call
 * sites never know or care.
 *
 * Migrating an existing call site is a one-line change:
 *     import { Plus } from "lucide-react";  →  import Icon from "@/components/Icon";
 *     <Plus size={16} />                    →  <Icon name="Plus" size={16} />
 *
 * Lucide remains the fallback in three cases — the theme uses it, the name has
 * no mapping, or the pack has not finished loading — so an icon always renders.
 *
 * Note that `resolveIcon()` in `@/lib/icons` is deliberately NOT themed: it is
 * called from server components and from `iconSvg.ts`, which renders to a
 * static string for the HTML sandbox, and neither can run hooks.
 */

import { createElement } from "react";
import { Icon as IconifyIcon } from "@iconify/react";
import { resolveIcon } from "@/lib/icons";
import { useIconPack } from "@/lib/theme/store";
import { ensureIconPack, useIconPackReady } from "@/lib/theme/icon-packs";
import { iconifyName } from "@/lib/theme/icon-registry";

export type IconProps = {
  /** Lucide icon name, e.g. "Plus", "AlertTriangle", "MessageCircle". */
  name: string;
  /** Edge length in px. Matches Lucide's `size` prop. */
  size?: number;
  className?: string;
  /**
   * Lucide stroke weight. Ignored by the Iconify packs, whose glyphs carry
   * their own weight — passing it is harmless so call sites need no edit.
   */
  strokeWidth?: number;
  /** SVG paint attributes some call sites set (e.g. a filled star). */
  fill?: string;
  color?: string;
  style?: React.CSSProperties;
  onClick?: React.MouseEventHandler<SVGSVGElement>;
  "aria-label"?: string;
  "aria-hidden"?: boolean;
};

export default function Icon({
  name,
  size = 16,
  className,
  strokeWidth,
  fill,
  color,
  style,
  onClick,
  ...aria
}: IconProps) {
  const pack = useIconPack();
  const ready = useIconPackReady(pack);

  // Idempotent and asynchronous — kicks off the fetch the first time a themed
  // icon is rendered, in case ThemeProvider's preload has not run yet.
  if (typeof window !== "undefined") ensureIconPack(pack);

  const themed = ready ? iconifyName(name, pack) : null;

  if (themed) {
    return (
      <IconifyIcon
        icon={themed}
        width={size}
        height={size}
        className={className}
        style={style}
        color={color}
        onClick={onClick}
        // Iconify renders decorative markup; without a label it should be
        // invisible to assistive tech, matching Lucide's own default.
        aria-hidden={aria["aria-label"] ? undefined : true}
        {...aria}
      />
    );
  }

  // createElement rather than JSX: `resolveIcon` LOOKS UP a component from a
  // fixed module map, it does not create one, but rendering the result as
  // `<LucideGlyph />` is indistinguishable from creating a component per render
  // to the lint rule. Same call shape used by genUITemplates and
  // GenerativeUINode for the same reason.
  return createElement(resolveIcon(name), {
    size,
    className,
    strokeWidth,
    fill,
    color,
    style,
    onClick,
    ...aria,
  });
}

/**
 * A themed icon component bound to one name — what `themedIcon` returns.
 * `displayName` is part of the type so bound icons are identifiable in React
 * DevTools rather than as a wall of anonymous functions.
 */
export type ThemedIcon = ((props: Omit<IconProps, "name">) => React.ReactNode) & {
  displayName?: string;
};

const bound = new Map<string, ThemedIcon>();

/**
 * A themed icon as a COMPONENT VALUE, for the many places that keep an icon in
 * a lookup table rather than rendering it inline:
 *
 *     const META = { inbox: { icon: themedIcon("Inbox"), label: "Inbox" } };
 *     …
 *     <META.inbox.icon size={16} />
 *
 * This exists so those call sites migrate with a one-token edit — `Inbox`
 * becomes `themedIcon("Inbox")` — instead of restructuring every table into
 * name strings and threading a render helper through everything that reads
 * them. Where such a table needs a TYPE, use `ThemedIcon`: `typeof` applied to
 * a call expression is not valid TypeScript.
 *
 * Results are memoised per name because the return value is a component TYPE.
 * A fresh function on every call would be a new type each render, and React
 * would unmount and remount the icon instead of updating it.
 */
export function themedIcon(name: string): ThemedIcon {
  const cached = bound.get(name);
  if (cached) return cached;
  const Bound: ThemedIcon = (props) => <Icon name={name} {...props} />;
  Bound.displayName = `ThemedIcon(${name})`;
  bound.set(name, Bound);
  return Bound;
}
