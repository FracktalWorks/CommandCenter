/**
 * DeepgramLive — browser-direct live captions during a recording.
 *
 * The gateway mints a short-lived, usage-scoped Deepgram key
 * (POST /notes/stt/live-token); the browser opens a WebSocket straight to
 * Deepgram with it and streams 16 kHz linear16 PCM, rendering interim + final
 * captions as people talk. This keeps the gateway out of the audio path
 * (spec §7 D7). Everything is best-effort: if the token or socket is
 * unavailable, onUnavailable() fires and the recorder just keeps doing its
 * chunked upload → authoritative batch transcript on stop (two-pass).
 */

export interface LiveCaption {
  text: string;
  isFinal: boolean;
  speaker: number | null;
}

export interface DeepgramLiveCallbacks {
  onCaption?: (c: LiveCaption) => void;
  /** Live isn't available (no Deepgram key/scope, or the socket failed). */
  onUnavailable?: (reason: string) => void;
}

const DG_WS = "wss://api.deepgram.com/v1/listen";
const TARGET_RATE = 16000;

export class DeepgramLive {
  private ws: WebSocket | null = null;
  private cb: DeepgramLiveCallbacks;
  private open = false;
  private closed = false;

  constructor(cb: DeepgramLiveCallbacks = {}) {
    this.cb = cb;
  }

  /** Fetch a token and open the socket. Resolves true if live is running. */
  async start(): Promise<boolean> {
    try {
      const res = await fetch("/api/notes/stt/live-token", { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        this.cb.onUnavailable?.(String(body?.detail ?? `token ${res.status}`));
        return false;
      }
      const { token, model } = (await res.json()) as {
        token: string;
        model: string;
      };
      const params = new URLSearchParams({
        model,
        encoding: "linear16",
        sample_rate: String(TARGET_RATE),
        channels: "1",
        interim_results: "true",
        punctuate: "true",
        smart_format: "true",
        diarize: "true",
      });
      // Deepgram accepts the key as the second WS subprotocol ("token", <key>).
      this.ws = new WebSocket(`${DG_WS}?${params}`, ["token", token]);
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
        // Tell Deepgram to flush and close cleanly.
        this.ws.send(JSON.stringify({ type: "CloseStream" }));
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
      const alt = msg?.channel?.alternatives?.[0];
      const text: string = (alt?.transcript ?? "").trim();
      if (!text) return;
      const speaker =
        typeof alt?.words?.[0]?.speaker === "number"
          ? alt.words[0].speaker
          : null;
      this.cb.onCaption?.({
        text,
        isFinal: Boolean(msg.is_final),
        speaker,
      });
    } catch {
      /* non-JSON keepalive/metadata frame */
    }
  }
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
