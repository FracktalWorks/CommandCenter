/**
 * MeetingRecorder — browser mic capture → chunked upload to the /notes API.
 *
 * MediaRecorder emits timeslice blobs that are parts of ONE continuous
 * container, so the server appends them in order to reconstruct the file. Each
 * blob is uploaded sequentially with retry+backoff; unacked blobs stay queued
 * in memory (the offline buffer), and stop() flushes the queue before
 * finalizing. Spec: note_taker_app.md §3.3 / §6 (slice 1).
 */

import { completeRecording, startRecording, uploadChunk } from "./api";
import { DeepgramLive, type LiveCaption } from "./live";

export type RecorderState = "idle" | "recording" | "paused" | "finalizing";

export interface RecorderCallbacks {
  onState?: (s: RecorderState) => void;
  onElapsed?: (seconds: number) => void;
  onLevel?: (level0to1: number) => void;
  /** Count of blobs captured but not yet acked by the server. */
  onBacklog?: (pending: number) => void;
  onError?: (message: string) => void;
  /** A live caption arrived (Deepgram streaming) — best-effort, may never fire. */
  onCaption?: (c: LiveCaption) => void;
  /** Live captions aren't available; recording continues via the batch path. */
  onLiveUnavailable?: (reason: string) => void;
}

/** Pick the best MediaRecorder mime the browser supports (Chromium/FF → webm,
 *  Safari → mp4). */
export function pickMimeType(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  const MR = typeof MediaRecorder !== "undefined" ? MediaRecorder : null;
  for (const c of candidates) {
    if (MR && MR.isTypeSupported(c)) return c;
  }
  return "audio/webm";
}

const CHUNK_MS = 5000;
const MAX_RETRIES = 6;

export class MeetingRecorder {
  private meetingId: string;
  private cb: RecorderCallbacks;
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private rafId = 0;
  private recordingId = "";
  private mime = "audio/webm";

  // Live captions (Deepgram streaming) — additive; failures never affect the
  // chunked-upload / batch path below.
  private live: DeepgramLive | null = null;
  private liveNode: ScriptProcessorNode | null = null;
  private liveSource: MediaStreamAudioSourceNode | null = null;
  private liveSink: GainNode | null = null;

  private seq = 0;
  private queue: { seq: number; blob: Blob }[] = [];
  private pumping = false;
  private startedAt = 0;
  private pausedAccum = 0;
  private pausedAt = 0;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private stopping = false;

