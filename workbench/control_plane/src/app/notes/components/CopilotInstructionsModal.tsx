"use client";

/**
 * CopilotInstructionsModal — your standing instructions to the meeting copilot.
 *
 * The per-meeting *brief* changes every time; how you want the copilot to
 * behave doesn't. These are prepended to the system prompt of EVERY copilot run
 * ("I run a 3D-printing company; prefer commercial framing; never offer
 * discounts"), so it's set once rather than retyped — which is the difference
 * between a feature that gets used and one that doesn't.
 */

import { useEffect, useState } from "react";
import { Loader2, Sparkles, X } from "lucide-react";
import { getCopilotInstructions, saveCopilotInstructions } from "../lib/api";

const PLACEHOLDER = `e.g. I run a 3D-printing company selling to manufacturing teams.
Prefer commercial framing over technical detail.
Never suggest offering a discount — steer to value instead.
Flag anything that sounds like a delivery commitment.`;

export default function CopilotInstructionsModal({
  onClose,
}: {
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    getCopilotInstructions()
      .then((v) => alive && setValue(v))
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  async function onSave() {
    setSaving(true);
    try {
      await saveCopilotInstructions(value);
      onClose();
    } catch {
      /* leave the text in place so nothing is lost */
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-lg rounded-2xl border border-border bg-card p-4 shadow-2xl">
        <div className="mb-3 flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <h2 className="flex-1 text-sm font-semibold">
            How the copilot should behave
          </h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          Applied to <span className="text-foreground">every</span> meeting, on
          top of that meeting&apos;s own briefing and agenda. Set it once.
        </p>
        {loading ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={8}
            placeholder={PLACEHOLDER}
            className="w-full resize-y rounded-lg border border-border bg-background p-2 text-sm outline-none focus:border-primary"
          />
        )}
        <div className="mt-3 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-accent"
          >
            Cancel
          </button>
          <button
            onClick={onSave}
            disabled={saving || loading}
            className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
