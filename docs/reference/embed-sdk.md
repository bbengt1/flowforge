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
| `iss` | yes | Minting host issuer (always the authenticated caller). Client-supplied issuer that differs is `403`. At mint must be on `EMBED_ISSUER` / `EMBED_ISSUER_ALLOWLIST` (Portal mint uses `PORTAL_*`). At exchange, `iss` must equal claim `host` (when present) and the exchange host issuer (`X-FlowForge-Host-Issuer` / `hostIssuer`) when more than one issuer is configured. `X-FlowForge-Host-Context` `portal` or `embed` selects that path allowlist. Empty allowlist fails closed (`403`). Production (empty/`production` `APP_ENV` or `REQUIRE_TLS`) requires every configured issuer to be an absolute `https://` URI (ADV-018; boot-fail + request-time `403`) |
| `aud` | yes | Must be `flowforge` |
| `sub` | yes | End-user external subject. Bound to the minting caller unless `embed.impersonate` (`PLATFORM_ADMINS`) |
| `nbf` | yes | Unix seconds. Not-yet-valid **beyond a short clock-skew leeway** fails closed (`401`). Default **30s** (`EMBED_NBF_LEEWAY`); hard max **60s**. Barely-future within leeway is accepted. `exp` is not given this leeway |
| `exp` | yes | Unix seconds. Expiry is exact (no clock-skew leeway) |
| `jti` | yes | Unique token id (UUID). Atomic single-statement consume (`INSERT … ON CONFLICT DO NOTHING RETURNING`). Used ids are retained **24h past assertion `exp`**; replay is `409` |
| `tenant_id` | yes | Context; never authorization by itself. Bound onto the session |
| `workbench_key` | yes | With `tenant_id` is the workspace identity. Bound onto the session |
| `workspace_id` | no | Binding only. Must match server resolution. Never the lookup key |
| `capabilities` | yes | FlowForge workspace permission keys; mint requires a subset of the caller. Caps the embed session. `platform.administer` and `embed.impersonate` are never mintable |
| `sdk` | yes | `embed.v1` |
| `display_name` | no | Display context until the API verifies the subject |
| `host` | no | Minting host issuer. Mint always writes `host=iss`. Exchange requires `host==iss` when the claim is present (ADV-023). Not a second authorization subject |

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
   `session.embed` and `GET /session` adds chrome-safe display
   (`mode`, `sdk`, `tenantSlug`, `tenantName`, `workspaceName`). That bind
   is the only workspace the session may use.
   The session **cannot** `POST /tenants` or `POST /workspaces` (sibling
   workbenches included), even if the principal is a platform-admin.
   **ADV-019:** `DELETE /workspace` (or a hard delete of the workspace
   row) revokes embed sessions bound to that workspace_id /
   `(tenant_id, workbench_key)`, including these CHIPS cookies. Later
   calls are `401`. Chloe: prefer existing session-expired handling —
   no dedicated chrome. Navigate to the embed mount (`/embed/v1/…`).
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
| GET `/session` | **ADV-021.** `session.embed` is the authoritative chrome payload after exchange: `mode`, `sdk`, `tenantId`, `tenantSlug`, `tenantName`, `workbenchKey`, `workspaceId`, `workspaceName`, capped `capabilities`. `principal.display_name` is the subject label. Standalone sessions omit `session.embed`. Refetch after exchange, on `/embed/v1` mount, after refresh, and on `401`. Fail closed on `/embed/v1` if `session.embed` is missing. Do not drive chrome from assertion leftovers, catalog guesses, or host query. Parser: `parseEmbedChromeFromSession`. Prefer no product-shell rewrite in the API story. |
| CHIPS cookies | After exchange, `ff_session` / `ff_csrf` are `SameSite=None; Secure; Partitioned`. Keep `credentials: "include"`. The Next rewrite must preserve `Partitioned` and must not drop `Secure` on that pair. Storage Access API is not required and must not request unpartitioned cookies. |
| Cookie not sent | Missing partitioned cookie → `401` on `GET /session` and later reads; missing `ff_csrf` on a mutation → `403`. Treat as HTTPS / browser Partitioned / frame-ancestor misconfig. Two-origin harness: ADV-013 (`docs/reference/portal-adapter.md`, `scripts/adv013-cross-origin.sh`). |
| Exchange `429` | Rate-limited. Back off (`Retry-After`). Do not treat as forbidden and do not rewrite chrome. |
| Host issuer bind | On exchange send `X-FlowForge-Host-Issuer` set to the configured Portal or embed issuer for this frame, plus optional `X-FlowForge-Host-Context` `portal` or `embed`. Never copy `iss` from the assertion. Wrong-issuer-for-host is `403`. |
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
| `GET` | `/api/v1/embed/catalog` | none | no | Contract + route map. `frameAncestors` is the shared host allowlist (ADV-011) |
| `GET` | `/api/v1/embed/jwks` | none | no | Public keys only (active + live overlap). Refreshes from the store; expired `overlapUntil` omitted. |
| `POST` | `/api/v1/embed/assertions` | session or identity headers + membership | yes if `ff_session` | Mint with the **active** key. Subject/issuer bind to the caller; a different subject requires `embed.impersonate` (`PLATFORM_ADMINS`); a different issuer is `403` |
| `POST` | `/api/v1/embed/exchange` | assertion | no | Refresh overlap from the store, refuse expired `overlapUntil`, then **verify signature / iss (path allowlist + minting host issuer bind) / aud / nbf / exp / jti eligibility before any workspace lookup**. `nbf` allows a short clock-skew leeway only (default **30s**, `EMBED_NBF_LEEWAY`, hard max **60s**); `exp` has no leeway. Durable `jti` consume is one `INSERT … ON CONFLICT DO NOTHING RETURNING` after verify succeeds. Used ids stay reserved **24h past `exp`** (`retain_until`); a separate `PurgeExpired` job deletes only after that window. Then resolve `(tenant_id, workbench_key)` and bind tenancy onto `ff_session` with CHIPS cookies (`SameSite=None; Secure; Partitioned`). Invalid assertions fail closed the same way whether or not the tenant exists. Bound sessions cannot create tenants or workspaces. Cookie not sent later is `401`/`403`. Rate-limited by IP (default 120/min) and issuer\|subject (default 30/min); burst is `429` `rate-limited`. |
| `POST` | `/api/v1/embed/keys/rotate` | session or identity headers + `platform.administer` (`PLATFORM_ADMINS`) | yes if `ff_session` | Register the previous active public JWK as overlap (`overlapUntil` **required**, max 4h), or retire it. `workspace.administer` is `403`. |

