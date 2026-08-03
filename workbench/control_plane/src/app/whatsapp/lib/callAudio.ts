/**
 * Duplex audio for a WhatsApp call — the browser half.
 *
 *     mic ──► AudioWorklet ──► WS ──► gateway ──► bridge ──► peer
 *     spkr ◄── AudioWorklet ◄── WS ◄── gateway ◄── bridge ◄── peer
 *
 * Everything runs at the call's native 16 kHz mono. The AudioContext is created
 * at that rate so the browser resamples once in native code; doing it in JS is
 * where clock drift and crackle come from.
 *
 * **Two phases, and the split matters.** `prepare()` opens the microphone and
 * the audio graph, and must run inside the click that starts the call —
 * getUserMedia needs user activation, and a call placed first would spend that
 * activation on a network round-trip. `attach()` then joins the socket once the
 * call has an id. Between the two we play a local ringback, so the caller hears
 * something from the moment they press Call rather than silence until answer.
 *
 * Echo: we ask for the browser's AEC, but it references what the browser itself
 * renders, and this plays through WebAudio rather than a WebRTC peer
 * connection — so cancellation is best-effort. Headphones are the reliable fix.
 */

const WORKLET_URL = "/call-audio-worklets.js";
const SAMPLE_RATE = 16000;

export type CallAudioState =
  | "idle"
  | "requesting-mic"
  | "ringing"
  | "connecting"
  | "live"
  | "failed";

export type PreparedCallAudio = {
  /** Join the call's audio socket. Safe to call once. */
  attach: (callId: string) => Promise<void>;
  /** Local ringback while we wait for the far end. Stops on first real audio. */
  ringback: (on: boolean) => void;
  setMuted: (muted: boolean) => void;
  stop: () => void;
};

/** One timestamped thing that happened on the browser side of the audio. */
export type AudioLogEntry = { at: string; detail: string };

/** Shared, module-level so the page can render it without threading it through
 *  every callback. Capped — a long call would otherwise grow it forever. */
const audioLog: AudioLogEntry[] = [];

export function logAudio(detail: string): void {
  audioLog.push({ at: new Date().toISOString(), detail });
  if (audioLog.length > 80) audioLog.splice(0, audioLog.length - 80);
}

export function readAudioLog(): AudioLogEntry[] {
  return [...audioLog];
}

export function clearAudioLog(): void {
  audioLog.length = 0;
}

type Options = {
  accountId: string;
  onState: (state: CallAudioState, detail?: string) => void;
};

