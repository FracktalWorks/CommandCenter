/**
 * Icon resolver — maps Lucide icon NAME strings to React components.
 *
 * Two callers:
 *   • App chrome (nav, sidebars) — uses the small curated ICON_MAP for zero
 *     ambiguity and named imports.
 *   • Generative UI (agent-driven, on the fly) — agents name any Lucide icon and
 *     resolveIcon looks it up against the FULL Lucide set (~1,600 icons) so an
 *     agent isn't limited to the curated few. Lucide is bundled (no network) and
 *     is the app's single icon language, so generated UI stays on-brand.
 *
 * Usage:
 *   import { resolveIcon } from "@/lib/icons";
 *   const Icon = resolveIcon("MessageCircle");   // or "message-circle", "mail", …
 *   return <Icon size={18} />;
 */

import * as Lucide from "lucide-react";
import {
  MessageCircle,
  Mail,
  Brain,
  CheckSquare,
  StickyNote,
  LayoutDashboard,
  Cpu,
  Bot,
  Plug,
  Wrench,
  PlusSquare,
  Zap,
  FolderOpen,
  Activity,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

// Curated, guaranteed-stable names used by app chrome.
const ICON_MAP: Record<string, LucideIcon> = {
  MessageCircle,
  Mail,
  Brain,
  CheckSquare,
  StickyNote,
  LayoutDashboard,
  Cpu,
  Bot,
  Plug,
  Wrench,
  PlusSquare,
  Zap,
  FolderOpen,
  Activity,
  ShieldCheck,
};

/** "message-circle" | "message_circle" | "messageCircle" → "MessageCircle". */
function toPascal(name: string): string {
  return name
    .trim()
    .replace(/[-_\s]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ""))
    .replace(/^(.)/, (c) => c.toUpperCase());
}

/**
 * Returns the Lucide component for a given icon name (curated map first, then
 * the full Lucide export set with kebab/snake/camel normalization), or Zap as a
 * safe fallback so an unknown/hallucinated name never crashes the render.
 *
 * Only resolves real Lucide component exports — never returns arbitrary module
 * members (the `typeof === function` + PascalCase guard rules out helpers).
 */
export function resolveIcon(name: string): LucideIcon {
  if (!name || typeof name !== "string") return Zap;
  if (ICON_MAP[name]) return ICON_MAP[name];

  const pascal = toPascal(name);
  const lib = Lucide as unknown as Record<string, unknown>;
  // Lucide exports both "Foo" and "FooIcon"; prefer the bare name.
  for (const key of [pascal, `${pascal}Icon`]) {
    const candidate = lib[key];
    if (
      /^[A-Z]/.test(key) &&
      (typeof candidate === "function" ||
        (typeof candidate === "object" && candidate !== null))
    ) {
      return candidate as LucideIcon;
    }
  }
  return Zap;
}

/** True when a name resolves to a real Lucide icon (not the Zap fallback). */
export function isKnownIcon(name: string): boolean {
  if (!name) return false;
  if (ICON_MAP[name]) return true;
  const pascal = toPascal(name);
  const lib = Lucide as unknown as Record<string, unknown>;
  return lib[pascal] != null || lib[`${pascal}Icon`] != null;
}
