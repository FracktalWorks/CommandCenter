#!/usr/bin/env bash
# Bring up the audio + display stack the headless-Chrome bot needs, then serve.
#
#  Xvfb        — a virtual X display so we can run Chrome *headful* (headless
#                Chrome doesn't drive the audio pipeline reliably).
#  PulseAudio  — a per-container sound server with a null sink named "meet";
#                Chrome plays the meeting audio into it and ffmpeg records its
#                monitor source (meet.monitor).
set -euo pipefail

export DISPLAY="${DISPLAY:-:99}"

rm -f /tmp/.X99-lock 2>/dev/null || true
Xvfb "$DISPLAY" -screen 0 1280x720x24 -ac -nolisten tcp >/tmp/xvfb.log 2>&1 &

# Per-container PulseAudio (not the system daemon).
pulseaudio -D --exit-idle-time=-1 --disallow-exit >/tmp/pulse.log 2>&1 || true
sleep 1

# Output sink: Chrome plays the meeting audio here; ffmpeg records meet.monitor.
pactl load-module module-null-sink sink_name=meet \
    sink_properties=device.description=meet >/dev/null 2>&1 || true
pactl set-default-sink meet >/dev/null 2>&1 || true

# Virtual microphone: a null sink whose monitor becomes Chrome's mic input.
# To speak into the call, TTS audio is played into the `vmic` sink -> it appears
# on vmic.monitor -> Chrome transmits it as the bot's microphone.
pactl load-module module-null-sink sink_name=vmic \
    sink_properties=device.description=vmic >/dev/null 2>&1 || true
pactl set-default-source vmic.monitor >/dev/null 2>&1 || true

# Live view of the bot's browser (MEET_VNC=1). Two uses, both things a
# post-mortem screenshot can't do: watch a join happen in real time, and
# complete a Google sign-in by hand when 2FA or a "verify it's you" wall
# appears. x11vnc shares the same Xvfb display Chrome draws on; noVNC puts it
# in a browser so no VNC client is needed.
if [ "${MEET_VNC:-0}" = "1" ]; then
  x11vnc -display "$DISPLAY" -forever -shared -nopw -quiet \
      -rfbport 5900 >/tmp/x11vnc.log 2>&1 &
  # websockify serves noVNC's static files and bridges to x11vnc.
  websockify --web=/usr/share/novnc 6080 localhost:5900 \
      >/tmp/novnc.log 2>&1 &
  echo "meeting-bot: VNC live view on :6080 (noVNC) and :5900 (raw)"
fi

exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8080}"
