# Backend API map

## Foundation routes

| Route | Purpose | Success | Failure |
| --- | --- | --- | --- |
| `GET /api/v1/health` | Process liveness; no dependency check. | `200 {"status":"ok"}` | — |
| `GET /api/v1/readiness` | PostgreSQL dependency readiness. | `200 {"status":"ready"}` | `503` RFC 9457 Problem Details (`dependency-unavailable`) |
| `GET /api/v1/metrics` | Baseline Prometheus text metrics (request count and duration). | `200` `text/plain` | — |
| `GET /api/v1/openapi.yaml` | Published OpenAPI YAML. | `200` | — |
| `GET /api/v1/openapi.json` | Published OpenAPI JSON. | `200` | — |
| `GET /api/v1/swagger` | Specification landing page. | `200` | — |

## Browser sessions (E2.3)

Browser clients use cookie sessions. Non-browser callers (tests, hooks, Next.js server proxies that still inject headers) may keep `X-FlowForge-Issuer` / `X-FlowForge-Subject`. When `ff_session` is present, identity comes only from the session; conflicting identity headers fail closed (`403`). Header-only callers skip CSRF.

**UI route map (Chloe):** call the API origin with `credentials: "include"`. Do not store the session token or CSRF secret in `localStorage`. Read `csrf_token` from the JSON body (or the `ff_csrf` cookie) and send it as `X-CSRF-Token` on every state-changing request.

| Cookie | Flags | Purpose |
| --- | --- | --- |
| `ff_session` | `HttpOnly`, `SameSite=Lax`, `Secure` on HTTPS, `Path=/api/v1` | Opaque session id (server stores SHA-256 only) |
| `ff_csrf` | readable, `SameSite=Strict`, `Secure` on HTTPS, `Path=/api/v1` | Double-submit CSRF pair with `X-CSRF-Token` |

Idle default **30m**, absolute default **12h** (`SESSION_IDLE_TIMEOUT` / `SESSION_ABSOLUTE_TIMEOUT`). Refresh extends idle only; it cannot pass the absolute cap. Stale, revoked, or forged cookies are `401`.

CORS is an exact allowlist (`CORS_ALLOWED_ORIGINS`). Empty allowlist + foreign `Origin` is `403` with no `Access-Control-Allow-Origin`. Wildcard / `null` origins are rejected at process start. Same-origin and Origin-less callers are allowed. CSP remains `default-src 'none'` (plus `frame-ancestors` / `form-action` / `object-src` none).

| Route | Purpose | Success | Failure |
| --- | --- | --- | --- |
| `POST /api/v1/session` | Create session from JSON `{issuer,external_subject,display_name?}` and/or identity headers. Sets both cookies. | `201` `{session,principal,csrf_token}` | `401` `403` (hostile origin) |
| `GET /api/v1/session` | Current browser session. Cookie required; header-only is `401`. | `200` `{session,principal,csrf_token}` | `401` `403` |
| `POST /api/v1/session/refresh` | Extend idle expiry; rotate CSRF. Requires CSRF pair. | `200` `{session,principal,csrf_token}` | `401` `403` |
| `POST /api/v1/session/logout` | Revoke session and clear cookies. Requires CSRF when a session cookie is present. | `204` | `403` |
| `GET /api/v1/session/audit-events` | Caller's secret-free session audit events. | `200` `{items}` | `401` |

Session audit event types: `session.created`, `session.refreshed`, `session.revoked`, `session.expired`, `session.csrf_rejected`, `session.origin_rejected`, `session.privilege_denied`, `session.auth_rejected`. Logs and audit rows never include cookie or token values.

## Workspace identity and RBAC (E2.1)

Identity headers establish the subject for non-browser callers: `X-FlowForge-Issuer` and `X-FlowForge-Subject` (optional `X-FlowForge-Display-Name`). Browser clients should use E2.3 sessions instead. Headers do not authorize a workspace.

Workspace identity is resolved only from `X-FlowForge-Tenant-ID` or `X-FlowForge-Tenant-Slug` plus `X-FlowForge-Workbench-Key`. `X-FlowForge-Workspace-ID` is untrusted host context: it is rejected when it is the only identity, and forbidden when it does not match the server-derived workspace.

