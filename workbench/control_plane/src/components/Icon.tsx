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
  style?: React.CSSProperties;
  "aria-label"?: string;
  "aria-hidden"?: boolean;
};

export default function Icon({
  name,
  size = 16,
  className,
  strokeWidth,
  style,
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
    style,
    ...aria,
  });
}
