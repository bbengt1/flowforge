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

## Workspace identity and RBAC (E2.1)

Identity headers establish the subject until E2.3 browser sessions: `X-FlowForge-Issuer` and `X-FlowForge-Subject` (optional `X-FlowForge-Display-Name`). They do not authorize a workspace.

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

Foundation responses also set restrictive content, referrer, and permissions policies. When the request is HTTPS (direct TLS or `X-Forwarded-Proto: https` from a CIDR in `TRUSTED_PROXY_CIDRS`), responses also set `Strict-Transport-Security`. If `REQUIRE_TLS` is true, plain HTTP is rejected as `invalid-request`, except `GET /api/v1/health` and `GET /api/v1/readiness` so Kubernetes HTTP probes can reach the pod without Ingress TLS. Structured logs are JSON and secret-free: they record method, path, route, status, duration, bytes, and `request_id`, and never record `Authorization`, cookies, query strings, or request bodies. Metrics labels are method, route, and status only.
