#!/bin/sh
# Starts the local whisper.cpp STT server (Kotoba-Whisper, Japanese-only —
# see docs/adr/0012-local-kotoba-whisper-stt.md) in the background, then
# execs the Express server as PID 1 so it receives container signals
# directly. whisper-server is 127.0.0.1-only; never reachable from outside
# the container.
set -e

whisper-server \
  --host 127.0.0.1 \
  --port "${WHISPER_STT_PORT:-8090}" \
  -m "${WHISPER_STT_MODEL:-/app/models/kotoba-whisper.bin}" \
  -t "${WHISPER_STT_THREADS:-8}" \
  -l ja \
  &

exec node server/src/index.mjs
