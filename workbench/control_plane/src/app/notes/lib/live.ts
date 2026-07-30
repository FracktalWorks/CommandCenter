/**
 * LiveTranscription — browser-direct live captions during a recording.
 *
 * The gateway mints a short-lived token (POST /notes/stt/live-token) and tells
 * us which provider it is for; the browser then opens a WebSocket straight to
 * that provider and streams 16 kHz linear16 PCM, rendering captions as people
 * talk. This keeps the gateway out of the audio path (spec §7 D7).
 *
 * Two protocols, one interface:
 *  - **AssemblyAI** (preferred) — v3 streaming: token in the query string,
 *    `Turn` messages whose `end_of_turn` marks a final. Diarizes live.
 *  - **Deepgram** (fallback) — ephemeral key as a WS subprotocol,
 *    `channel.alternatives[0]` messages with `is_final`.
 *
 * Everything is best-effort: if the token or socket is unavailable,
 * onUnavailable() fires and the recorder just keeps doing its chunked upload →
 * authoritative batch transcript on stop (two-pass).
 */

export interface LiveCaption {
  text: string;
  isFinal: boolean;
  /** Diarized speaker index, 0-based, or null when the provider didn't say. */
  speaker: number | null;
  /** Seconds from the start of the stream. Used when relaying finals to the
   *  live bus, where spans drive speaker reconciliation. */
  startS: number;
  endS: number;
}

export interface LiveCallbacks {
  onCaption?: (c: LiveCaption) => void;
  /** Live isn't available (no key/scope, or the socket failed). */
  onUnavailable?: (reason: string) => void;
}

interface LiveToken {
  provider: "assemblyai" | "deepgram";
  token: string;
  model: string;
  expires_in: number;
}

const DG_WS = "wss://api.deepgram.com/v1/listen";
const AAI_WS = "wss://streaming.assemblyai.com/v3/ws";
const TARGET_RATE = 16000;

export class LiveTranscription {
  private ws: WebSocket | null = null;
  private cb: LiveCallbacks;
  private open = false;
  private closed = false;
  private provider: LiveToken["provider"] = "assemblyai";

  constructor(cb: LiveCallbacks = {}) {
    this.cb = cb;
  }

  /** Fetch a token and open the socket. Resolves true if live is running.
   *
   *  Passing the meeting lets the gateway refuse when nothing is reading the
   *  stream — streaming ASR bills per minute, and with the copilot off the
   *  recording still yields the same transcript afterwards at batch prices. A
   *  refusal (409) is a normal outcome, not an error: the recorder carries on
   *  without captions. */
  async start(meetingId?: string): Promise<boolean> {
    try {
      const url = meetingId
        ? `/api/notes/stt/live-token?meeting_id=${encodeURIComponent(meetingId)}`
        : "/api/notes/stt/live-token";
      const res = await fetch(url, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        this.cb.onUnavailable?.(String(body?.detail ?? `token ${res.status}`));
        return false;
      }
      const tok = (await res.json()) as LiveToken;
      this.provider = tok.provider === "deepgram" ? "deepgram" : "assemblyai";
      this.ws =
        this.provider === "deepgram"
          ? this.openDeepgram(tok)
          : this.openAssemblyAI(tok);
      this.ws.binaryType = "arraybuffer";
      this.ws.onopen = () => {
        this.open = true;
      };
      this.ws.onmessage = (ev) => this.onMessage(ev);
      this.ws.onerror = () => {
        if (!this.closed) this.cb.onUnavailable?.("live socket error");
      };
      this.ws.onclose = () => {
        this.open = false;
      };
      return true;
    } catch (e) {
      this.cb.onUnavailable?.(String(e instanceof Error ? e.message : e));
      return false;
    }
  }

  private openAssemblyAI(tok: LiveToken): WebSocket {
    const params = new URLSearchParams({
      sample_rate: String(TARGET_RATE),
      encoding: "pcm_s16le",
      format_turns: "true",
      // Ask for speakers. Streaming diarization has to be requested explicitly
      // — exactly like Deepgram's `diarize` below — and omitting it was why
      // live captions arrived with no speaker separation at all. Note it needs
      // a streaming model that supports it (Universal-3 Pro Streaming or a
      // multilingual streaming model); Universal-2 does not.
      speaker_labels: "true",
      token: tok.token,
    });
    // Empty model → AssemblyAI's default streaming model.
    if (tok.model) params.set("speech_model", tok.model);
    return new WebSocket(`${AAI_WS}?${params}`);
  }

