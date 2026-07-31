"use client";

/**
 * useRoom — who else is in this conversation, live.
 *
 * One hook owns the whole room layer for a thread: the membership snapshot, the
 * live event tail, and this browser's presence heartbeat. Components read a
 * single `RoomState` rather than assembling one from four requests, because a
 * header showing three participants and a rail showing four is worse than a
 * header showing nothing.
 *
 * **A solo thread costs nothing.** The snapshot is fetched once; if it comes
 * back with nobody else in it, no stream is opened and no heartbeat is sent.
 * The room layer only wakes up when there is a room. That matters because the
 * overwhelming majority of conversations are and will remain one person's.
 *
 * Two live channels exist per thread and they are deliberately separate:
 * `/api/agent/chat` (run events — the agent working, reset every run) and
 * `/room-stream` (room events — people, agents, settings, which outlive runs).
 * This hook owns the second one only.
 */

import { useCallback, useEffect, useState } from "react";
import {
  fetchRoom,
  isShared as roomIsShared,
  sendPresence,
  soloRoom,
  type PresenceEntry,
  type RoomEvent,
  type RoomState,
} from "@/lib/rooms";

/** The tab tells the server it is here on this cadence; presence expires at 45s. */
const HEARTBEAT_MS = 15_000;

/**
 * Room membership changes rarely and always emits an event, so this poll is a
 * backstop for a dropped stream, not the mechanism. Kept slow on purpose.
 */
const REFRESH_MS = 60_000;

export interface UseRoom {
  room: RoomState | null;
  /** True once the first snapshot has landed — gate room UI on this, not on `room`. */
  loaded: boolean;
  /** Somebody other than you is in here. Every piece of room UI keys off this. */
  shared: boolean;
  presence: PresenceEntry[];
  /** Room events worth showing inline in the transcript (joins, agent changes). */
  timeline: RoomEvent[];
  refresh: () => Promise<void>;
  error: string | null;
}

export function useRoom(
  sessionId: string | null | undefined,
  viewerEmail: string,
  opts: { enabled?: boolean } = {}
): UseRoom {
  const enabled = opts.enabled !== false && Boolean(sessionId);
  const [room, setRoom] = useState<RoomState | null>(null);
  const [presence, setPresence] = useState<PresenceEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  //: Both of these are keyed by session so switching threads resets them
  //: WITHOUT a setState inside an effect body — the reset is a read-time
  //: comparison instead, which cannot cascade a render.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [events, setEvents] = useState<{ sid: string; list: RoomEvent[] }>({
    sid: "",
    list: [],
  });

  const loaded = !enabled || loadedFor === sessionId;
  const timeline = events.sid === sessionId ? events.list : [];

  // The live channels open on this boolean, NOT on the room object: `room`
  // gets a new identity on every 60s refresh, and re-subscribing that often
  // would drop events in each gap. `shared` flips at most once per thread.
  //
  // It was a ref first, which was wrong in the one case that matters: sharing
  // a solo thread from inside the room updates the ref but nothing re-runs the
  // effects, so the person who just shared their conversation was the only one
  // in it not receiving its live events until they reloaded.
  const shared = roomIsShared(room);

  const refresh = useCallback(async () => {
    if (!sessionId || !enabled) return;
    try {
      const next = await fetchRoom(sessionId);
      setRoom(next);
      setPresence(next.presence ?? []);
      setError(null);
    } catch (e) {
      // A room we cannot read is not an error state for the chat — the
      // conversation still works, it just has no room layer. Fall back to a
      // room of one so the composer never renders disabled by accident.
      setRoom((prev) => prev ?? soloRoom(sessionId, viewerEmail));
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadedFor(sessionId);
    }
  }, [sessionId, viewerEmail, enabled]);

  // `refresh` only sets state after awaiting a fetch, so it cannot cascade a
  // render — but the rule cannot see through the await. Same scoped exemption
  // the other data-fetching effects in this app use.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const t = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh, enabled]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // ── Live room events ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled || !sessionId || !loaded) return;
    if (!shared) return;   // nobody to hear about

    const es = new EventSource(
      `/api/chat/sessions/${encodeURIComponent(sessionId)}/room-stream?since=0`
    );

    es.onmessage = (msg) => {
      let evt: RoomEvent;
      try {
        evt = JSON.parse(msg.data) as RoomEvent;
      } catch {
        return;
      }
      if (evt.type === "ROOM_PING" || evt.type === "ROOM_REPLAY_DONE") return;

      // Anything that changes who is in the room re-reads the snapshot rather
      // than patching it: the server resolves group subjects and the capability
      // cap, and a client-side patch would be a second, wrong answer.
      if (
        evt.type === "PARTICIPANT_JOINED" ||
        evt.type === "PARTICIPANT_LEFT" ||
        evt.type === "PARTICIPANT_ROLE_CHANGED" ||
        evt.type === "AGENT_ADDED" ||
        evt.type === "AGENT_REMOVED" ||
        evt.type === "ROOM_SETTINGS_CHANGED"
      ) {
        void refresh();
      }

      // USER_MESSAGE is somebody else's turn arriving. It is deliberately NOT
      // merged into the transcript here: the history endpoint is the one place
      // that applies the room's redaction rules, and a live event that skipped
      // them would be the leak the whole clearance design exists to prevent.
      setEvents((prev) =>
        prev.sid === sessionId
          ? { sid: sessionId, list: [...prev.list.slice(-49), evt] }
          : { sid: sessionId, list: [evt] }
      );
    };

    es.onerror = () => {
      // EventSource reconnects on its own; a transient gap is covered by the
      // backstop poll above. Nothing to report to the user.
    };

    return () => es.close();
  }, [sessionId, enabled, loaded, shared, refresh]);

  // ── Presence heartbeat ───────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled || !sessionId || !loaded) return;
    if (!shared) return;

    let alive = true;
    const beat = async () => {
      try {
        const list = await sendPresence(sessionId, "viewing");
        if (alive) setPresence(list);
      } catch {
        /* presence is a nicety; never surface its failures */
      }
    };
    void beat();
    const t = setInterval(() => void beat(), HEARTBEAT_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [sessionId, enabled, loaded, shared]);

  return {
    room,
    loaded,
    shared,
    presence,
    timeline,
    refresh,
    error,
  };
}
