/**
 * Icon resolver — maps Lucide icon name strings to React components.
 *
 * Usage:
 *   import { resolveIcon } from "@/lib/icons";
 *   const Icon = resolveIcon("MessageCircle");
 *   return <Icon size={18} />;
 */

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
  type LucideIcon,
} from "lucide-react";

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
};

/** Returns the Lucide component for a given icon name, or Zap as fallback. */
export function resolveIcon(name: string): LucideIcon {
  return ICON_MAP[name] ?? Zap;
}
