# FlowForge control-plane API

Go module `github.com/bbengt1/flowforge/apps/api` (Go **1.25**). Listens on **8080** and exposes the routes from `docs/reference/backend-api-map.md`.

## Routes

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/v1/health` | Liveness. Always `200 {"status":"ok"}`. Does not check PostgreSQL. |
| `GET` | `/api/v1/readiness` | `200 {"status":"ready"}` when PostgreSQL is reachable; otherwise `503` RFC 9457 (`dependency-unavailable`). |
| `GET` | `/api/v1/metrics` | Prometheus 0.0.4 text: request counts and duration histograms (method/route/status labels only). |
| `GET` | `/api/v1/openapi.yaml` | Published OpenAPI YAML. |
| `GET` | `/api/v1/openapi.json` | Published OpenAPI JSON. |
| `GET` | `/api/v1/swagger` | Specification landing page. |
| `GET` | `/api/v1/permission-matrix` | Role/permission catalog (view, edit, publish, execute, credential, approval, administration). |
| `GET` | `/api/v1/roles` | Role vocabulary. |
| `GET` | `/api/v1/permissions` | Permission vocabulary. |
| `POST` | `/api/v1/tenants` | Create tenant. |
| `GET` | `/api/v1/workspaces` | Workspaces the caller belongs to. |
| `POST` | `/api/v1/workspaces` | Create workspace unique on `(tenant_id, workbench_key)`; creator becomes `admin`. |
| `GET` | `/api/v1/workspace` | Server-derived current workspace + roles + permissions. |
| `GET` | `/api/v1/workspace/members` | List members (`workspace.administer`). |
| `PUT` | `/api/v1/workspace/members` | Bind member roles (`workspace.administer`). |
| `DELETE` | `/api/v1/workspace/members/{userID}` | Remove member; last admin is protected. |
| `GET` | `/api/v1/workspace/records` | List FORCE-RLS records (`kind` required). |
| `POST` | `/api/v1/workspace/records` | Create a scoped record. Body `id` / `workspace_id` rejected. |
| `GET` | `/api/v1/workspace/records/{id}` | Get a scoped record; other-workspace UUIDs are 404. |
| `POST` | `/api/v1/workspace/records/{id}/links` | Composite `(workspace_id, parent_id)` attach. |
| `POST` | `/api/v1/workspace/credentials/{id}/use` | Credential use (`credential.use`). |
| `GET` | `/api/v1/workspace/artifacts/{id}` | Artifact access (`execution.view`). |
| `GET` / `POST` | `/api/v1/workspace/jobs` | Job hooks (`execution.view` / `workflow.execute`). |
| `GET` / `PUT` | `/api/v1/workspace/cache/{key}` | Workspace-prefixed cache. |
| `POST` | `/api/v1/workspace/realtime/channels/{id}/subscribe` | Realtime subscribe. |
| `GET` | `/api/v1/workspace/audit-events` | Audit hooks (`workspace.administer`). |

Subject identity (until E2.3 sessions) uses `X-FlowForge-Issuer` and `X-FlowForge-Subject`. Workspace identity is resolved from tenant + `X-FlowForge-Workbench-Key`. A host-supplied `X-FlowForge-Workspace-ID` is never the lookup key. After authorization, workspace-owned queries set transaction-local `app.workspace_id`; pooled connections reset leftover session scope on checkout.

Every response sets `X-Request-ID`. A caller value is accepted only when it is 16–128 ASCII letters, digits, or hyphens; otherwise the API generates one. The same id is echoed on the header, in problem documents as `request_id`, and in JSON request logs.

Errors use `application/problem+json` with `type`, `title`, `status`, `detail`, `instance`, `code`, and `request_id`. Documented codes: `invalid-request` (400), `unauthenticated` (401), `forbidden` (403), `not-found` (404), `conflict` (409), `method-not-allowed` (405), `request-too-large` (413), `internal-error` (500), `dependency-unavailable` (503). Request bodies are capped at 1 MiB. Logs never include `Authorization`, cookies, query strings, or bodies.

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
| `TRUSTED_PROXY_CIDRS` | empty | CIDRs allowed to set `X-Forwarded-Proto`. Empty ignores forwarded headers. |
| `REQUIRE_TLS` | `false` | When `true`, reject non-HTTPS (direct TLS or trusted-proxy proto). Probe paths `/api/v1/health` and `/api/v1/readiness` stay reachable over plain HTTP for kubelet. |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | empty | Optional process TLS. Both must be set or neither. |

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
- Image user: UID/GID `65532` (non-root). Compose and `deploy/k8s` also set a read-only root filesystem, `cap_drop: ALL`, `no-new-privileges`, and CPU/memory/PID limits.
- Same image can run migrations as a one-shot. The image uses `CMD` (not `ENTRYPOINT`), so compose `command: ["/usr/local/bin/migrate"]` replaces the API process.
- UI (`apps/web`) should call `http://api:8080` from the compose network, or `http://localhost:8080` from the host
- Kubernetes / TLS / supply-chain foundation: [`deploy/`](../../deploy/)
