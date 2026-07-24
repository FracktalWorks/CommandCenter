/**
 * Global recording session — hoists the MeetingRecorder out of the session page
 * so an active recording SURVIVES navigation and follows the user as a dock
 * (mirrors the tasks Focus-timer pattern: identity in a module-level store, the
 * owning component mounted once in AppShell). Previously the recorder lived in a
 * useRef inside /notes/session/[id] and its unmount cancelled the capture — so
 * leaving the page dropped the recording. Now the page is just a view onto this
 * store, and the dock keeps it alive everywhere else.
 */

import { create } from "zustand";
import { MeetingRecorder, type RecorderState } from "./recorder";

export type Cap = { text: string; speaker: number | null };

/** Rolling VU-level buffer for the waveform — kept OUT of reactive state so the
 *  per-audio-frame updates don't thrash React; canvases read it in a RAF loop. */
export const LEVEL_BARS = 48;
export const levelBuffer: number[] = [];

/** The single live recorder. Module-level (not React state) so exactly one
 *  exists regardless of how many components read the store. */
let recorder: MeetingRecorder | null = null;

export type Phase = "ready" | RecorderState;

/** True when a recording is capturing (or finishing) — the dock shows in these. */
export function isActive(phase: Phase): boolean {
  return phase === "recording" || phase === "paused" || phase === "finalizing";
}

interface RecordingState {
  meetingId: string | null;
  title: string | null;
  phase: Phase;
  elapsed: number;
  backlog: number;
  error: string | null;
  captions: Cap[];
  interim: Cap | null;
  liveOff: boolean;

  start: (meetingId: string, title?: string | null) => Promise<void>;
  pause: () => void;
  resume: () => void;
  /** Flush + finalize; returns the meeting id to navigate to (or null on error). */
  stop: () => Promise<string | null>;
  cancel: () => void;
  setTitle: (title: string | null) => void;
  clearError: () => void;
}

const IDLE = {
  meetingId: null,
  title: null,
  phase: "ready" as Phase,
  elapsed: 0,
  backlog: 0,
  error: null,
  captions: [] as Cap[],
  interim: null as Cap | null,
  liveOff: false,
};

export const useRecordingStore = create<RecordingState>((set, get) => ({
  ...IDLE,

  start: async (meetingId, title = null) => {
    if (recorder) return; // already recording — one session at a time
    levelBuffer.length = 0;
    set({ ...IDLE, meetingId, title });
    const rec = new MeetingRecorder(meetingId, {
      onState: (s) => set({ phase: s }),
      onElapsed: (sec) => set({ elapsed: sec }),
      onBacklog: (n) => set({ backlog: n }),
      onLevel: (lvl) => {
        levelBuffer.push(lvl);
        if (levelBuffer.length > LEVEL_BARS) levelBuffer.shift();
      },
      onError: (m) => set({ error: m }),
      onCaption: (c) => {
        if (c.isFinal) {
          set((st) => ({
            captions: [...st.captions.slice(-60), { text: c.text, speaker: c.speaker }],
            interim: null,
          }));
        } else {
          set({ interim: { text: c.text, speaker: c.speaker } });
        }
      },
      onLiveUnavailable: () => set({ liveOff: true }),
    });
    recorder = rec;
    try {
      await rec.start();
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      recorder = null;
      set({
        phase: "ready",
        error:
          msg.includes("Permission") || msg.toLowerCase().includes("denied")
            ? "Microphone access was denied. Allow the mic in your browser and try again."
            : `Could not start recording: ${msg}`,
      });
    }
  },

  pause: () => recorder?.pause(),
  resume: () => recorder?.resume(),

  stop: async () => {
    const id = get().meetingId;
    try {
      await recorder?.stop();
    } finally {
      recorder = null;
      levelBuffer.length = 0;
      set({ ...IDLE });
    }
    return id;
  },

  cancel: () => {
    recorder?.cancel();
    recorder = null;
    levelBuffer.length = 0;
    set({ ...IDLE });
  },

  setTitle: (title) => set({ title }),
  clearError: () => set({ error: null }),
}));
