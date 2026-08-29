# Deploy: TagTeam2 on Core (docktail / Tailscale)

Deploy **every version** to Core as the **`tagteam2`** docktail service, reachable at:

    https://tagteam2.mango-rockhopper.ts.net   (tailnet only)

Pattern follows the old TagTeam deployment (see `docs/handoff-phase7b.md`).

## Stack layout on Core

- Stack dir: `/home/jon/docker/tagteam2/`
- Container: `tagteam2-api` (image `tagteam2:latest`), port `8083`
- Service: docktail label `tagteam2`, HTTPS via Tailscale serve
- API + static SPA served by a single Express container (`server/src/index.mjs`)

## What lives where

| Config | Where | Committed? |
|---|---|---|
| Connect creds, host URLs, asset IDs | `/home/jon/docker/tagteam2/.env` (on Core) | **No — never commit** |
| Dockerfile | repo `Dockerfile` | Yes |
| docker-compose.yml | repo `docker-compose.yml` | Yes |
| Build context excludes | `.dockerignore` (server/.env, node_modules, dist) | Yes |

`docker-compose.yml` injects `.env` via `env_file`; the image reads config from
process env (no `--env-file` at runtime). `server/.env` is dockerignored so secrets
never enter the build context.

## Deploy procedure (after pushing to `main`)

From the repo root — ship the tracked source (no secrets) and rebuild:

```sh
# 1. Commit + push first, then ship HEAD to Core
git archive HEAD | tailscale ssh core 'cd /home/jon/docker/tagteam2 && tar -x'

# 2. Ship local .env (secrets — not in git, not in Docker build context)
tailscale ssh core 'cat > /home/jon/docker/tagteam2/.env' < server/.env

# 3. Rebuild + restart the container
tailscale ssh core 'cd /home/jon/docker/tagteam2 && docker compose up -d --build'

# 4. Verify from inside the container
tailscale ssh core 'docker exec tagteam2-api node -e "fetch(\"http://localhost:8083/api/health\").then(r=>r.json()).then(j=>console.log(JSON.stringify(j)))"'

# 5. Verify through the public host (from a tailnet client)
curl -s https://tagteam2.mango-rockhopper.ts.net/api/health
curl -s https://tagteam2.mango-rockhopper.ts.net/api/connect/config | head -c 200
```

## Network caveat (IMPORTANT — did this once)

`docker-compose.yml` creates a `tagteam2-internal` network. For docktail's
reverse-proxy tailscaled to reach the container, that network **must be joined to the
`docktail-tailscale` container** (and `docktail`). Docktail auto-joins other service
networks but did not pick up this new one on first deploy, so tagteam2 timed out at the
public host while `serve status` showed the route. Fix (done once; persists until those
containers are recreated):

```sh
tailscale ssh core 'docker network connect tagteam2-internal docktail-tailscale'
tailscale ssh core 'docker network connect tagteam2-internal docktail'
tailscale ssh core 'docker exec docktail-tailscale wget -q -O- http://172.16.46.2:8083/api/health'
```

If `docker-compose up` later recreates `docktail`/`docktail-tailscale`, re-run the
`docker network connect` lines before declaring the deploy done.

## Troubleshooting

- **Public host 000 / timeout but container healthy:** check the network join above.
- **Secrets in the image?** `.dockerignore` excludes `server/.env`; keep Connect creds
  only in the stack `.env` on Core.
