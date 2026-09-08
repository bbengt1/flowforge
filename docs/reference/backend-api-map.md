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

Every request receives `X-Request-ID`. A caller-supplied value is accepted only when it is 16–128 ASCII letters, digits, or hyphens; otherwise the API generates one. The same identifier is present on the response header, in `application/problem+json` as `request_id`, and in structured request logs so an API flow can be traced end to end.

Errors use `application/problem+json` and include `type`, `title`, `status`, `detail`, `instance`, `code`, and `request_id`. Documented codes:

| Code | Status | When |
| --- | --- | --- |
| `invalid-request` | 400 | Malformed JSON, missing body, or unsupported `Content-Type` |
| `unauthenticated` | 401 | Missing or invalid credentials |
| `forbidden` | 403 | Authenticated caller is not authorized |
| `not-found` | 404 | Unknown path |
| `method-not-allowed` | 405 | Known path, unsupported method |
| `request-too-large` | 413 | Body exceeds 1048576 bytes |
| `internal-error` | 500 | Unexpected failure |
| `dependency-unavailable` | 503 | PostgreSQL is not reachable |

Foundation responses also set restrictive content, referrer, and permissions policies. When the request is HTTPS (direct TLS or `X-Forwarded-Proto: https` from a CIDR in `TRUSTED_PROXY_CIDRS`), responses also set `Strict-Transport-Security`. If `REQUIRE_TLS` is true, plain HTTP is rejected as `invalid-request`. Structured logs are JSON and secret-free: they record method, path, route, status, duration, bytes, and `request_id`, and never record `Authorization`, cookies, query strings, or request bodies. Metrics labels are method, route, and status only.
