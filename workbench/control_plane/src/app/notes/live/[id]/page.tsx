"use client";

/**
 * Copilot console — watch a meeting that is happening RIGHT NOW.
 *
 * Presence + a live transcript attributed by the speaker roster, plus the
 * copilot itself (spec §7, §13 Phases A-B): when it's opted in, its suggestions
 * stream in on their OWN channel — deliberately separate from the transcript, so
 * agent chatter never mixes into the record. Off by default; turning it off
 * unsubscribes the orchestrator, so spend stops immediately.
 *
 * It works for BOTH capture sources because both feed one bus: a headless bot in
 * a Meet call, or your own mic on the recording screen. Reattaches to a running
 * session by id, so a refresh or navigating away never drops it.
 */

import { use, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  BookOpen,
  Bot,
  ListChecks,
  Loader2,
  Mic,
  Sparkles,
  Users,
} from "lucide-react";
import {
  chatAgenda,
  getAgenda,
  getLiveRoster,
  getLiveSession,
  getMeetingContext,
  setCopilot,
  setDeepContext,
  setMeetingBrief,
} from "../../lib/api";
import type {
  AgendaItem,
  CopilotEvent,
  MeetingContext,
  LiveSegment,
  LiveSession,
  LiveSpeaker,
} from "../../lib/types";

/** Keep the rendered transcript bounded — this can run for hours. */
const MAX_LINES = 300;