Mint JSON (camelCase): `{subject?,displayName?,issuer?,tenantId?,workbenchKey?,workspaceId?,capabilities,ttlSeconds?}`.
`subject` and `issuer` default to the authenticated caller. A different
`subject` requires `embed.impersonate` (same `PLATFORM_ADMINS` allowlist as
`platform.administer`; workspace `admin` is `403`). A different `issuer` is
always `403`. Capabilities must still be a subset of the caller.
`embed.impersonate` is platform-scoped and is never mintable.

Exchange JSON: `{assertion, sdk?, hostIssuer?, hostContext?}`. Optional `X-FlowForge-Host-Issuer` / `X-FlowForge-Host-Context` headers are the preferred binding (must agree with the body when both are set). `201` `{session,principal,csrf_token,assertion,workspace,tenant,capabilities}`. `session.embed` is `{mode:"embed",sdk,tenantId,tenantSlug,tenantName,workbenchKey,workspaceId,workspaceName,capabilities}`. The nested `assertion` object is metadata only (no compact JWS). `GET /session` returns the same `session.embed` chrome object (no assertion).

Rotate JSON: `{action:"register-overlap"|"retire", publicJwk:{kty,crv,x,kid,use,alg}, overlapUntil, kid?}`. On `register-overlap`, `overlapUntil` is **required** RFC3339 and must be a short future window (**max 4h**). Missing, zero, past, or farther-future is `400`. `publicJwk` must be the current active signing key (`kid` + `x`). Arbitrary keys are `400`. Response is the public JWKS. Never send or receive `d` / PEM / seed.

**Active key vs overlap keys:** the process **active** signing key (`EMBED_SIGNING_KEY`) is not an overlap key and does not carry `overlapUntil`. Missing `overlapUntil` on the active JWKS entry is correct — that key stays valid until a new signing key replaces it. Every **overlap** verify key (rotate API or `EMBED_OVERLAP_KEYS`) must carry a short finite `overlapUntil`. A missing field is not “valid forever”.

