# Backend API map

## Foundation routes

| Route | Purpose | Success | Failure |
| --- | --- | --- | --- |
| `GET /api/v1/health` | Process liveness; no dependency check. | `200 {"status":"ok"}` | — |
| `GET /api/v1/readiness` | PostgreSQL dependency readiness. | `200 {"status":"ready"}` | `503` RFC 9457 Problem Details (`dependency-unavailable`) |
| `GET /api/v1/openapi.yaml` | Published OpenAPI YAML. | `200` | — |
| `GET /api/v1/openapi.json` | Published OpenAPI JSON. | `200` | — |
| `GET /api/v1/swagger` | Specification landing page. | `200` | — |

Every request receives `X-Request-ID`. A caller-supplied value is accepted only when it is 16–128 ASCII letters, digits, or hyphens; otherwise the API generates one. Errors use `application/problem+json` and include `type`, `title`, `status`, `detail`, `instance`, `code`, and `request_id`. Foundation responses also set restrictive content, referrer, and permissions policies.
