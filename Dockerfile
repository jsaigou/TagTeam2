# syntax=docker/dockerfile:1
# TagTeam2 — single-container build: Vite app (app/) + Express server (server/).
# The Express server serves the built app statically + the /api proxies.

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

# --- Runtime ---
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/server/node_modules ./server/node_modules
COPY server/ ./server/
COPY content/ ./content/
COPY --from=build /app/app/dist ./app/dist

ENV PORT=8083
EXPOSE 8083
# Env (Connect creds, host URLs, asset IDs) injected via compose env_file.
CMD ["node", "server/src/index.mjs"]
