"use client";

/**
 * MicPicker — the "green room" before recording (spec §5.1). Lets you choose
 * which microphone to use (Google-Meet style) and SEE it working via a live
 * input-level meter, so a wrong/muted default mic is caught *before* you record
 * rather than discovered in an empty transcript. The chosen device is
 * remembered across sessions (localStorage) and passed to the recorder.
 *
 * Self-contained: it owns a throwaway getUserMedia stream purely for the meter
 * and tears it down on unmount / when disabled. It never touches the real
 * recording capture — that starts fresh from the selected deviceId.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Check, ChevronDown, Mic, MicOff } from "lucide-react";
import { listMicrophones, type MicDevice } from "../lib/recorder";

export const MIC_STORAGE_KEY = "notes.micDeviceId";

/** Remembered mic from a previous session (null = system default). */
export function loadPreferredMic(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(MIC_STORAGE_KEY) || null;
}

interface MicPickerProps {
  value: string | null;
  onChange: (deviceId: string | null) => void;
  /** Pause the live meter (e.g. once recording has started elsewhere). */
  disabled?: boolean;
}

const METER_SEGMENTS = 14;

export function MicPicker({ value, onChange, disabled }: MicPickerProps) {
  const [devices, setDevices] = useState<MicDevice[]>([]);
  const [level, setLevel] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [ready, setReady] = useState(false); // meter is live
  const [open, setOpen] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef(0);

  const refreshDevices = useCallback(async () => {
    setDevices(await listMicrophones());
  }, []);

  const stopMeter = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    setLevel(0);
    setReady(false);
  }, []);

  const startMeter = useCallback(
    async (deviceId: string | null) => {
      stopMeter();
      try {
        const base: MediaTrackConstraints = { echoCancellation: true };
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: deviceId ? { ...base, deviceId: { exact: deviceId } } : base,
        });
        streamRef.current = stream;
        // First grant reveals real device labels — re-enumerate now.
        await refreshDevices();
        setErr(null);
        setReady(true);

        const AC =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        const ctx = new AC();
        ctxRef.current = ctx;
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        src.connect(analyser);
        const buf = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (const v of buf) {
            const c = (v - 128) / 128;
            sum += c * c;
          }
          setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 3));
          rafRef.current = requestAnimationFrame(tick);
        };
        tick();
      } catch (e) {
        const name = e instanceof DOMException ? e.name : "";
        setReady(false);
        setErr(
          name === "NotAllowedError" || name === "SecurityError"
            ? "Microphone access blocked — allow it in your browser to pick a mic."
            : name === "NotFoundError" || name === "OverconstrainedError"
              ? "That microphone isn't available. Choose another below."
              : "Couldn't open the microphone."
        );
      }
    },
    [refreshDevices, stopMeter]
  );

  // Green-room: auto-start the meter when shown (prompts permission once), and
  // restart it whenever the chosen device changes. When disabled we simply skip
  // starting; the previous run's cleanup has already torn the meter down. This
  // effect legitimately syncs an external system (the mic stream) with React —
  // startMeter's setState lands async after getUserMedia resolves.
  useEffect(() => {
    if (disabled) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void startMeter(value);
    return () => stopMeter();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, disabled]);

  // Devices coming and going (headset plugged/unplugged) should refresh the list.
  useEffect(() => {
    const md = navigator.mediaDevices;
    if (!md?.addEventListener) return;
    const handler = () => void refreshDevices();
    md.addEventListener("devicechange", handler);
    return () => md.removeEventListener("devicechange", handler);
  }, [refreshDevices]);

  function select(deviceId: string | null) {
    onChange(deviceId);
    if (typeof window !== "undefined") {
      if (deviceId) window.localStorage.setItem(MIC_STORAGE_KEY, deviceId);
      else window.localStorage.removeItem(MIC_STORAGE_KEY);
    }
    setOpen(false);
  }

  const selected = devices.find((d) => d.deviceId === value);
  const selectedLabel = selected?.label || "Default microphone";
  const lit = Math.round(level * METER_SEGMENTS);

  return (
    <div className="w-full max-w-sm">
      {/* Device selector */}
      <div className="relative">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-2 rounded-xl border border-border bg-card px-3 py-2.5 text-left text-sm text-foreground hover:border-primary/40 tech-transition"
        >
          {ready ? (
            <Mic className="w-4 h-4 shrink-0 text-primary" />
          ) : (
            <MicOff className="w-4 h-4 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate">{selectedLabel}</span>
          <ChevronDown className="w-4 h-4 shrink-0 text-muted-foreground" />
        </button>

        {open && (
          <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-xl border border-border bg-card shadow-xl">
            <button
              onClick={() => select(null)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-secondary tech-transition"
            >
              <span className="min-w-0 flex-1 truncate">Default microphone</span>
              {value === null && <Check className="w-3.5 h-3.5 text-primary" />}
            </button>
            {devices
              .filter((d) => d.deviceId)
              .map((d, i) => (
                <button
                  key={d.deviceId}
                  onClick={() => select(d.deviceId)}
                  className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-sm hover:bg-secondary tech-transition"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {d.label || `Microphone ${i + 1}`}
                  </span>
                  {value === d.deviceId && (
                    <Check className="w-3.5 h-3.5 text-primary" />
                  )}
                </button>
              ))}
          </div>
        )}
      </div>

      {/* Live level meter — the "is my mic working?" confidence check */}
      <div className="mt-2 flex items-center gap-2 px-1">
        <div className="flex flex-1 items-center gap-[3px]" aria-hidden>
          {Array.from({ length: METER_SEGMENTS }).map((_, i) => (
            <span
              key={i}
              className={`h-2.5 flex-1 rounded-full tech-transition ${
                i < lit
                  ? i > METER_SEGMENTS - 4
                    ? "bg-warning"
                    : "bg-primary"
                  : "bg-border"
              }`}
            />
          ))}
        </div>
      </div>
      <p className="mt-1.5 px-1 text-[11px] text-muted-foreground">
        {err ? (
          <span className="inline-flex items-center gap-1 text-destructive">
            <AlertCircle className="w-3 h-3 shrink-0" />
            {err}
          </span>
        ) : ready ? (
          level > 0.02 ? (
            "Mic is picking up sound — you're good to record."
          ) : (
            "Say something — if the bar stays flat, pick another mic above."
          )
        ) : (
          "Checking your microphone…"
        )}
      </p>
    </div>
  );
}
