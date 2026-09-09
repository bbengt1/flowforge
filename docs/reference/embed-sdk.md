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
| `iss` | yes | Host issuer (always the authenticated minting caller). Client-supplied issuer that differs is `403`. Must be on `EMBED_ISSUER` / `EMBED_ISSUER_ALLOWLIST` (merged with Portal issuers on exchange). Empty allowlist fails closed (`403`) |
| `aud` | yes | Must be `flowforge` |
| `sub` | yes | End-user external subject. Bound to the minting caller unless `embed.impersonate` (`PLATFORM_ADMINS`) |
| `nbf` | yes | Unix seconds. Not-yet-valid fails closed |
| `exp` | yes | Unix seconds |
| `jti` | yes | Unique token id (UUID). Atomic single-statement consume (`INSERT … ON CONFLICT DO NOTHING RETURNING`). Used ids are retained **24h past assertion `exp`**; replay is `409` |
| `tenant_id` | yes | Context; never authorization by itself. Bound onto the session |
| `workbench_key` | yes | With `tenant_id` is the workspace identity. Bound onto the session |
| `workspace_id` | no | Binding only. Must match server resolution. Never the lookup key |
| `capabilities` | yes | FlowForge workspace permission keys; mint requires a subset of the caller. Caps the embed session. `platform.administer` and `embed.impersonate` are never mintable |
| `sdk` | yes | `embed.v1` |
| `display_name` | no | Display context until the API verifies the subject |
| `host` | no | Minting caller issuer. Set when minting for another subject (`embed.impersonate`) |

## Host flow

1. Portal / host **backend** authenticates to FlowForge (`X-FlowForge-Issuer` /
   `X-FlowForge-Subject` or a service session) and sends tenant + workbench
   headers.
2. `POST /api/v1/embed/assertions` `{capabilities:[…]}` → compact JWS (once).
3. Host **frontend** POSTs `{assertion}` to `POST /api/v1/embed/exchange`
   (same-origin `/api/v1/embed/exchange` or `/api/control-plane/embed/exchange`).
   **Never** put the assertion in a URL, `localStorage`, or logs.
4. Response sets `ff_session` / `ff_csrf` and returns workspace + capabilities.
   Those cookies are **CHIPS**: `SameSite=None; Secure; Partitioned`. That is
   the only SameSite change for embed — top-level `POST /session` stays
   `Lax` / `Strict` and is not Partitioned. `Secure` is never dropped;
   `SameSite=None` is never used without `Partitioned`. The session record
   stores `(tenant_id, workbench_key, workspace_id, capabilities)` as
   `session.embed`. That bind is the only workspace the session may use.
   The session **cannot** `POST /tenants` or `POST /workspaces` (sibling
   workbenches included), even if the principal is a platform-admin.
   Navigate to the embed mount (`/embed/v1/…`).
5. Subsequent API calls use the cookie session + `X-CSRF-Token` like standalone.
   Fetch must use `credentials: "include"` (already the same-origin proxy
   default). The UI **must** send `X-FlowForge-Tenant-ID` + `X-FlowForge-Workbench-Key`
   from the **exchanged** workspace / `session.embed`, never from host query.
   A disagreeing host tenant/workbench is `403`. Host tenant is never
   authorization. If the partitioned cookie is not stored or not sent
   (HTTP, no Partitioned support, blocked third-party storage), later
   calls are `401` or CSRF `403` — do not weaken SameSite as a workaround.

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
| CHIPS cookies | After exchange, `ff_session` / `ff_csrf` are `SameSite=None; Secure; Partitioned`. Keep `credentials: "include"`. The Next rewrite must preserve `Partitioned` and must not drop `Secure` on that pair. Storage Access API is not required and must not request unpartitioned cookies. |
| Cookie not sent | Missing partitioned cookie → `401` on `GET /session` and later reads; missing `ff_csrf` on a mutation → `403`. Treat as HTTPS / browser Partitioned / frame-ancestor misconfig. Manual two-host iframe check is ADV-013 — do not expand that epic here. |
| Exchange `429` | Rate-limited. Back off (`Retry-After`). Do not treat as forbidden and do not rewrite chrome. |
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
| `GET` | `/api/v1/embed/jwks` | none | no | Public keys only (active + live overlap). Refreshes from the store; expired `overlapUntil` omitted. |
| `POST` | `/api/v1/embed/assertions` | session or identity headers + membership | yes if `ff_session` | Mint with the **active** key. Subject/issuer bind to the caller; a different subject requires `embed.impersonate` (`PLATFORM_ADMINS`); a different issuer is `403` |
| `POST` | `/api/v1/embed/exchange` | assertion | no | Refresh overlap from the store, refuse expired `overlapUntil`, then **verify signature / iss / aud / nbf / exp / jti eligibility before any workspace lookup**. Durable `jti` consume is one `INSERT … ON CONFLICT DO NOTHING RETURNING` after verify succeeds. Used ids stay reserved **24h past `exp`** (`retain_until`); a separate `PurgeExpired` job deletes only after that window. Then resolve `(tenant_id, workbench_key)` and bind tenancy onto `ff_session` with CHIPS cookies (`SameSite=None; Secure; Partitioned`). Invalid assertions fail closed the same way whether or not the tenant exists. Bound sessions cannot create tenants or workspaces. Cookie not sent later is `401`/`403`. Rate-limited by IP (default 120/min) and issuer\|subject (default 30/min); burst is `429` `rate-limited`. |
| `POST` | `/api/v1/embed/keys/rotate` | session or identity headers + `platform.administer` (`PLATFORM_ADMINS`) | yes if `ff_session` | Register the previous active public JWK as overlap (`overlapUntil` **required**, max 4h), or retire it. `workspace.administer` is `403`. |

