"use client";

/**
 * The custom React Flow node card — color-coded by category (RFC §5.2:
 * color is a functional encoding), with live run-status ring during a test
 * run (queued → running → ok/err) and design-time issue badges.
 */

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  AlertTriangle,
  Bot,
  Boxes,
  CheckCircle2,
  GitBranch,
  Loader2,
  LogOut,
  PauseCircle,
  SlidersHorizontal,
  Timer,
  UserCheck,
  Wrench,
  XCircle,
  Zap,
} from "lucide-react";
import { NODE_CATEGORY_STYLE, categoryForType } from "../lib/types";
import type { NodeType } from "../lib/types";

const TYPE_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
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

export type CCNodeData = {
  label: string;
  nodeType: NodeType;
  summary?: string;
  runStatus?: "running" | "ok" | "error" | "skipped" | "waiting" | "pending";
  issueCount?: number;
  [key: string]: unknown;
};

function WorkflowNodeInner(props: NodeProps) {
  const data = props.data as CCNodeData;
  const type = data.nodeType;
  const category = categoryForType(type);
  const style = NODE_CATEGORY_STYLE[category] ?? NODE_CATEGORY_STYLE.logic;
  const Icon = TYPE_ICON[type] ?? Zap;

  const ring =
    data.runStatus === "running"
      ? "ring-2 ring-primary animate-pulse"
      : data.runStatus === "ok"
        ? "ring-2 ring-success/60"
        : data.runStatus === "error"
          ? "ring-2 ring-destructive/70"
          : data.runStatus === "waiting"
            ? "ring-2 ring-warning/70"
            : props.selected
              ? "ring-2 ring-ring"
              : "";
  const dim =
    data.runStatus === "skipped" || data.runStatus === "pending" ? "opacity-50" : "";

  return (
    <div
      className={`rounded-xl border bg-card shadow-sm w-52 tech-transition ${style.border} ${ring} ${dim}`}
    >
      {type !== "trigger" && (
        <Handle
          type="target"
          position={Position.Top}
          className="!w-2.5 !h-2.5 !bg-muted-foreground !border-background"
        />
      )}
      <div className="px-3 py-2">
        <div className="flex items-center gap-1.5">
          <span
            className={`inline-flex items-center gap-1 text-[9px] px-1.5 py-px rounded-full border ${style.chip}`}
          >
            <Icon className="w-2.5 h-2.5" />
            {category}
          </span>
          <span className="ml-auto flex items-center gap-1">
            {(data.issueCount ?? 0) > 0 && (
              <span title={`${data.issueCount} validation issue(s)`}>
                <AlertTriangle className="w-3.5 h-3.5 text-warning" />
              </span>
            )}
            {data.runStatus === "running" && (
              <Loader2 className="w-3.5 h-3.5 text-primary animate-spin" />
            )}
            {data.runStatus === "ok" && (
              <CheckCircle2 className="w-3.5 h-3.5 text-success" />
            )}
            {data.runStatus === "error" && (
              <XCircle className="w-3.5 h-3.5 text-destructive" />
            )}
            {data.runStatus === "waiting" && (
              <PauseCircle className="w-3.5 h-3.5 text-warning" />
            )}
          </span>
        </div>
        <div className="mt-1 text-xs font-medium text-foreground truncate">
          {data.label || type}
        </div>
        {data.summary && (
          <div className="text-[10px] text-muted-foreground truncate mt-0.5">
            {data.summary}
          </div>
        )}
      </div>
      {type === "condition" ? (
        <>
          <Handle
            id="true"
            type="source"
            position={Position.Bottom}
            style={{ left: "30%" }}
            className="!w-2.5 !h-2.5 !bg-success !border-background"
          />
          <Handle
            id="false"
            type="source"
            position={Position.Bottom}
            style={{ left: "70%" }}
            className="!w-2.5 !h-2.5 !bg-destructive !border-background"
          />
          <div className="flex justify-between px-6 pb-1 -mt-1">
            <span className="text-[8px] text-success">true</span>
            <span className="text-[8px] text-destructive">false</span>
          </div>
        </>
      ) : type !== "output" ? (
        <Handle
          type="source"
          position={Position.Bottom}
          className="!w-2.5 !h-2.5 !bg-muted-foreground !border-background"
        />
      ) : null}
    </div>
  );
}

export default memo(WorkflowNodeInner);
