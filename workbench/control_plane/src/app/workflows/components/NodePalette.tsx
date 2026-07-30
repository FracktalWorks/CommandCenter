"use client";

/**
 * The node palette (RFC §5.2) — drag a node type onto the canvas, or click to
 * append. Everything here comes from the served catalog (spec D7): agents,
 * integration actions, ready modules — never a hard-coded capability.
 */

import { useState } from "react";
import {
  Bot,
  Boxes,
  ChevronDown,
  ChevronRight,
  GitBranch,
  LogOut,
  Wrench,
  Zap,
} from "lucide-react";
import { NODE_CATEGORY_STYLE } from "../lib/types";
import type { Catalog, NodeType } from "../lib/types";

export type PaletteDrop = {
  nodeType: NodeType;
  label: string;
  config: Record<string, unknown>;
};

type SectionIcon = React.ComponentType<{ className?: string }>;

export default function NodePalette({
  catalog,
  onAdd,
}: {
  catalog: Catalog | null;
  onAdd: (drop: PaletteDrop) => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({
    agent: true,
    tool: true,
    module: true,
    logic: true,
    output: false,
  });

  const startDrag = (e: React.DragEvent, drop: PaletteDrop) => {
    e.dataTransfer.setData("application/cc-workflow-node", JSON.stringify(drop));
    e.dataTransfer.effectAllowed = "move";
  };

  const item = (
    key: string,
    drop: PaletteDrop,
    title: string,
    subtitle: string,
    category: string,
    disabled = false,
  ) => {
    const style = NODE_CATEGORY_STYLE[category] ?? NODE_CATEGORY_STYLE.logic;
    return (
      <button
        key={key}
        draggable={!disabled}
        onDragStart={(e) => startDrag(e, drop)}
        onClick={() => !disabled && onAdd(drop)}
        disabled={disabled}
        title={disabled ? "Not available — configure the integration first" : subtitle}
        className={`w-full text-left rounded-lg border border-border px-2.5 py-1.5 tech-transition ${
          disabled
            ? "opacity-40 cursor-not-allowed"
            : "hover:border-primary/40 hover:bg-secondary cursor-grab active:cursor-grabbing"
        }`}
      >
        <div className="flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${style.dot}`} />
          <span className="text-[11px] font-medium text-foreground truncate">
            {title}
          </span>
        </div>
        <p className="text-[9px] text-muted-foreground truncate ml-3">
          {subtitle}
        </p>
      </button>
    );
  };

  const section = (id: string, label: string, Icon: SectionIcon, children: React.ReactNode) => (
    <div key={id}>
      <button
        onClick={() => setOpen((o) => ({ ...o, [id]: !o[id] }))}
        className="w-full flex items-center gap-1.5 px-1 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground tech-transition"
      >
        {open[id] ? (
          <ChevronDown className="w-3 h-3" />
        ) : (
          <ChevronRight className="w-3 h-3" />
        )}
        <Icon className="w-3 h-3" />
        {label}
      </button>
      {open[id] && <div className="space-y-1 mb-2">{children}</div>}
    </div>
  );

  return (
    <div className="w-52 sm:w-56 shrink-0 border-r border-border overflow-y-auto scrollbar-thin p-2">
      <div className="flex items-center gap-1.5 px-1 pb-2 text-[10px] text-muted-foreground">
        <Zap className="w-3 h-3 text-amber-500" />
        Drag onto the canvas, or click to append
      </div>

      {section(
        "agent", "Agents", Bot,
        (catalog?.agents ?? []).map((a) =>
          item(
            `agent:${a.name}`,
            {
              nodeType: "agent",
              label: a.name,
              config: { agent: a.name, message: "" },
            },
            a.name,
            a.description,
            "agent",
          ),
        ),
      )}

      {section(
        "tool", "Tools & Integrations", Wrench,
        <>
          {(catalog?.tools ?? []).map((t) =>
            item(
              `tool:${t.action}`,
              {
                nodeType: "tool",
                label: t.label,
                config: { action: t.action, args: {} },
              },
              t.label,
              t.destructive ? "write — approval-gated" : t.description,
              "tool",
            ),
          )}
          {(catalog?.integrations ?? [])
            .filter((i) => i.actions.length === 0)
            .map((i) =>
              item(
                `integration:${i.service}`,
                { nodeType: "tool", label: i.service, config: {} },
                i.service,
                i.available ? "no actions yet" : "not configured",
                "tool",
                true,
              ),
            )}
        </>,
      )}

      {section(
        "module", "Modules", Boxes,
        (catalog?.modules ?? []).filter((m) => m.status === "ready").length === 0 ? (
          <p className="text-[10px] text-muted-foreground px-1">
            No ready modules — build one in the Module Studio.
          </p>
        ) : (
          (catalog?.modules ?? [])
            .filter((m) => m.status === "ready")
            .map((m) =>
              item(
                `module:${m.id}`,
                {
                  nodeType: "module",
                  label: m.name,
                  config: { module_id: m.id, inputs: {} },
                },
                m.name,
                m.description || "code module",
                "module",
              ),
            )
        ),
      )}

      {section(
        "logic", "Logic", GitBranch,
        <>
          {item(
            "logic:condition",
            {
              nodeType: "condition",
              label: "Condition",
              config: { left: "", op: "equals", right: "" },
            },
            "Condition",
            "branch on true/false",
            "logic",
          )}
          {item(
            "logic:set",
            {
              nodeType: "set",
              label: "Set variables",
              config: { assignments: {} },
            },
            "Set variables",
            "assign into {{vars.*}}",
            "logic",
          )}
        </>,
      )}

      {section(
        "output", "Output", LogOut,
        item(
          "output:output",
          { nodeType: "output", label: "Output", config: { value: "" } },
          "Output",
          "yield the run's result",
          "output",
        ),
      )}
    </div>
  );
}
