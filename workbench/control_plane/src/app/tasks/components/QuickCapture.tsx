"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, X, ListPlus, Wind, Check, Sparkles, ArrowLeft, ArrowRight, Trash2 } from "lucide-react";
import { useTaskStore } from "../lib/taskStore";
import { GTD_TRIGGERS } from "../lib/mockData";

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

  const [mode, setMode] = useState<"single" | "sweep">(storeMode);
  const [value, setValue] = useState("");
  const [added, setAdded] = useState(0);
  // Sweep has a review gate: write → review the parsed items → add.
  const [phase, setPhase] = useState<"write" | "review">("write");
  const [reviewLines, setReviewLines] = useState<string[]>([]);
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
    capture(t);
    setValue("");
    setAdded((a) => a + 1);
    inputRef.current?.focus();
  };

  // Sweep → review gate. Parse the brain dump into candidate items the user
  // can edit/remove before anything lands in the inbox. This is also the seam
  // where AI atomization + dedupe will populate `reviewLines` (spec §2.1).
  const goToReview = () => {
    const lines = value
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) return;
    setReviewLines(lines);
    setPhase("review");
  };
  const reviewCount = reviewLines.filter((l) => l.trim()).length;
  const commitReview = () => {
    const clean = reviewLines.map((l) => l.trim()).filter(Boolean);
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
      className="chat-fade-in fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[10vh]"
      onClick={close}
    >
      <div
        className="flex w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
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
              className="w-full resize-none rounded-xl border border-border bg-background/60 px-3 py-2.5 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground focus:border-primary/50 focus:outline-none"
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
              <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
              <span>
                Review before adding — edit or remove any item. Nothing is filed
                until you confirm. (AI will atomize run-on notes &amp; flag
                duplicates here — coming.)
              </span>
            </div>
            <div className="flex max-h-[42vh] flex-col gap-1.5 overflow-y-auto pr-1">
              {reviewLines.map((line, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="w-4 shrink-0 text-right text-[10px] text-muted-foreground">
                    {i + 1}
                  </span>
                  <input
                    value={line}
                    onChange={(e) =>
                      setReviewLines((ls) =>
                        ls.map((l, idx) => (idx === i ? e.target.value : l)),
                      )
                    }
                    className="tech-transition flex-1 rounded-md border border-border bg-background/60 px-2.5 py-1.5 text-sm text-foreground focus:border-primary/50 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setReviewLines((ls) => ls.filter((_, idx) => idx !== i))
                    }
                    aria-label="Remove item"
                    className="tech-transition rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setReviewLines((ls) => [...ls, ""])}
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