Mint JSON (camelCase): `{subject?,displayName?,issuer?,tenantId?,workbenchKey?,workspaceId?,capabilities,ttlSeconds?}`.
`subject` and `issuer` default to the authenticated caller. A different
`subject` requires `embed.impersonate` (same `PLATFORM_ADMINS` allowlist as
`platform.administer`; workspace `admin` is `403`). A different `issuer` is
always `403`. Capabilities must still be a subset of the caller.
`embed.impersonate` is platform-scoped and is never mintable.

Exchange JSON: `{assertion, sdk?}`. `201` `{session,principal,csrf_token,assertion,workspace,tenant,capabilities}`. `session.embed` is `{tenantId,workbenchKey,workspaceId,capabilities}`. The nested `assertion` object is metadata only (no compact JWS).

Rotate JSON: `{action:"register-overlap"|"retire", publicJwk:{kty,crv,x,kid,use,alg}, overlapUntil, kid?}`. On `register-overlap`, `overlapUntil` is **required** RFC3339 and must be a short future window (**max 4h**). Missing, zero, past, or farther-future is `400`. `publicJwk` must be the current active signing key (`kid` + `x`). Arbitrary keys are `400`. Response is the public JWKS. Never send or receive `d` / PEM / seed.

**Active key vs overlap keys:** the process **active** signing key (`EMBED_SIGNING_KEY`) is not an overlap key and does not carry `overlapUntil`. Missing `overlapUntil` on the active JWKS entry is correct — that key stays valid until a new signing key replaces it. Every **overlap** verify key (rotate API or `EMBED_OVERLAP_KEYS`) must carry a short finite `overlapUntil`. A missing field is not “valid forever”.

Failures: missing claims `400`; wrong audience / expired / nbf / bad signature / unknown or expired-overlap kid `401` (same class whether or not the claimed tenant/workbench exists — exchange never resolves a workspace until verify succeeds); tenancy mismatch / foreign subject without `embed.impersonate` / spoofed issuer `403`; replayed `jti` `409`; exchange/mint burst `429` `rate-limited`; missing signing key or JTI/overlap store `503`. A verified assertion for an unknown workspace is `404` after verify. Production **boot-fails** if `EMBED_SIGNING_KEY` is unset (empty/`production` `APP_ENV` or `REQUIRE_TLS`). Problem details never echo the JWS or private keys. Successful impersonation is audited (`reason=impersonated`).

**ADV-012:** Embed authorization decisions (mint allow/deny including impersonation, exchange allow/deny with reason codes, rotate allow/deny, capability and tenancy bind failures, rate-limit denials) emit structured `embed_audit` events. Payloads are secret-free: `event_type`, `outcome`, `reason`, `jti`, `kid`, `issuer`, `subject`, `tenant_id`, `workbench_key`, `workspace_id`, `request_id`. Never assertion plaintext, signing keys, or session secrets.

`POST /embed/exchange` is rate-limited **before** verify, keyed by client IP (default **120/min**) and peekable `iss`\|`sub` (default **30/min**) over `EMBED_RATE_LIMIT_WINDOW` (default `1m`). Soft-deny is `429` + problem detail + `Retry-After`. Mint may use `EMBED_MINT_RATE_LIMIT_PRINCIPAL` (default 60/min). A nil limiter fails closed. Defaults are sized so legitimate Portal iframe remounts from a shared egress IP stay under the cap.

Chloe: **no UI change** beyond treating `429` as backoff (`Retry-After` / `EMBED_RATE_LIMITED_MESSAGE`). Do not treat 429 as forbidden.

