/**
 * Duplex audio for a live WhatsApp call — the browser half.
 *
 * Captures the microphone, streams it to the bridge, and plays the peer's audio
 * back through the speakers:
 *
 *     mic ──► AudioWorklet ──► WS ──► gateway ──► bridge ──► peer
 *     spkr ◄── AudioWorklet ◄── WS ◄── gateway ◄── bridge ◄── peer
 *
 * Everything runs at the call's native 16 kHz mono. The AudioContext is created
 * at that rate so the browser resamples once in native code; doing it in JS is
 * where clock drift and crackle come from.
 *
 * Echo: we ask for the browser's AEC, but it references what the browser itself
 * renders, and this path plays through WebAudio rather than a WebRTC peer
 * connection — so cancellation is best-effort. Headphones are the reliable fix,
 * and the UI says so.
 */

const WORKLET_URL = "/call-audio-worklets.js";
const SAMPLE_RATE = 16000;

export type CallAudioState =
  | "idle"
  | "requesting-mic"
  | "connecting"
  | "live"
  | "failed";

export type CallAudioHandle = {
  stop: () => void;
  setMuted: (muted: boolean) => void;
};

type Options = {
  accountId: string;
  callId: string;
  onState: (state: CallAudioState, detail?: string) => void;
};

/**
 * Ask the gateway for a short-lived token and the absolute socket URL.
 *
 * The URL comes from the server because audio can't go through the Next proxy —
 * App Router route handlers can't upgrade a connection — so the browser opens
 * the gateway origin directly, which only the server knows. A relative URL back
 * means local dev, where the gateway is same-origin.
 */
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
  if (/^wss?:\/\//.test(data.ws_url)) return data.ws_url;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${data.ws_url}`;
}

/**
 * Start duplex audio. Resolves once the socket is open and audio is flowing;
 * rejects with a message fit to show the user.
 */
export async function startCallAudio({
  accountId,
  callId,
  onState,
}: Options): Promise<CallAudioHandle> {
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
    throw new Error(
      name === "NotAllowedError"
        ? "Microphone permission was denied — allow it for this site and try again."
        : "Couldn't open the microphone."
    );
  }

  // Anything that succeeded before a later failure has to be torn down, or a
  // failed attempt leaves the mic light on.
  const cleanups: Array<() => void> = [
    () => stream.getTracks().forEach((t) => t.stop()),
  ];
  const bail = (err: unknown) => {
    cleanups.reverse().forEach((fn) => {
      try {
        fn();
      } catch {
        /* teardown is best-effort */
      }
    });
    throw err;
  };

  try {
    onState("connecting");
    const wsUrl = await mintAudioSocket(accountId, callId);

    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    cleanups.push(() => void ctx.close());
    // Autoplay policy: a context created outside a user gesture starts
    // suspended, and suspended means silence with no error.
    if (ctx.state === "suspended") await ctx.resume();
    await ctx.audioWorklet.addModule(WORKLET_URL);

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

    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    cleanups.push(() => ws.close());

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("The audio connection timed out.")),
        15000
      );
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("Couldn't open the audio connection."));
      };
    });

    // Mic → socket. Float32 to int16 here so the wire carries half the bytes.
    capture.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const f = e.data;
      const pcm = new Int16Array(f.length);
      for (let i = 0; i < f.length; i++) {
        const v = Math.max(-1, Math.min(1, f[i]));
        pcm[i] = v * 32767;
      }
      ws.send(pcm.buffer);
    };

    // Socket → speakers.
    ws.onmessage = (e: MessageEvent) => {
      if (!(e.data instanceof ArrayBuffer)) return;
      const pcm = new Int16Array(e.data);
      const f = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
      playback.port.postMessage(f, [f.buffer]);
    };

    ws.onclose = () => onState("idle", "Audio disconnected.");

    onState("live");
    return {
      stop: () => {
        cleanups.reverse().forEach((fn) => {
          try {
            fn();
          } catch {
            /* teardown is best-effort */
          }
        });
        onState("idle");
      },
      setMuted: (muted: boolean) => capture.port.postMessage({ muted }),
    };
  } catch (err) {
    return bail(err);
  }
}
