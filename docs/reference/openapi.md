# API / OpenAPI publishing

Relates to #184 / Part of #181. **Keep #184 open.**

This is the operator guide for the published control-plane contract.
Authoritative route behavior stays in the [backend API map](backend-api-map.md).
Security and session rules stay in the [security model](security-model.md).

The UI does not re-host the specification. Home/shell links that point at
swagger/OpenAPI are **not** a product screen (ADV-020).
**Operator UI guide — Chloe / E12.3.**

## Where the specification lives

| Form | Location |
| --- | --- |
| Source of truth (embedded at build time) | [`apps/api/openapi/openapi.yaml`](../../apps/api/openapi/openapi.yaml) |
| Go embed | [`apps/api/openapi/fs.go`](../../apps/api/openapi/fs.go) (`//go:embed openapi.yaml`) |
| Runtime YAML | `GET /api/v1/openapi.yaml` |
| Runtime JSON | `GET /api/v1/openapi.json` (YAML unmarshaled in-process; not a second file) |
| Landing page | `GET /api/v1/swagger` (links to the two documents; not an interactive explorer) |

OpenAPI **3.0.3**. `info.version` is the document version (currently
`0.17.0` in the YAML). That is not the URL prefix.

There is no code-generated spec. When a route or problem code changes,
update `apps/api/openapi/openapi.yaml` in the same change as
`docs/reference/backend-api-map.md` and the Go handlers. Tests in
`apps/api/internal/httpapi` assert the published document includes
foundation paths (`/health`, `/readiness`, `/metrics`, OpenAPI, swagger).

## Versioning (`/api/v1`)

All control-plane HTTP routes are under `/api/v1`. The OpenAPI
`servers` entry is `url: /api/v1`, so paths in the document are
`/health`, `/session`, `/embed/exchange`, and so on.

There is no `/api/v2` and no unversioned alias. Kubernetes probes use
the versioned paths only:

- Liveness: `GET /api/v1/health` (process up; no dependency check)
- Readiness: `GET /api/v1/readiness` (PostgreSQL reachable)

There are no `/healthz` / `/readyz` aliases. See
[incident and recovery](../operations/incident-recovery.md).

## How operators obtain the published spec

Production identity is a cookie session from `POST /embed/exchange` (or
a future OIDC login). Metrics and OpenAPI/swagger require
`platform.administer` via `PLATFORM_ADMINS` (`issuer|subject`). Empty
allowlist is fail-closed (`403`). Workspace `admin` is not enough.
Unauthenticated is `401`. There is no anonymous scrape token and no
`ops.metrics.read` grant.

```bash
# Source tree (no auth)
sed -n '1,50p' apps/api/openapi/openapi.yaml

# Running API — platform-admin session (Bearer is the opaque ff_session token)
curl -fsS -H "Authorization: Bearer ${FF_SESSION}" \
  "${API_ORIGIN}/api/v1/openapi.yaml"

curl -fsS -H "Authorization: Bearer ${FF_SESSION}" \
  "${API_ORIGIN}/api/v1/openapi.json"

# Cookie form (browser / operator). Idle/absolute expiry still apply.
curl -fsS -b "ff_session=${FF_SESSION}" \
  "${API_ORIGIN}/api/v1/swagger"
```

Local compose may instead send `X-FlowForge-Issuer` /
`X-FlowForge-Subject` matching `PLATFORM_ADMINS` because
`TRUSTED_DEV_IDENTITY_HEADERS=1`. Do **not** enable that in production
(boot-fail when `APP_ENV` is empty/`production` or `REQUIRE_TLS=true`).
See [deployment](../deployment.md).

Prometheus scrape of `GET /api/v1/metrics` uses the same authz. Example
in [deployment](../deployment.md#metrics-and-openapi-scrape-adv-020).

## Auth and session (high level)

| Caller | How identity is established | Notes |
| --- | --- | --- |
| Browser / embed | `POST /embed/exchange` → `ff_session` + `ff_csrf` | Production path. Embed sessions use CHIPS (`SameSite=None; Secure; Partitioned`). Mutations need `X-CSRF-Token`. |
| Platform scraper | `Authorization: Bearer <ff_session>` | Preferred for Prometheus / OpenAPI fetch. Refresh before idle (`SESSION_IDLE_TIMEOUT`, default 30m) or absolute (`SESSION_ABSOLUTE_TIMEOUT`, default 12h) expiry. |
| Trusted-dev only | `X-FlowForge-Issuer` / `X-FlowForge-Subject` and `POST /session` | Local/compose only. Not authentication in production. |
| Kubernetes probes | none | `/health` and `/readiness` stay unauthenticated. |

Workspace identity is server-derived from `(tenant_id|tenant_slug,
workbench_key)`. A host-supplied workspace UUID is never the lookup key.

Embed-origin sessions cannot `POST /tenants` or `POST /workspaces`
(including when the principal is a platform-admin). Portal `admin`
never includes `platform.administer`.

Full rules: [security model](security-model.md) (Identity, sessions, and
authorization) and [backend API map](backend-api-map.md) (Foundation
routes + Browser sessions + Embed SDK).

## Conventions operators should expect

Documented in the YAML `info.description` and enforced by the API:

- Every response sets `X-Request-ID` (caller value accepted only when
  16–128 ASCII letters, digits, or hyphens). The same id is
  `request_id` on RFC 9457 problem documents and in structured logs.
- 4xx/5xx use `application/problem+json`. Problem details never echo
  bodies, credentials, or secret material.
- Request bodies are capped at 1 MiB (`request-too-large` / 413).
- CORS is an exact origin allowlist (`CORS_ALLOWED_ORIGINS`). Empty +
  foreign `Origin` fails closed. Wildcard is rejected at process start.

Route inventory and success/failure codes:
[backend API map](backend-api-map.md). Handler list:
[`apps/api/README.md`](../../apps/api/README.md).

## Chloe map

| Surface | This PR | Chloe / E12.3 |
| --- | --- | --- |
| Published YAML/JSON/swagger | Documented here | Do not add a metrics or swagger product screen |
| Home/shell OpenAPI links | Already fail `401`/`403` for non-platform-admins | **Operator UI guide — Chloe / E12.3** (how a platform-admin uses the existing links) |
| Accessibility of swagger HTML | Out of scope (landing page is links only) | **Accessibility review — Chloe / E12.3** |