**ADV-008:** `POST /embed/exchange` (the only assertion-accepting path) completes cryptographic verify, audience, issuer allowlist, `nbf`/`exp`, and `jti` eligibility **before** `ResolveWorkspace` / membership. Peeking unverified JWT claims must not drive tenant lookup. Durable `jti` consume is after verify success so forged tokens do not burn ids. Chloe: **no UI change.**

**ADV-009:** `jti` consume is a **single database statement** (`INSERT … ON CONFLICT DO NOTHING RETURNING`). Concurrent exchanges with the same `jti` yield exactly one `201` and the rest `409`. Used ids are **not** deleted at JWT `exp` — that would allow minting the same `jti` again. They are retained until `retain_until = exp + 24h`. `PurgeExpired` is a separate job and must key off `retain_until`, never `expires_at` alone. Store errors fail closed (`503`). Chloe: **no UI change.**

## Key rotation (ops)

Mint always uses the process **active** key (`EMBED_SIGNING_KEY` / `EMBED_SIGNING_KEY_ID`). That material must be durable — production refuses to start without it. The active key is **not** an “overlap until forever” via a missing field; it is the current signing key until replaced. Verify (exchange) **refreshes** overlap from the durable store, then accepts the active key and any **explicit overlap** public key that still has a short finite `overlapUntil` (max 4h), is still inside that window, and has not been retired. Unknown, missing-expiry, expired, far-future, or retired `kid` fails closed. A stale in-memory ring does not keep accepting expired keys and does not miss overlap registered on another instance.

### Recommended rotate procedure

1. Generate a new Ed25519 seed. Keep the current public JWK (`GET /embed/jwks` active key).
2. As a **platform-admin** (`PLATFORM_ADMINS=issuer|subject`), `POST /api/v1/embed/keys/rotate` `{action:"register-overlap", publicJwk:<current public JWK from GET /embed/jwks>, overlapUntil:<now+≤4h>}` **or** set `EMBED_OVERLAP_KEYS` to a JWKS of the current public key **with `overlapUntil` on every key** before restart. Missing/too-long env `overlapUntil` is a **boot-fail**. Workspace admins cannot call this route.
3. Deploy `EMBED_SIGNING_KEY` + `EMBED_SIGNING_KEY_ID` for the new key. Restart API pods.
4. JWKS (refreshed from the store) lists `status=active` (new, no `overlapUntil`) and `status=overlap` (old, with required `overlapUntil`). In-flight assertions still verify until that instant.
5. After the overlap window, exchange refuses the old kid automatically. Optionally `POST /embed/keys/rotate` `{action:"retire", kid:<old>}` and/or remove the old key from `EMBED_OVERLAP_KEYS`.

`EMBED_OVERLAP_KEYS` accepts `{"keys":[…]}` or a bare JWK array. Only public OKP/Ed25519/EdDSA keys. Every key **must** include RFC3339 `overlapUntil` within 4h of process start. Private `d` is ignored and never stored.

## Key management

| Variable | Default | Purpose |
| --- | --- | --- |
| `EMBED_SIGNING_KEY` | **required in production** (boot-fail) | Durable Ed25519 seed (32 bytes) or private key (64 bytes) as base64/hex, or PKCS8 PEM. Compose seeds a **local-only** key. An ephemeral process key is allowed only when `APP_ENV` is `development`/`dev`/`local`/`test` and `REQUIRE_TLS` is off. |
| `EMBED_SIGNING_KEY_FILE` | empty | File form of the same material |
| `EMBED_SIGNING_KEY_ID` | `env:EMBED_SIGNING_KEY` | Active `kid`. Never `ephemeral:process` in production. |
| `EMBED_OVERLAP_KEYS` | empty | JSON JWKS / array of previous public keys for the overlap window. Each key **requires** `overlapUntil` (RFC3339, max 4h from boot). Missing/zero/far-future is boot-fail. Prefer `POST /embed/keys/rotate` so every instance refreshes from the store. |
| `PLATFORM_ADMINS` / `PLATFORM_ADMIN` | empty | Comma-separated `issuer\|subject` pairs allowed to rotate embed overlap keys, create tenants/workspaces, **and** mint for another subject (`embed.impersonate`). Empty is fail-closed (`403`). |
| `EMBED_AUDIENCE` | `flowforge` | Must stay `flowforge` |
| `EMBED_ASSERTION_TTL` | `60s` | Default mint TTL (clamped 15s–5m) |
| `EMBED_ISSUER` | empty | Single allowed `iss` for embed mint. Empty (with an empty allowlist) fails closed at mint (`403`) |
| `EMBED_ISSUER_ALLOWLIST` | empty | Comma-separated allowed `iss`. Empty is fail-closed: mint and (when Portal is also empty) exchange return `403`. Compose seeds `https://idp.example` for local/dev. |
| `WEB_EMBED_FRAME_ANCESTORS` | empty | Space/comma exact origins allowed to frame `/embed/v1` only. `*` / `null` ignored. Standalone stays `frame-ancestors 'none'` |
| `PORTAL_ISSUER` / `PORTAL_ISSUER_ALLOWLIST` | empty | E11.3 Portal mint issuer allowlist. Empty fails closed at Portal mint (`403`). Merged into embed exchange verification. Compose seeds `https://portal.cp-ops.example`. |
| `PORTAL_FRAME_ANCESTORS` | empty | Exact Portal origins published on `GET /api/v1/portal/adapter` |
| `WEB_PORTAL_FRAME_ANCESTORS` | empty | Exact Portal origins merged into `/embed/v1` `frame-ancestors` |
| `EMBED_EXCHANGE_RATE_LIMIT_IP` | `120` | Max `POST /embed/exchange` requests per client IP per window. `0`/unset uses the default. Negative is unlimited. |
| `EMBED_EXCHANGE_RATE_LIMIT_PRINCIPAL` | `30` | Max exchange requests per peekable `iss\|sub` per window. |
| `EMBED_MINT_RATE_LIMIT_PRINCIPAL` | `60` | Max mint (`/embed/assertions` and Portal adapter mint) per authenticated principal per window. |
| `EMBED_RATE_LIMIT_WINDOW` | `1m` | Fixed window for the counters above. |