async function mintAudioSocket(
  accountId: string,
  callId: string
): Promise<string> {
  const res = await fetch(
    `/api/whatsapp/calls/${encodeURIComponent(callId)}/audio-token?account_id=${encodeURIComponent(
      accountId
    )}`,
    { method: "POST" }
  );
  const data = (await res.json().catch(() => null)) as
    | { ws_url?: string; detail?: string }
    | null;
  if (!res.ok || !data?.ws_url) {
    throw new Error(
      data?.detail ?? `Couldn't get an audio token (HTTP ${res.status})`
    );
  }
  // A relative URL means local dev, where the gateway is same-origin. In
  // production it's absolute, because Next can't proxy a WebSocket upgrade so
  // the browser opens the gateway directly.
  if (/^wss?:\/\//.test(data.ws_url)) return data.ws_url;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${data.ws_url}`;
}

/**
 * Open the microphone and audio graph. Call this synchronously from the click
 * that places the call — before any await on the network.
 */
export async function prepareCallAudio({
  accountId,
  onState,
}: Options): Promise<PreparedCallAudio> {
  clearAudioLog();
  logAudio(`browser: ${navigator.userAgent}`);
  logAudio("requesting microphone");
  onState("requesting-mic");

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (e) {
    const name = e instanceof DOMException ? e.name : "";
    logAudio(`microphone FAILED: ${name || String(e)}`);
    throw new Error(
      name === "NotAllowedError"
        ? "Microphone permission was denied — allow it for this site and try again."
        : "Couldn't open the microphone."
    );
  }

  const cleanups: Array<() => void> = [
    () => stream.getTracks().forEach((t) => t.stop()),
  ];
  const teardown = () => {
    cleanups.reverse().forEach((fn) => {
      try {
        fn();
      } catch {
        /* teardown is best-effort */
      }
    });
    cleanups.length = 0;
  };

  try {
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    cleanups.push(() => void ctx.close());
    // A context created outside a user gesture starts suspended, and suspended
    // means silence with no error anywhere.
    if (ctx.state === "suspended") await ctx.resume();
    logAudio(`AudioContext ready @ ${ctx.sampleRate}Hz (state=${ctx.state})`);
    await ctx.audioWorklet.addModule(WORKLET_URL);
    logAudio("audio worklets loaded");

    const capture = new AudioWorkletNode(ctx, "call-capture");
    const playback = new AudioWorkletNode(ctx, "call-playback", {
      processorOptions: { prebufferFrames: 3, maxFrames: 25 },
    });
    const mic = ctx.createMediaStreamSource(stream);
    mic.connect(capture);
    playback.connect(ctx.destination);
    cleanups.push(() => {
      mic.disconnect();
      capture.disconnect();
      playback.disconnect();
    });

    // ── local ringback ──────────────────────────────────────────────────────
    // Generated here, not sent by WhatsApp. Without it the caller hears nothing
    // between pressing Call and the far end answering, which is indistinguishable
    // from the audio being broken — the exact ambiguity that cost us a day.
    let ringGain: GainNode | null = null;
    let ringOsc: OscillatorNode | null = null;
    let ringTimer: ReturnType<typeof setInterval> | null = null;

    const ringback = (on: boolean) => {
      if (on && !ringOsc) {
        ringGain = ctx.createGain();
        ringGain.gain.value = 0;
        ringGain.connect(ctx.destination);
        ringOsc = ctx.createOscillator();
        ringOsc.frequency.value = 400; // Indian ringback tone
        ringOsc.connect(ringGain);
        ringOsc.start();
        // 0.4s on · 0.2s off · 0.4s on · 2s off, the standard cadence.
        let step = 0;
        const pattern = [0.06, 0, 0.06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        ringTimer = setInterval(() => {
          if (!ringGain) return;
          ringGain.gain.setTargetAtTime(
            pattern[step % pattern.length],
            ctx.currentTime,
            0.02
          );
          step++;
        }, 200);
      } else if (!on && ringOsc) {
        if (ringTimer) clearInterval(ringTimer);
        ringTimer = null;
        try {
          ringOsc.stop();
        } catch {
          /* already stopped */
        }
        ringOsc.disconnect();
        ringGain?.disconnect();
        ringOsc = null;
        ringGain = null;
      }
    };
    cleanups.push(() => ringback(false));

    let stopping = false;
    let sent = 0;
    let received = 0;

    const attach = async (callId: string): Promise<void> => {
      onState("connecting");
      logAudio(`minting audio token for call ${callId}`);
      const wsUrl = await mintAudioSocket(accountId, callId);
      // Host only — the token is a credential and must not land in a report.
      logAudio(`opening socket to ${new URL(wsUrl, window.location.href).host}`);
      const sock = new WebSocket(wsUrl);
      sock.binaryType = "arraybuffer";
      cleanups.push(() => sock.close());

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("The audio connection timed out.")),
          15000
        );
        sock.onopen = () => {
          clearTimeout(timer);
          logAudio("socket OPEN");
          resolve();
        };
        sock.onerror = () => {
          clearTimeout(timer);
          logAudio("socket ERROR before open");
          reject(new Error("Couldn't open the audio connection."));
        };
      });

      capture.port.onmessage = (e: MessageEvent<Float32Array>) => {
        if (sock.readyState !== WebSocket.OPEN) return;
        const f = e.data;
        const pcm = new Int16Array(f.length);
        for (let i = 0; i < f.length; i++) {
          const v = Math.max(-1, Math.min(1, f[i]));
          pcm[i] = v * 32767;
        }
        sock.send(pcm.buffer);
        if (++sent === 1) logAudio("first microphone frame sent");
      };

      sock.onmessage = (e: MessageEvent) => {
        if (!(e.data instanceof ArrayBuffer)) return;
        // Real audio from the far end — the ringback has served its purpose.
        ringback(false);
        if (++received === 1) logAudio("first peer audio frame received");
        const pcm = new Int16Array(e.data);
        const f = new Float32Array(pcm.length);
        for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
        playback.port.postMessage(f, [f.buffer]);
      };

      // Only report a close we didn't ask for. Hanging up closes this socket
      // by design, and surfacing that as an error made every normal call end
      // with a red banner.
      sock.onclose = (e) => {
        // The close code is the single most useful number in a bug report.
        logAudio(
          `socket CLOSED code=${e.code} reason=${e.reason || "(none)"} ` +
            `clean=${e.wasClean} sent=${sent} received=${received}`
        );
        if (stopping) onState("idle");
        else onState("idle", `Audio disconnected (code ${e.code}).`);
      };
      onState("live");
    };

    return {
      attach,
      ringback,
      setMuted: (muted: boolean) => capture.port.postMessage({ muted }),
      stop: () => {
        stopping = true;
        logAudio("stopping audio (requested)");
        teardown();
        onState("idle");
      },
    };
  } catch (err) {
    teardown();
    throw err;
  }
}