export default function LiveConsolePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [session, setSession] = useState<LiveSession | null>(null);
  const [roster, setRoster] = useState<LiveSpeaker[]>([]);
  const [lines, setLines] = useState<LiveSegment[]>([]);
  const [suggestions, setSuggestions] = useState<CopilotEvent[]>([]);
  const [ctx, setCtx] = useState<MeetingContext | null>(null);
  const [brief, setBrief] = useState("");
  const [savingBrief, setSavingBrief] = useState(false);
  const [agenda, setAgenda] = useState<AgendaItem[]>([]);
  const [agendaMsg, setAgendaMsg] = useState("");
  const [agendaReply, setAgendaReply] = useState("");
  const [planning, setPlanning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    const [s, r, c, a] = await Promise.all([
      getLiveSession(id).catch(() => null),
      getLiveRoster(id).catch(() => [] as LiveSpeaker[]),
      getMeetingContext(id).catch(() => null),
      getAgenda(id).catch(() => [] as AgendaItem[]),
    ]);
    setAgenda(a);
    setSession(s);
    setRoster(r);
    if (c) {
      setCtx(c);
      // Don't clobber what the user is mid-way through typing.
      setBrief((prev) => (prev ? prev : c.brief));
    }
    setLoading(false);
  }, [id]);

  // Poll session + roster: both change on human timescales (a speaker joining,
  // a name being detected), so polling is cheaper and simpler than a 2nd stream.
  useEffect(() => {
    // Syncs an external system (the live-session registry) into React; refresh()
    // is async so its setState lands after the fetch, not synchronously here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  // The transcript itself IS worth a stream — words arrive continuously.
  useEffect(() => {
    const es = new EventSource(`/api/notes/meetings/${id}/live`);
    es.onmessage = (ev) => {
      try {
        const seg = JSON.parse(ev.data) as LiveSegment;
        if (!seg?.text) return;
        setLines((prev) => [...prev.slice(-(MAX_LINES - 1)), seg]);
      } catch {
        /* keepalive / non-JSON frame */
      }
    };
    // Errors are expected (the stream ends when the meeting does); EventSource
    // reconnects on its own, and live is best-effort by design.
    es.onerror = () => {};
    return () => es.close();
  }, [id]);

  // The copilot's output is its own channel, so its chatter never mixes into
  // the transcript. Only subscribed while it's actually on.
  useEffect(() => {
    if (!session?.copilot_enabled) return;
    const es = new EventSource(`/api/notes/meetings/${id}/copilot/stream`);
    es.onmessage = (ev) => {
      try {
        const e = JSON.parse(ev.data) as CopilotEvent;
        if (e?.text) setSuggestions((prev) => [...prev.slice(-49), e]);
      } catch {
        /* keepalive */
      }
    };
    es.onerror = () => {};
    return () => es.close();
  }, [id, session?.copilot_enabled]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [lines]);

  async function onToggleCopilot() {
    if (!session) return;
    setBusy(true);
    try {
      setSession(await setCopilot(id, !session.copilot_enabled));
    } catch {
      /* surfaced by the unchanged toggle state */
    } finally {
      setBusy(false);
    }
  }

  async function onSaveBrief() {
    setSavingBrief(true);
    try {
      await setMeetingBrief(id, brief);
      setCtx(await getMeetingContext(id).catch(() => ctx));
    } catch {
      /* left in the box so nothing is lost */
    } finally {
      setSavingBrief(false);
    }
  }

  async function onPlan() {
    const msg = agendaMsg.trim();
    if (!msg) return;
    setPlanning(true);
    try {
      const res = await chatAgenda(id, msg);
      setAgenda(res.agenda);
      setAgendaReply(res.reply);
      setAgendaMsg("");
    } catch {
      setAgendaReply("Couldn't reach the copilot — your agenda is unchanged.");
    } finally {
      setPlanning(false);
    }
  }

  async function onToggleDeep() {
    if (!session) return;
    try {
      await setDeepContext(id, !session.deep_context);
      await refresh();
    } catch {
      /* surfaced by the unchanged toggle */
    }
  }

  const live = session?.status === "live";
  const tips = suggestions.filter((e) => e.kind !== "status");
  const lastStatus = [...suggestions].reverse().find((e) => e.kind === "status");
  const nameFor = (seg: LiveSegment) =>
    seg.speaker_name ?? seg.speaker_id ?? seg.speaker_label ?? "Speaker";

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center">
        <p className="text-sm text-muted-foreground">
          No live session for this meeting.
        </p>
        <Link
          href={`/notes/meeting/${id}`}
          className="mt-4 inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
        >
          <ArrowLeft className="h-4 w-4" /> Open the meeting
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      {/* Header — what's live, from where, since when */}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Link
          href="/notes"
          className="text-muted-foreground hover:text-foreground"
          aria-label="Back to notes"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="text-lg font-semibold">
          {session.title ?? "Untitled meeting"}
        </h1>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
          {session.source === "bot" ? (
            <Bot className="h-3.5 w-3.5" />
          ) : (
            <Mic className="h-3.5 w-3.5" />
          )}
          {session.source === "bot" ? "Notetaker in call" : "Recording here"}
        </span>
        {live ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-500">
            <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
            Live
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">Ended</span>
        )}
      </div>

      {/* Agenda — planned by talking to the copilot, then measured against
          during the call. Structured (not prose) precisely so it CAN be
          measured: "you haven't touched pricing and you're 40 minutes in". */}
      <div className="mb-5 rounded-xl border border-border bg-card p-3">
        <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <ListChecks className="h-3.5 w-3.5" /> Agenda
        </p>
        {agenda.length > 0 ? (
          <ol className="mb-2 space-y-1">
            {agenda.map((item, i) => (
              <li key={i} className="text-sm">
                <span className="mr-1.5 text-muted-foreground">{i + 1}.</span>
                {item.title}
                {item.notes ? (
                  <span className="text-muted-foreground"> — {item.notes}</span>
                ) : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="mb-2 text-sm text-muted-foreground">
            No agenda yet. Describe the meeting below and the copilot will draft one.
          </p>
        )}
        {agendaReply && (
          <p className="mb-2 rounded-lg bg-muted/50 p-2 text-xs text-muted-foreground">
            {agendaReply}
          </p>
        )}
        <div className="flex gap-2">
          <input
            value={agendaMsg}
            onChange={(e) => setAgendaMsg(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !planning) void onPlan();
            }}
            placeholder={
              agenda.length
                ? "Refine it — e.g. drop the demo, add pricing"
                : "e.g. 30-min call with Acme to close the annual renewal"
            }
            className="flex-1 rounded-lg border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary"
          />
          <button
            onClick={onPlan}
            disabled={planning || !agendaMsg.trim()}
            className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-50"
          >
            {planning ? "…" : agenda.length ? "Refine" : "Draft"}
          </button>
        </div>
      </div>

      {/* Context — the difference between a generic observer and a useful one.
          Shown first because it's what you'd want to fill in BEFORE turning the
          copilot on. */}
      <div className="mb-5 rounded-xl border border-border bg-card p-3">
        <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <BookOpen className="h-3.5 w-3.5" /> What the copilot knows
        </p>
        <textarea
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          rows={3}
          placeholder="Why this meeting? e.g. Pricing negotiation with Acme. They churned in 2024 over cost. Goal: land the annual contract."
          className="w-full resize-y rounded-lg border border-border bg-background p-2 text-sm outline-none focus:border-primary"
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            onClick={onSaveBrief}
            disabled={savingBrief || brief === (ctx?.brief ?? "")}
            className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
          >
            {savingBrief ? "Saving…" : "Save briefing"}
          </button>
          <button
            onClick={onToggleDeep}
            disabled={!live}
            title="Ask your CRM and task agents for background on the attendees. Costs tokens before the meeting starts."
            className="rounded-lg border border-border px-2.5 py-1 text-xs hover:bg-accent disabled:opacity-50"
          >
            {session.deep_context ? "✓ Asking your agents" : "Ask CRM + tasks"}
          </button>
          <span className="text-[11px] text-muted-foreground">
            Takes effect on the next suggestion.
          </span>
        </div>

        {/* What it actually assembled — so "why is it being generic?" is answerable. */}
        {ctx && (
          <div className="mt-3 space-y-1.5 border-t border-border pt-2 text-xs">
            {ctx.is_empty && !brief ? (
              <p className="text-muted-foreground">
                No background yet — add a briefing above, or add attendees so it
                can pull up your past meetings with them.
              </p>
            ) : (
              <>
                {ctx.attendees.length > 0 && (
                  <p className="text-muted-foreground">
                    <span className="text-foreground">Attendees:</span>{" "}
                    {ctx.attendees.join(", ")}
                  </p>
                )}
                {ctx.past.map((p, i) => (
                  <p key={`p${i}`} className="text-muted-foreground">
                    <span className="text-foreground">Previously:</span> {p}
                  </p>
                ))}
                {ctx.open_actions.map((a, i) => (
                  <p key={`a${i}`} className="text-muted-foreground">
                    <span className="text-foreground">Still open:</span> {a}
                  </p>
                ))}
                {Object.entries(ctx.systems).map(([k, v]) => (
                  <p key={k} className="text-muted-foreground">
                    <span className="text-foreground uppercase">{k}:</span> {v}
                  </p>
                ))}
              </>
            )}
          </div>
        )}
      </div>

      {/* Copilot opt-in. Off by default; honest that it doesn't act yet. */}
      <div className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-3">
        <Sparkles className="h-4 w-4 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Meeting copilot</p>
          <p className="text-xs text-muted-foreground">
            {session.copilot_enabled
              ? "On — listening, and it will chime in when a moment warrants it."
              : "Off. Opt in to let an agent listen and suggest talking points."}
          </p>
        </div>
        <button
          onClick={onToggleCopilot}
          disabled={busy || !live}
          className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-50"
        >
          {busy ? "…" : session.copilot_enabled ? "Turn off" : "Turn on"}
        </button>
      </div>

      {/* What the copilot has surfaced. Only shown when it's on, so the console
          stays uncluttered for plain transcript-watching. */}
      {session.copilot_enabled && (
        <div className="mb-5 rounded-xl border border-primary/30 bg-primary/5 p-3">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-primary">
            <Sparkles className="h-3.5 w-3.5" /> Copilot
          </p>
          {tips.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {lastStatus?.text ?? "Listening — it stays quiet unless it has something specific."}
            </p>
          ) : (
            <div className="space-y-2">
              {tips.slice(-6).map((e, i) => (
                <div key={i} className="rounded-lg border border-border bg-card p-2.5">
                  <p className="text-sm text-foreground">{e.text}</p>
                  {/* Grounding: what triggered it, so a suggestion is
                      inspectable rather than an oracle. */}
                  {e.refs?.trigger && (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {e.refs.trigger}
                      {e.refs.speakers?.length
                        ? ` · ${e.refs.speakers.join(", ")}`
                        : ""}
                    </p>
                  )}
                </div>
              ))}
              {lastStatus && (
                <p className="text-[11px] text-muted-foreground">{lastStatus.text}</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Roster — who's on the call, per the live voiceprint gallery */}
      <div className="mb-5 rounded-xl border border-border bg-card p-3">
        <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <Users className="h-3.5 w-3.5" /> In the room
        </p>
        {roster.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Listening for speakers…
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {roster.map((s) => (
              <span
                key={s.speaker_id}
                className="rounded-full border border-border px-2.5 py-1 text-sm"
                title={`${s.utterances} utterance${s.utterances === 1 ? "" : "s"}`}
              >
                {s.name ?? s.speaker_id}
                {s.role ? (
                  <span className="ml-1 text-xs text-muted-foreground">
                    {s.role}
                  </span>
                ) : null}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* The live transcript, attributed by the roster */}
      <div className="rounded-xl border border-border bg-card p-3">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Live transcript
        </p>
        {lines.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {live
              ? "Waiting for speech…"
              : "This session has ended. The full transcript is on the meeting page."}
          </p>
        ) : (
          <div className="max-h-[55vh] space-y-2 overflow-y-auto pr-1">
            {lines.map((seg, i) => (
              <p key={i} className="text-sm leading-relaxed">
                <span className="mr-2 font-medium text-primary">
                  {nameFor(seg)}
                </span>
                <span className="text-foreground/90">{seg.text}</span>
              </p>
            ))}
            <div ref={endRef} />
          </div>
        )}
      </div>

      <p className="mt-3 text-center text-xs text-muted-foreground">
        Live is a fast draft — the authoritative transcript is written when the
        meeting ends.
      </p>
    </div>
  );
}
