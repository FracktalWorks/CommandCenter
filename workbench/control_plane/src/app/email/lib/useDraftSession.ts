"use client";

import { useCallback, useRef, useState } from "react";
import { composeAssistStream, type ComposeAssistArgs } from "./api";

/**
 * One "Draft with AI" session for a composer.
 *
 * Drafting is iterative, not one-shot: the first run writes a draft, and every
 * later run REFINES the draft that's currently in the box ("make it shorter",
 * "mention the deadline"). Each run is kept as a revision the user can flip
 * back to, so trying an edit is never destructive.
 *
 * The hook owns the whole session — live backend steps, revisions, and the
 * busy/error state — so all three composer surfaces (compose window, inline
 * reply, conversation draft card) behave identically.
 */

/** A merged step in the live activity feed (start/done events collapse into one). */
export interface DraftStep {
  key: string;
  label: string;
  detail: string;
  state: "running" | "done" | "failed";
  /** Consults only: the question put to the specialist agent, and its answer. */
  question?: string;
  answer?: string;
}

/** A saved version of the body — the first one is the user's own starting text. */
export interface DraftRevision {
  id: number;
  body: string;
  label: string;
  source: "user" | "ai";
  /** The instruction that produced this revision ("" for the starting text). */
  instruction: string;
}

interface ActivityEvent {
  kind?: string;
  id?: string;
  status?: string;
  detail?: string;
  emailKind?: string;
  consults?: number;
  agent?: string;
  question?: string;
  answer?: string;
}

const STAGE_LABELS: Record<string, string> = {
  context: "Thread context",
  memory: "Sender history",
  draft: "Writing draft",
};

/** "agent-sales-assistant" → "sales assistant" */
export function prettyAgent(agent: string): string {
  return agent.replace(/^agent-/, "").replace(/-/g, " ");
}

function applyEvent(steps: DraftStep[], evt: ActivityEvent): DraftStep[] {
  const upsert = (key: string, next: Partial<DraftStep> & { label: string }) => {
    const i = steps.findIndex((s) => s.key === key);
    if (i === -1) {
      return [...steps, { key, detail: "", state: "running", ...next } as DraftStep];
    }
    const merged = [...steps];
    merged[i] = { ...merged[i], ...next };
    return merged;
  };

  if (evt.kind === "stage" && evt.id) {
    return upsert(`stage:${evt.id}`, {
      label: STAGE_LABELS[evt.id] ?? evt.id,
      detail: evt.detail ?? "",
      state: evt.status === "done" ? "done" : "running",
    });
  }
  if (evt.kind === "qualify") {
    return upsert("qualify", {
      label: evt.emailKind ? `Qualified as ${evt.emailKind}` : "Qualified",
      detail: evt.detail ?? "",
      state: "done",
    });
  }
  if (evt.kind === "consult" && evt.agent) {
    return upsert(`consult:${evt.agent}`, {
      label: `Asked ${prettyAgent(evt.agent)}`,
      question: evt.question,
      answer: evt.answer,
      detail: evt.detail ?? "",
      state:
        evt.status === "done"
          ? "done"
          : evt.status === "failed"
            ? "failed"
            : "running",
    });
  }
  return steps;
}

export interface UseDraftSessionOptions {
  /** Push streamed/final text into the composer's body. */
  onBody: (body: string) => void;
  /** Called with the final draft once a run succeeds (mark dirty, etc.). */
  onSettled?: (draft: string) => void;
  /** Surface a failure to the composer's own error slot. */
  onError?: (message: string) => void;
}

export function useDraftSession({
  onBody,
  onSettled,
  onError,
}: UseDraftSessionOptions) {
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<DraftStep[]>([]);
  const [thinking, setThinking] = useState("");
  const [revisions, setRevisions] = useState<DraftRevision[]>([]);
  const [activeRevision, setActiveRevision] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const revisionSeq = useRef(0);

  /** Run a draft/refine round against the CURRENT body text. */
  const run = useCallback(
    async (
      args: ComposeAssistArgs,
      opts: { instruction: string; quote?: string | null } = { instruction: "" },
    ) => {
      const startedAt = Date.now();
      const priorBody = args.body ?? "";
      const quote = opts.quote ?? "";
      const withQuote = (text: string) =>
        quote ? `${text.replace(/\s+$/, "")}\n\n${quote}` : text;

      setBusy(true);
      setSteps([]);
      setThinking("");
      setElapsedMs(null);

      // Seed revision 0 with what the user had before the AI touched it, so
      // "back to my own text" is always one click away.
      setRevisions((prev) => {
        if (prev.length > 0 || !priorBody.trim()) return prev;
        revisionSeq.current = 1;
        return [
          { id: 1, body: priorBody, label: "Yours", source: "user", instruction: "" },
        ];
      });

      let streamed = "";
      try {
        const res = await composeAssistStream(args, {
          onActivity: (evt) => setSteps((prev) => applyEvent(prev, evt)),
          onDelta: (kind, text) => {
            if (kind === "reasoning") {
              setThinking((t) => (t + text).slice(-4000));
              return;
            }
            streamed += text;
            onBody(withQuote(streamed));
          },
        });
        if (!res.draft) {
          onBody(withQuote(priorBody)); // never leave a half-streamed preview
          onError?.(
            res.skipped === "low_confidence"
              ? "The assistant wasn't confident enough to draft this — try adding an instruction."
              : "AI couldn't draft this — try adding a quick instruction.",
          );
          return null;
        }
        onBody(withQuote(res.draft));
        revisionSeq.current += 1;
        const id = revisionSeq.current;
        setRevisions((prev) => [
          ...prev,
          {
            id,
            body: res.draft,
            label: `v${prev.filter((r) => r.source === "ai").length + 1}`,
            source: "ai",
            instruction: opts.instruction,
          },
        ]);
        setActiveRevision(id);
        setElapsedMs(Date.now() - startedAt);
        onSettled?.(res.draft);
        return res.draft;
      } catch (err) {
        onBody(withQuote(priorBody));
        onError?.((err as Error)?.message || "AI draft failed");
        return null;
      } finally {
        setBusy(false);
      }
    },
    [onBody, onSettled, onError],
  );

  /** Flip the composer back to a saved revision (non-destructive). */
  const restore = useCallback(
    (id: number, quote?: string | null) => {
      const rev = revisions.find((r) => r.id === id);
      if (!rev) return;
      onBody(quote ? `${rev.body.replace(/\s+$/, "")}\n\n${quote}` : rev.body);
      setActiveRevision(id);
    },
    [revisions, onBody],
  );

  /** Forget the session (composer closed / a new message opened). */
  const reset = useCallback(() => {
    setSteps([]);
    setThinking("");
    setRevisions([]);
    setActiveRevision(null);
    setElapsedMs(null);
    revisionSeq.current = 0;
  }, []);

  return {
    busy,
    steps,
    thinking,
    revisions,
    activeRevision,
    elapsedMs,
    run,
    restore,
    reset,
    /** True once at least one AI round has produced a draft. */
    hasDraft: revisions.some((r) => r.source === "ai"),
  };
}
