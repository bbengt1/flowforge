# FlowForge control-plane API

Go module `github.com/bbengt1/flowforge/apps/api` (Go **1.26**). Listens on **8080** and exposes the routes from `docs/reference/backend-api-map.md`.

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
| `POST` | `/api/v1/tenants` | Create tenant (`platform.administer` / `PLATFORM_ADMINS` on a non-embed session). Embed sessions are `403`. |
| `GET` | `/api/v1/workspaces` | Workspaces the caller belongs to. |
| `POST` | `/api/v1/workspaces` | Create workspace unique on `(tenant_id, workbench_key)`; creator becomes `admin`. Requires `platform.administer` on a non-embed session. Embed sessions are `403`. |
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
| `POST` | `/api/v1/session` | Trusted-dev only: create browser session from self-asserted issuer/subject. Production is `401` (use `POST /embed/exchange`). |
| `GET` | `/api/v1/session` | Current browser session (cookie required). |
| `POST` | `/api/v1/session/refresh` | Extend idle expiry; rotate CSRF. |
| `POST` | `/api/v1/session/logout` | Revoke session; clear cookies. |
| `GET` | `/api/v1/session/audit-events` | Caller's secret-free session audit events. |
| `GET` | `/api/v1/embed/catalog` | Versioned embed SDK/contract. |
| `GET` | `/api/v1/embed/jwks` | Public embed keys (active + overlap). |
| `POST` | `/api/v1/embed/assertions` | Mint a short-lived embed assertion. Subject/issuer bind to the caller unless `embed.impersonate` (`PLATFORM_ADMINS`). |
| `POST` | `/api/v1/embed/exchange` | Exchange assertion for a tenancy-bound `ff_session`. |
| `POST` | `/api/v1/embed/keys/rotate` | Register the previous active public JWK as overlap, or retire it (`platform.administer` / `PLATFORM_ADMINS`). |
| `GET` | `/api/v1/portal/adapter` | CP Ops Portal adapter contract, capability map, host wiring. |
| `POST` | `/api/v1/portal/adapter/assertions` | Portal-backend mint (maps roles, then E11.1 `embed.Mint`). Subject binds to the caller unless `embed.impersonate`. |
| `GET` | `/api/v1/workflows/catalog` | Core node/trigger catalog (`workflow.view`). E3.3 adds `rules` and full contracts (ports/classification/bounds/policy/redaction/`allowedWith`) for condition, delay, data set/map/validate, and flow stop/fail. |
| `POST` | `/api/v1/workflows/validate` | Ephemeral YAML validation (`workflow.edit`). |
| `POST` | `/api/v1/workflows/normalize` | Normalize YAML + digest (`workflow.edit`). |
| `GET` / `POST` | `/api/v1/workflows` | List / create workflow + draft (`workflow.view` / `workflow.edit`). |
| `GET` | `/api/v1/workflows/{workflowId}` | Workflow summary. |
| `GET` / `PUT` | `/api/v1/workflows/{workflowId}/draft` | Read or conflict-safe save (`If-Match` or JSON `revision`). |
| `POST` | `/api/v1/workflows/{workflowId}/publish` | Immutable version (`workflow.publish`). |
| `POST` | `/api/v1/workflows/{workflowId}/compare` | Draft/version structured diff. |
| `GET` | `/api/v1/workflows/{workflowId}/versions` | Version history. |
| `GET` | `/api/v1/workflows/{workflowId}/versions/{versionId}` | Frozen snapshot. |
| `GET` | `/api/v1/workflows/{workflowId}/versions/{versionId}/export` | Immutable YAML export. |
| `POST` | `/api/v1/workflows/{workflowId}/versions/{versionId}/restore` | Restore as a new draft revision. |
| `POST` / `GET` | `/api/v1/workflows/{workflowId}/executions` | Durable start pins version/digest; drafts cannot run. Optional idempotency key. |
| `GET` | `/api/v1/workflows/{workflowId}/executions/{executionId}` | Execution detail (redacted steps/jobs/audit). |
| `GET` | `/api/v1/executions` | Workspace execution history. |
| `GET` | `/api/v1/executions/{executionId}` | Execution detail by id. |
| `GET` | `/api/v1/executions/{executionId}/steps` | Redacted steps. |
| `GET` | `/api/v1/executions/{executionId}/jobs` | Dispatch jobs. |
| `GET` | `/api/v1/executions/{executionId}/audit-events` | Execution audit events. |
| `POST` | `/api/v1/executions/{executionId}/cancel` | Cancel open work (`execution.cancel`, idempotent). |
| `POST` | `/api/v1/executions/{executionId}/retry` | Retry latest eligible failed/canceled step. |
| `POST` | `/api/v1/executions/{executionId}/steps/{stepId}/retry` | Retry one step (`workflow.execute`). |
| `POST` | `/api/v1/jobs/claim` | Worker claim + authenticated job ticket. |
| `POST` | `/api/v1/jobs/recover` | Expired leases → `indeterminate`. |
| `POST` | `/api/v1/jobs/{jobId}/heartbeat` | Extend lease / mark running. |
| `POST` | `/api/v1/jobs/{jobId}/release` | Requeue or fail closed. |
| `POST` | `/api/v1/jobs/{jobId}/complete` | Succeed with fencing. |
| `POST` | `/api/v1/jobs/{jobId}/fail` | Fail with fencing. |
| `GET` | `/api/v1/audit-events` | Workspace audit events (redacted). |
| `GET` | `/api/v1/alerts` | Operational alerts (`alert.view`). Query `kind`, `status`, `resourceType`, `resourceId`, `limit`. Identifiers only. |
| `GET` | `/api/v1/alerts/{alertId}` | One operational alert. |
| `POST` | `/api/v1/alerts/{alertId}/ack` | Acknowledge (`alert.ack`, operator/admin, idempotent). |
| `GET` | `/api/v1/credentials/catalog` | Typed vault field catalog (`credential.view`). |
| `GET` / `POST` | `/api/v1/credentials` | List metadata / create encrypted credential. |
| `GET` / `PATCH` / `DELETE` | `/api/v1/credentials/{credentialId}` | Metadata, safe patch, confirmed delete. |
| `POST` | `/api/v1/credentials/{credentialId}/rotate` | Replace encrypted payload. |
| `POST` | `/api/v1/credentials/{credentialId}/disable` | Disable. |
| `POST` | `/api/v1/credentials/{credentialId}/enable` | Re-enable. |
| `POST` | `/api/v1/credentials/{credentialId}/test` | Redacted shape test. |
| `POST` | `/api/v1/credentials/{credentialId}/use` | Record use (`204`, no secret). |
| `GET` | `/api/v1/credentials/{credentialId}/usage` | Usage visibility. |
| `GET` | `/api/v1/credentials/{credentialId}/deletion-impact` | Deletion impact. |
| `GET` | `/api/v1/credentials/{credentialId}/events` | Redacted vault audit. |
| `GET` | `/api/v1/ops-config/catalog` | Ops-config kinds, YAML field map, engine catalogs including `httpNotificationEngine` (`opsconfig.view`). |
| `GET` | `/api/v1/http/catalog` | HTTP/notification node contracts, SSRF/redirect/TLS rules, and integration gate (`opsconfig.view`). |
| `GET` | `/api/v1/kubernetes/catalog` | Kubernetes allowlists, evaluation keys, SA templates, and E7.2 apply/get/list node contracts (`opsconfig.view`). |
| `POST` | `/api/v1/ops-config/select` | Batch server-authorized pins. |
| `GET` / `POST` | `/api/v1/{collection}` | List / create draft for `cluster-targets`, `ssh-targets`, `command-profiles`, `runtime-profiles`, `connections`, `recipient-lists`, `message-templates`, `response-schemas`, `policies`. |
| `GET` / `PUT` | `/api/v1/{collection}/{resourceId}/draft` | Read or conflict-safe save. |
| `POST` | `/api/v1/{collection}/{resourceId}/publish` | Immutable revision (`opsconfig.publish`). |
| `GET` | `/api/v1/{collection}/{resourceId}/versions` | Version history. |
| `POST` | `/api/v1/{collection}/{resourceId}/select` | Pin a published revision. |
| `GET` | `/api/v1/workflows/{workflowId}/versions/{versionId}/pins` | Pins bound at workflow publish. |

