# FlowForge control-plane API

Go module `github.com/bbengt1/flowforge/apps/api`. Listens on **8080** and exposes the E1 foundation routes from `docs/reference/backend-api-map.md`.

## Routes

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/v1/health` | Liveness. Always `200 {"status":"ok"}`. Does not check PostgreSQL. |
| `GET` | `/api/v1/readiness` | `200 {"status":"ready"}` when PostgreSQL is reachable; otherwise `503` RFC 9457 (`dependency-unavailable`). |
| `GET` | `/api/v1/openapi.yaml` | Published OpenAPI YAML. |
| `GET` | `/api/v1/openapi.json` | Published OpenAPI JSON. |
| `GET` | `/api/v1/swagger` | Specification landing page. |

Every response sets `X-Request-ID`. A caller value is accepted only when it is 16–128 ASCII letters, digits, or hyphens; otherwise the API generates one. Errors use `application/problem+json` with `type`, `title`, `status`, `detail`, `instance`, `code`, and `request_id`.

The process boots even if PostgreSQL is down. Health stays 200; readiness tracks the database. On connect, the API applies forward-only migrations recorded in `schema_migrations`.

## Environment

Copy these into the root `.env` (from `env-template.txt`) that compose loads. Existing environment variables win over a local `.env`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HTTP_ADDR` | `:8080` | Listen address. |
| `PORT` | — | Used as `:PORT` when `HTTP_ADDR` is unset. |
| `DATABASE_URL` | built from `POSTGRES_*` | PostgreSQL URL. Preferred. No secrets are hard-coded. |
| `POSTGRES_HOST` / `PGHOST` | `localhost` | Used only when `DATABASE_URL` is unset. |
| `POSTGRES_PORT` / `PGPORT` | `5432` | |
| `POSTGRES_USER` / `PGUSER` | `flowforge` | |
| `POSTGRES_PASSWORD` / `PGPASSWORD` | empty | |
| `POSTGRES_DB` / `PGDATABASE` | `flowforge` | |
| `POSTGRES_SSLMODE` / `PGSSLMODE` | `disable` | |
| `SHUTDOWN_TIMEOUT` | `10s` | Graceful HTTP shutdown. |
| `MIGRATE_TIMEOUT` | `5m` | Deadline for applying migrations after PostgreSQL is reachable. Separate from the 5s connect/ping timeout. |

Suggested local URL (compose service hostname `postgres`):

```text
DATABASE_URL=postgres://flowforge:change-me@postgres:5432/flowforge?sslmode=disable
HTTP_ADDR=:8080
```

## Local commands

From `apps/api`:

```bash
go test ./...
go run ./cmd/migrate
go run ./cmd/api
```

Integration coverage for a live database is skipped unless `TEST_DATABASE_URL` or `DATABASE_URL` is set.

## Compose wiring (`api` service)

Do not overwrite a root `docker-compose` / `env-template.txt` owned by the UI agent. Point the **`api`** service at this module:

```yaml
  api:
    build:
      context: ./apps/api
      dockerfile: Dockerfile
    ports:
      - "8080:8080"
    environment:
      HTTP_ADDR: ":8080"
      DATABASE_URL: postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}?sslmode=disable
    depends_on:
      postgres:
        condition: service_healthy
```

Conventions:

- Service name: `api`
- Host/container port: `8080`
- Build context: `apps/api` (this Dockerfile)
- Image user: UID/GID `65532` (non-root)
- Same image can run migrations as a one-shot. The image uses `CMD` (not `ENTRYPOINT`), so compose `command: ["/usr/local/bin/migrate"]` replaces the API process.
- UI (`apps/web`) should call `http://api:8080` from the compose network, or `http://localhost:8080` from the host