Production must set a durable `EMBED_SIGNING_KEY` (Secret / env / file).
Missing signing material is a **boot-fail** when `APP_ENV` is empty or
`production` or when `REQUIRE_TLS=true` — unlike empty issuer allowlists,
which fail closed at **request time** (`403` on mint and exchange) so
the rest of the API stays up. Local compose seeds a local-only signing
key plus `https://idp.example` and `https://portal.cp-ops.example`.
Production ConfigMaps/Secrets must set their own values; do not copy the
compose seeds. ADV-016 may later remove the hardcoded ephemeral seed
used only in trusted-dev when the env key is unset.

Public JWKS never includes `d`, PEM, or seed. Logs redact `assertion`,
`token`, and `private_key`. Audit events record `jti`, `kid`, `issuer`,
`subject`, `tenant_id`, `workbench_key`, and `workspace_id` only.

## Completed E11.2 hooks

| Hook | Status | Fail closed |
| --- | --- | --- |
| `jti.consume` | ready | Single-statement Postgres `INSERT … ON CONFLICT DO NOTHING RETURNING`. Used ids retained 24h past assertion `exp` (`retain_until`). Separate `PurgeExpired` job. Replay `409`. Store down `503`. Consume runs only after signature and claims verify succeed. |
| `assertion.verify-before-lookup` | ready | Forged/invalid assertions fail closed without resolving tenant/workbench. Same error class whether or not the workspace exists. Tenancy bind is after verify. |
| `key.rotation` | ready | Durable active key + overlap verification. Every overlap key requires a short `overlapUntil` (max 4h). Unknown / missing-expiry / expired / far-future `kid` `401`. Verify refreshes from the store. Rotate API is platform-admin only, requires `overlapUntil`, and accepts only the previous active public key. Production missing `EMBED_SIGNING_KEY` or bad `EMBED_OVERLAP_KEYS` is boot-fail. The active key is not an overlap key. |
| `tenancy.propagation` | ready | Embed session binds `(tenant_id, workbench_key)` through API authz, configuration lookups, jobs/workers, caches, realtime, history, and audit. Host tenant is never authorization. Embed sessions cannot bootstrap tenants or sibling workbenches (`403`). Chloe chrome + deep links honor `session.embed` / exchanged workspace only. **No embed UI change required** — Membership create actions are standalone / platform-admin only. |
| Portal adapter | ready | CP Ops Portal add-in. Portal RBAC is entry only. Mint uses this SDK (`aud=flowforge`). Empty issuer allowlists fail closed (`403`). FlowForge never shares its database or executor. Host wiring: [portal adapter](portal-adapter.md). Chloe host: `/portal/workflows`. |
| `chips.embed-cookies` | ready | Embed `ff_session` / `ff_csrf` are `SameSite=None; Secure; Partitioned`. Top-level cookies stay Lax/Strict. Secure is never dropped. Cookie not sent fails closed (`401`/`403`). HTTPS / Partitioned support required. Full two-host iframe check is ADV-013. |
| `authz.audit` | ready | Mint/exchange/rotate allow and deny, impersonation, capability and tenancy bind failures, and rate-limit denials emit secret-free `embed_audit` events. Assertion plaintext, signing keys, and session secrets are never logged. |
| `exchange.rate-limit` | ready | `POST /embed/exchange` burst is `429` `rate-limited` (IP + issuer\|subject keys). Configurable via env. Mint may share a per-principal cap. Chloe treats 429 as backoff. |
