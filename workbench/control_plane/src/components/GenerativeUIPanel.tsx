"use client";

/**
 * GenerativeUIPanel — renders AG-UI generative-UI payloads inline in chat.
 *
 * M2.6 foundation: agents can push structured state (STATE_SNAPSHOT) and named
 * CUSTOM events to the frontend without per-agent UI code. Until typed renderers
 * exist (M3: clickup_task_card, zoho_deal_chip, approval_request, …) this panel
 * renders a generic, readable view: tables for array/object state and a labelled
 * card per custom event. A renderer registry keyed by `name` plugs in later.
 */

import { useState } from "react";

type Json = unknown;

interface GenerativeUIPanelProps {
  agentState?: Record<string, unknown>;
  customEvents?: { name: string; value: unknown }[];
}

/** Render a primitive/array/object value as compact, readable JSX. */
function JsonView({ value }: { value: Json }): React.ReactElement {
  if (value === null || value === undefined) {
    return <span className="text-zinc-600">—</span>;
  }
  if (Array.isArray(value)) {
    // Array of objects → table; array of primitives → comma list.
    const allObjects =
      value.length > 0 && value.every((v) => v && typeof v === "object" && !Array.isArray(v));
    if (allObjects) {
      const cols = Array.from(
        new Set(value.flatMap((row) => Object.keys(row as object))),
      );
      return (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-zinc-700 text-zinc-400">
                {cols.map((c) => (
                  <th key={c} className="px-2 py-1 font-medium">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {value.map((row, i) => (
                <tr key={i} className="border-b border-zinc-800/60">
                  {cols.map((c) => (
                    <td key={c} className="px-2 py-1 align-top text-zinc-200">
                      <JsonView value={(row as Record<string, unknown>)[c]} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    return (
      <span className="text-zinc-200">
        {value.map((v) => String(v)).join(", ")}
      </span>
    );
  }
  if (typeof value === "object") {
    return (
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
        {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-zinc-400">{k}</dt>
            <dd className="text-zinc-200">
              <JsonView value={v} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return <span className="text-zinc-200">{String(value)}</span>;
}

export default function GenerativeUIPanel({
  agentState,
  customEvents,
}: GenerativeUIPanelProps): React.ReactElement | null {
  const [open, setOpen] = useState(true);
  const hasState = agentState && Object.keys(agentState).length > 0;
  const hasCustom = customEvents && customEvents.length > 0;
  if (!hasState && !hasCustom) return null;

  return (
    <div className="mt-3 rounded-lg border border-sky-800/40 bg-sky-950/20">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-sky-300 hover:text-sky-200"
      >
        <span className="text-[10px]">{open ? "▾" : "▸"}</span>
        Interactive view
        <span className="ml-auto text-[10px] text-sky-500/70">AG-UI</span>
      </button>
      {open && (
        <div className="space-y-3 px-3 pb-3">
          {hasState && (
            <div className="rounded-md bg-zinc-900/50 p-2">
              <JsonView value={agentState} />
            </div>
          )}
          {hasCustom &&
            customEvents!.map((ev, i) => (
              <div key={i} className="rounded-md bg-zinc-900/50 p-2">
                <div className="mb-1 text-[10px] uppercase tracking-wide text-sky-400/80">
                  {ev.name || "custom"}
                </div>
                <JsonView value={ev.value} />
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