Subject identity uses a browser session cookie (`ff_session`) or, for non-browser callers, `X-FlowForge-Issuer` and `X-FlowForge-Subject`. A present session cookie wins; conflicting identity headers fail closed. State-changing cookie requests require `X-CSRF-Token` matching `ff_csrf`. Workspace identity is resolved from tenant + `X-FlowForge-Workbench-Key`. A host-supplied `X-FlowForge-Workspace-ID` is never the lookup key. After authorization, workspace-owned queries set transaction-local `app.workspace_id`; pooled connections reset leftover session scope on checkout.

Every response sets `X-Request-ID`. A caller value is accepted only when it is 16–128 ASCII letters, digits, or hyphens; otherwise the API generates one. The same id is echoed on the header, in problem documents as `request_id`, and in JSON request logs.

Errors use `application/problem+json` with `type`, `title`, `status`, `detail`, `instance`, `code`, and `request_id`. Documented codes: `invalid-request` (400), `invalid-workflow` (400, with `errors` path/line/column/code/message), `unauthenticated` (401), `forbidden` (403), `not-found` (404), `conflict` (409), `method-not-allowed` (405), `request-too-large` (413), `internal-error` (500), `dependency-unavailable` (503). Request bodies are capped at 1 MiB. Logs never include `Authorization`, cookies, query strings, or bodies.

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
| `CORS_ALLOWED_ORIGINS` | empty | Comma-separated exact origins (e.g. `http://localhost:3000`). Empty is fail-closed for foreign `Origin`. `*` and `null` are rejected. |
| `SESSION_IDLE_TIMEOUT` | `30m` | Browser session idle lifetime. Refresh extends this up to the absolute cap. |
| `SESSION_ABSOLUTE_TIMEOUT` | `12h` | Hard session lifetime. |
| `CREDENTIAL_KEK` | empty | 32-byte AES-256 vault KEK (base64 or 64 hex). Required for create/rotate/test/use. |
| `CREDENTIAL_KEK_FILE` | empty | Optional file whose contents are parsed like `CREDENTIAL_KEK` (or raw 32 bytes). |
| `CREDENTIAL_KEK_ID` | `env:CREDENTIAL_KEK` | Stored `keyReference` for the active KEK. |
| `JOB_BINDING_SECRET` | ephemeral | 32-byte HMAC key (base64 or 64 hex) for worker job tickets. Unset generates a process-local key (tickets die on restart). |
| `SCRIPT_SIGNING_KEY` | ephemeral | 32-byte HMAC key (base64 or 64 hex) for script artifact signatures (E9.1). Domain-separated with SHA-3. Unset generates a process-local key (signatures die on restart). |
| `ARTIFACT_STORE_DIR` | empty | Filesystem root for encrypted artifact payloads (`{dir}/{workspaceID}/{storageRef}`). Empty uses in-process memory. Compose/k8s API containers are read-only — use `/tmp/flowforge-artifacts`. |
| `ARTIFACT_DOWNLOAD_TTL` | `60s` | Lifetime of a download grant (max 5m). |
| `ARTIFACT_MAX_BYTES` | `1048576` | Upload cap for `file` artifacts. Logs cap at 256KiB; step output at 16KiB. |
| `EMBED_SIGNING_KEY` | **required in production** (boot-fail) | Durable Ed25519 seed/key (base64, hex, or PKCS8 PEM) for embed assertions (E11.1). Empty/`production` `APP_ENV` or `REQUIRE_TLS` refuses to start without it. Compose seeds a local-only key. Non-prod ephemeral keys use `crypto/rand` (no committed seed). Never returned from an API. |
| `EMBED_SIGNING_KEY_FILE` | empty | File form of `EMBED_SIGNING_KEY`. |
| `EMBED_SIGNING_KEY_ID` | `env:EMBED_SIGNING_KEY` | Public `kid`. |
| `EMBED_AUDIENCE` | `flowforge` | Must stay `flowforge`. |
| `EMBED_ASSERTION_TTL` | `60s` | Default mint TTL (15s–5m). |
| `EMBED_OVERLAP_KEYS` | empty | JSON JWKS / array of previous public keys for the overlap window. Each key requires `overlapUntil` (RFC3339, max 4h). Missing/too-long is boot-fail. The active signing key is not an overlap key. |
| `EMBED_ISSUER` / `EMBED_ISSUER_ALLOWLIST` | empty | Required allowed assertion `iss` for embed mint. Empty fails closed (`403`). |
| `PORTAL_ISSUER` / `PORTAL_ISSUER_ALLOWLIST` | empty | Required Portal mint issuer allowlist. Empty fails closed (`403`). Merged into embed exchange verification. |
| `PORTAL_FRAME_ANCESTORS` | empty | Shared host allowlist (merged with `WEB_PORTAL_FRAME_ANCESTORS` and `WEB_EMBED_FRAME_ANCESTORS`). Published on `GET /api/v1/embed/catalog` and `GET /api/v1/portal/adapter` as `frameAncestors`. Empty fails closed. |

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
      CORS_ALLOWED_ORIGINS: ${CORS_ALLOWED_ORIGINS:-http://localhost:3000}
      SESSION_IDLE_TIMEOUT: ${SESSION_IDLE_TIMEOUT:-30m}
      SESSION_ABSOLUTE_TIMEOUT: ${SESSION_ABSOLUTE_TIMEOUT:-12h}
      CREDENTIAL_KEK: ${CREDENTIAL_KEK:-}
      ARTIFACT_STORE_DIR: /tmp/flowforge-artifacts
      ARTIFACT_DOWNLOAD_TTL: ${ARTIFACT_DOWNLOAD_TTL:-60s}
      ARTIFACT_MAX_BYTES: ${ARTIFACT_MAX_BYTES:-1048576}
      EMBED_SIGNING_KEY: ${EMBED_SIGNING_KEY:-Zmxvd2ZvcmdlLWVtYmVkLWxvY2FsLWRldi1rZXkhISE=}
      EMBED_SIGNING_KEY_ID: ${EMBED_SIGNING_KEY_ID:-local:compose}
      APP_ENV: ${APP_ENV:-development}
      TRUSTED_DEV_IDENTITY_HEADERS: ${TRUSTED_DEV_IDENTITY_HEADERS:-1}
      PLATFORM_ADMINS: ${PLATFORM_ADMINS:-https://idp.example|admin-1}
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
