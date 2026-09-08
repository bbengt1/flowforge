# FlowForge

Deployable application skeleton (E1.1). Product design, contracts, and the backlog live in [docs/](docs/index.md) — start with [architecture](docs/architecture.md) and the [master implementation plan](docs/master-implementation-plan.md).

This README only covers how to start the local stack. It does not define product scope.

## Local startup

1. Copy `env-template.txt` to `.env` and replace the local PostgreSQL password placeholder.
2. Run `docker compose up --build`.
3. Open the UI at [http://localhost:3000](http://localhost:3000).
4. With the Go module from [PR #2](https://github.com/bbengt1/flowforge/pull/2) present, verify [http://localhost:8080/api/v1/health](http://localhost:8080/api/v1/health) then [http://localhost:8080/api/v1/readiness](http://localhost:8080/api/v1/readiness).

The UI calls `GET /api/v1/health` (compose network `http://api:8080`). Until the API is running, the home page reports that the control plane is not up yet.

## UI only (optional)

```bash
pnpm install
pnpm dev
```

Serves [http://localhost:3000](http://localhost:3000) and checks `http://localhost:8080/api/v1/health`.

## Layout

| Path | Role |
| --- | --- |
| `apps/web` | Next.js App Router UI (Compose `web` build context) |
| `apps/api` | Go control plane (PR #2). Compose `api` build context, `HTTP_ADDR=:8080` |
| `docs/` | Normative architecture and implementation plan |

Compose builds `web` from `./apps/web` and `api` from `./apps/api`. This PR does not add `apps/api` files so it cannot clobber PR #2. Either merge order works: #2 first (compose then has a real context) or #1 first (compose assumes `apps/api` from #2). pnpm workspace root is ready for more packages later.

## E1.1 ownership

| Slice | Owner |
| --- | --- |
| Next.js UI, `env-template.txt`, `docker-compose.yml`, this README | Chloe |
| Go API, PostgreSQL connection/migration harness, `/api/v1/health` and `/api/v1/readiness` | jonny |