| Route | Purpose | Success | Failure |
| --- | --- | --- | --- |
| `GET /api/v1/permission-matrix` | Role/permission catalog covering view, edit, publish, execute, credential, approval, and administration. | `200` `{permissions,roles}` | `401` |
| `GET /api/v1/roles` | Persisted role vocabulary. | `200` `{items}` | `401` |
| `GET /api/v1/permissions` | Persisted permission vocabulary. | `200` `{items}` | `401` |
| `POST /api/v1/tenants` | Create a tenant. Any identified subject may bootstrap a tenant in this slice. | `201` tenant | `400` `401` `409` |
| `GET /api/v1/workspaces` | Workspaces the caller belongs to (server-side bindings). | `200` `{items}` | `401` |
| `POST /api/v1/workspaces` | Create a workspace unique on `(tenant_id, workbench_key)`; caller is bound as `admin`. Body `id` / `workspace_id` rejected. | `201` workspace | `400` `401` `404` `409` |
| `GET /api/v1/workspace` | Current workspace, roles, and permissions after membership check. | `200` | `400` `401` `403` `404` |
| `GET /api/v1/workspace/members` | List members. Requires `workspace.administer`. | `200` `{items}` | `401` `403` |
| `PUT /api/v1/workspace/members` | Replace a member's roles (`user_id` or issuer+subject). Requires `workspace.administer`. | `200` member | `400` `401` `403` `404` `409` |
| `DELETE /api/v1/workspace/members/{userID}` | Remove a member. Cannot remove the last administrator. | `204` | `401` `403` `404` `409` |

## Workspace isolation (E2.2)

After membership authorization, the API sets transaction-local `app.workspace_id` and queries workspace-owned tables under `FORCE ROW LEVEL SECURITY`. Host-supplied `id` / `workspace_id` on write bodies is rejected. A valid UUID from another workspace is `not-found` (not a leak). These routes are isolation hooks for surfaces that exist today; later credential/artifact/execution epics keep the same scope rules.

| Route | Purpose | Success | Failure |
| --- | --- | --- | --- |
| `GET /api/v1/workspace/records?kind=` | List scoped records. `kind` required. Permission depends on kind. | `200` `{items}` | `400` `401` `403` |
| `POST /api/v1/workspace/records` | Create a scoped record (`credential`, `artifact`, `job`, `cache`, `realtime`, `audit`). | `201` record | `400` `401` `403` |
| `GET /api/v1/workspace/records/{id}` | Get a scoped record. | `200` | `401` `403` `404` |
| `POST /api/v1/workspace/records/{id}/links` | Attach a child via composite `(workspace_id, parent_id)` FK. | `201` link | `400` `401` `403` `404` |
| `POST /api/v1/workspace/credentials/{id}/use` | Credential use. Requires `credential.use`. | `204` | `401` `403` `404` |
| `GET /api/v1/workspace/artifacts/{id}` | Artifact access. Requires `execution.view`. | `200` | `401` `403` `404` |
| `GET /api/v1/workspace/jobs` | List job hooks. Requires `execution.view`. | `200` `{items}` | `401` `403` |
| `POST /api/v1/workspace/jobs` | Enqueue a job hook. Requires `workflow.execute`. | `201` | `401` `403` |
| `GET /api/v1/workspace/cache/{key}` | Workspace-prefixed cache read. | `200` | `401` `403` `404` |
| `PUT /api/v1/workspace/cache/{key}` | Workspace-prefixed cache write. | `200` | `401` `403` |
| `POST /api/v1/workspace/realtime/channels/{id}/subscribe` | Realtime subscribe. Requires `workflow.view`. | `200` | `401` `403` `404` |
| `GET /api/v1/workspace/audit-events` | List audit hooks. Requires `workspace.administer`. | `200` `{items}` | `401` `403` |

Every request receives `X-Request-ID`. A caller-supplied value is accepted only when it is 16–128 ASCII letters, digits, or hyphens; otherwise the API generates one. The same identifier is present on the response header, in `application/problem+json` as `request_id`, and in structured request logs so an API flow can be traced end to end.

Errors use `application/problem+json` and include `type`, `title`, `status`, `detail`, `instance`, `code`, and `request_id`. Documented codes:

| Code | Status | When |
| --- | --- | --- |
| `invalid-request` | 400 | Malformed JSON, missing body, or unsupported `Content-Type` |
| `unauthenticated` | 401 | Missing or invalid credentials |
| `forbidden` | 403 | Authenticated caller is not authorized |
| `not-found` | 404 | Unknown path or missing tenant/workspace/user |
| `conflict` | 409 | Unique `(tenant_id, workbench_key)` / tenant slug collision, or last-admin protection |
| `method-not-allowed` | 405 | Known path, unsupported method |
| `request-too-large` | 413 | Body exceeds 1048576 bytes |
| `internal-error` | 500 | Unexpected failure |
| `dependency-unavailable` | 503 | PostgreSQL is not reachable |

Foundation responses also set restrictive content, referrer, and permissions policies. When the request is HTTPS (direct TLS or `X-Forwarded-Proto: https` from a CIDR in `TRUSTED_PROXY_CIDRS`), responses also set `Strict-Transport-Security`. If `REQUIRE_TLS` is true, plain HTTP is rejected as `invalid-request`, except `GET /api/v1/health` and `GET /api/v1/readiness` so Kubernetes HTTP probes can reach the pod without Ingress TLS. Structured logs are JSON and secret-free: they record method, path, route, status, duration, bytes, and `request_id`, and never record `Authorization`, cookies, query strings, or request bodies. Session audit logs add `event_type`, `outcome`, `reason`, `user_id`, and `session_id` only. Metrics labels are method, route, and status only.
