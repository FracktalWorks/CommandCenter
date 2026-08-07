"use client";

/**
 * Projects · the tree sidebar.
 *
 * Departments, projects and subprojects are one self-FK (D-PM-2), so this is
 * one recursive list rather than three panes — the indentation IS the
 * hierarchy.
 */
import { ChevronDown, ChevronRight, FolderKanban, Plus } from "lucide-react";
import { useState } from "react";

import type { ProjectRow } from "../lib/api";

interface Props {
  roots: ProjectRow[];
  selectedId: string | null;
  onSelect: (project: ProjectRow) => void;
  /** Start creating a subproject under this node. Omitted = read-only tree. */
  onAddChild?: (parent: ProjectRow) => void;
}

function Node({
  node,
  depth,
  selectedId,
  onSelect,
  onAddChild,
}: {
  node: ProjectRow;
  depth: number;
  selectedId: string | null;
  onSelect: (project: ProjectRow) => void;
  onAddChild?: (parent: ProjectRow) => void;
}) {
  const [open, setOpen] = useState(depth < 1);
  const children = node.children ?? [];
  const isSelected = node.id === selectedId;

  return (
    <li>
      <div
        className={`flex items-center gap-1 rounded-md px-2 py-1.5 text-sm ${
          isSelected
            ? "bg-accent text-accent-foreground"
            : "text-foreground hover:bg-muted"
        }`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        {children.length > 0 ? (
          <button
            type="button"
            aria-label={open ? `Collapse ${node.name}` : `Expand ${node.name}`}
            onClick={() => setOpen((v) => !v)}
            className="shrink-0 rounded p-0.5 hover:bg-background/60"
          >
            {open ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
        ) : (
          <span className="w-[18px] shrink-0" />
        )}
        <button
          type="button"
          onClick={() => onSelect(node)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <FolderKanban className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{node.name}</span>
          {node.clickup_id ? (
            <span
              title="Imported from ClickUp"
              className="ml-auto shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground"
            >
              CU
            </span>
          ) : null}
        </button>
        {onAddChild ? (
          // A subproject is created HERE rather than from a dialog that asks
          // "which parent?" — the answer is already on screen, and asking for
          // it again is how a tree with fifty nodes gets mis-parented rows.
          <button
            type="button"
            aria-label={`New subproject under ${node.name}`}
            title="New subproject"
            onClick={() => onAddChild(node)}
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-background/60"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      {open && children.length > 0 ? (
        <ul>
          {children.map((child) => (
            <Node
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              onSelect={onSelect}
              onAddChild={onAddChild}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function ProjectTree({ roots, selectedId, onSelect, onAddChild }: Props) {
  if (roots.length === 0) {
    return (
      <p className="px-2 py-6 text-sm text-muted-foreground">
        No projects yet. Create one, or import a ClickUp workspace.
      </p>
    );
  }
  return (
    <ul className="space-y-0.5">
      {roots.map((root) => (
        <Node
          key={root.id}
          node={root}
          depth={0}
          selectedId={selectedId}
          onSelect={onSelect}
          onAddChild={onAddChild}
        />
      ))}
    </ul>
  );
}
