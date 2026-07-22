// Lucide icons for the priority levels and the action-mode suggestions — the
// UI-layer counterpart to priority.ts (which stays pure data, no JSX imports).
// One mapping so the priority icon reads the same everywhere it appears: the
// card PriorityBadge, the list Priority/Suggestion columns, and the grouped
// section headers. Replaces the old emoji so the pills match the app's lucide
// icon language.

import {
  ArrowDownWideNarrow,
  Ban,
  CalendarClock,
  CircleAlert,
  Flame,
  FlaskConical,
  Rocket,
  Siren,
  Target,
  TrendingUp,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import type { ActionMode, PriorityCell } from "./priority";

/** Priority level → icon. Matches CELL_META's order/meaning:
 *  🔥 critical, 🚨 urgent, 📈 high-leverage, ❗ important,
 *  🚀 quick-leverage, 🧪 speculative-bet, ↓ low-priority. */
export const CELL_ICON: Record<PriorityCell, LucideIcon> = {
  critical: Flame,
  urgent: Siren,
  "high-leverage": TrendingUp,
  important: CircleAlert,
  "quick-leverage": Rocket,
  "speculative-bet": FlaskConical,
  "low-priority": ArrowDownWideNarrow,
};

/** Action-mode / suggestion → icon: 🎯 do, 🙋 delegate (hand to a person),
 *  📅 schedule, 🚫 drop (eliminate/ignore). Shared by the Suggestion column,
 *  the card suggestion nudge, and the mode group headers. */
export const MODE_ICON: Record<ActionMode, LucideIcon> = {
  do: Target,
  delegate: UserPlus,
  schedule: CalendarClock,
  drop: Ban,
};

/** The icon for a grouped section header, given the grouping axis and the
 *  group key. Only the priority and mode axes carry an icon (their keys are the
 *  PriorityCell / ActionMode); energy and context headers use their own marker. */
export function groupIcon(
  by: "priority" | "mode" | "energy" | "context" | "none" | string,
  key: string,
): LucideIcon | null {
  if (by === "priority") return CELL_ICON[key as PriorityCell] ?? null;
  if (by === "mode") return MODE_ICON[key as ActionMode] ?? null;
  return null;
}
