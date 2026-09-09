# Embed SDK / contract (E11.1 + E11.2)

Versioned contract for mounting the canonical FlowForge UI in a host
application and exchanging a short-lived, asymmetric-signed, audience-bound,
single-use assertion. E11.2 completes independent validation, durable one-time
`jti` consumption, active/overlap key rotation, and `(tenant_id, workbench_key)`
propagation.

Chloe owns the embed shell UI. This document is the route and field map.
Adapter: `apps/web/src/lib/embed-contract.ts`. E11.2 UI adapter:
`apps/web/src/lib/embed-tenancy-contract.ts`. Relates to #122 / Part of #120 —
**Keep #122 open**. Relates to #121 for the shell.

E11.3 CP Ops Portal adapter (Relates to #123 / **Keep #123 open**):
[portal adapter](portal-adapter.md). Portal backends mint through this
SDK after Portal RBAC — they do not share FlowForge’s database or executor.

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
| `iss` | yes | Host issuer. Optional `EMBED_ISSUER` / `EMBED_ISSUER_ALLOWLIST` fail closed |
| `aud` | yes | Must be `flowforge` |
| `sub` | yes | End-user external subject |
| `nbf` | yes | Unix seconds. Not-yet-valid fails closed |
| `exp` | yes | Unix seconds |
| `jti` | yes | Unique token id (UUID). Atomic one-time consume with TTL; replay is `409` |
| `tenant_id` | yes | Context; never authorization by itself. Bound onto the session |
| `workbench_key` | yes | With `tenant_id` is the workspace identity. Bound onto the session |
| `workspace_id` | no | Binding only. Must match server resolution. Never the lookup key |
| `capabilities` | yes | FlowForge workspace permission keys; mint requires a subset of the caller. Caps the embed session. `platform.administer` is never mintable |
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
   The session record stores `(tenant_id, workbench_key, workspace_id, capabilities)`
   as `session.embed`. That bind is the only workspace the session may use.
   The session **cannot** `POST /tenants` or `POST /workspaces` (sibling
   workbenches included), even if the principal is a platform-admin.
   Navigate to the embed mount (`/embed/v1/…`).
5. Subsequent API calls use the cookie session + `X-CSRF-Token` like standalone.
   The UI **must** send `X-FlowForge-Tenant-ID` + `X-FlowForge-Workbench-Key`
   from the **exchanged** workspace / `session.embed`, never from host query.
   A disagreeing host tenant/workbench is `403`. Host tenant is never
   authorization.

E11.3 CP Ops Portal host (`/portal/workflows`) follows this flow: map
roles from `GET /api/v1/portal/adapter`, mint via
`POST /api/v1/portal/adapter/assertions` `{portalRoles}`, iframe-mount
`/embed/v1` with display-only tenant/workbench query, then `postMessage`
the assertion so the embed shell can `POST /api/v1/embed/exchange`.
Portal entry RBAC is not FlowForge authorization. See
[portal-adapter.md](portal-adapter.md).

## How the UI must honor workbench/tenant (Chloe)

| Rule | Behavior |
| --- | --- |
| Persist from exchange | After `201`, keep `workspace.tenant_id` + `workspace.workbench_key` (or `session.embed`) in tab `sessionStorage`. Drop host query `tenant` / `workbench` as authority. |
| Send both headers | Every later `/api/v1` / `/api/control-plane` call sends tenant id (or slug) **and** workbench key matching the bound session. |
| Host is display only | Deep-link `tenant`, `workbench`, `host`, `displayName` stay unverified chrome until exchange. They never authorize. |
| Mismatch fails closed | If the host later supplies a different tenant or workbench, the API returns `403`. Do not retry with the host value. |
| Capabilities cap | `session.embed.capabilities` is the minted set. Membership cannot escalate past it. Hide UI actions the session cannot perform. `platform.administer` is never in this set. |
| No bootstrap | Do not offer create-tenant / create-workspace from embed chrome. Those routes return `403` for embed sessions. Standalone platform-admin bootstrap is unchanged. |
| GET `/session` | When `session.embed` is present, treat it as the source of truth over host route state. |
| Configuration / jobs / history | Lookups, job tickets, caches, realtime, history, and audit are scoped by the server-derived workspace that matches that pair. Do not send `X-FlowForge-Workspace-ID` as the lookup key. |

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
| `GET` | `/api/v1/embed/jwks` | none | no | Public keys only (active + overlap) |
| `POST` | `/api/v1/embed/assertions` | session or identity headers + membership | yes if `ff_session` | Mint with the **active** key |
| `POST` | `/api/v1/embed/exchange` | assertion | no | Validate + atomic `jti` consume + bind tenancy onto `ff_session`. Bound sessions cannot create tenants or workspaces. |
| `POST` | `/api/v1/embed/keys/rotate` | session or identity headers + `platform.administer` (`PLATFORM_ADMINS`) | yes if `ff_session` | Register the previous active public JWK as overlap, or retire it. `workspace.administer` is `403`. |

Mint JSON (camelCase): `{subject?,displayName?,issuer?,tenantId?,workbenchKey?,workspaceId?,capabilities,ttlSeconds?}`.

Exchange JSON: `{assertion, sdk?}`. `201` `{session,principal,csrf_token,assertion,workspace,tenant,capabilities}`. `session.embed` is `{tenantId,workbenchKey,workspaceId,capabilities}`. The nested `assertion` object is metadata only (no compact JWS).

Rotate JSON: `{action:"register-overlap"|"retire", publicJwk:{kty,crv,x,kid,use,alg}, overlapUntil?, kid?}`. `publicJwk` on `register-overlap` must be the current active signing key (`kid` + `x`). Arbitrary keys are `400`. Response is the public JWKS. Never send or receive `d` / PEM / seed.

Failures: missing claims `400`; wrong audience / expired / nbf / bad signature / unknown kid `401`; tenancy mismatch `403`; replayed `jti` `409`; missing signing key or JTI store `503`. Problem details never echo the JWS or private keys.

## Key rotation (ops)

Mint always uses the process **active** key (`EMBED_SIGNING_KEY` / `EMBED_SIGNING_KEY_ID`). Verify accepts the active key and any **explicit overlap** public key. Unknown `kid` fails closed.

### Recommended rotate procedure

1. Generate a new Ed25519 seed. Keep the current public JWK (`GET /embed/jwks` active key).
2. As a **platform-admin** (`PLATFORM_ADMINS=issuer|subject`), `POST /api/v1/embed/keys/rotate` `{action:"register-overlap", publicJwk:<current public JWK from GET /embed/jwks>, overlapUntil:<now+max TTL>}` **or** set `EMBED_OVERLAP_KEYS` to a JWKS of the current public key before restart. Workspace admins cannot call this route.
3. Deploy `EMBED_SIGNING_KEY` + `EMBED_SIGNING_KEY_ID` for the new key. Restart API pods.
4. JWKS now lists `status=active` (new) and `status=overlap` (old). In-flight assertions (≤5m) still verify.
5. After the overlap window, `POST /embed/keys/rotate` `{action:"retire", kid:<old>}` and/or remove the old key from `EMBED_OVERLAP_KEYS`.

`EMBED_OVERLAP_KEYS` accepts `{"keys":[…]}` or a bare JWK array. Only public OKP/Ed25519/EdDSA keys. Private `d` is ignored and never stored.

## Key management

| Variable | Default | Purpose |
| --- | --- | --- |
| `EMBED_SIGNING_KEY` | ephemeral process key | Ed25519 seed (32 bytes) or private key (64 bytes) as base64/hex, or PKCS8 PEM |
| `EMBED_SIGNING_KEY_FILE` | empty | File form of the same material |
| `EMBED_SIGNING_KEY_ID` | `env:EMBED_SIGNING_KEY` or `ephemeral:process` | Active `kid` |
| `EMBED_OVERLAP_KEYS` | empty | JSON JWKS / array of previous public keys for the overlap window |
| `PLATFORM_ADMINS` / `PLATFORM_ADMIN` | empty | Comma-separated `issuer\|subject` pairs allowed to rotate embed overlap keys **and** create tenants/workspaces. Empty is fail-closed (`403`). |
| `EMBED_AUDIENCE` | `flowforge` | Must stay `flowforge` |
| `EMBED_ASSERTION_TTL` | `60s` | Default mint TTL (clamped 15s–5m) |
| `EMBED_ISSUER` | empty | Optional single allowed `iss` |
| `EMBED_ISSUER_ALLOWLIST` | empty | Comma-separated allowed `iss`. Empty accepts any `ValidIssuer` |
| `WEB_EMBED_FRAME_ANCESTORS` | empty | Space/comma exact origins allowed to frame `/embed/v1` only. `*` / `null` ignored. Standalone stays `frame-ancestors 'none'` |
| `PORTAL_ISSUER` / `PORTAL_ISSUER_ALLOWLIST` | empty | E11.3 Portal mint issuer allowlist. Merged into embed exchange verification |
| `PORTAL_FRAME_ANCESTORS` | empty | Exact Portal origins published on `GET /api/v1/portal/adapter` |
| `WEB_PORTAL_FRAME_ANCESTORS` | empty | Exact Portal origins merged into `/embed/v1` `frame-ancestors` |

Production must set a stable `EMBED_SIGNING_KEY`. Public JWKS never includes
`d`, PEM, or seed. Logs redact `assertion`, `token`, and `private_key`. Audit
events record `jti`, `kid`, `issuer`, `subject`, `tenant_id`, `workbench_key`,
and `workspace_id` only.

## Completed E11.2 hooks

| Hook | Status | Fail closed |
| --- | --- | --- |
| `jti.consume` | ready | Atomic Postgres `INSERT … ON CONFLICT DO NOTHING` with TTL. Replay `409`. Store down `503`. |
| `key.rotation` | ready | Active + overlap verification. Unknown `kid` `401`. Rotate API is platform-admin only and accepts only the previous active public key. |
| `tenancy.propagation` | ready | Embed session binds `(tenant_id, workbench_key)` through API authz, configuration lookups, jobs/workers, caches, realtime, history, and audit. Host tenant is never authorization. Embed sessions cannot bootstrap tenants or sibling workbenches (`403`). Chloe chrome + deep links honor `session.embed` / exchanged workspace only. **No embed UI change required** — Membership create actions are standalone / platform-admin only. |
| Portal adapter | ready | CP Ops Portal add-in. Portal RBAC is entry only. Mint uses this SDK (`aud=flowforge`). FlowForge never shares its database or executor. Host wiring: [portal adapter](portal-adapter.md). Chloe host: `/portal/workflows`. |
