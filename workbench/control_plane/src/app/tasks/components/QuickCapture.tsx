"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, X, ListPlus, Wind, Check, Sparkles, ArrowLeft, ArrowRight, Trash2, Loader2, CopyX } from "lucide-react";
import { useTaskStore } from "../lib/taskStore";
import { apiAtomize } from "../lib/api";
import { GTD_TRIGGERS } from "../lib/mockData";
import { AttachmentComposer } from "./AttachmentComposer";
import type { TaskAttachment } from "../lib/types";
import { useVisualViewport } from "../lib/useVisualViewport";

// Ubiquitous capture (C2) + Mind Sweep (C3/C4). A global palette openable from
// any Tasks view via a hotkey (C / ⌘K) or a button. Single mode = rapid-fire
// quick add; Sweep mode = multi-line brain dump (one item per line) with the
// GTD Incompletion Trigger List as memory-joggers. Capture stays PURE — no
// clarify here (GTD keeps the two stages separate).
// Gate: mounts the panel fresh each time the palette opens, so its local state
// starts clean without a reset-in-effect.
export function QuickCapture() {
  const open = useTaskStore((s) => s.quickCaptureOpen);
  if (!open) return null;
  return <QuickCapturePanel />;
}

function QuickCapturePanel() {
  const storeMode = useTaskStore((s) => s.quickCaptureMode);
  const close = useTaskStore((s) => s.closeQuickCapture);
  const capture = useTaskStore((s) => s.capture);
  const captureMany = useTaskStore((s) => s.captureMany);

  const vp = useVisualViewport();
  const [mode, setMode] = useState<"single" | "sweep">(storeMode);
  const [value, setValue] = useState("");
  const [added, setAdded] = useState(0);
  const [pendingAtts, setPendingAtts] = useState<TaskAttachment[]>([]);
  // Sweep has a review gate: write → review the parsed items → add.
  const [phase, setPhase] = useState<"write" | "review">("write");
  /** Review candidates. Verdicts come from the AI atomizer: "duplicate"
   *  (confident same — excluded by default), "similar" (asks the user),
   *  "new". The instant line-split shows first; the atomizer upgrades the
   *  list in place unless the user already edited it. */
  const [reviewItems, setReviewItems] = useState<
    { title: string; include: boolean; verdict: "new" | "similar" | "duplicate"; matchTitle?: string }[]
  >([]);
  const [atomizing, setAtomizing] = useState(false);
  const reviewEditedRef = useRef(false);
  const backend = useTaskStore((s) => s.backend);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const switchMode = (m: "single" | "sweep") => {
    setMode(m);
    setPhase("write");
  };

  // Escape closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const lineCount = value
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean).length;

  const submitSingle = () => {
    const t = value.trim();
    if (!t) return;
    capture(t, pendingAtts.length ? pendingAtts : undefined);
    setValue("");
    setPendingAtts([]);
    setAdded((a) => a + 1);
    inputRef.current?.focus();
  };

  // Sweep → review gate (the §2.1 AI seam, now live). The instant line-split
  // renders immediately; the server atomizer (LLM splitting + duplicate
  // check against open items, deterministic fallback) upgrades the list in
  // place — unless the user already started editing (their edits win).
  const goToReview = () => {
    const lines = value
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) return;
    reviewEditedRef.current = false;
    setReviewItems(lines.map((t) => ({ title: t, include: true, verdict: "new" as const })));
    setPhase("review");
    if (backend !== "live") return;
    setAtomizing(true);
    apiAtomize(value)
      .then(({ items }) => {
        if (reviewEditedRef.current || !items.length) return;
        setReviewItems(items.map((it) => ({
          title: it.title,
          // Confident duplicates are excluded by default (still listed, one
          // tap re-includes); "similar" stays included but flagged.
          include: it.verdict !== "duplicate",
          verdict: it.verdict,
          matchTitle: it.matchTitle,
        })));
      })
      .catch(() => { /* keep the line split — atomizer is an upgrade */ })
      .finally(() => setAtomizing(false));
  };
  const reviewCount = reviewItems.filter((l) => l.include && l.title.trim()).length;
  const commitReview = () => {
    const clean = reviewItems
      .filter((l) => l.include)
      .map((l) => l.title.trim())
      .filter(Boolean);
    if (!clean.length) return;
    captureMany(clean.join("\n"));
    close();
  };

  const appendTrigger = (trigger: string) => {
    setValue((v) => {
      const sep = v.length && !v.endsWith("\n") ? "\n" : "";
      return `${v}${sep}${trigger}: `;
    });
    areaRef.current?.focus();
  };

  return (
    <div
      className="chat-fade-in fixed inset-x-0 bottom-0 top-0 z-[80] flex items-end justify-center bg-black/50 p-0 pt-0 sm:items-start sm:p-4 sm:pt-[10vh]"
      style={vp ? { top: vp.top, height: vp.height, bottom: "auto" } : undefined}
      onClick={close}
    >
      <div
        className="flex max-h-full w-full max-w-xl flex-col overflow-hidden rounded-t-2xl border-t border-border bg-card shadow-2xl pb-safe sm:max-h-[85vh] sm:rounded-2xl sm:border sm:pb-0"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header: mode toggle + close */}
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <div className="flex rounded-lg bg-secondary p-0.5 text-xs">
            <ModeTab active={mode === "single"} onClick={() => switchMode("single")} icon={Plus}>
              Quick
            </ModeTab>
            <ModeTab active={mode === "sweep"} onClick={() => switchMode("sweep")} icon={Wind}>
              Mind sweep
            </ModeTab>
          </div>
          <span className="ml-auto text-[11px] text-muted-foreground">
            Capture only — clarify later
          </span>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="tech-transition rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {mode === "single" ? (
          <div className="p-4">
            <div className="tech-transition flex items-center gap-3 rounded-xl border border-border bg-background/60 px-4 py-3 focus-within:border-primary/50">
              <Plus className="h-5 w-5 shrink-0 text-muted-foreground" />
              <input
                ref={inputRef}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitSingle();
                  }
                }}
                autoFocus
                placeholder="Capture to inbox…"
                aria-label="Capture to inbox"
                className="flex-1 bg-transparent text-base text-foreground placeholder:text-muted-foreground focus:outline-none"
              />
              <kbd className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                ↵
              </kbd>
            </div>
            <AttachmentComposer attachments={pendingAtts} onChange={setPendingAtts} compact />
            <div className="mt-2 flex items-center justify-between px-1 text-[11px] text-muted-foreground">
              <span>Enter to add · keep going · Esc to close</span>
              {added > 0 && (
                <span className="inline-flex items-center gap-1 text-success">
                  <Check className="h-3 w-3" />
                  {added} captured
                </span>
              )}
            </div>
          </div>
        ) : phase === "write" ? (
          <div className="p-4">
            <p className="mb-2 text-xs text-muted-foreground">
              Empty your head — one thought per line. Use the prompts to jog your memory.
            </p>
            <textarea
              ref={areaRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
              rows={7}
              placeholder={"Call the lab about calibration\nBook flights for Bangalore\nAsk Priya about the vendor review\n…"}
              className="w-full resize-none rounded-xl border border-border bg-background/60 px-3 py-2.5 text-base leading-relaxed text-foreground placeholder:text-muted-foreground focus:border-primary/50 focus:outline-none sm:text-sm"
            />
            <div className="mt-2.5">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Trigger list
              </p>
              <div className="flex flex-wrap gap-1.5">
                {GTD_TRIGGERS.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => appendTrigger(t)}
                    className="tech-transition rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:border-primary/40 hover:bg-primary/5 hover:text-foreground"
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between">
              <span className="text-[11px] text-muted-foreground">
                {lineCount} item{lineCount === 1 ? "" : "s"}
              </span>
              <button
                type="button"
                disabled={!lineCount}
                onClick={goToReview}
                className={[
                  "tech-transition inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium",
                  lineCount
                    ? "bg-primary text-primary-foreground hover:opacity-90"
                    : "cursor-not-allowed bg-secondary text-muted-foreground",
                ].join(" ")}
              >
                Review {lineCount || ""} item{lineCount === 1 ? "" : "s"}
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        ) : (
          <div className="p-4">
            <div className="mb-2.5 flex items-start gap-1.5 rounded-lg border border-primary/20 bg-primary/5 px-2.5 py-2 text-[11px] text-muted-foreground">
              {atomizing ? (
                <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
              ) : (
                <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
              )}
              <span>
                {atomizing
                  ? "AI is splitting your dump into atomic items and checking for duplicates…"
                  : "Review before adding — edit, remove, or re-include any item. Nothing is filed until you confirm."}
              </span>
            </div>
            <div className="flex max-h-[42vh] flex-col gap-1.5 overflow-y-auto pr-1">
              {reviewItems.map((item, i) => (
                <div key={i} className="flex flex-col gap-0.5">
                  <div className={`flex items-center gap-2 ${item.include ? "" : "opacity-45"}`}>
                    <button
                      type="button"
                      aria-label={item.include ? "Skip this item" : "Include this item"}
                      onClick={() => {
                        reviewEditedRef.current = true;
                        setReviewItems((ls) =>
                          ls.map((l, idx) => (idx === i ? { ...l, include: !l.include } : l)),
                        );
                      }}
                      className={`tech-transition flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded border ${
                        item.include
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border text-transparent"
                      }`}
                    >
                      <Check className="h-3 w-3" />
                    </button>
                    <input
                      value={item.title}
                      onChange={(e) => {
                        reviewEditedRef.current = true;
                        setReviewItems((ls) =>
                          ls.map((l, idx) => (idx === i ? { ...l, title: e.target.value } : l)),
                        );
                      }}
                      className="tech-transition flex-1 rounded-md border border-border bg-background/60 px-2.5 py-1.5 text-base text-foreground focus:border-primary/50 focus:outline-none sm:text-sm"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        reviewEditedRef.current = true;
                        setReviewItems((ls) => ls.filter((_, idx) => idx !== i));
                      }}
                      aria-label="Remove item"
                      className="tech-transition rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  {item.verdict !== "new" && (
                    <div className="ml-6 flex items-center gap-1 text-[10px]">
                      <CopyX className={`h-3 w-3 ${item.verdict === "duplicate" ? "text-warning" : "text-muted-foreground"}`} />
                      <span className={item.verdict === "duplicate" ? "text-warning" : "text-muted-foreground"}>
                        {item.verdict === "duplicate"
                          ? `Already in your system: "${item.matchTitle}" — skipped (tap the box to add anyway)`
                          : `Similar to: "${item.matchTitle}" — same item? Untick to skip.`}
                      </span>
                    </div>
                  )}
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => {
                reviewEditedRef.current = true;
                setReviewItems((ls) => [...ls, { title: "", include: true, verdict: "new" }]);
              }}
              className="tech-transition mt-2 inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
            >
              <Plus className="h-3 w-3" /> Add another
            </button>
            <div className="mt-3 flex items-center justify-between">
              <button
                type="button"
                onClick={() => setPhase("write")}
                className="tech-transition inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="h-4 w-4" /> Back
              </button>
              <button
                type="button"
                disabled={!reviewCount}
                onClick={commitReview}
                className={[
                  "tech-transition inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium",
                  reviewCount
                    ? "bg-primary text-primary-foreground hover:opacity-90"
                    : "cursor-not-allowed bg-secondary text-muted-foreground",
                ].join(" ")}
              >
                <ListPlus className="h-4 w-4" />
                Add {reviewCount} to inbox
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ModeTab({
  active,
  onClick,
  icon: Icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Plus;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "tech-transition inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium",
        active
          ? "bg-card text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      ].join(" ")}
    >
      <Icon className="h-3.5 w-3.5" />
      {children}
    </button>
  );
}