  private openDeepgram(tok: LiveToken): WebSocket {
    const params = new URLSearchParams({
      model: tok.model || "nova-3",
      encoding: "linear16",
      sample_rate: String(TARGET_RATE),
      channels: "1",
      interim_results: "true",
      punctuate: "true",
      smart_format: "true",
      diarize: "true",
    });
    // Deepgram accepts the key as the second WS subprotocol ("token", <key>).
    return new WebSocket(`${DG_WS}?${params}`, ["token", tok.token]);
  }

  /** Feed one buffer of mono Float32 samples at `inRate` Hz. */
  send(samples: Float32Array, inRate: number): void {
    if (!this.open || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const pcm = downsampleToInt16(samples, inRate, TARGET_RATE);
    if (pcm.byteLength > 0) this.ws.send(pcm.buffer);
  }

  stop(): void {
    this.closed = true;
    this.open = false;
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        // Ask the provider to flush and close cleanly.
        this.ws.send(
          JSON.stringify(
            this.provider === "deepgram"
              ? { type: "CloseStream" }
              : { type: "Terminate" }
          )
        );
      }
      this.ws?.close();
    } catch {
      /* already closing */
    }
    this.ws = null;
  }

  private onMessage(ev: MessageEvent): void {
    if (typeof ev.data !== "string") return;
    try {
      const msg = JSON.parse(ev.data);
      const caption =
        this.provider === "deepgram"
          ? parseDeepgram(msg)
          : parseAssemblyAI(msg);
      if (caption) this.cb.onCaption?.(caption);
    } catch {
      /* non-JSON keepalive/metadata frame */
    }
  }
}

/** AssemblyAI v3: `Turn` messages; `end_of_turn` marks a final. */
export function parseAssemblyAI(msg: {
  type?: string;
  transcript?: string;
  end_of_turn?: boolean;
  speaker?: unknown;
  words?: { start?: number; end?: number; speaker?: unknown }[];
}): LiveCaption | null {
  if (msg?.type !== "Turn") return null;
  const text = (msg.transcript ?? "").trim();
  if (!text) return null;
  const words = Array.isArray(msg.words) ? msg.words : [];
  // AssemblyAI reports word offsets in milliseconds.
  const startS = words.length ? (words[0].start ?? 0) / 1000 : 0;
  const endS = words.length ? (words[words.length - 1].end ?? 0) / 1000 : 0;
  // A diarized turn belongs to one speaker by definition, but the label can
  // arrive on the turn or on its words depending on the streaming model. Read
  // whichever is present rather than betting on one — a miss here shows up as
  // "diarization is broken" when it's really just the wrong field.
  const speaker =
    msg.speaker != null ? msg.speaker : words.find((w) => w.speaker != null)?.speaker;
  return {
    text,
    isFinal: Boolean(msg.end_of_turn),
    speaker: speakerIndex(speaker),
    startS,
    endS,
  };
}

/** Deepgram: `channel.alternatives[0]`; `is_final` marks a final. */
export function parseDeepgram(msg: {
  is_final?: boolean;
  start?: number;
  duration?: number;
  channel?: { alternatives?: { transcript?: string; words?: { speaker?: unknown }[] }[] };
}): LiveCaption | null {
  const alt = msg?.channel?.alternatives?.[0];
  const text = (alt?.transcript ?? "").trim();
  if (!text) return null;
  const startS = typeof msg.start === "number" ? msg.start : 0;
  const duration = typeof msg.duration === "number" ? msg.duration : 0;
  return {
    text,
    isFinal: Boolean(msg.is_final),
    speaker: speakerIndex(alt?.words?.[0]?.speaker),
    startS,
    endS: startS + duration,
  };
}

/**
 * Normalise a provider's speaker marker to a 0-based index.
 * Deepgram emits ints (0,1,…); AssemblyAI emits letters ("A","B",…). The caller
 * maps this onto the app-wide S1/S2 label space.
 */
export function speakerIndex(raw: unknown): number | null {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string" && raw.length) {
    if (/^\d+$/.test(raw)) return Number(raw);
    if (/^[A-Za-z]$/.test(raw)) return raw.toUpperCase().charCodeAt(0) - 65;
  }
  return null;
}

/** Linear-interpolate/decimate Float32 @ inRate → Int16 PCM @ outRate. */
function downsampleToInt16(
  input: Float32Array,
  inRate: number,
  outRate: number
): Int16Array {
  if (inRate <= outRate) {
    // Already at/below target — just convert to Int16.
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) out[i] = clamp16(input[i]);
    return out;
  }
  const ratio = inRate / outRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    // Average the source window for a cheap anti-alias.
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = clamp16(sum / Math.max(1, end - start));
  }
  return out;
}

function clamp16(v: number): number {
  const s = Math.max(-1, Math.min(1, v));
  return s < 0 ? s * 0x8000 : s * 0x7fff;
}