Failures: missing claims `400`; wrong audience / expired / nbf beyond leeway / bad signature / unknown or expired-overlap kid `401` (same class whether or not the claimed tenant/workbench exists — exchange never resolves a workspace until verify succeeds); tenancy mismatch / foreign subject without `embed.impersonate` / spoofed issuer `403`; replayed `jti` `409`; exchange/mint burst `429` `rate-limited`; missing signing key or JTI/overlap store `503`. A verified assertion for an unknown workspace is `404` after verify. Production **boot-fails** if `EMBED_SIGNING_KEY` is unset (empty/`production` `APP_ENV` or `REQUIRE_TLS`). Problem details never echo the JWS or private keys. Successful impersonation is audited (`reason=impersonated`).

**ADV-012:** Embed authorization decisions (mint allow/deny including impersonation, exchange allow/deny with reason codes, rotate allow/deny, capability and tenancy bind failures, rate-limit denials) emit structured `embed_audit` events. Payloads are secret-free: `event_type`, `outcome`, `reason`, `jti`, `kid`, `issuer`, `subject`, `tenant_id`, `workbench_key`, `workspace_id`, `request_id`. Never assertion plaintext, signing keys, or session secrets.

`POST /embed/exchange` is rate-limited **before** verify, keyed by client IP (default **120/min**) and peekable `iss`\|`sub` (default **30/min**) over `EMBED_RATE_LIMIT_WINDOW` (default `1m`). Soft-deny is `429` + problem detail + `Retry-After`. Mint may use `EMBED_MINT_RATE_LIMIT_PRINCIPAL` (default 60/min). A nil limiter fails closed. Defaults are sized so legitimate Portal iframe remounts from a shared egress IP stay under the cap.

Chloe: **no UI change** beyond treating `429` as backoff (`Retry-After` / `EMBED_RATE_LIMITED_MESSAGE`). Do not treat 429 as forbidden.

## ADV-011 shared host allowlist (Chloe)

One allowlist feeds CSP `frame-ancestors` on `/embed/v1` **and** embed-shell
postMessage origin checks. Do not keep a second client list.

**Env (same merge on API and web):**

| Variable | Where it is read |
| --- | --- |
| `WEB_EMBED_FRAME_ANCESTORS` | Next CSP (`security-headers.ts` → `embedHostAllowlist`). API catalog merge. |
| `WEB_PORTAL_FRAME_ANCESTORS` | Same Next merge (E11.3). API catalog merge. |
| `PORTAL_FRAME_ANCESTORS` | Same merge (API-side name). Set on the API so the catalog matches CSP. |

Space/comma exact `http(s)` origins. `'self'` is kept for the in-repo
same-origin Portal demo. `*` / `null` are ignored. Empty → CSP
`frame-ancestors 'none'` and **no** postMessage (including same-origin).

**How the UI reads the list (prefer catalog, not Next public env):**

1. `GET /api/v1/embed/catalog` `frameAncestors` — publish path for the embed shell.
2. `GET /api/v1/portal/adapter` `frameAncestors` — same list for the Portal host.
3. Server CSP still reads process env at request time (`frameAncestorsForPath`).
   That is **not** `NEXT_PUBLIC_*`. `NEXT_PUBLIC_EMBED_FRAME_ANCESTORS` is
   **not** a source of truth.

**Contract exports** (`apps/web/src/lib/embed-contract.ts`,
`portal-adapter-contract.ts`):

| Export | Use |
| --- | --- |
| `embedHostAllowlist(env)` | Parse the shared list from the three env vars |
| `embedPostMessageAllowlist(env)` | Alias of `embedHostAllowlist` |
| `frameAncestorsForPath(path, env)` | CSP directive (`'none'` off `/embed/v1` or when empty) |
| `parseCatalogFrameAncestors(payload)` | Read catalog / adapter `frameAncestors` |
| `isAllowedEmbedMessageOrigin(origin, list, { selfOrigin })` | Receiver + sender check. Empty list denies |
| `EMBED_HOST_ALLOWLIST_RULES` / `EMBED_HOST_ALLOWLIST_HELP` | Chloe map constants |
| `portalFrameAncestors(env)` / `portalPostMessageAllowlist(env)` | Portal adapter aliases |
| `deliverPortalAssertion(..., allowlist, selfOrigin?)` | Sender must pass the catalog list |

