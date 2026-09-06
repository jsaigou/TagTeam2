# syntax=docker/dockerfile:1
# TagTeam2 — single-container build: Vite app (app/) + Express server (server/)
# + a local whisper.cpp server for Japanese STT (Kotoba-Whisper, see
# docs/adr/0012-local-kotoba-whisper-stt.md). The Express server serves the
# built app statically + the /api proxies.

FROM node:22-slim AS build
WORKDIR /app

# --- Server deps (production only) ---
COPY server/package.json server/package-lock.json ./server/
WORKDIR /app/server
RUN npm install --omit=dev

# --- App build ---
WORKDIR /app/app
COPY app/package.json app/package-lock.json ./
RUN npm install
COPY app/ ./
RUN npm run build

# --- whisper.cpp build (CPU, plain pthreads — no BLAS/GPU needed for
# short-utterance turn-based transcription) + the Kotoba-Whisper GGML model.
# Pinned tag for reproducible builds; bump deliberately.
FROM debian:bookworm-slim AS whisper-build
ARG WHISPER_CPP_TAG=v1.9.3
ARG KOTOBA_WHISPER_MODEL_URL=https://huggingface.co/kenrouse/kotoba-whisper-v2.2-ggml/resolve/main/kotoba-whisper-v2.2-ggml-q8_0.bin
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
# Model download first, into its own directory (not /whisper — that's about
# to be `git clone`d into and whisper.cpp's repo has its own models/ path),
# on its own layer (~780MB, the slow part) so it stays cached independently
# of source/build-flag changes below.
RUN mkdir -p /model \
    && curl -fL --retry 3 -o /model/kotoba-whisper.bin "${KOTOBA_WHISPER_MODEL_URL}"
WORKDIR /whisper
RUN git clone --depth 1 --branch ${WHISPER_CPP_TAG} https://github.com/ggml-org/whisper.cpp.git .
# Static link: BUILD_SHARED_LIBS=OFF means one self-contained binary to
# copy into the runtime stage (no libwhisper/libggml .so files to chase
# down separately, only the standard system libs libgomp/libstdc++/etc.
# already on the runtime image's search path once libgomp1 is installed).
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
    && cmake --build build -j"$(nproc)" --config Release --target whisper-server

# --- Runtime ---
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/server/node_modules ./server/node_modules
COPY server/ ./server/
COPY content/ ./content/
COPY --from=build /app/app/dist ./app/dist
COPY --from=whisper-build /whisper/build/bin/whisper-server /usr/local/bin/whisper-server
COPY --from=whisper-build /model/kotoba-whisper.bin /app/models/kotoba-whisper.bin

ENV PORT=8083
# Local STT server (127.0.0.1-only — never exposed outside the container).
ENV WHISPER_STT_PORT=8090
ENV WHISPER_STT_MODEL=/app/models/kotoba-whisper.bin
ENV WHISPER_STT_THREADS=8
ENV STT_LOCAL_BASE_URL=http://127.0.0.1:8090
EXPOSE 8083
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh
# Env (Connect creds, host URLs, asset IDs) injected via compose env_file.
CMD ["/app/start.sh"]
