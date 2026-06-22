"use client";

import { useState } from "react";
import { Check, Plus, Tag } from "lucide-react";
import { Email } from "../lib/types";
import { useEmailStore } from "../lib/emailStore";

/**
 * Label picker — toggle the account's labels on a message (multi-select, stays
 * open) and create new ones. Applied labels show a check. Writes sync to the
 * provider (Gmail labels / Outlook categories) via the store.
 */
export function LabelMenu({
  email,
  embedded = false,
}: {
  email: Email;
  /** When rendered inside another popover/flyout (e.g. the right-click submenu),
   *  drop this component's own panel chrome + fixed width so it doesn't create a
   *  box-in-a-box with a nested scrollbar. */
  embedded?: boolean;
}) {
  const { availableLabels, applyLabel } = useEmailStore();
  const [newLabel, setNewLabel] = useState("");
  const applied = new Set(email.categories || []);

  const create = () => {
    const name = newLabel.trim();
    if (!name) return;
    applyLabel(email.id, name, true);
    setNewLabel("");
  };

  return (
    <div
      className={
        embedded
          ? "text-xs"
          : "w-52 bg-popover border border-border rounded-lg shadow-xl py-1 text-xs"
      }
    >
      <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        Labels
      </div>
      {/* Only the label list scrolls (and only when it overflows) — the create
          row below stays pinned. */}
      <div className="max-h-48 overflow-y-auto">
        {availableLabels.length === 0 ? (
          <div className="px-3 py-1.5 text-muted-foreground">No labels yet</div>
        ) : (
          availableLabels.map((name) => {
            const on = applied.has(name);
            return (
              <button
                key={name}
                onClick={() => applyLabel(email.id, name, !on)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-foreground/80 hover:text-foreground hover:bg-secondary transition-colors"
              >
                <span
                  className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
                    on
                      ? "bg-primary border-primary text-primary-foreground"
                      : "border-muted-foreground/40"
                  }`}
                >
                  {on && <Check size={11} />}
                </span>
                <Tag size={10} className="flex-shrink-0" />
                <span className="truncate">{name}</span>
              </button>
            );
          })
        )}
      </div>
      <div className="border-t border-border mt-1 pt-1 px-2 pb-1">
        <div className="flex items-center gap-1">
          <input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                create();
              }
            }}
            placeholder="Create label…"
            className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground outline-none px-1 py-1"
          />
          <button
            onClick={create}
            disabled={!newLabel.trim()}
            title="Create label"
            className="text-primary hover:opacity-80 disabled:opacity-40"
          >
            <Plus size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}