**Remaining shell wiring:** any new postMessage listener Chloe adds must call
`isAllowedEmbedMessageOrigin` with the catalog list. Do not accept same-origin
unless `'self'` or the exact origin is listed. Relates to #143 — keep #143 open.

**ADV-008:** `POST /embed/exchange` (the only assertion-accepting path) completes cryptographic verify, audience, issuer allowlist, `nbf`/`exp`, and `jti` eligibility **before** `ResolveWorkspace` / membership. Peeking unverified JWT claims must not drive tenant lookup. Durable `jti` consume is after verify success so forged tokens do not burn ids. Chloe: **no UI change.**

**ADV-023:** Exchange binds assertion `iss` to the minting host issuer context — not merely “any allowlisted issuer.” Mint already writes `host=iss` (the authenticated caller). On exchange:

1. When `host` is present it must equal `iss`.
2. `X-FlowForge-Host-Context` / `hostContext` `portal` uses only `PORTAL_ISSUER` / `PORTAL_ISSUER_ALLOWLIST`; `embed` uses only `EMBED_ISSUER` / `EMBED_ISSUER_ALLOWLIST`. Omitted context merges both.
3. `X-FlowForge-Host-Issuer` / `hostIssuer` must equal `iss`. Required when the selected allowlist has more than one issuer (typical production: both Portal and embed lists set). A single configured issuer stays compatible without the header.
4. Header and body must agree when both are sent. Wrong-issuer-for-host is `403`.

**Chloe:** `EmbedExchangeGate` sends `X-FlowForge-Host-Issuer` set to the **configured** Portal issuer on a Portal-framed flow (`GET /portal/adapter` `issuers`, or server `PORTAL_ISSUER` when the allowlist has more than one), or the configured embed issuer standalone (server `EMBED_ISSUER`, or catalog `issuers` if published). Optional `X-FlowForge-Host-Context: portal|embed` from the in-repo `/portal` demo referrer, `WEB_PORTAL_FRAME_ANCESTORS`, or an explicit prop. **Never copy `iss` / `host` from the assertion.** `NEXT_PUBLIC_*` is not a source. Prefer no UI rewrite beyond attaching those headers (`FLOWFORGE_HOST_ISSUER_HEADER`, `embedHostBindingHeaders`, `resolveEmbedHostBinding`). Contract: `EMBED_HOST_ISSUER_RULES` / `EMBED_HOST_ISSUER_HELP`.

**ADV-009:** `jti` consume is a **single database statement** (`INSERT … ON CONFLICT DO NOTHING RETURNING`). Concurrent exchanges with the same `jti` yield exactly one `201` and the rest `409`. Used ids are **not** deleted at JWT `exp` — that would allow minting the same `jti` again. They are retained until `retain_until = exp + 24h`. `PurgeExpired` is a separate job and must key off `retain_until`, never `expires_at` alone. Store errors fail closed (`503`). Chloe: **no UI change.**

**ADV-017:** Embed assertion `nbf` allows a short documented clock-skew leeway only: default **30s** (`DefaultNBFLeeway` / `EMBED_NBF_LEEWAY`), hard max **60s** (`MaxNBFLeeway`). Values above the max are clamped. Assertions with `nbf` in the future beyond leeway are `401` (same class as other nbf failures). `exp` stays exact — the nbf helper is not reused for expiry. Chloe: **no UI change.**

