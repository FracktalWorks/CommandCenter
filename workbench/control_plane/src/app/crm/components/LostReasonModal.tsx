"use client";

/**
 * The lost-reason prompt.
 *
 * Entering a lost-type status without a reason is a 422 BEFORE any of the
 * transition's three effects — "why did we lose it" is the whole reason the
 * lost vocabulary exists. The board asks first rather than animating a card
 * into the lane and then putting it back with a red toast, and the reason
 * travels WITH the move so a single PATCH either lands or does not.
 */

import { X } from "lucide-react";
import { useState } from "react";
import type { LostReason } from "../lib/types";

export default function LostReasonModal({
  statusName,
  reasons,
  saving,
  onCancel,
  onConfirm,
}: {
  statusName: string;
  reasons: LostReason[];
  saving: boolean;
  onCancel: () => void;
  onConfirm: (payload: { lost_reason_id: string; lost_note?: string }) => void;
}) {
  const [reasonId, setReasonId] = useState<string>(reasons[0]?.id ?? "");
  const [note, setNote] = useState("");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        aria-label="Cancel"
        onClick={onCancel}
        className="absolute inset-0 bg-background/80 backdrop-blur-sm"
      />
      <div className="relative w-full max-w-sm rounded-xl border border-border bg-card shadow-xl">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h2 className="text-base font-bold text-foreground">
              Moving to {statusName}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              A lost deal needs a reason — it is what the funnel report is for.
            </p>
          </div>
          <button
            onClick={onCancel}
            className="rounded-lg border border-border p-2 text-muted-foreground hover:bg-secondary tech-transition"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="space-y-3 p-4">
          {reasons.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No lost reasons are configured. Add one before closing deals as
              lost — the gateway will refuse the move without it.
            </p>
          ) : (
            <div className="space-y-1">
              {[...reasons]
                .sort((a, b) => a.position - b.position)
                .map((reason) => (
                  <button
                    key={reason.id}
                    onClick={() => setReasonId(reason.id)}
                    className={`w-full rounded-lg border px-3 py-2 text-left text-xs tech-transition ${
                      reasonId === reason.id
                        ? "border-primary bg-primary/5 text-foreground"
                        : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
                    }`}
                  >
                    {reason.label}
                  </button>
                ))}
            </div>
          )}
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Anything worth remembering (optional)"
            className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary/40 focus:outline-none"
          />
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button
            onClick={onCancel}
            className="rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:border-primary/30 tech-transition"
          >
            Cancel
          </button>
          <button
            onClick={() =>
              onConfirm({
                lost_reason_id: reasonId,
                lost_note: note.trim() || undefined,
              })
            }
            disabled={saving || !reasonId}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40 tech-transition"
          >
            Mark lost
          </button>
        </footer>
      </div>
    </div>
  );
}
