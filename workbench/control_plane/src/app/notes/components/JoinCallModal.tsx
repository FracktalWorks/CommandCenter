"use client";

/**
 * JoinCallModal — send the notetaker bot to join a live call by link (spec
 * §3.13, Phase 1). Paste one meeting URL per line to fan several notetakers out
 * to concurrent meetings. Honest about the consent posture and about the "not
 * set up yet" state when no provider key is configured.
 */

import { useEffect, useState } from "react";
import { AlertCircle, Loader2, Video, X } from "lucide-react";
import { botJoin, getBotConfig } from "../lib/api";

interface JoinCallModalProps {
  onClose: () => void;
  /** Called after at least one bot was dispatched, so the page can refresh. */
  onJoined: () => void;
}

type LineResult = { url: string; ok: boolean; error?: string };

export default function JoinCallModal({ onClose, onJoined }: JoinCallModalProps) {
  const [urls, setUrls] = useState("");
  const [busy, setBusy] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [results, setResults] = useState<LineResult[] | null>(null);

  useEffect(() => {
    void getBotConfig()
      .then((c) => setConfigured(c.configured))
      .catch(() => setConfigured(false));
  }, []);

  async function dispatch() {
    const links = urls
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (links.length === 0) return;
    setBusy(true);
    setResults(null);
    const settled = await Promise.all(
      links.map(async (url): Promise<LineResult> => {
        try {
          await botJoin(url);
          return { url, ok: true };
        } catch (e) {
          return { url, ok: false, error: String(e instanceof Error ? e.message : e) };
        }
      })
    );
    setResults(settled);
    setBusy(false);
    if (settled.some((r) => r.ok)) onJoined();
  }

  const anySuccess = results?.some((r) => r.ok) ?? false;

  return (
    <div
      className="fixed inset-0 z-[70] grid place-items-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-border bg-card p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary/15 text-primary">
            <Video className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-bold text-foreground">
              Send the notetaker to a call
            </h2>
            <p className="text-[11px] text-muted-foreground">
              Google Meet, Zoom, or Teams — it joins, records, and writes notes.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-muted-foreground hover:bg-secondary hover:text-foreground tech-transition"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {configured === false ? (
          <div className="rounded-lg bg-warning/10 px-3 py-2.5 text-xs text-warning">
            <span className="flex items-start gap-1.5">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                The meeting notetaker isn&apos;t set up yet. An admin needs to add
                a Recall.ai API key (<code>RECALL_API_KEY</code>) on the server to
                enable it.
              </span>
            </span>
          </div>
        ) : (
          <>
            <textarea
              value={urls}
              onChange={(e) => setUrls(e.target.value)}
              rows={3}
              autoFocus
              placeholder={
                "Paste a meeting link…\nhttps://meet.google.com/abc-defg-hij\n(one per line to join several at once)"
              }
              className="w-full resize-y rounded-xl border border-border bg-background p-3 font-mono text-xs text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-1 focus:ring-ring"
            />

            {results && (
              <div className="mt-2 space-y-1">
                {results.map((r, i) => (
                  <p
                    key={i}
                    className={`truncate text-[11px] ${
                      r.ok ? "text-success" : "text-destructive"
                    }`}
                    title={r.error || r.url}
                  >
                    {r.ok ? "✓ Joining" : "✗ Failed"} — {r.url}
                  </p>
                ))}
              </div>
            )}

            <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
              The bot joins named so everyone can see it. Recording others may
              require their consent depending on where you are — get it first.
            </p>

            <div className="mt-3 flex justify-end gap-2">
              <button
                onClick={onClose}
                className="rounded-lg px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground tech-transition"
              >
                {anySuccess ? "Done" : "Cancel"}
              </button>
              <button
                onClick={() => void dispatch()}
                disabled={busy || configured === null || !urls.trim()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 tech-transition disabled:opacity-50"
              >
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Video className="h-3.5 w-3.5" />
                )}
                {busy ? "Sending…" : "Send notetaker"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