**ADV-018:** Production-locked processes (empty/`production` `APP_ENV` or `REQUIRE_TLS`) require every configured embed/Portal issuer (`EMBED_ISSUER` / `EMBED_ISSUER_ALLOWLIST`, `PORTAL_ISSUER` / `PORTAL_ISSUER_ALLOWLIST`) to be an absolute `https://` URI. `http://`, relative, protocol-relative, and opaque issuers are a **boot-fail**. Mint and exchange also reject a non-https `iss` at request time (`403`) even if it was injected onto the allowlist. Empty allowlists still fail closed at request time only (ADV-005). Local/dev/test may keep `http://` issuers when `APP_ENV` is `development`/`dev`/`local`/`test` and `REQUIRE_TLS` is off. Chloe: **no UI change.**

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
| `EMBED_SIGNING_KEY` | **required in production** (boot-fail) | Durable Ed25519 seed (32 bytes) or private key (64 bytes) as base64/hex, or PKCS8 PEM. Compose seeds a **local-only** key. An ephemeral process key is allowed only when `APP_ENV` is `development`/`dev`/`local`/`test` and `REQUIRE_TLS` is off; that key is minted with `crypto/rand` (no committed seed). |
| `EMBED_SIGNING_KEY_FILE` | empty | File form of the same material |
| `EMBED_SIGNING_KEY_ID` | `env:EMBED_SIGNING_KEY` | Active `kid`. Never `ephemeral:process` in production. |
| `EMBED_OVERLAP_KEYS` | empty | JSON JWKS / array of previous public keys for the overlap window. Each key **requires** `overlapUntil` (RFC3339, max 4h from boot). Missing/zero/far-future is boot-fail. Prefer `POST /embed/keys/rotate` so every instance refreshes from the store. |
| `PLATFORM_ADMINS` / `PLATFORM_ADMIN` | empty | Comma-separated `issuer\|subject` pairs allowed to rotate embed overlap keys, create tenants/workspaces, read metrics/OpenAPI/swagger, **and** mint for another subject (`embed.impersonate`). Empty is fail-closed (`403`). |
| `EMBED_AUDIENCE` | `flowforge` | Must stay `flowforge` |
| `EMBED_ASSERTION_TTL` | `60s` | Default mint TTL (clamped 15s–5m) |
| `EMBED_NBF_LEEWAY` | `30s` | Clock-skew for assertion `nbf` only (ADV-017). Hard max `60s` (clamped). `exp` is not given this leeway. |
| `EMBED_ISSUER` | empty | Single allowed `iss` for embed mint. Empty (with an empty allowlist) fails closed at mint (`403`). Production requires `https://` (ADV-018; boot-fail) |
| `EMBED_ISSUER_ALLOWLIST` | empty | Comma-separated allowed `iss`. Empty is fail-closed: mint and (when Portal is also empty) exchange return `403`. Compose seeds `https://idp.example` for local/dev. Production requires every entry to be an absolute `https://` URI |
| `WEB_EMBED_FRAME_ANCESTORS` | empty | Exact origins in the **shared host allowlist** (ADV-011). Merged with `WEB_PORTAL_FRAME_ANCESTORS` and `PORTAL_FRAME_ANCESTORS`. Drives CSP `frame-ancestors` on `/embed/v1` **and** postMessage origin checks. `*` / `null` ignored. Empty fails closed (`'none'`, no open postMessage). Standalone stays `frame-ancestors 'none'` |
| `PORTAL_ISSUER` / `PORTAL_ISSUER_ALLOWLIST` | empty | E11.3 Portal mint issuer allowlist. Empty fails closed at Portal mint (`403`). Merged into embed exchange verification. Compose seeds `https://portal.cp-ops.example`. Production requires `https://` (ADV-018; boot-fail) |
| `PORTAL_FRAME_ANCESTORS` | empty | Same shared host allowlist (API-side name). Merged with the `WEB_*` vars. Published on `GET /embed/catalog` and `GET /portal/adapter` as `frameAncestors` |
| `WEB_PORTAL_FRAME_ANCESTORS` | empty | Same shared host allowlist (Portal-origin name). Merged with `WEB_EMBED_FRAME_ANCESTORS` and `PORTAL_FRAME_ANCESTORS` |
| `EMBED_EXCHANGE_RATE_LIMIT_IP` | `120` | Max `POST /embed/exchange` requests per client IP per window. `0`/unset uses the default. Negative is unlimited. |
| `EMBED_EXCHANGE_RATE_LIMIT_PRINCIPAL` | `30` | Max exchange requests per peekable `iss\|sub` per window. |
| `EMBED_MINT_RATE_LIMIT_PRINCIPAL` | `60` | Max mint (`/embed/assertions` and Portal adapter mint) per authenticated principal per window. |
| `EMBED_RATE_LIMIT_WINDOW` | `1m` | Fixed window for the counters above. |

Production must set a durable `EMBED_SIGNING_KEY` (Secret / env / file).
Missing signing material is a **boot-fail** when `APP_ENV` is empty or
`production` or when `REQUIRE_TLS=true` — unlike empty issuer allowlists,
which fail closed at **request time** (`403` on mint and exchange) so
the rest of the API stays up. A **non-empty** production allowlist that
contains `http://`, relative, or opaque issuers is a boot-fail (ADV-018).
Local compose seeds a local-only signing
key plus `https://idp.example` and `https://portal.cp-ops.example`.
Production ConfigMaps/Secrets must set their own values; do not copy the
compose seeds. When a non-production process is allowed to mint an
ephemeral key (explicit `APP_ENV` and `REQUIRE_TLS` off), that key is
generated with `crypto/rand` per process. There is no committed
GenerateKey seed in Go source.

