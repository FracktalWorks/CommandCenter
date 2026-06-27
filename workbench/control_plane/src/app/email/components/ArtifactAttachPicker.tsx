"use client";

/**
 * ArtifactAttachPicker — a small "AI files" dropdown for attaching an artifact
 * the email assistant (or a sub-agent it imported from) produced, to an outgoing
 * email. Lists the email-assistant workspace via listEmailArtifacts() and hands
 * the chosen file back as a {path, name} ref (resolved to bytes server-side at
 * send time — no base64 round-trip in the browser).
 */

import { useState, useEffect, useRef } from "react";
import { Sparkles, Loader2, Paperclip } from "lucide-react";
import { listEmailArtifacts, type EmailArtifact } from "../lib/api";

export function ArtifactAttachPicker({
  onPick,
  exclude = [],
}: {
  onPick: (ref: { path: string; name: string }) => void;
  /** Paths already attached — hidden from the list. */
  exclude?: string[];
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<EmailArtifact[] | null>(null);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Lazy-load the artifact list the first time the menu opens.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open || items) return;
    setLoading(true);
    listEmailArtifacts()
      .then(setItems)
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [open, items]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const available = (items ?? []).filter((a) => !exclude.includes(a.path));

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Attach an AI-generated file"
        className="px-2 py-1 text-xs rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors flex items-center gap-1"
      >
        <Sparkles size={13} /> AI files
      </button>
      {open && (
        <div className="absolute bottom-full right-0 mb-1.5 w-64 max-h-60 overflow-y-auto rounded-lg border border-border bg-popover shadow-xl z-[70] py-1">
          {loading ? (
            <div className="px-3 py-2 text-[11px] text-muted-foreground flex items-center gap-1.5">
              <Loader2 size={12} className="animate-spin" /> Loading…
            </div>
          ) : available.length === 0 ? (
            <div className="px-3 py-2 text-[11px] text-muted-foreground">
              No AI files yet. Ask the assistant to create one.
            </div>
          ) : (
            available.map((a) => (
              <button
                key={a.path}
                type="button"
                onClick={() => {
                  onPick({ path: a.path, name: a.name });
                  setOpen(false);
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-secondary transition-colors flex items-center gap-2"
              >
                <Paperclip size={12} className="text-muted-foreground flex-shrink-0" />
                <span className="text-[11px] text-foreground truncate flex-1" title={a.path}>
                  {a.name}
                </span>
                <span className="text-[9px] text-muted-foreground flex-shrink-0">{a.category}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
