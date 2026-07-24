"use client";

/**
 * GlossaryModal — manage the org vocabulary that biases transcription
 * (spec §4 Tier-1 item 6). Terms are injected into the STT prompt so jargon,
 * product names, people and customers get spelled right.
 */

import { useEffect, useState } from "react";
import { Loader2, Plus, X } from "lucide-react";
import {
  addGlossaryTerm,
  deleteGlossaryTerm,
  listGlossary,
  type GlossaryTerm,
} from "../lib/api";

export default function GlossaryModal({ onClose }: { onClose: () => void }) {
  const [terms, setTerms] = useState<GlossaryTerm[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listGlossary()
      .then(setTerms)
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setLoading(false));
  }, []);

  async function add() {
    const t = input.trim();
    if (!t || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await addGlossaryTerm(t);
      setTerms((prev) =>
        prev.some((x) => x.id === created.id) ? prev : [...prev, created]
      );
      setInput("");
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setTerms((prev) => prev.filter((t) => t.id !== id));
    await deleteGlossaryTerm(id).catch(() => {});
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-border bg-card shadow-xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Glossary</h2>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Jargon, product & people names — transcription spells these right.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-muted-foreground hover:bg-secondary tech-transition"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto">
          {error && (
            <div className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}
          <div className="flex items-center gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
              placeholder="Add a term (e.g. TwinDragon, Penrose)…"
              className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <button
              onClick={add}
              disabled={busy || !input.trim()}
              className="p-2 rounded-lg bg-primary text-primary-foreground hover:opacity-90 tech-transition disabled:opacity-50"
              aria-label="Add term"
            >
              {busy ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Plus className="w-4 h-4" />
              )}
            </button>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : terms.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-6">
              No terms yet. Add the names and jargon your meetings use so they’re
              transcribed correctly.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {terms.map((t) => (
                <span
                  key={t.id}
                  className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-xs text-foreground"
                >
                  {t.term}
                  <button
                    onClick={() => remove(t.id)}
                    className="text-muted-foreground hover:text-destructive"
                    aria-label={`Remove ${t.term}`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