Public JWKS never includes `d`, PEM, or seed. Logs redact `assertion`,
`token`, and `private_key`. Audit events record `jti`, `kid`, `issuer`,
`subject`, `tenant_id`, `workbench_key`, and `workspace_id` only.

## Completed E11.2 hooks

| Hook | Status | Fail closed |
| --- | --- | --- |
| `jti.consume` | ready | Single-statement Postgres `INSERT … ON CONFLICT DO NOTHING RETURNING`. Used ids retained 24h past assertion `exp` (`retain_until`). Separate `PurgeExpired` job. Replay `409`. Store down `503`. Consume runs only after signature and claims verify succeed. |
| `assertion.verify-before-lookup` | ready | Forged/invalid assertions fail closed without resolving tenant/workbench. Same error class whether or not the workspace exists. Tenancy bind is after verify. |
| `key.rotation` | ready | Durable active key + overlap verification. Every overlap key requires a short `overlapUntil` (max 4h). Unknown / missing-expiry / expired / far-future `kid` `401`. Verify refreshes from the store. Rotate API is platform-admin only, requires `overlapUntil`, and accepts only the previous active public key. Production missing `EMBED_SIGNING_KEY` or bad `EMBED_OVERLAP_KEYS` is boot-fail. The active key is not an overlap key. |
| `tenancy.propagation` | ready | Embed session binds `(tenant_id, workbench_key)` through API authz, configuration lookups, jobs, workers, caches, realtime, history, and audit. Host tenant is never authorization. Embed sessions cannot bootstrap tenants or sibling workbenches (`403`). Workspace delete revokes bound embed sessions (including CHIPS); later cookies are `401`. Chloe chrome + deep links honor `session.embed` / exchanged workspace only. **No embed UI change required** — Membership create actions are standalone / platform-admin only; treat post-delete `401` as existing session expiry. |
| `chrome.from-session` | ready | **ADV-021.** `GET /session` `session.embed` is the authoritative embed chrome payload. Fail closed on `/embed/v1` without that bind. Assertion leftovers, catalog guesses, and host query are not chrome authority. No secrets / no raw assertion. Chloe retargets via `parseEmbedChromeFromSession`. Prefer no product-shell rewrite in this API story. |
| Portal adapter | ready | CP Ops Portal add-in. Portal RBAC is entry only. Mint uses this SDK (`aud=flowforge`). Empty issuer allowlists fail closed (`403`). FlowForge never shares its database or executor. Host wiring: [portal adapter](portal-adapter.md). Chloe host: `/portal/workflows`. |
| `chips.embed-cookies` | ready | Embed `ff_session` / `ff_csrf` are `SameSite=None; Secure; Partitioned`. Top-level cookies stay Lax/Strict. Secure is never dropped. Cookie not sent fails closed (`401`/`403`). HTTPS / Partitioned support required. Two-origin harness: ADV-013 (`scripts/adv013-cross-origin.sh`). |
| `host.allowlist` | ready | One list (`WEB_EMBED_FRAME_ANCESTORS` ∪ `WEB_PORTAL_FRAME_ANCESTORS` ∪ `PORTAL_FRAME_ANCESTORS`) drives CSP `frame-ancestors` on `/embed/v1` and postMessage origin checks. Empty fails closed. `*` / `null` ignored. `GET /embed/catalog` `frameAncestors` publishes the list. `NEXT_PUBLIC_EMBED_FRAME_ANCESTORS` is not a source. |
| `authz.audit` | ready | Mint/exchange/rotate allow and deny, impersonation, capability and tenancy bind failures, and rate-limit denials emit secret-free `embed_audit` events. Assertion plaintext, signing keys, and session secrets are never logged. |
| `exchange.rate-limit` | ready | `POST /embed/exchange` burst is `429` `rate-limited` (IP + issuer\|subject keys). Configurable via env. Mint may share a per-principal cap. Chloe treats 429 as backoff. |
