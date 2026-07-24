"use client";

/**
 * AskPanel — grounded Q&A over one meeting's transcript. Answers cite segment
 * numbers; clicking a citation scrolls the transcript there and cues the audio
 * (spec §4 Tier-1 / §5.3 provenance-you-can-touch).
 */

import { useState } from "react";
import { Loader2, MessageCircleQuestion, Send } from "lucide-react";
import { askMeeting } from "../lib/api";

interface QA {
  q: string;
  a: string;
  citations: { segment_id: string; idx: number }[];
  truncated: boolean;
}

export default function AskPanel({
  meetingId,
  onCite,
}: {
  meetingId: string;
  onCite: (segmentId: string) => void;
}) {
  const [question, setQuestion] = useState("");
  const [history, setHistory] = useState<QA[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ask() {
    const q = question.trim();
    if (!q || loading) return;
    setQuestion("");
    setLoading(true);
    setError(null);
    try {
      const res = await askMeeting(meetingId, q);
      setHistory((h) => [
        ...h,
        { q, a: res.answer, citations: res.citations, truncated: res.truncated },
      ]);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-border">
        <MessageCircleQuestion className="w-4 h-4 text-primary" />
        <h2 className="text-sm font-semibold text-foreground">
          Ask this meeting
        </h2>
      </div>

      <div className="p-3 space-y-3 max-h-[40vh] overflow-y-auto">
        {history.length === 0 && !loading && (
          <p className="text-xs text-muted-foreground px-1">
            Ask anything about what was discussed — “What did we decide about
            the budget?”, “What did Priya commit to?” Answers cite the moments
            they come from.
          </p>
        )}
        {history.map((qa, i) => (
          <div key={i} className="space-y-1.5">
            <p className="text-xs font-medium text-foreground">{qa.q}</p>
            <p className="text-sm text-muted-foreground whitespace-pre-wrap">
              {qa.a}
            </p>
            {qa.citations.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {qa.citations.map((c) => (
                  <button
                    key={c.segment_id}
                    onClick={() => onCite(c.segment_id)}
                    className="text-[10px] font-mono rounded-md bg-primary/10 text-primary px-1.5 py-0.5 hover:bg-primary/20 tech-transition"
                    title="Jump to this moment"
                  >
                    #{c.idx}
                  </button>
                ))}
              </div>
            )}
            {qa.truncated && (
              <p className="text-[10px] text-warning">
                Answered from the most relevant parts of a long transcript.
              </p>
            )}
          </div>
        ))}
        {loading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Thinking…
          </div>
        )}
        {error && (
          <p className="text-xs text-destructive">{error}</p>
        )}
      </div>

      <div className="flex items-center gap-2 p-2 border-t border-border">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ask()}
          placeholder="Ask a question…"
          className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <button
          onClick={ask}
          disabled={loading || !question.trim()}
          className="p-2 rounded-lg bg-primary text-primary-foreground hover:opacity-90 tech-transition disabled:opacity-50"
          aria-label="Ask"
        >
          <Send className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
