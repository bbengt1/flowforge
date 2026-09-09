# Embed SDK / contract (E11.1)

Versioned contract for mounting the canonical FlowForge UI in a host
application and exchanging a short-lived, asymmetric-signed, audience-bound,
single-use assertion.

Chloe owns the embed shell UI. This document is the route and field map.
Adapter: `apps/web/src/lib/embed-contract.ts`. Relates to #121 / Part of #120 —
**Keep #121 open**.

## SDK

| Field | Value |
| --- | --- |
| SDK | `embed.v1` |
| Algorithm | `EdDSA` (Ed25519) |
| Audience | `flowforge` |
| Default TTL | 60s (min 15s, max 5m) |
| Mount prefix | `/embed/v1` |

## Assertion claims

Compact JWS (`typ: JWT`). Required claims fail closed when missing.

| Claim | Required | Notes |
| --- | --- | --- |
| `iss` | yes | Host issuer (minting caller issuer by default) |
| `aud` | yes | Must be `flowforge` |
| `sub` | yes | End-user external subject |
| `nbf` | yes | Unix seconds |
| `exp` | yes | Unix seconds |
| `jti` | yes | Unique token id (UUID) |
| `tenant_id` | yes | Context; never authorization by itself |
| `workbench_key` | yes | With `tenant_id` is the workspace identity |
| `workspace_id` | no | Binding only. Must match server resolution. Never the lookup key |
| `capabilities` | yes | FlowForge permission keys; mint requires a subset of the caller |
| `sdk` | yes | `embed.v1` |
| `display_name` | no | Display context until the API verifies the subject |
| `host` | no | Minting caller issuer when minting for another subject |

## Host flow

1. Portal / host **backend** authenticates to FlowForge (`X-FlowForge-Issuer` /
   `X-FlowForge-Subject` or a service session) and sends tenant + workbench
   headers.
2. `POST /api/v1/embed/assertions` `{capabilities:[…]}` → compact JWS (once).
3. Host **frontend** POSTs `{assertion}` to `POST /api/v1/embed/exchange`
   (same-origin `/api/v1/embed/exchange` or `/api/control-plane/embed/exchange`).
   **Never** put the assertion in a URL, `localStorage`, or logs.
4. Response sets `ff_session` / `ff_csrf` and returns workspace + capabilities.
   Navigate to the embed mount (`/embed/v1/…`).
5. Subsequent API calls use the cookie session + `X-CSRF-Token` like standalone.

## Stable routes / deep links

Standalone hrefs remain valid. Embed is the same path under `/embed/v1`.
Next.js rewrites `/embed/v1/:path*` to `/:path*` so the canonical pages mount
without a UI rewrite.

| Standalone | Embed |
| --- | --- |
| `/` | `/embed/v1` |
| `/workflows` | `/embed/v1/workflows` |
| `/workflows/{id}` | `/embed/v1/workflows/{id}` |
| `/executions` | `/embed/v1/executions` |
| `/executions/{id}` | `/embed/v1/executions/{id}` |
| `/credentials` | `/embed/v1/credentials` |
| `/credentials/new` | `/embed/v1/credentials/new` |
| `/credentials/{id}` | `/embed/v1/credentials/{id}` |
| `/approvals` | `/embed/v1/approvals` |
| `/approvals/{id}` | `/embed/v1/approvals/{id}` |
| `/config` | `/embed/v1/config` |
| `/config/{kind}` | `/embed/v1/config/{kind}` |
| `/config/{kind}/new` | `/embed/v1/config/{kind}/new` |
| `/config/{kind}/{id}` | `/embed/v1/config/{kind}/{id}` |
| `/config/{kind}/{id}/versions/{versionId}` | `/embed/v1/config/{kind}/{id}/versions/{versionId}` |
| `/alerts` | `/embed/v1/alerts` |
| `/alerts/{id}` | `/embed/v1/alerts/{id}` |
| `/audit` | `/embed/v1/audit` |
| `/actions` | `/embed/v1/actions` |
| `/templates` | `/embed/v1/templates` |
| `/settings` | `/embed/v1/settings` |
| `/membership` | `/embed/v1/membership` |
| `/isolation` | `/embed/v1/isolation` |

Query and hash fragments are unchanged (`?tab=`, `#schedules`). Discovery:
`GET /api/v1/embed/catalog` `routes[]`.

## API

| Method | Path | Auth | CSRF | Notes |
| --- | --- | --- | --- | --- |
| `GET` | `/api/v1/embed/catalog` | none | no | Contract + route map |
| `GET` | `/api/v1/embed/jwks` | none | no | Public keys only |
| `POST` | `/api/v1/embed/assertions` | session or identity headers + membership | yes if `ff_session` | Mint |
| `POST` | `/api/v1/embed/exchange` | assertion | no | Session issue |

Mint JSON (camelCase): `{subject?,displayName?,issuer?,tenantId?,workbenchKey?,workspaceId?,capabilities,ttlSeconds?}`.

Exchange JSON: `{assertion, sdk?}`. `201` `{session,principal,csrf_token,assertion,workspace,tenant,capabilities}`. The nested `assertion` object is metadata only (no compact JWS).

Failures: missing claims `400`; wrong audience / expired / bad signature `401`; replayed `jti` `409`; missing signing key `503`. Problem details never echo the JWS or private keys.

## Key management

| Variable | Default | Purpose |
| --- | --- | --- |
| `EMBED_SIGNING_KEY` | ephemeral process key | Ed25519 seed (32 bytes) or private key (64 bytes) as base64/hex, or PKCS8 PEM |
| `EMBED_SIGNING_KEY_FILE` | empty | File form of the same material |
| `EMBED_SIGNING_KEY_ID` | `env:EMBED_SIGNING_KEY` or `ephemeral:process` | `kid` |
| `EMBED_AUDIENCE` | `flowforge` | Must stay `flowforge` |
| `EMBED_ASSERTION_TTL` | `60s` | Default mint TTL (clamped 15s–5m) |
| `EMBED_ISSUER` | empty | Reserved for operators; mint `iss` defaults to the caller issuer |
| `WEB_EMBED_FRAME_ANCESTORS` | empty | Space/comma exact origins allowed to frame `/embed/v1` only. `*` / `null` ignored. Standalone stays `frame-ancestors 'none'` |

Production must set a stable `EMBED_SIGNING_KEY`. Public JWKS never includes
`d`, PEM, or seed. Logs redact `assertion`, `token`, and `private_key`.

## E11.2 / E11.3 hooks (fail closed)

| Hook | E11.1 status | E11.2/E11.3 |
| --- | --- | --- |
| `jti.consume` | In-process `MemoryJTI` rejects replay in the same process | Atomic durable consume with TTL |
| `key.rotation` | Active key only; unknown `kid` fails closed | Active + explicit overlap verification keys |
| `tenancy.propagation` | Validates `(tenant_id, workbench_key)` and optional binding; session stays identity-only | Propagate through UI, API, jobs, workers, caches, realtime, history, audit |
| Portal adapter | Out of scope | E11.3 CP Ops Portal add-in |
