# FlowForge API (hook)

This directory is the Compose build context for the Go control plane.

**Owner: jonny.** This slice only reserves the path, a placeholder `Dockerfile`, and environment hooks. Do not treat the placeholder image as the API.

## Expected from jonny (E1.1)

- Go control-plane service listening on `:8080` (or `$API_ADDR`)
- PostgreSQL connection and forward-only migration harness (`schema_migrations`)
- `GET /api/v1/health` → `200 {"status":"ok"}`
- `GET /api/v1/readiness` → `200 {"status":"ready"}` after migrations

See `docs/reference/backend-api-map.md` and `docs/deployment.md`.

## Compose

`docker-compose.yml` builds `image: flowforge-api:local` from this folder (`context: ./apps/api`) and injects `DATABASE_URL` plus `POSTGRES_*` from the root `.env` (copied from `env-template.txt`). The process must listen on `:8080`. Replace this `Dockerfile` with the real multi-stage Go image; keep the build context as `./apps/api`.