  constructor(meetingId: string, cb: RecorderCallbacks = {}) {
    this.meetingId = meetingId;
    this.cb = cb;
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this.mime = pickMimeType();
    const { recording_id } = await startRecording(
      this.meetingId,
      "mic",
      this.mime.split(";")[0]
    );
    this.recordingId = recording_id;

    this.setupMeter();
    this.recorder = new MediaRecorder(this.stream, { mimeType: this.mime });
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        this.queue.push({ seq: this.seq++, blob: e.data });
        this.cb.onBacklog?.(this.queue.length);
        void this.pump();
      }
    };
    this.recorder.onerror = () =>
      this.cb.onError?.("Recording error — the browser stopped the recorder.");
    this.recorder.start(CHUNK_MS);

    this.startedAt = Date.now();
    this.timerId = setInterval(() => this.cb.onElapsed?.(this.elapsed()), 250);
    this.cb.onState?.("recording");

    // Attach live captions without blocking the recording start — if the token
    // or socket isn't available, the batch path is unaffected.
    void this.setupLive();
  }

  /** Best-effort live captions: tap the audio graph and stream PCM to Deepgram. */
  private async setupLive(): Promise<void> {
    if (!this.audioCtx || !this.stream || this.stopping) return;
    const live = new DeepgramLive({
      onCaption: (c) => this.cb.onCaption?.(c),
      onUnavailable: (r) => this.cb.onLiveUnavailable?.(r),
    });
    const ok = await live.start();
    if (!ok || this.stopping || !this.audioCtx || !this.stream) {
      live.stop();
      return;
    }
    this.live = live;
    try {
      const ctx = this.audioCtx;
      const source = ctx.createMediaStreamSource(this.stream);
      const node = ctx.createScriptProcessor(4096, 1, 1);
      const sink = ctx.createGain();
      sink.gain.value = 0; // never play the mic back through the speakers
      node.onaudioprocess = (e) => {
        // Only stream while actually recording (not paused).
        if (this.recorder?.state !== "recording") return;
        this.live?.send(e.inputBuffer.getChannelData(0), ctx.sampleRate);
      };
      source.connect(node);
      node.connect(sink);
      sink.connect(ctx.destination);
      this.liveSource = source;
      this.liveNode = node;
      this.liveSink = sink;
    } catch (e) {
      this.cb.onLiveUnavailable?.(String(e instanceof Error ? e.message : e));
      live.stop();
      this.live = null;
    }
  }

  pause(): void {
    if (this.recorder?.state === "recording") {
      this.recorder.pause();
      this.pausedAt = Date.now();
      this.cb.onState?.("paused");
    }
  }

  resume(): void {
    if (this.recorder?.state === "paused") {
      this.pausedAccum += Date.now() - this.pausedAt;
      this.pausedAt = 0;
      this.recorder.resume();
      this.cb.onState?.("recording");
    }
  }

  /** Stop capture, flush every queued chunk, then finalize + kick transcription. */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.cb.onState?.("finalizing");
    const durationS = this.elapsed();

    // Wait for MediaRecorder's final ondataavailable before draining.
    await new Promise<void>((resolve) => {
      if (!this.recorder || this.recorder.state === "inactive") return resolve();
      this.recorder.onstop = () => resolve();
      this.recorder.stop();
    });
    this.teardownCapture();

    await this.pump(); // drain remaining chunks (with retry)
    if (this.queue.length > 0) {
      this.cb.onError?.(
        `${this.queue.length} audio chunk(s) failed to upload — the recording may be truncated.`
      );
    }
    await completeRecording(this.meetingId, this.recordingId, durationS);
    this.cb.onState?.("idle");
  }

  /** Abandon: stop capture without finalizing (user cancelled). */
  cancel(): void {
    this.stopping = true;
    try {
      if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    } catch {
      /* already stopped */
    }
    this.teardownCapture();
    this.queue = [];
  }

  private elapsed(): number {
    if (!this.startedAt) return 0;
    const paused =
      this.pausedAccum + (this.pausedAt ? Date.now() - this.pausedAt : 0);
    return Math.max(0, (Date.now() - this.startedAt - paused) / 1000);
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue[0];
        const ok = await this.uploadWithRetry(item.seq, item.blob);
        if (!ok) break; // keep it queued; a later pump() retries
        this.queue.shift();
        this.cb.onBacklog?.(this.queue.length);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async uploadWithRetry(seq: number, blob: Blob): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        await uploadChunk(this.meetingId, this.recordingId, seq, blob);
        return true;
      } catch {
        // Exponential backoff (250ms → 8s), capped — rides out wifi blips.
        const wait = Math.min(250 * 2 ** attempt, 8000);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    return false;
  }

  private setupMeter(): void {
    try {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      this.audioCtx = new AC();
      const src = this.audioCtx.createMediaStreamSource(this.stream!);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 512;
      src.connect(this.analyser);
      const buf = new Uint8Array(this.analyser.frequencyBinCount);
      const tick = () => {
        if (!this.analyser) return;
        this.analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) {
          const c = (v - 128) / 128;
          sum += c * c;
        }
        this.cb.onLevel?.(Math.min(1, Math.sqrt(sum / buf.length) * 3));
        this.rafId = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      /* metering is best-effort */
    }
  }

  private teardownCapture(): void {
    if (this.timerId) clearInterval(this.timerId);
    this.timerId = null;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.analyser = null;
    // Tear down the live path before the context closes.
    try {
      if (this.liveNode) this.liveNode.onaudioprocess = null;
      this.liveNode?.disconnect();
      this.liveSource?.disconnect();
      this.liveSink?.disconnect();
    } catch {
      /* nodes already detached */
    }
    this.liveNode = null;
    this.liveSource = null;
    this.liveSink = null;
    this.live?.stop();
    this.live = null;
    void this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}
