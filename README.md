# FlowForge

Deployable application skeleton (E1.1). Product design, contracts, and the backlog live in [docs/](docs/index.md) — start with [architecture](docs/architecture.md) and the [master implementation plan](docs/master-implementation-plan.md).

This README only covers how to start the local stack. It does not define product scope.

## Local startup

1. Copy `env-template.txt` to `.env` and replace the local PostgreSQL password placeholder.
2. Run `docker compose up --build`.
3. Open the UI at [http://localhost:3000](http://localhost:3000).
4. After the Go control plane lands, verify [http://localhost:8080/api/v1/health](http://localhost:8080/api/v1/health) then [http://localhost:8080/api/v1/readiness](http://localhost:8080/api/v1/readiness).

The UI can call the health endpoint as soon as the API is listening. Until then the home page reports that the control plane is not up yet.

## UI only (optional)

```bash
pnpm install
pnpm dev
```

Serves [http://localhost:3000](http://localhost:3000) and checks `http://localhost:8080/api/v1/health`.

## Layout

| Path | Role |
| --- | --- |
| `apps/web` | Next.js App Router UI |
| `apps/api` | Go control-plane hook (placeholder image) |
| `docs/` | Normative architecture and implementation plan |

pnpm workspace root is ready for more packages later.

## E1.1 ownership

| Slice | Owner |
| --- | --- |
| Next.js UI, `env-template.txt`, `docker-compose.yml`, this README | Chloe |
| Go API, PostgreSQL connection/migration harness, `/api/v1/health` and `/api/v1/readiness` | jonny |
