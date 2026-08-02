/**
 * AudioWorklet processors for WhatsApp call audio.
 *
 * Served as a static file because AudioWorklet.addModule() loads a URL, not a
 * bundle — this can't be imported like normal app code.
 *
 * Both sides speak the call's native format: 16 kHz mono, 960-sample (60 ms)
 * frames. The AudioContext is created at 16 kHz so the browser resamples once,
 * in native code, instead of us doing it badly in JS.
 */

/** Mic → main thread. Accumulates 128-sample render quanta into 960-frames. */
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(960);
    this.filled = 0;
    this.muted = false;
    this.port.onmessage = (e) => {
      if (e.data && typeof e.data.muted === "boolean") this.muted = e.data.muted;
    };
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;

    for (let i = 0; i < input.length; i++) {
      // Muting at the source, not the socket: we must keep sending frames to
      // hold the relay bridge open, so mute means silence, not silence-of-data.
      this.frame[this.filled++] = this.muted ? 0 : input[i];
      if (this.filled === 960) {
        // Transfer a copy — the worklet reuses its buffer immediately.
        const out = this.frame.slice();
        this.port.postMessage(out, [out.buffer]);
        this.filled = 0;
      }
    }
    return true;
  }
}

/**
 * Main thread → speakers, with a jitter buffer.
 *
 * Network frames don't arrive on the audio clock, so playing them the instant
 * they land produces constant underruns. We hold a few frames before starting
 * and re-arm if we run dry, which trades a little latency for audio that
 * doesn't crackle.
 */
class PlaybackProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options?.processorOptions ?? {};
    /** Frames to buffer before starting (and after an underrun). */
    this.prebuffer = opts.prebufferFrames ?? 3; // ~180 ms
    /** Hard cap so a stalled consumer can't grow latency without bound. */
    this.maxFrames = opts.maxFrames ?? 25; // ~1.5 s
    this.queue = [];
    this.current = null;
    this.offset = 0;
    this.priming = true;

    this.port.onmessage = (e) => {
      if (e.data === "reset") {
        this.queue = [];
        this.current = null;
        this.offset = 0;
        this.priming = true;
        return;
      }
      this.queue.push(e.data);
      // Drop from the FRONT when overfull: the newest audio is the one the
      // listener wants, and dropping the tail would keep them permanently behind.
      while (this.queue.length > this.maxFrames) this.queue.shift();
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0]?.[0];
    if (!out) return true;

    if (this.priming) {
      if (this.queue.length < this.prebuffer) {
        out.fill(0);
        return true;
      }
      this.priming = false;
    }

    for (let i = 0; i < out.length; i++) {
      if (!this.current || this.offset >= this.current.length) {
        this.current = this.queue.shift() ?? null;
        this.offset = 0;
        if (!this.current) {
          // Underrun: fill silence and re-prime so we don't stutter frame by
          // frame for the rest of the call.
          out.fill(0, i);
          this.priming = true;
          return true;
        }
      }
      out[i] = this.current[this.offset++];
    }
    return true;
  }
}

registerProcessor("call-capture", CaptureProcessor);
registerProcessor("call-playback", PlaybackProcessor);
