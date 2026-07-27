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
pactl load-module module-null-sink sink_name=meet \
    sink_properties=device.description=meet >/dev/null 2>&1 || true
pactl set-default-sink meet >/dev/null 2>&1 || true

exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8080}"
