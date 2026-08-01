/**
 * The editor's shared visual vocabulary — one icon and one kind label per node
 * type, one hue per category (RFC §5.2: colour is a functional encoding, not
 * decoration, so the graph is legible at a glance).
 *
 * Palette items, canvas cards and the inspector header all read from here, so a
 * block looks the same wherever it appears — that identity is the point.
 */

import {
  Bot,
  Boxes,
  GitBranch,
  LogOut,
  SlidersHorizontal,
  Timer,
  UserCheck,
  Wrench,
  Zap,
} from "lucide-react";
import type { NodeType } from "./types";

export type IconComponent = React.ComponentType<{ className?: string }>;

export const NODE_ICON: Record<NodeType, IconComponent> = {
  trigger: Zap,
  agent: Bot,
  tool: Wrench,
  module: Boxes,
  condition: GitBranch,
  set: SlidersHorizontal,
  approval: UserCheck,
  wait: Timer,
  output: LogOut,
};

/** The card's eyebrow — what kind of block this is, not what it is called. */
export const NODE_KIND_LABEL: Record<NodeType, string> = {
  trigger: "Trigger",
  agent: "Agent",
  tool: "Tool",
  module: "Module",
  condition: "Condition",
  set: "Set variables",
  approval: "Human approval",
  wait: "Wait",
  output: "Output",
};

export const CATEGORY_LABEL: Record<string, string> = {
  trigger: "Triggers",
  agent: "Agents",
  tool: "Tools & integrations",
  module: "Modules",
  logic: "Logic",
  output: "Output",
};

/**
 * Fallbacks for a node type the client does not know yet (a graph saved by a
 * newer gateway). Read these as `NODE_ICON[type] ?? FALLBACK_ICON` — indexing,
 * not a call, so the icon component is not "created during render".
 */
export const FALLBACK_ICON: IconComponent = Zap;
