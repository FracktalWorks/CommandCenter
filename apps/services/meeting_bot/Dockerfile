# CommandCenter Meeting Bot — headless-Chrome meeting-joining worker.
# Based on Playwright's Python image (bundles Chromium + all its system libs),
# plus PulseAudio + ffmpeg + Xvfb for the audio-capture pipeline.
FROM mcr.microsoft.com/playwright/python:v1.48.0-jammy

RUN apt-get update \
    && apt-get install -y --no-install-recommends pulseaudio ffmpeg xvfb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

ENV MEETING_BOT_DATA=/data \
    PULSE_MONITOR=meet.monitor \
    DISPLAY=:99
VOLUME ["/data"]
EXPOSE 8080

CMD ["./entrypoint.sh"]
