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

Browser clients use cookie sessions from `POST /embed/exchange` (or a future OIDC login). Production does **not** treat `X-FlowForge-Issuer` / `X-FlowForge-Subject` as authentication and `POST /session` must not upsert principals from those values. Self-asserted header identity exists only behind `TRUSTED_DEV_IDENTITY_HEADERS` plus an explicit non-production `APP_ENV` (see [security model](security-model.md) and [deployment](../deployment.md)). When `ff_session` is present, identity comes only from the session; conflicting identity headers fail closed (`403`). Header-only callers skip CSRF, and only when trusted-dev is on.

**UI route map (Chloe):** call the API origin with `credentials: "include"`. Do not store the session token or CSRF secret in `localStorage`. Read `csrf_token` from the JSON body (or the `ff_csrf` cookie) and send it as `X-CSRF-Token` on every state-changing request.

| Cookie | Flags | Purpose |
| --- | --- | --- |
| `ff_session` (top-level / `POST /session`) | `HttpOnly`, `SameSite=Lax`, `Secure` on HTTPS, `Path=/api/v1` | Opaque session id (server stores SHA-256 only) |
| `ff_csrf` (top-level / `POST /session`) | readable, `SameSite=Strict`, `Secure` on HTTPS, `Path=/api/v1` | Double-submit CSRF pair with `X-CSRF-Token` |
| `ff_session` (embed / `POST /embed/exchange`) | `HttpOnly`, **CHIPS** `SameSite=None; Secure; Partitioned`, `Path=/api/v1` | Cross-site iframe session. Secure is never dropped. Not used for top-level sessions. |
| `ff_csrf` (embed / `POST /embed/exchange`) | readable, **CHIPS** `SameSite=None; Secure; Partitioned`, `Path=/api/v1` | Same partition as embed `ff_session` so CSRF still pairs in the iframe |

Idle default **30m**, absolute default **12h** (`SESSION_IDLE_TIMEOUT` / `SESSION_ABSOLUTE_TIMEOUT`). Refresh extends idle only; it cannot pass the absolute cap. Stale, revoked, or forged cookies are `401`.

CORS is an exact allowlist (`CORS_ALLOWED_ORIGINS`). Empty allowlist + foreign `Origin` is `403` with no `Access-Control-Allow-Origin`. Wildcard / `null` origins are rejected at process start. Same-origin and Origin-less callers are allowed. CSP remains `default-src 'none'` (plus `frame-ancestors` / `form-action` / `object-src` none).

| Route | Purpose | Success | Failure |
| --- | --- | --- | --- |
| `POST /api/v1/session` | Trusted-dev only: create session from identity headers and/or JSON `{issuer,external_subject,display_name?}`. Headers win; a conflicting body is `403`. Production (fail-closed) returns `401` and does not upsert a principal. Prefer `POST /embed/exchange`. Sets both cookies when allowed. | `201` `{session,principal,csrf_token}` | `401` `403` (hostile origin, identity conflict, or fail-closed) |
| `GET /api/v1/session` | Current browser session. Cookie required; header-only is `401`. | `200` `{session,principal,csrf_token}` | `401` `403` |
| `POST /api/v1/session/refresh` | Extend idle expiry; rotate CSRF. Requires CSRF pair. Concurrent/stale CSRF is `409`. | `200` `{session,principal,csrf_token}` | `401` `403` `409` |
| `POST /api/v1/session/logout` | Revoke session and clear cookies. Requires CSRF when a session cookie is present. | `204` | `403` |
| `GET /api/v1/session/audit-events` | Caller's secret-free session audit events. | `200` `{items}` | `401` |

Session audit event types: `session.created`, `session.refreshed`, `session.revoked`, `session.expired`, `session.csrf_rejected`, `session.origin_rejected`, `session.privilege_denied`, `session.auth_rejected`. Logs and audit rows never include cookie or token values.

## Embed SDK/contract (E11.1 + E11.2)

Host backends mint a short-lived Ed25519 (EdDSA) assertion; the embed shell exchanges it for a normal `ff_session` **bound** to `(tenant_id, workbench_key)`. Assertions are audience-bound to `flowforge`, single-use (`jti`, durable atomic consume), and never accepted from a URL. Full claim/route map: [embed SDK](embed-sdk.md). UI adapter: `apps/web/src/lib/embed-contract.ts`. Relates to #122 / Part of #120 — **Keep #122 open** (Chloe still has UI pending).

**UI map (Chloe):** after exchange, persist tenant + workbench from `workspace` / `session.embed`, not from host query. **ADV-011:** CSP `frame-ancestors` and postMessage share `GET /embed/catalog` `frameAncestors` (`embedHostAllowlist` / `parseCatalogFrameAncestors`). Empty fails closed. `NEXT_PUBLIC_EMBED_FRAME_ANCESTORS` is not a source. Send `X-FlowForge-Tenant-ID` + `X-FlowForge-Workbench-Key` on every later call. Header mismatch is `403`. Host tenant is never authorization. `session.embed.capabilities` caps the session. Cookie session + `X-CSRF-Token` on later mutations. Same-origin proxy fetch already uses `credentials: "include"` — keep that so CHIPS cookies are stored and sent. Do not put `assertion` in the query, hash, or path. Do not rewrite the product shell in this API story. **ADV-007:** embed Set-Cookie is `SameSite=None; Secure; Partitioned`. The Next rewrite must preserve `Partitioned` and must not drop `Secure` on that pair. Storage Access API is **not** required and must not be used to request unpartitioned cookies. If the partitioned cookie is not sent: `401` on session reads, `403` CSRF on mutations — treat as HTTPS / Partitioned-support / frame-ancestor misconfig, not a SameSite weaken. Full two-host iframe check is ADV-013. **ADV-005:** empty or unknown issuer on mint/exchange is `403` — treat as host/env misconfig, not a UI retry. No chrome change. **ADV-004:** mint subject/issuer bind is API-only. The embed shell does not mint. No UI change. **ADV-006:** production requires a durable `EMBED_SIGNING_KEY` (boot-fail if missing). Exchange refreshes overlap and treats expired `overlapUntil` as `401`. **ADV-014:** `register-overlap` requires short `overlapUntil` (max 4h). Missing/too-long is `400`. The embed shell does not rotate keys. **ADV-008:** exchange verifies the assertion before any workspace lookup. Invalid assertions are the same `401`/`403` class whether or not the tenant exists. **ADV-009:** `jti` consume is one `INSERT … ON CONFLICT DO NOTHING RETURNING`. Used ids are retained 24h past assertion `exp`; purge is a separate job on `retain_until`. **No `apps/web` UI change.**

| Route | Purpose | Success | Failure |
| --- | --- | --- | --- |
| `GET /api/v1/embed/catalog` | SDK `embed.v1`, claims, standalone/embed routes, key management, completed E11.2 hooks, and `frameAncestors` (shared host allowlist for CSP + postMessage). No auth. | `200` catalog | — |
| `GET /api/v1/embed/jwks` | Public Ed25519 keys (active + live overlap). Refreshes overlap from the store and omits expired `overlapUntil`. Never `d` / PEM / seed. | `200` `{keys,signingReady}` | `503` store |
| `POST /api/v1/embed/assertions` | Host mint with the **durable active** key. Identity headers or session. Workspace from tenant + workbench. Subject/issuer bind to the caller. A different subject requires `embed.impersonate` (`PLATFORM_ADMINS`); a different issuer is `403`. `capabilities` ⊂ caller perms. Issuer must be on `EMBED_ISSUER` / `EMBED_ISSUER_ALLOWLIST` (empty fails closed). | `201` minted assertion (JWS once) | `400` `401` `403` empty/unknown issuer / impersonation `503` |
| `POST /api/v1/embed/exchange` | Refresh overlap from the store, refuse expired/retired `overlapUntil` kids, then **verify** iss (path allowlist + minting host issuer bind; empty fails closed)/aud/nbf/exp/jti/signature/capabilities **before any workspace lookup**. `iss` must equal claim `host` (when present) and `X-FlowForge-Host-Issuer` / `hostIssuer` when more than one issuer is configured. `X-FlowForge-Host-Context` / `hostContext` `portal` or `embed` selects `PORTAL_*` vs `EMBED_*`. Durable `jti` consume is one `INSERT … ON CONFLICT DO NOTHING RETURNING` after verify success. Used ids stay reserved 24h past `exp` (`retain_until`). Then resolve `(tenant_id, workbench_key)` and bind tenancy onto `ff_session` with CHIPS cookies (`SameSite=None; Secure; Partitioned`). Body `{assertion,sdk?,hostIssuer?,hostContext?}`. No CSRF. Bound sessions cannot `POST /tenants` or `POST /workspaces`. Invalid assertions do not probe tenant existence. Rate-limited by IP (default 120/min) and issuer\|subject (default 30/min) **before** verify. Authz decisions emit secret-free `embed_audit` events. | `201` `{session,principal,csrf_token,assertion,workspace,tenant,capabilities}` (`session.embed` present; Set-Cookie is Partitioned) | `400` missing claims `401` audience/expired/nbf/signature/unknown or expired-overlap kid **or cookie not sent later** (same class if the claimed workspace is missing) `403` empty/unknown issuer, wrong-issuer-for-host, or tenancy **or CSRF cookie missing in iframe** `404` verified assertion for unknown workspace `409` replay `429` `rate-limited` `503` |
| `POST /api/v1/embed/keys/rotate` | Register the previous active public JWK as overlap (`overlapUntil` required, max 4h), or retire an overlap kid (`platform.administer` via `PLATFORM_ADMINS`). `workspace.administer` is `403`. Mint stays on the active env key. Active key ≠ overlap key. | `200` JWKS | `400` missing/too-long `overlapUntil` or foreign key `401` `403` `503` |

Mint body: `{subject?,displayName?,issuer?,tenantId?,workbenchKey?,workspaceId?,capabilities,ttlSeconds?}`. Defaults: subject/issuer = caller; TTL 60s (15s–5m). A different `subject` requires `embed.impersonate` (`PLATFORM_ADMINS`; workspace `admin` is `403` and is audited). A different `issuer` is always `403`. Successful impersonation is audited (`reason=impersonated`). Mint allow/deny (capability, tenancy bind, issuer, impersonation) and rotate allow/deny emit the same secret-free `embed_audit` stream. Assertion claims: `iss`, `aud=flowforge`, `sub`, `nbf`, `exp`, `jti`, `tenant_id`, `workbench_key`, `workspace_id?`, `capabilities`, `sdk=embed.v1`, `host` (mint writes `host=iss`).

**ADV-012 / Chloe:** `POST /embed/exchange` may return `429` `rate-limited` with `Retry-After`. Treat as backoff only — prefer **no UI change** beyond that. Do not treat 429 as forbidden. Audit payloads never include the compact JWS, signing keys, or session secrets. Env: `EMBED_EXCHANGE_RATE_LIMIT_IP` (120), `EMBED_EXCHANGE_RATE_LIMIT_PRINCIPAL` (30), `EMBED_MINT_RATE_LIMIT_PRINCIPAL` (60), `EMBED_RATE_LIMIT_WINDOW` (`1m`).

**ADV-023 / Chloe:** Exchange binds `iss` to the minting host issuer. Send `X-FlowForge-Host-Issuer` set to the **configured** Portal issuer (`hostContext=portal`) or embed issuer (`hostContext=embed`) — never a value peeked from the assertion. Required when more than one issuer is configured. Wrong-issuer-for-host is `403`. Prefer **no UI rewrite** beyond attaching those headers (`FLOWFORGE_HOST_ISSUER_HEADER`, `embedHostBindingHeaders`, `PORTAL_HOST_ISSUER_RULES`).

Rotate body: `{action:"register-overlap"|"retire", publicJwk, overlapUntil, kid?}`. On `register-overlap`, `overlapUntil` is **required** RFC3339 and must be ≤ 4h from now (missing / zero / past / farther-future → `400`). Ops (platform-admin only): register the **current** public JWK as overlap (must match the process active key), deploy new `EMBED_SIGNING_KEY` / `EMBED_SIGNING_KEY_ID`, retire after the overlap window. The **active** signing key is not an overlap key and does not use `overlapUntil`. A caller-supplied foreign Ed25519 key is `400`. `EMBED_OVERLAP_KEYS` is the env form of the same public set and **requires** `overlapUntil` on every key (boot-fail if missing or > 4h). Verify/JWKS reload overlap from the store on each call so a rotate on another instance is visible and missing/expired/far-future `overlapUntil` kids are dropped.

Embed sessions propagate `(tenant_id, workbench_key)` through API authorization (capability intersection), configuration lookups, job tickets (`v2` when present), workers, caches, realtime, history, and audit. They **cannot** bootstrap tenants or sibling workbenches (`POST /tenants` / `POST /workspaces` → `403`), even if the principal is on `PLATFORM_ADMINS`. Chloe UI honors that bind on chrome and deep links (`apps/web/src/lib/embed-tenancy-contract.ts`, `EMBED_TENANCY_RULES`). **No embed UI change** — Membership create-tenant/create-workspace is standalone / platform-admin only; hide or treat `403` as expected from `/embed/v1/membership`.

## CP Ops Portal adapter (E11.3)

Replace/adapt Portal’s protected workflow surface without sharing the FlowForge database or executor. Portal entry RBAC is not FlowForge authorization. After Portal RBAC, the Portal backend mints via E11.1 (`aud=flowforge`, portal issuer, mapped capabilities, tenant, workbench). Exchange stays `POST /embed/exchange`. Full host wiring: [portal adapter](portal-adapter.md). UI adapter: `apps/web/src/lib/portal-adapter-contract.ts`. Relates to #123 / Part of #120 — **Keep #123 open**.

**Host wiring (Chloe):** Portal entry (`/portal/workflows`) → map Portal roles (`GET /portal/adapter`) → `POST /api/v1/portal/adapter/assertions` `{portalRoles}` → iframe `/embed/v1` → `POST /api/v1/embed/exchange` with `X-FlowForge-Host-Issuer` = configured `PORTAL_ISSUER` and `X-FlowForge-Host-Context: portal`. Persist tenant + workbench from the exchanged session, not from host query. The shared host allowlist (`WEB_PORTAL_FRAME_ANCESTORS` ∪ `WEB_EMBED_FRAME_ANCESTORS` ∪ `PORTAL_FRAME_ANCESTORS`) relaxes framing on `/embed/v1` and is the postMessage origin list. Prefer catalog `frameAncestors` over client env. Empty fails closed. Exchange cookies are CHIPS (`SameSite=None; Secure; Partitioned`) so the iframe can keep a session without weakening top-level SameSite. Keep `credentials: "include"` on the same-origin proxy. Do not request Storage Access / unpartitioned cookies. **ADV-005:** empty `PORTAL_ISSUER` / `PORTAL_ISSUER_ALLOWLIST` is `403` on mint (and exchange when embed is also empty). Show the existing hostile-issuer copy; no host chrome change. **ADV-004:** minting `{subject}` for a Portal end-user requires the Portal service principal on `PLATFORM_ADMINS` (`embed.impersonate`). Without it the API returns `403`. No host chrome change — this is a backend identity header + allowlist concern.

| Route | Purpose | Success | Failure |
| --- | --- | --- | --- |
| `GET /api/v1/portal/adapter` | Adapter `portal.v1`, capability map, host wiring, issuer allowlist, and `frameAncestors` (same shared host allowlist as `GET /embed/catalog`). No auth. Never includes DB/executor/credentials. | `200` catalog | — |
| `POST /api/v1/portal/adapter/assertions` | Portal-backend mint. `portalRoles` → FlowForge capabilities, then E11.1 `embed.Mint`. Identity headers + tenant/workbench. Subject binds to the caller unless `embed.impersonate` (`PLATFORM_ADMINS`). A different issuer is `403`. Issuer must be on a non-empty `PORTAL_ISSUER` / `PORTAL_ISSUER_ALLOWLIST` (empty fails closed). | `201` minted assertion (JWS once) | `400` unknown role `401` `403` empty/hostile issuer / impersonation / binding `503` |

Mint body: `{subject?,displayName?,issuer?,tenantId?,workbenchKey?,workspaceId?,portalRoles?,capabilities?,ttlSeconds?}`. Roles: `portal.viewer` / `viewer`, `portal.editor` / `editor`, `portal.publisher` / `publisher`, `portal.operator` / `operator`, `portal.approver` / `approver`, `portal.admin` / `admin`. `portal.admin` does **not** include `platform.administer` or `embed.impersonate` and cannot bootstrap tenants or membership. Minting for another Portal user requires the minting caller on `PLATFORM_ADMINS`.

Epic #120 negatives (fail closed): hostile host issuer, replayed assertion (`409` on exchange), cross-tenant/workbench (`403`), no credential plaintext or raw runner-log exposure, embed session tenant/workspace create (`403`), Portal `admin` extra `platform.administer` (`400`).

## Workspace identity and RBAC (E2.1)

In trusted-dev only, identity headers establish the subject for non-browser callers: `X-FlowForge-Issuer` and `X-FlowForge-Subject` (optional `X-FlowForge-Display-Name`). Production requires a cookie session (embed exchange today). Headers never authorize a workspace. The UI session adapter is `apps/web/src/lib/session-contract.ts`.

Workspace identity is resolved only from `X-FlowForge-Tenant-ID` or `X-FlowForge-Tenant-Slug` plus `X-FlowForge-Workbench-Key`. `X-FlowForge-Workspace-ID` is untrusted host context: it is rejected when it is the only identity, and forbidden when it does not match the server-derived workspace.

| Route | Purpose | Success | Failure |
| --- | --- | --- | --- |
| `GET /api/v1/permission-matrix` | Role/permission catalog covering view, edit, publish, execute, credential, approval, and administration (including platform-scoped `platform.administer` and `embed.impersonate`). | `200` `{permissions,roles}` | `401` |
| `GET /api/v1/roles` | Persisted role vocabulary. | `200` `{items}` | `401` |
| `GET /api/v1/permissions` | Persisted permission vocabulary. | `200` `{items}` | `401` |
| `POST /api/v1/tenants` | Create a tenant. Requires `platform.administer` (`PLATFORM_ADMINS`) on a **non-embed** session. Unauthenticated is `401`; embed sessions and any other caller are `403`. | `201` tenant | `400` `401` `403` `409` |
| `GET /api/v1/workspaces` | Workspaces the caller belongs to (server-side bindings). | `200` `{items}` | `401` |
| `POST /api/v1/workspaces` | Create a workspace unique on `(tenant_id, workbench_key)`; caller is bound as `admin`. Requires `platform.administer` on a **non-embed** session. Embed sessions (including sibling-workbench bodies) are `403`. Body `id` / `workspace_id` rejected. | `201` workspace | `400` `401` `403` `404` `409` |
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
| `POST /api/v1/workspace/credentials/{id}/use` | E2.2 isolation hook use (stub record). Requires `credential.use`. Product vault use is `POST /credentials/{id}/use`. | `204` | `401` `403` `404` |
| `GET /api/v1/workspace/artifacts/{id}` | E2.2 isolation hook (stub record). Product artifacts are `GET /artifacts/{id}` (E5.3). Requires `execution.view`. | `200` | `401` `403` `404` |
| `GET /api/v1/workspace/jobs` | List job hooks. Requires `execution.view`. | `200` `{items}` | `401` `403` |
| `POST /api/v1/workspace/jobs` | Enqueue a job hook. Requires `workflow.execute`. | `201` | `401` `403` |
| `GET /api/v1/workspace/cache/{key}` | Workspace-prefixed cache read. | `200` | `401` `403` `404` |
| `PUT /api/v1/workspace/cache/{key}` | Workspace-prefixed cache write. | `200` | `401` `403` |
| `POST /api/v1/workspace/realtime/channels/{id}/subscribe` | Realtime subscribe. Requires `workflow.view`. | `200` | `401` `403` `404` |
| `GET /api/v1/workspace/audit-events` | List audit hooks. Requires `workspace.administer`. | `200` `{items}` | `401` `403` |

E2.2 `kind=credential` records are isolation stubs without encryption. The product vault is `/api/v1/credentials` below.

## Encrypted credential vault (E4.1)

Workspace-scoped envelope-encrypted secrets. Plaintext is accepted only on create/rotate over TLS, encrypted before persistence, and is **never** returned in JSON, problem details, logs, metrics, YAML, jobs, or audit `details`. Isolation hook `POST /workspace/credentials/{id}/use` stays for E2.2 stubs; product use is `POST /credentials/{id}/use` (`204`, empty body).

**Key source (no hard-coded secrets):** `CREDENTIAL_KEK` (32-byte AES-256 as standard/raw-URL base64 or 64 hex chars) or `CREDENTIAL_KEK_FILE`. Optional `CREDENTIAL_KEK_ID` is stored as `keyReference` (default `env:CREDENTIAL_KEK` / `file:CREDENTIAL_KEK_FILE`). Missing/invalid KEK fails closed on create/rotate/test/use (`503` `dependency-unavailable`). Local MVP envelope: random DEK + AES-256-GCM payload, DEK wrapped with the KEK. Production should wrap the KEK with a KMS and keep loading the unwrapped key from env.

**UI route map (Chloe):** cookie session + `credentials: "include"`; send `X-CSRF-Token` on POST/PATCH/DELETE. JSON is camelCase. Never persist `secret` in `sessionStorage`, `localStorage`, URLs, or analytics. After submit, drop the form values. List/detail/events show only metadata (`displayName`, `type`, `status`, `tags`, `fingerprint`, test/rotation timestamps, `permittedActions`). Host-supplied `id` / `workspace_id` / `workspaceId` on write bodies is `400`. Cross-workspace UUIDs are `404`. Do not rewrite `apps/web` in this API story.

Suggested UI flow:

1. `GET /credentials/catalog` for type + field shapes (names only).
2. Add wizard: `POST /credentials` `{type,displayName,tags?,metadata?,expiresAt?,secret}`. Keep `id`; discard `secret`.
3. List: `GET /credentials`. Detail: `GET /credentials/{id}`.
4. Metadata edit: `PATCH /credentials/{id}` (sending `secret` is `400`).
5. Rotate: `POST /credentials/{id}/rotate` `{secret}`.
6. Test: `POST /credentials/{id}/test` → `{result:{status,reason,checkedAt},credential}` (no plaintext).
7. Disable/enable: `POST .../disable` / `.../enable`.
8. Usage: `GET .../usage`. Before delete: `GET .../deletion-impact`. Delete only with `{confirm:true}`; `409` while an active execution **or webhook trigger** references the id.
9. Audit: `GET .../events`.

RBAC: `credential.view` list/get/usage/impact/events/catalog; `credential.use` test+use (operator); `credential.manage` create/rotate/disable/enable/delete/patch (admin). Viewer has no credential permissions. Editor/publisher can view metadata only.

| Route | Purpose | Success | Failure |
| --- | --- | --- | --- |
| `GET /api/v1/credentials/catalog` | Typed field catalog (no values). Requires `credential.view`. | `200` `{types}` | `401` `403` |
| `GET /api/v1/credentials` | List metadata. | `200` `{items}` | `401` `403` |
| `POST /api/v1/credentials` | Create; encrypt `secret` before persist. | `201` metadata | `400` `401` `403` `503` |
| `GET /api/v1/credentials/{credentialId}` | Metadata only. | `200` | `401` `403` `404` |
| `PATCH /api/v1/credentials/{credentialId}` | Safe metadata (`displayName`, `tags`, `metadata`, `expiresAt`). | `200` | `400` (incl. `secret`) `401` `403` `404` |
| `POST /api/v1/credentials/{credentialId}/rotate` | Replace encrypted payload. | `200` metadata | `400` `401` `403` `404` `503` |
| `POST /api/v1/credentials/{credentialId}/disable` | Disable; use fails closed. | `200` | `401` `403` `404` |
| `POST /api/v1/credentials/{credentialId}/enable` | Re-enable. | `200` | `401` `403` `404` |
| `POST /api/v1/credentials/{credentialId}/test` | In-process shape check. Requires `credential.use` or `manage`. | `200` `{result,credential}` | `401` `403` `404` |
| `POST /api/v1/credentials/{credentialId}/use` | Record use; empty body. Requires `credential.use`. | `204` | `401` `403` `404` `409` (disabled/expired) |
| `GET /api/v1/credentials/{credentialId}/usage` | Last-used + draft/version/execution/trigger refs. | `200` | `401` `403` `404` |
| `GET /api/v1/credentials/{credentialId}/deletion-impact` | Affected drafts/versions/active executions/webhook triggers. | `200` `{canDelete,...}` | `401` `403` `404` |
| `DELETE /api/v1/credentials/{credentialId}` | Delete after `{confirm:true}`. | `204` | `400` `401` `403` `404` `409` |
| `GET /api/v1/credentials/{credentialId}/events` | Redacted vault audit. | `200` `{items}` | `401` `403` `404` |

## Versioned operational configuration (E4.2)

Workspace-scoped cluster/SSH targets, command/runtime profiles, connections, recipient lists, message templates, response schemas, and policies. Each resource has one mutable draft and immutable published revisions. Workflow publish and execution start **pin exact versions**; later draft edits do not retarget a pin. Endpoint, recipient, template, and schema selection is server-authorized: the client sends resource UUIDs only; the API resolves a published revision in the current workspace. Cross-workspace UUIDs are `404`. Host-supplied `id` / `workspace_id` / `workspaceId` on write bodies is `400`.

Physical tables: `ops_resources`, `ops_resource_drafts`, `ops_resource_versions` (immutable), `ops_pins` (immutable), `target_policy_bindings`. FORCE RLS + composite `(workspace_id, id)` FKs. Credential references use composite FK to `credentials`. Policy evaluation and approval binding are E4.3 below.

**UI route map (Chloe):** do **not** stack on another feature branch. These paths are stable on `main`. Cookie session + `credentials: "include"`; send `X-CSRF-Token` on POST/PUT. JSON is camelCase. Next proxies can rewrite `/api/control-plane/{collection}/...` the same way as credentials/workflows. Suggested screens: `/targets`, `/profiles`, `/connections`, `/templates` (or one `/ops-config?kind=`). Do not rewrite `apps/web` in this API story.

Suggested UI flow:

1. `GET /ops-config/catalog` for kinds, URL collections, YAML field names, `usePermission`, (E7.1) `kubernetesEngine`, (E8.1) `sshEngine`, (E9.1) `scriptEngine`, and (E10.4) `httpNotificationEngine`. Cluster-target rows include `allowedCredentialTypes: ["kubernetes"]`. SSH-target rows include `allowedCredentialTypes: ["ssh_private_key"]`. Connection rows include `allowedCredentialTypes: ["token"]` and `engine: "http-notification"`. Runtime-profile rows include `engine: "script"`.
2. List: `GET /{collection}` (`cluster-targets`, `ssh-targets`, `command-profiles`, `runtime-profiles`, `connections`, `recipient-lists`, `message-templates`, `response-schemas`, `policies`).
3. Create draft: `POST /{collection}` `{name, slug?, spec}`. Keep `resource.id` and `draft.revision`.
4. Save: `PUT /{collection}/{id}/draft` `{revision, spec, name?}`. On `409`, reload the draft.
5. Publish: `POST /{collection}/{id}/publish` `{revision?, note?}` (`opsconfig.publish`).
6. History: `GET /{collection}/{id}/versions` and `GET .../versions/{versionId}`.
7. Picker / authorize: `POST /{collection}/{id}/select` `{versionId?}` or batch `POST /ops-config/select` `{refs:[{kind,resourceId,versionId?}]}`. Drafts cannot be selected (`400`).
8. Workflow YAML stores **resource** UUIDs (`clusterTargetId`, `sshTargetId`, `commandProfileId`, `runtimeProfileId`, `connectionId`, `recipientListId`, `templateId`, `responseSchemaRef`, `policyId`). The API pins versions at workflow publish / execution start. Read pins: `GET /workflows/{workflowId}/versions/{versionId}/pins` and `pins[]` on execution JSON.
9. Disable/enable: `POST /{collection}/{id}/disable` / `enable`. Disabled resources cannot be selected.

RBAC: `opsconfig.view` list/get/select snapshot; `opsconfig.edit` create/save/disable; `opsconfig.publish` publish; `opsconfig.use` plus `clusterTarget.use`, `sshTarget.use`, `commandProfile.use`, `runtimeProfile.use`, `connection.use`, `recipientList.use`, `messageTemplate.use`, `responseSchema.use`, `policy.use` are required to **execute** a workflow that pins those kinds (operator/admin). Viewer can read catalogs; editor can draft; publisher can publish revisions.

| Route | Purpose | Success | Failure |
| --- | --- | --- | --- |
| `GET /api/v1/ops-config/catalog` | Kinds, collections, YAML fields, plus `kubernetesEngine` (E7.1), `sshEngine` (E8.1), `scriptEngine` (E9.1), and `httpNotificationEngine` (E10.4). Requires `opsconfig.view`. | `200` `{kinds,kubernetesEngine,sshEngine,scriptEngine,httpNotificationEngine}` | `401` `403` |
| `GET /api/v1/kubernetes/catalog` | Engine allowlists, evaluation keys, service-account templates. Requires `opsconfig.view`. Does not contact a cluster. | `200` engine catalog | `401` `403` |
| `GET /api/v1/ssh/catalog` | Profile parameter types, reviewed render rules, retry/indeterminate contract (`retry.ui`, `retry.probe`), publish rules, and error codes. Requires `opsconfig.view`. Does not open SSH. | `200` engine catalog | `401` `403` |
| `GET /api/v1/scripts/catalog` | Script node fields, publish/scan/sign/pin rules, E9.2 isolation, E9.3 I/O/retry, and E9.4 `revocation` + `emergencyStop`. Requires `opsconfig.view`. Does not start a runner. | `200` engine catalog | `401` `403` |
| `GET /api/v1/http/catalog` | HTTP/notification node fields, SSRF/redirect/TLS/size/secret-field rules, and `integrationGate`. Requires `opsconfig.view`. Does not make a remote call. | `200` engine catalog | `401` `403` |
| `POST /api/v1/ops-config/select` | Batch server-authorized pins. | `200` `{items}` | `400` `401` `403` `404` |
| `GET /api/v1/{collection}` | List heads. | `200` `{items}` | `401` `403` |
| `POST /api/v1/{collection}` | Create draft revision 1. | `201` `{resource,draft}` | `400` `401` `403` `409` |
| `GET /api/v1/{collection}/{resourceId}` | Head + latest version pointers. | `200` | `401` `403` `404` |
| `GET /api/v1/{collection}/{resourceId}/draft` | Mutable spec. | `200` | `401` `403` `404` |
| `PUT /api/v1/{collection}/{resourceId}/draft` | Conflict-safe save. | `200` `{resource,draft}` | `400` `409` `401` `403` `404` |
| `POST /api/v1/{collection}/{resourceId}/publish` | Immutable revision. | `201` `{resource,version}` | `409` `401` `403` `404` |
| `GET /api/v1/{collection}/{resourceId}/versions` | History, newest first. | `200` `{items}` | `401` `403` `404` |
| `GET /api/v1/{collection}/{resourceId}/versions/{versionId}` | Frozen snapshot. | `200` | `401` `403` `404` |
| `POST /api/v1/{collection}/{resourceId}/select` | Pin latest or `{versionId}`. | `200` pin | `400` draft `404` `409` disabled |
| `POST /api/v1/{collection}/{resourceId}/disable` | Soft-disable. | `200` | `401` `403` `404` |
| `POST /api/v1/{collection}/{resourceId}/enable` | Re-enable. | `200` | `401` `403` `404` |
| `GET /api/v1/workflows/{workflowId}/versions/{versionId}/pins` | Pins bound at publish. | `200` `{items}` | `401` `403` `404` |

`spec` shapes (unknown fields rejected):

| Kind | Required `spec` |
| --- | --- |
| `cluster_target` | `credentialId` (workspace `kubernetes` / kubeconfig credential only), `endpoint.apiServer` or `tlsServerName`; optional `allowedNamespaces` (non-empty DNS-1123 labels), `policyId` (published `kind=kubernetes` policy; target namespaces must be a subset), `serviceAccount.{name,namespace?,roleTemplate?}` (`roleTemplate` defaults to `namespace-scoped-runner`; ClusterRoles are not MVP). Wrong credential type → `400`. Cross-workspace `credentialId` → `404`. Specs never include kubeconfig. |
| `ssh_target` | `credentialId` (workspace `ssh_private_key` credential only), `hostname`, `hostKeyFingerprint` (`sha256:<64 hex>` or OpenSSH `SHA256:<base64>`, canonicalized to `sha256:<hex>`); optional `port` (default 22), `username` (non-root; default at execute is `flowforge`; `root`/`toor`/`administrator` rejected), `allowedAddresses` (IP/CIDR; present empty list is rejected; no `0.0.0.0/0`), `policyId` (published `kind=ssh` policy). Wrong credential type → `400`. Cross-workspace `credentialId` → `404`. Specs never include `privateKey` / `passphrase` / kubeconfig. |
| `command_profile` | `parameterSchema` (restricted object schema: `string` / `integer` / `boolean` properties, `additionalProperties: false`), `template` (reviewed `{name}` placeholders only; no `$()`, `` ` ``, `${`, `{{`, `$`); optional `retrySafe` (default `false`; when `true`, `verification` is required); optional `verification` `{template, expectExitCode?, expectStdoutContains?, onMatch?, onMismatch?, onError?}`; `policyId` (published `kind=ssh` policy). The reviewed renderer owns POSIX single-quote substitution and rejects values outside the schema. |
| `runtime_profile` | `language` (`python`/`go`), `imageDigest`, `dependencyLockDigest`, `limits.{cpuMillis,memoryMib,timeoutSeconds,processes}`; optional `egress.{destinations[{host,port,protocol}],dnsConstrained:true}` (omitted = default-deny; metadata/loopback/wildcards rejected) |
| `connection` | `type` (`http`/`webhook`/`smtp`), `endpointPolicy.{hosts,methods,pathPrefixes}`; optional `credentialId`, ports/TLS/redirects, `allowedAddresses` (destination-IP allowlist; required at execute for DNS names), `allowPrivateDestinations` (default `false`, fail closed — required to reach loopback/RFC1918/ULA after resolve), `secretFields`, `maxRequestBytes`/`maxResponseBytes` |
| `recipient_list` | `recipientPolicy.emails` and/or `domains` (allowlist only) |
| `message_template` | `inputSchema`, `contentClassification`, `body`; optional `subject` |
| `response_schema` | `schema`, `maxBytes` (1–1048576) |
| `policy` | `kind` (`kubernetes`/`ssh`/`script`/`http`/`notification`/`approval`), `policy` object. Evaluation keys (E4.3 / E7.1): `requireApproval`, `approverRole`, `expiresIn` (ISO-8601), `operations`, `deny`, `allowedNamespaces`/`namespaces`, `allowedKinds`/`kinds`, `allowedVerbs`/`verbs`, `allowedHosts`/`hosts`, `allowedAddresses`/`addresses`. For `kind=http` / `kind=notification`, optional `allowPrivateDestinations` (boolean, unset = `false`) opts in to loopback/RFC1918/ULA after DNS; link-local and metadata stay denied. For `kind=kubernetes`, unknown keys are rejected; aliases canonicalize to `allowedNamespaces` / `allowedKinds` / `allowedVerbs`. Empty allowlists are rejected (open-by-accident). Publish/select of a kubernetes policy requires a non-empty namespace allowlist unless `deny=true`. Allowlists fail closed when present (including empty). Engine kinds: ConfigMap, Service, Deployment, StatefulSet, DaemonSet, Job, CronJob, Ingress, NetworkPolicy. Engine verbs: `get` (`kubernetes.get`), `list` (`kubernetes.list`), `apply` (`kubernetes.apply`), `watch` (`kubernetes.rolloutStatus`). `expiresIn` must be a valid ISO-8601 duration (max `P7D`). |

Workflow publish fails closed if a YAML resource UUID is missing, unpublished, disabled, or in another workspace. Execution JSON includes `pins[]` copied from the workflow version; later ops-config publishes do not change that pin. **Authorization** on start re-evaluates the **current** published target/policy (E4.3), so a later policy/target publish can block dispatch even though the execution pin stays on the older revision.

## Policy evaluation and approvals (E4.3)

Evaluate target/action policy **before dispatch**. Approval requirements are bound to workflow version, target revision, policy revision, operation, and expiry. A changed policy, target, or workflow version invalidates a prior approval. Decide rechecks membership and `approval.decide` on the server. Requester self-approval is denied. Pre-run `requireApproval` still gates start (`409`). Mid-run `flow.approval` nodes are **wait** requirements (`wait: true`): they do not block start. Durable wait/resume is E10.3 below.

**UI route map (Chloe):** do **not** stack on another feature branch. These paths are stable on `main`. Cookie session + `credentials: "include"`; send `X-CSRF-Token` on POST. JSON is camelCase. Suggested screens: `/approvals` (inbox) and a pre-run policy panel on the workflow run dialog. Next proxies can rewrite `/api/control-plane/policy/evaluate` and `/api/control-plane/approvals/...`. Do not rewrite `apps/web` in this API story. Enable decide UX for mid-run waits (E10.3): `GET /approvals/catalog` now has `waitResumeEnabled: true`; resume is `POST /approvals/{id}/decide`.

Suggested UI flow:

1. Pre-run: `POST /policy/evaluate` `{workflowId, workflowVersionId}` → `{decision, dispatchAllowed, operations[], requirements[], approvals[]}`.
2. If `decision=deny`, block Run and show `denied[].reason`.
3. If `decision=approval-required`, `POST /approvals` `{workflowId, workflowVersionId}` (or let Run 409 after the server materializes pending rows). Inbox: `GET /approvals?status=pending`.
4. Approver (not the requester): `POST /approvals/{id}/decide` `{decision:"approved"|"rejected", note?}`. Requires `approval.decide` plus the bound `approverRole` (or `admin`).
5. Run again: `POST /workflows/{id}/executions` `{workflowVersionId}`. Valid approvals → `201`. Missing/stale/expired → `409` `conflict`. Policy deny → `403`.
6. After a policy or target **publish** (or disable), prior pending/approved rows become `invalidated`. Re-evaluate and request a new approval.
7. Detail/audit: `GET /approvals/{id}`, `GET /approvals/{id}/events`. Catalog: `GET /approvals/catalog`.

RBAC: `approval.view` list/get/events/catalog/evaluate; `workflow.execute` create requirements; `approval.decide` decide (approver/admin). Viewer can read status. Operator can request, not decide. Host-supplied `id` / `workspace_id` / `workspaceId` on write bodies is `400`. Cross-workspace UUIDs are `404`.

| Route | Purpose | Success | Failure |
| --- | --- | --- | --- |
| `GET /api/v1/approvals/catalog` | Statuses, decisions, default expiry. Requires `approval.view`. | `200` `{statuses,decisions,defaultExpiresIn}` | `401` `403` |
| `POST /api/v1/policy/evaluate` | Preview current published target/policy vs a workflow version. Requires `workflow.view`. | `200` evaluation | `400` `401` `403` `404` |
| `GET /api/v1/approvals` | List. Query `status`, `workflowId`, `workflowVersionId`, `executionId`. Refreshes stale rows. | `200` `{items}` | `401` `403` |
| `POST /api/v1/approvals` | Materialize pending requirements from evaluate. Idempotent on active fingerprint. Requires `workflow.execute`. | `201` `{items}` | `400` `401` `403` `404` |
| `GET /api/v1/approvals/{approvalId}` | One requirement; refreshes expiry/binding. | `200` | `401` `403` `404` |
| `POST /api/v1/approvals/{approvalId}/decide` | Fresh auth. `{decision, note?}`. No self-approval. | `200` | `400` `401` `403` `404` `409` (expired/invalidated/not pending) |
| `GET /api/v1/approvals/{approvalId}/events` | Secret-free audit. | `200` `{items}` | `401` `403` `404` |
| `POST /api/v1/workflows/{workflowId}/executions` | **Also** evaluates policy before the pin stub. Approval-required without a valid approval is `409` (pending rows are created). Deny is `403`. | `201` execution | `400` `401` `403` `404` `409` |

Statuses: `pending`, `approved`, `rejected`, `expired`, `invalidated`. Binding fields on every requirement/record: `workflowVersionId`, `workflowDigest`, `targetId`/`targetVersionId`/`targetDigest`, `policyResourceId`/`policyVersionId`/`policyDigest`/`policyRevision`, `operation`, `nodeId`, `expiresAt`, `bindingFingerprint`.

`flow.approval` nodes always produce a **wait** requirement (`with.approverRole`, `with.expiresIn`, `wait: true`). Wait-only graphs are `decision=allow` / `dispatchAllowed=true` so the run can start and park. A kubernetes/ssh/http/notification/script policy produces a pre-dispatch requirement when `kind=approval` or `policy.requireApproval=true`. Allowlists fail closed when present (a present empty list denies). Cluster-target `allowedNamespaces` is also enforced at evaluate. A `policyId` that is not a published policy in the workspace is deny. No bound policy means no extra constraint (existing E4.2 workflows still run).

## Kubernetes target and policy management (E7.1)

Control-plane hardening on the existing E4.2 collections. E7.2 adds the apply/get/list engine. E7.3 fulfills `kubernetes.rolloutStatus` and `wait=ready` bounded watch.

**UI route map (Chloe):** same cookie session + `X-CSRF-Token` + camelCase JSON as E4.2. Use `GET /ops-config/catalog` (`kubernetesEngine`) or `GET /kubernetes/catalog` for allowlists, evaluation-key aliases, and service-account template paths. Cluster-target credential pickers must list only workspace `type=kubernetes` credentials (secret field `kubeconfig`, never shown). Host-supplied `id` / `workspaceId` is `400`. Cross-workspace credential or resource UUIDs are `404`. Next can proxy `/api/control-plane/kubernetes/catalog` the same way as ops-config. Do not rewrite `apps/web` in this API story.

Suggested UI flow:

1. Create a vault credential `type=kubernetes` (E4.1). Never echo kubeconfig.
2. Optionally create/publish a `policies` resource with `kind=kubernetes` and a non-empty `allowedNamespaces` (or `namespaces`). Add `allowedKinds` / `allowedVerbs` to fail closed on those axes.
3. Create/publish a `cluster-targets` draft: `{name, spec:{credentialId, endpoint:{apiServer}, allowedNamespaces?, policyId?, serviceAccount?}}`.
4. Select as today (`POST /cluster-targets/{id}/select`). Publish/select re-checks credential type, required fields, empty allowlists, and namespace subset vs the bound policy.
5. Apply `deploy/kubernetes/workspace-*.yaml` in each allowed namespace (operator, not FlowForge). E7.2 workers will read `serviceAccount` metadata.

Least-privilege SA templates (no ClusterRoles): [`deploy/kubernetes/`](../../deploy/kubernetes/). Default name `flowforge-runner`, `roleTemplate=namespace-scoped-runner`.

## Kubernetes read/apply nodes (E7.2)

Engine path for `kubernetes.apply`, `kubernetes.get`, and `kubernetes.list`. No new browser routes. Workers claim E5.2 jobs and call the engine; kubeconfig never appears on job JSON, outputs, or audit details. `GET /kubernetes/catalog` now includes `nodes[]`, `errors[]`, and `apply` (fieldManager/`Force=false`/always server dry-run). The live workflow catalog is `GET /workflows/catalog` (`allowedWith`, `policy`, `bounds`, `redaction`).

**UI route map (Chloe):** do **not** stack on another feature branch. Cookie session + `credentials: "include"`; send `X-CSRF-Token` on POST. JSON is camelCase. Host-supplied `id` / `workspaceId` is `400`. Do not rewrite `apps/web` in this API story. Wizard/library should read `allowedWith` on the three nodes instead of inferring fields.

### Node contracts

Shared fields: `clusterTargetId` (UUID), `namespace` (DNS-1123), `dryRun` (`client`|`server`), `wait` (`none`|`ready`), `timeoutSeconds` (1–3600, default 60), optional `fieldManager` (`flowforge` only), optional `policyId` (UUID). `client` dry-run adds local validation and **never** replaces the mandatory server-side dry-run on apply. `wait=ready` performs a bounded watch of observable kinds (see E7.3).

| Node | Extra `with` | Verb | Permissions | Outputs |
| --- | --- | --- | --- | --- |
| `kubernetes.apply` | `manifests` (YAML string) | `apply` | `workflow.execute`, `kubernetes.apply`, `clusterTarget.use` | `result`, `resources`, `status` |
| `kubernetes.get` | `kind` (allowlisted), `name` | `get` | `workflow.execute`, `kubernetes.read`, `clusterTarget.use` | `result`, `items` |
| `kubernetes.list` | `kind` (allowlisted) | `list` | `workflow.execute`, `kubernetes.read`, `clusterTarget.use` | `result`, `items` |

Apply flow: parse YAML docs → validate kind/namespace/secret/workload/image/ingress policy → revalidate policy → SSA dry-run (`dryRun=All`) → SSA apply `FieldManager=flowforge` `Force=false`. Ownership conflicts are `409` `ownership-conflict` and are never forced. Get/list contact only the node namespace.

Allowlisted kinds: ConfigMap, Service, Deployment, StatefulSet, DaemonSet, Job, CronJob, Ingress, NetworkPolicy. Denied: Secret `data`/`stringData`/`binaryData`, cluster-scoped, Namespace, CRDs, RBAC, admission webhooks, privileged/hostPath/host namespaces, capability escalation, mutable tags including `:latest`, images not on `allowedImages`/`images`, Ingress hosts/TLS/backends/annotations outside `allowedIngressHosts`/`ingressHosts`.

### Result / error shapes

Success `result`: `{ok, operation, clusterTargetId, namespace, manifestDigest?, fieldManager:"flowforge", force:false, serverDryRun, applied, wait, observation?, resources[], items?, status, policyRevision?, policyDigest?, correlationId?}`. Outputs are redacted (`kubeconfig`, secret keys, PEM).

| `error.code` | HTTP-ish | When |
| --- | --- | --- |
| `invalid-manifest` | 400 | Parse/required field |
| `secret-forbidden` | 400 | Secret kind or secret data fields |
| `kind-denied` / `namespace-denied` / `verb-denied` / `policy-denied` / `forbidden` / `rbac-denied` | 403 | Allowlist, RBAC, or FlowForge permission |
| `image-denied` / `ingress-denied` / `workload-denied` | 403 | Manifest security policy |
| `ownership-conflict` | 409 | Another field manager owns applied fields (`Force=false`) |
| `dry-run-failed` | 400 | Server-side dry-run rejected the object |
| `apply-failed` / `read-failed` / `timeout` | 502 / 404 / 408 | Cluster or bound timeout |

Job binding still includes workspace, workflow version, cluster target, policy revision, correlation ID, and normalized-manifest SHA-256. Workers revalidate policy before cluster contact.

Out of scope for E7.2: E7.3 `kubernetes.rolloutStatus` watch (now below), `apps/web` rewrite, SSH/script engines.

## Kubernetes rollout observation and audit (E7.3)

Bounded watch for `kubernetes.apply` when `wait=ready` and the dedicated `kubernetes.rolloutStatus` node. No new browser routes. `GET /kubernetes/catalog` adds `observation` (`waitReady=observed`, states, kinds, `verb=watch`, cancel/timeout = `stop-wait`, `neverDeletesOrRollsBack=true`) plus the `kubernetes.rolloutStatus` node. The live workflow catalog is `GET /workflows/catalog`.

**UI route map (Chloe):** do **not** stack on another feature branch and do **not** rewrite `apps/web` in this API story. Cookie session + `credentials: "include"`; send `X-CSRF-Token` on POST. JSON is camelCase. Host-supplied `id` / `workspaceId` is `400`. Wizard/library should read `allowedWith` / `observation` from `GET /kubernetes/catalog` and `GET /workflows/catalog`. Keep #72 open until rollout-status UI surfaces land.

Suggested UI flow:

1. Author `kubernetes.apply` with `wait=ready` (or a following `kubernetes.rolloutStatus` node).
2. Show `result.observation` and `result.status.progress[]` counters. Treat timeout/cancel as “stopped waiting” — never offer delete/rollback.
3. Render `result.audit` (or the matching `audit_events` row) as the secret-free snapshot: actor, target, policy revision, manifest digest, resource identities, dry-run/apply/watch outcome, correlation ID.
4. On `error.code` `timeout` / `canceled` / `rollout-failed`, keep the applied identities visible; the cluster objects remain.

### Node contracts

Shared fields match E7.2. `kubernetes.rolloutStatus` extra identity: `kind` + `name`, or `resource` `{kind,name}`, or a wired `resource` input. Observable kinds only: Deployment, StatefulSet, DaemonSet, Job. Verb is `watch` (E7.1 allowlist). Cancel/timeout stop the wait and **never** delete or roll back.

| Node | Extra `with` | Verb | Permissions | Outputs |
| --- | --- | --- | --- | --- |
| `kubernetes.apply` (`wait=ready`) | `manifests` | `apply` then `watch` | `workflow.execute`, `kubernetes.apply`, `clusterTarget.use` (watch also requires policy `watch`) | `result`, `resources`, `status` |
| `kubernetes.rolloutStatus` | `kind`+`name` or `resource` | `watch` | `workflow.execute`, `kubernetes.read`, `clusterTarget.use` | `result`, `status` |

Non-observable apply kinds (ConfigMap, Service, CronJob, Ingress, NetworkPolicy) with `wait=ready` return `observation=skipped` and do not require `watch`.

### Observation states

| `result.observation` | Meaning |
| --- | --- |
| `ready` | Watched object reached the kind’s ready condition (see below). |
| `failed` | Job `Failed=True` or Deployment `Progressing` `ProgressDeadlineExceeded`. |
| `timeout` | `timeoutSeconds` elapsed. Resources left in place. |
| `canceled` | Caller/context canceled. Resources left in place. |
| `skipped` | Kind is not observable, or apply `wait=ready` had no watchable docs. |
| `progressing` | Intermediate poll state only; not a terminal result. |

Ready conditions (secret-free counters on `status.progress[]`):

- **Deployment:** `observedGeneration >= generation`, `updated/ready/availableReplicas == spec.replicas`, `unavailableReplicas == 0`, `Available=True` when present.
- **StatefulSet:** `readyReplicas == spec.replicas` (and `updatedReplicas` when reported).
- **DaemonSet:** `updatedNumberScheduled` and `numberAvailable` equal `desiredNumberScheduled`.
- **Job:** `Complete=True` or `succeeded >= completions`; `Failed=True` is `failed`.

`status.progress[]` fields: `kind`, `namespace`, `name`, `generation`, `observedGeneration`, replica/job counters, `state`, `reason`. No raw object dump, Secret data, or kubeconfig.

### Result / audit / error shapes

Success `result` extends E7.2 with `observation` (`ready`/`skipped`/…), `status.progress[]`, and `audit`. `audit` (and the persistable snapshot) is secret-free: `actorId`, `operation`, `clusterTargetId`, `namespace`, `policyRevision`, `policyDigest`, `manifestDigest`, `resources[]`, `serverDryRun`, `applied`, `watch`, `observation`, `correlationId`, `outcome`, optional `errorCode`.

| `error.code` | HTTP-ish | When |
| --- | --- | --- |
| (E7.2 codes unchanged) | | |
| `timeout` | 408 | Bounded watch elapsed. No delete/rollback. |
| `canceled` | 408 | Observation canceled. No delete/rollback. |
| `rollout-failed` | 409 | Deployment deadline exceeded or Job failed. No delete/rollback. |
| `verb-denied` / `rbac-denied` | 403 | Policy or Kubernetes RBAC denied `watch`. |

Out of scope: `apps/web` rewrite, deletion, rollback, force apply, SSH/script engines.

## SSH target and command-profile management (E8.1)

Control-plane hardening on the existing E4.2 `ssh-targets` / `command-profiles` collections. E8.2 (below) is the isolated `ssh.run` worker. E8.3 (below) implements retry/indeterminate verification.

**UI route map (Chloe):** same cookie session + `X-CSRF-Token` + camelCase JSON as E4.2. Use `GET /ops-config/catalog` (`sshEngine`) or `GET /ssh/catalog` for parameter types, render rules, retry-safe flags, and error codes. SSH-target credential pickers must list only workspace `type=ssh_private_key` credentials (secret fields `privateKey` / `passphrase`, never shown). Host-supplied `id` / `workspaceId` is `400`. Cross-workspace credential or resource UUIDs are `404`. Next can proxy `/api/control-plane/ssh/catalog` the same way as kubernetes/ops-config. Do not rewrite `apps/web` in this API story. Keep #82 open until target/profile UI surfaces land.

Suggested UI flow:

1. Create a vault credential `type=ssh_private_key` (E4.1). Never echo the private key or passphrase.
2. Optionally create/publish a `policies` resource with `kind=ssh` and `allowedHosts` / `allowedAddresses` (empty present lists are rejected).
3. Create/publish an `ssh-targets` draft: `{name, spec:{credentialId, hostname, hostKeyFingerprint, port?, allowedAddresses?, policyId?}}`.
4. Create/publish a `command-profiles` draft: `{name, spec:{parameterSchema, template, retrySafe?, verification?, policyId?}}`. Template placeholders are `{name}` only. The API renderer quotes string values with POSIX single quotes; it never interpolates `$()`, backticks, `${`, or `{{`. `retrySafe=true` requires `verification.template` (an idempotent probe).
5. Select as today (`POST /ssh-targets/{id}/select`, `POST /command-profiles/{id}/select`). Publish/select re-checks credential type, fingerprint format, allowlists, and parameter schema. Workflow publish pins the exact target + profile revisions and rejects `ssh.run` parameters outside the pinned schema.
6. Later draft edits do **not** retarget a pin. Published revisions are immutable. Drafts remain editable to create the next revision.

### `spec` field map

**`ssh_target`**

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `credentialId` | yes | UUID | Workspace `ssh_private_key` only |
| `hostname` | yes | string | DNS name or IP; lowercased |
| `hostKeyFingerprint` | yes | string | `sha256:<64 hex>` or OpenSSH `SHA256:<base64>` |
| `port` | no | integer | Default `22`; range 1–65535 |
| `username` | no | string | Non-root remote account. Omitted targets use `flowforge` at execute. `root` / `toor` / `administrator` → `400`. |
| `allowedAddresses` | no | string[] | IP or CIDR; present empty → `400`; no default-route CIDR |
| `policyId` | no | UUID | Published `kind=ssh` policy |

**`command_profile`**

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `parameterSchema` | yes | object | `{type:"object", additionalProperties:false, required?, properties}` |
| `parameterSchema.properties.*` | — | object | `type`: `string` \| `integer` \| `boolean`. String: `enum`, `minLength`, `maxLength`, `pattern`, `sensitive`. Integer: `enum`, `minimum`, `maximum`. Names: `[A-Za-z][A-Za-z0-9_]{0,31}`. Max 16 properties. |
| `template` | yes | string | Reviewed command with `{name}` placeholders matching properties. No interpolation tokens. |
| `retrySafe` | no | boolean | Default `false`. When `true`, `verification` is required. |
| `verification` | when `retrySafe` | object | Idempotent probe. `template` (reviewed `{name}`), `expectExitCode` (default 0), `expectStdoutContains?`, `onMatch` (`already-applied` default), `onMismatch` (`safe-to-retry` default), `onError` (`indeterminate` only). |
| `policyId` | no | UUID | Published `kind=ssh` policy |

### Catalog (`GET /ssh/catalog`)

| Field | Purpose |
| --- | --- |
| `credentialType` | `ssh_private_key` |
| `credentialSecretFields` | `privateKey`, `passphrase` (never returned on ops-config) |
| `parameterTypes[]` | Allowed schema types + constraints |
| `render` | `owner=reviewed-profile-renderer`, `quoting=posix-single-quotes`, `rawShellInterpolation=false`, forbidden tokens |
| `retry` | `defaultMaxAttempts=0`, `blindRetry=false`, `leaseLossOutcome=indeterminate`, `requiresVerificationWhenRetrySafe`, `whenRetryAllowed`, `ui` (indeterminate badge / when Retry is enabled), `probe` (verification contract) |
| `publishRules` | Required fields, empty-allowlist rejection, fingerprint format, pin immutability |
| `evaluationKeys[]` | SSH policy aliases (`allowedHosts`/`hosts`, `allowedAddresses`/`addresses`) |
| `nodes[]` | `ssh.run` wizard map (`sshTargetId`, `commandProfileId`, `parameters`, `timeoutSeconds`, `retryPolicy`) |
| `errors[]` | Codes for Chloe: `invalid-target`, `invalid-fingerprint`, `invalid-address`, `empty-allowlist`, `invalid-schema`, `invalid-template`, `interpolation-denied`, `parameter-rejected`, `credential-denied`, `forbidden`, `host-key-mismatch`, `address-denied`, `timeout`, `canceled`, `auth-denied`, `forwarding-denied`, `root-denied`, `handle-forbidden`, `retry-denied`, `invalid-verification`, `policy-denied`, `connect-failed`, `command-failed`, `indeterminate` |
| `permissions[]` | `workflow.execute`, `ssh.run`, `sshTarget.use`, `commandProfile.use` |
| `isolation` | Hard denies (password/agent/port-forward/proxy/auto-accept/shell), known-host fingerprint match, resolve-then-allowlist, connect verified address only, ephemeral handle, default username `flowforge` |

RBAC: `opsconfig.view` list/get/select/catalog; `opsconfig.edit` create/save/disable; `opsconfig.publish` publish; execute paths require `sshTarget.use` and `commandProfile.use` plus `ssh.run`. Viewer can read catalogs; editor can draft; publisher can publish revisions.

## Isolated ssh.run (E8.2)

Worker library path for `ssh.run`. No new browser routes. Workers claim E5.2 jobs and call `ssh.Execute`; `privateKey` / passphrase never appear on job JSON, outputs, or audit details. `GET /ssh/catalog` now includes `isolation` plus engine errors. The live workflow catalog is `GET /workflows/catalog` (`allowedWith`, `policy.defaultMaxAttempts=0`, `redaction`).

**UI route map (Chloe):** do **not** stack on another feature branch. Cookie session + `credentials: "include"`; send `X-CSRF-Token` on POST. JSON is camelCase. Host-supplied `id` / `workspaceId` is `400`. Do not rewrite `apps/web` in this API story. Wizard/library should read `allowedWith` on `ssh.run` and `isolation` / `errors[]` from `GET /ssh/catalog`. Keep #83 open until node/config UI surfaces land.

### Node contract

| Field | Required | Notes |
| --- | --- | --- |
| `sshTargetId` | yes | Published SSH target UUID. Execution pins the revision. |
| `commandProfileId` | yes | Published command profile UUID. Parameters must match the pinned schema. |
| `parameters` | no | Typed object. Reviewed renderer POSIX-quotes strings. Extra/missing/invalid → `parameter-rejected`. |
| `timeoutSeconds` | no | 1–3600, default 60. Bounds connect + command. |
| `retryPolicy` | no | `{maxAttempts:0-5}`. **Default `maxAttempts=0`.** `maxAttempts>0` requires pinned profile `retrySafe=true` **and** `verification`. |
| `policyId` | no | Optional published `kind=ssh` policy UUID. |

Permissions: `workflow.execute`, `ssh.run`, `sshTarget.use`, `commandProfile.use`. Policy is revalidated immediately before connect.

Outputs: `result` (redacted summary), `stdout` (bounded, secret-stripped), `exitCode`.

### Security guarantees

1. Ephemeral credential handle: vault `privateKey` is parsed into an in-memory signer. Handle JSON is `{id,sshTargetId,credentialId?,username?,expiresAt}` only.
2. Known-host verification: presented host key SHA-256 must match `hostKeyFingerprint`. Mismatch → `host-key-mismatch`. Auto-accept is disabled.
3. Approved resolver: hostname is resolved through the engine resolver (IP literals skip DNS). **Every** resolved address must be in the target `allowedAddresses` (and policy allowlist when present). A DNS name without an allowlist is denied.
4. Connect only to the verified IP (`ip:port`). Dialing the original hostname is denied (anti DNS-rebinding / SSRF).
5. Key-only auth. Password, keyboard-interactive, agent forwarding, port forwarding, proxy commands, and interactive shells (`RequestPty` / `Shell`) are hard-denied.
6. Non-root remote account: default `flowforge`. `root` / `toor` / `administrator` → `root-denied`. Optional target `username` is stored when present.
7. Redacted results + audit: parameter **names** always; sensitive values `[redacted]`; command text is stored as `commandDigest` only; exit outcome; correlation ID. PEM / private-key shaped stdout is `[redacted]`.
8. Lease loss or unknown provider outcome after dispatch → `indeterminate`. The engine never blindly repeats the command. See E8.3.

### Result / error shapes

Success `result`: `{ok, operation, sshTargetId, commandProfileId, hostname, port, username, resolvedAddresses, connectedAddress, parameterNames, parameters, commandDigest, stdout, exitCode, retry:{maxAttempts,executedAttempts,retrySafe,allowed,requiresVerification,verificationDeclared,semantics,note,verification?}, policyRevision?, policyDigest?, correlationId, audit}`.

| `error.code` | HTTP-ish | When |
| --- | --- | --- |
| `parameter-rejected` / `interpolation-denied` / `invalid-template` / `invalid-schema` | 400 | Profile render / schema |
| `forbidden` | 403 | Missing `workflow.execute`, `ssh.run`, `sshTarget.use`, or `commandProfile.use` |
| `host-key-mismatch` | 403 | Known-host fingerprint mismatch |
| `address-denied` | 403 | Resolved address outside allowlist or DNS without allowlist |
| `auth-denied` / `forwarding-denied` / `root-denied` / `handle-forbidden` / `policy-denied` | 403 | Hard denies / expired handle / policy |
| `timeout` / `canceled` | 408 | Bounded wait |
| `retry-denied` | 400 / 409 | `maxAttempts>0` without `retrySafe`+verification, or a step/execution retry that is not allowed |
| `invalid-verification` | 400 | `retrySafe=true` without a valid `verification` probe |
| `connect-failed` / `command-failed` | 502 | Transport / known non-zero exit |
| `indeterminate` | 409 | Lease lost after dispatch, unknown provider outcome, or verification could not confirm state. **Never a silent re-run.** |

## SSH indeterminate / retry semantics (E8.3)

Default retries are **zero**. A retry is allowed only when the **pinned** command profile has `retrySafe=true`, declares `verification`, and the node `retryPolicy.maxAttempts` is `1`–`5` with attempts remaining. Otherwise the engine and `POST /executions/{id}/retry` fail closed (`retry-denied`). Relates to #84 (already closed by #90) / Part of #81 — do not re-close #84; keep epic #81 open until the UI PR merges. This API is the contract.

**UI route map (Chloe):** do **not** rewrite `apps/web` in this API story. Read `GET /ssh/catalog` `retry.ui` + `retry.probe` and `GET /workflows/catalog` `ssh.run.policy.defaultMaxAttempts=0`. Cookie session + `X-CSRF-Token`. Show an unmistakable `indeterminate` badge (not color alone). Enable **Retry** only when `result.retry.allowed` is true (or evaluate `retryAllowed` on `POST /policy/evaluate` for `ssh.run`). Hide/disable Retry for non-retrySafe indeterminate — never imply the remote command did not run.

### When retry is allowed

| Condition | Retry |
| --- | --- |
| Omitted / `maxAttempts=0` (default) | No. First attempt only. |
| `maxAttempts>0` and profile `retrySafe=false` | `retry-denied` at execute, publish pin, and retry API. |
| `retrySafe=true` without `verification` | `invalid-verification` at profile save/publish. |
| `retrySafe=true` + verification + remaining attempts + status `failed` / `canceled` / `indeterminate` | Yes — **after** the probe. |
| Lease loss / unknown outcome after dispatch | Status `indeterminate`. No command on that call. A later attempt may run **only** the verification probe first. |

### Verification contract

`spec.verification` is an idempotent read-only probe rendered with the same `parameterSchema` and POSIX quoting as `template`. It is **never** the mutating command.

| Field | Default | Meaning |
| --- | --- | --- |
| `template` | required | Reviewed `{name}` probe |
| `expectExitCode` | `0` | Match |
| `expectStdoutContains` | omitted | Optional substring match on redacted stdout |
| `onMatch` | `already-applied` | Probe matched: do **not** re-run the mutating command; treat as success |
| `onMismatch` | `safe-to-retry` | Probe did not match: one more mutating attempt is allowed |
| `onError` | `indeterminate` | Probe itself failed; stay indeterminate |

`result.retry.verification.outcome` is `already-applied` / `safe-to-retry` / `indeterminate`. `audit.verificationOutcome` is secret-free.

### Execution retry APIs

`POST /executions/{id}/retry` and `.../steps/{stepId}/retry` still require `workflow.execute`. Core `data.*` / `flow.*` rules are unchanged. For `ssh.run`:

- Default `maxAttempts=0` → `409` `retry-denied`
- Non-retrySafe or missing verification → `409` `retry-denied`
- `indeterminate` without retrySafe → stays indeterminate; retry denied
- retrySafe + verification + remaining attempts → `201` queues a new attempt that **must verify first** (never a blind re-run)

Out of scope: `apps/web` rewrite; Kubernetes/script engines.

Out of scope: E10 webhook/schedule triggers, durable wait/resume across worker loss, provider engines.

Types: `kubernetes` (`secret.kubeconfig`), `ssh_private_key` (`privateKey`, optional `passphrase`), `token` (`token`), `webhook_secret` (`secret`), `provider` (`token`). Metadata cannot store those secret keys. `fingerprint` is `sha256:<hex>` of canonical secret JSON (not reversible).

## Script source validation and publish pipeline (E9.1)

Control-plane publish/scan/sign/pin for `script.python` and `script.go`. Isolated runners are E9.2 below. Typed I/O execution is E9.3. Revocation/emergency-stop is E9.4 below. Relates to #92 / Part of #91. Keep #92 open until Chloe's UI lands; do not treat this API story as closing the issue.

**UI route map (Chloe):** do **not** rewrite `apps/web` in this API story. Cookie session + `credentials: "include"`; send `X-CSRF-Token` on POST. JSON is camelCase. Host-supplied `id` / `workspaceId` is `400`. Cross-workspace artifact or runtime-profile UUIDs are `404`. Read `GET /scripts/catalog` (or `GET /ops-config/catalog` → `scriptEngine`) for node fields, publish rules, and error codes. Wizard/library should use `GET /workflows/catalog` `script.python` / `script.go` `allowedWith`. YAML still holds source; the artifact digest lives **outside** YAML on version pins. Execution uses the pinned digest only.

Suggested UI flow:

1. Author `script.python` / `script.go` with `source`, `entrypoint` (basename only: `main.py` / `main.go` or Go `package.Function`), published `runtimeProfileId`, and `timeoutSeconds` (1–3600). Optional `memoryMiB` / `cpuMillis` / `processes` / `inputSchema` / `outputSchema` / `policyId`.
2. Create or reuse an approved runtime profile (`POST /runtime-profiles` → publish). Spec requires `language` (`python`/`go`), digest-pinned `imageDigest` + `dependencyLockDigest` (`sha256:<64 hex>`), and `limits.{cpuMillis,memoryMib,timeoutSeconds,processes}`. Mutable image tags are rejected.
3. Save draft YAML as today. Drafts never execute.
4. Publish: `POST /workflows/{id}/publish` `{revision, note}` packages, scans, signs, and pins each script node. Response includes `scriptArtifacts[]` (`nodeId`, `artifactId`, `digest`, `scanStatus`, `signature`). Dedicated publish: `POST /scripts` `{language,source,entrypoint,runtimeProfileId,...}` → `201` artifact (no package blob).
5. Inspect pins: `GET /workflows/{id}/versions/{versionId}/script-artifacts` and `GET /scripts/{artifactId}`.
6. Run: `POST /workflows/{id}/executions` `{workflowVersionId}`. Requires `workflow.execute` + `script.run` + `runtimeProfile.use`. Mutable / unscanned / unsigned / failed-scan artifacts fail closed (`artifact-*`) **before** a run is created.

RBAC: `opsconfig.view` for catalogs; `workflow.publish` for dedicated `POST /scripts` and workflow publish; `workflow.view` for get/list artifacts; operator/admin have `script.run` and `runtimeProfile.use`. Viewer cannot publish or run.

Signing: HMAC-SHA256 over the content digest, domain-separated with SHA-3 (`SCRIPT_SIGNING_KEY`, 32-byte hex/base64). Signature format `hmac-sha256:<hex>`. Scan reuses the E5.3 artifact scanner; secrets in published source fail closed (not just redacted). Max source 64 KiB. Same digest reuses the immutable workspace artifact.

### Routes

| Route | Purpose | Success | Failure |
| --- | --- | --- | --- |
| `GET /api/v1/scripts/catalog` | Node fields, publish rules, isolation, I/O/retry, revocation + emergency-stop, error codes. Requires `opsconfig.view`. | `200` catalog | `401` `403` |
| `POST /api/v1/scripts` | Dedicated package/scan/sign. Requires `workflow.publish`. Body `language`, `source`, `entrypoint`, `runtimeProfileId` (optional version, schemas, limits). Host-supplied workspace IDs rejected. | `201` artifact | `400` `401` `403` `404` |
| `GET /api/v1/scripts/{artifactId}` | Metadata + digest + scan/signature + `revokedAt?`. Never the package blob. Requires `workflow.view`. | `200` artifact | `401` `403` `404` |
| `POST /api/v1/scripts/{artifactId}/revoke` | Revoke a published artifact. Requires `script.revoke`. Idempotent. Body `{reason?}`. | `200` artifact | `400` `401` `403` `404` |
| `GET /api/v1/workflows/{workflowId}/versions/{versionId}/script-artifacts` | Pins bound at publish. Requires `workflow.view`. | `200` `{items}` | `401` `403` `404` |
| `POST /api/v1/workflows/{workflowId}/publish` | Also packages/scans/signs/pins script nodes. | `201` `{workflow,version,pins,scriptArtifacts}` | `400` `401` `403` `404` `409` |

### Node `with` fields (`script.python` / `script.go`)

| Field | Required | Kind | Notes |
| --- | --- | --- | --- |
| `source` | yes | string | Visible in YAML. UTF-8, no NUL, ≤64 KiB. Secrets (PEM, kubeconfig, tokens) rejected. Go must declare `package`. |
| `entrypoint` | yes | string | Basename only. Python: `*.py`. Go: `*.go` or `package.Function`. Paths/`..` rejected. |
| `runtimeProfileId` | yes | uuid | Published `runtime_profile`. Language must match the node. Workflow publish pins the exact revision. |
| `timeoutSeconds` | yes | integer | 1–3600. Must not exceed the pinned profile. |
| `memoryMiB` | no | integer | 32–2048. Must not exceed the pinned profile. |
| `cpuMillis` | no | integer | 1–8000. Must not exceed the pinned profile. |
| `processes` | no | integer | 1–256. Must not exceed the pinned profile. |
| `inputSchema` / `outputSchema` | no | object | Documented JSON Schema subset. A declared schema must set root `type` to the string `object` (matches the input/result ports). Omitted / non-object roots are `invalid-schema`. Shape validated at publish; values validated at execute (16 KiB, no secrets). |
| `retrySafe` | no | boolean | Default `false`. When `true`, `idempotencyKey` and `verification` are required. |
| `idempotencyKey` | when `retrySafe` | string | 1–128 identifier. Required with verification to mark the node retry-safe. |
| `verification` | when `retrySafe` | object | Idempotent `declared-hook`. `behavior`, optional `expect`, `onMatch` / `onMismatch` / `onError`. |
| `retryPolicy` | no | object | `{maxAttempts:0-5}`. **Default `maxAttempts=0`.** `maxAttempts>0` requires `retrySafe` + `idempotencyKey` + `verification`. |
| `policyId` | no | uuid | Optional published `kind=script` policy. |

Forbidden `with` keys: `env`, `environment`, `secrets`, `credentials`, `privateKey`, `token`, `password`, `kubeconfig`, `command`, `shell`.

### Artifact JSON (never `package` / `storageRef`)

`id`, `language`, `entrypoint`, `digest` (`sha256:<hex>`), `signature` (`hmac-sha256:<hex>`), `scanStatus` (`clean` required to execute), `status` (`published` required to execute), `runtimeProfileId`, `runtimeProfileVersionId`, `runtimeProfileDigest`, `sourceBytes`, `metadata` (secret-free), `createdBy`, `createdAt`, `revokedAt?`, `revokedBy?`.

### Catalog error codes (`GET /scripts/catalog` → `errors[]`)

| Code | Status | When |
| --- | --- | --- |
| `invalid-source` | 400 | Missing, not UTF-8, wrong language shape, or >64 KiB |
| `invalid-entrypoint` | 400 | Empty, a path, or language mismatch |
| `invalid-runtime-profile` | 400 | Missing, unpublished, or not digest-pinned |
| `language-mismatch` | 400 | `script.python` must pin a python profile |
| `invalid-schema` | 400 | Declared I/O schema is not the documented subset, or a value failed it |
| `secret-forbidden` | 400 | Source, YAML, persisted input, or output contained secret material |
| `size-limit` | 400 | Source, timeout, resource, or I/O size cap exceeded |
| `input-rejected` | 400 | Execution input failed schema, size, or secret checks before inject |
| `output-too-large` | 400 | Runner output exceeded the 16 KiB persist cap |
| `artifact-mutable` | 400 | Draft/unsigned package cannot execute |
| `artifact-unscanned` | 400 | `scanStatus` pending or missing |
| `artifact-unsigned` | 400 | Signature missing or does not verify |
| `artifact-scan-failed` | 400 | `scanStatus` is failed |
| `artifact-revoked` | 409 | Revoked artifacts cannot start (rechecked at start/claim/heartbeat-before-dispatch/Execute) |
| `permission-denied` | 403 | Missing `workflow.execute`, `script.run`, or `runtimeProfile.use` |
| `isolation-denied` | 403 | Requested runner environment violates isolation |
| `root-denied` | 403 | Runner UID/GID must be non-root (`65532`) |
| `writable-rootfs-denied` | 403 | Root filesystem is read-only |
| `capability-denied` | 403 | All Linux capabilities are dropped |
| `privilege-escalation-denied` | 403 | `no_new_privs` required |
| `metadata-denied` | 403 | Cloud metadata (`169.254.169.254`) is denied |
| `egress-denied` | 403 | Destination outside the default-deny allowlist |
| `package-install-denied` | 403 | Runtime `pip` / `go get` / `apt` is denied |
| `image-denied` | 400 | Arbitrary or mutable base images |
| `docker-socket-denied` | 403 | Host Docker socket is denied |
| `service-account-denied` | 403 | Kubernetes SA mounts are denied (MVP) |
| `resource-limit` | 400 | CPU / memory / process / time exceeded the pin |
| `indeterminate` | 409 | Lease lost after dispatch, unknown outcome, uncertain emergency stop, or verification could not confirm state. Never a silent re-run |
| `emergency-stopped` | 409 | Emergency stop halted the script before dispatch |
| `emergency-stop-denied` | 403 | Missing `script.emergencyStop` or policy `allowEmergencyStop=false` |
| `retry-denied` | 400 / 409 | `maxAttempts>0` without retrySafe+idempotencyKey+verification, or a step retry that is not allowed |
| `invalid-verification` | 400 | `retrySafe=true` without a valid idempotency key or `verification.behavior` |
| `handle-forbidden` | 403 | Handle missing, expired, unscoped, or contained plaintext secrets |
| `env-denied` | 403 | Runtime env key outside the allowlist, or plaintext credentials supplied as env |
| `runner-not-implemented` | 501 | Live container runtime requested; CI harness only |

Out of scope for E9.1: `apps/web` rewrite, typed I/O execution (E9.3), revocation/emergency-stop (E9.4), SSH/K8s engines.

## Isolated script runners (E9.2)

Workers claim an E5.2 job, then call `scripts.Execute` after `VerifyForDispatch`. No new browser routes. Read `GET /scripts/catalog` → `isolation` + `errors[]` + `runtimeProfile`. Relates to #93 / Part of #91. **Do not close #93** — Chloe may land runtime-profile UI separately. Keep #93 open.

**UI route map (Chloe):** do **not** rewrite `apps/web` in this API story. Cookie session + `credentials: "include"`; send `X-CSRF-Token` on POST. JSON is camelCase. Host-supplied `id` / `workspaceId` is `400`. Catalog isolation fields are additive (existing booleans stay). Wizard/library can show isolation guarantees from `GET /scripts/catalog`. Execution still starts with `POST /workflows/{id}/executions` as today; the worker — not the browser — runs the isolated script.

### Runtime profile fields the runner consumes

| Field | Required | Notes |
| --- | --- | --- |
| `language` | yes | `python` or `go` (must match the node) |
| `imageDigest` | yes | `sha256:<64 hex>` only. Mutable tags (`:latest`, `python:3.12`) rejected |
| `dependencyLockDigest` | yes | `sha256:<64 hex>` locked dependency profile |
| `limits.cpuMillis` | yes | 1–8000. Node `cpuMillis` must not exceed this |
| `limits.memoryMib` | yes | 32–2048. Node `memoryMiB` must not exceed this |
| `limits.timeoutSeconds` | yes | 1–3600. Node `timeoutSeconds` must not exceed this |
| `limits.processes` | yes | 1–256 |
| `egress.destinations` | no | `[{host,port,protocol}]`. Omitted = default-deny. Metadata / loopback / `*` rejected |
| `egress.dnsConstrained` | no | Must be `true` when present |

### Isolation guarantees (`GET /scripts/catalog` → `isolation`)

Non-root UID/GID `65532`, read-only root FS, ephemeral writable `/workspace`, drop `ALL` capabilities, `no_new_privs`, no host Docker socket, no cloud metadata, no Kubernetes SA mount (MVP deny), approved digest-pinned images only, runtime package install denied, default-deny egress with constrained DNS.

Python: approved digest-pinned image + lock. Go: precompiled signed binary from the published source in a controlled builder. CI uses `HarnessRuntime` + `StubBuilder` (HMAC of the published digest) so `go test` does not need runc or a Go toolchain. Manifests: `deploy/kubernetes/script-runner-deployment.yaml` and `script-runner-networkpolicy.yaml`.

### Result shape (job output)

`{ok, operation, language, entrypoint, artifactId, artifactDigest, signatureVerified, scanStatus, runtimeProfileId, runtimeProfileDigest, isolation, binary?, stdout, stderr, exitCode, input, output, handles, env, inputValidated, outputValidated, retry, correlationId, audit, error?}`. Never includes package blobs, `storageRef`, or plaintext credentials. Lease loss or uncertain emergency stop → `error.code=indeterminate` (no rerun).

Out of scope for E9.2: `apps/web` rewrite, typed I/O + lease-loss recovery (now E9.3 below), artifact revocation + emergency stop (E9.4).

## Typed script I/O and recovery (E9.3)

Workers still claim an E5.2 job and call `scripts.Execute`. No new browser routes. Read `GET /scripts/catalog` → `io` + `retry` + `errors[]`. Relates to #94 / Part of #91. **Do not close #94** — Chloe may land I/O schema / result UI separately. Keep #94 open.

**UI route map (Chloe):** do **not** rewrite `apps/web` in this API story. Cookie session + `credentials: "include"`; send `X-CSRF-Token` on POST. JSON is camelCase. Host-supplied `id` / `workspaceId` is `400`. Wizard/library should read `allowedWith` (`inputSchema`, `outputSchema`, `retrySafe`, `idempotencyKey`, `verification`, `retryPolicy`) from `GET /workflows/catalog` and `GET /scripts/catalog` `io` / `retry.ui` / `retry.probe`. Show an unmistakable `indeterminate` badge. Enable **Retry** only when `result.retry.allowed` is true.

### I/O contract

1. Validate execution `input` against the declared `inputSchema` and the 16 KiB size limit **before** inject. Reject secret keys/values in persisted input and in YAML (already fail-closed at publish).
2. Inject only scoped short-lived handles (`{id,credentialId?,workspaceId?,scopes,expiresAt}`). Plaintext credentials never enter env, logs, job JSON, or audit details. Handle TTL default 60s, max 5m.
3. Runtime env is an allowlist only: `FLOWFORGE_CORRELATION_ID`, `FLOWFORGE_LANGUAGE`, `FLOWFORGE_ENTRYPOINT`, `FLOWFORGE_ARTIFACT_DIGEST`, `FLOWFORGE_RUNTIME_PROFILE_ID`, `FLOWFORGE_HANDLE_IDS`, `FLOWFORGE_IDEMPOTENCY_KEY`. `AWS_*` / `KUBECONFIG` / `DOCKER_*` / secret-named keys are `env-denied`.
4. Validate runner output against `outputSchema` and the 16 KiB cap. A declared schema must set root `type` to the string `object` (omitted / `array` / `string` / other roots are `invalid-schema`). The persisted result is that validated object — never rewritten as `{"value": parsed}`. A persisted `{}` is a real object and is not treated as missing prior output. Nil schema still uses a persist envelope (`stdout`) for non-JSON. Redact token-shaped strings before persist/audit. Irredactable secrets fail closed.

### Retry / lease-loss contract

Default retries are **zero**. A node is retry-safe only when it declares `retrySafe=true`, an `idempotencyKey`, and `verification.behavior=declared-hook`, and `retryPolicy.maxAttempts` is `1`–`5` with attempts remaining. Otherwise execute and `POST /executions/{id}/retry` fail closed (`retry-denied`).

| Condition | Retry |
| --- | --- |
| Omitted / `maxAttempts=0` (default) | No. First attempt only. |
| `maxAttempts>0` without `retrySafe` + key + verification | `retry-denied` at validate, execute, and retry API. |
| `retrySafe=true` without key or verification | `invalid-verification` at validate/publish. |
| `retrySafe` + key + verification + remaining attempts + status `failed` / `canceled` / `indeterminate` | Yes — **after** the verification hook. |
| Lease loss / unknown outcome after dispatch | Status `indeterminate`. No script on that call. A later attempt may run **only** the verification hook first. |

`verification` is an idempotent hook, never a blind re-run of the mutating script.

| Field | Default | Meaning |
| --- | --- | --- |
| `behavior` | required | Must be the string `declared-hook`. Missing / non-string / empty is `invalid-verification`. |
| `expect` | omitted | Optional prior-output subset to match |
| `onMatch` | `already-applied` | Do **not** re-run; treat as success |
| `onMismatch` | `safe-to-retry` | One more mutating attempt is allowed |
| `onError` | `indeterminate` | Hook could not confirm state |

`result.retry` matches the E8.3 shape (`allowed`, `retrySafe`, `requiresVerification`, `verificationDeclared`, `verification.outcome`). `audit` is secret-free (`inputValidated`, `outputValidated`, `handleIds`, `verificationOutcome`).

### Execution retry APIs

`POST /executions/{id}/retry` and `.../steps/{stepId}/retry` still require `workflow.execute`. For `script.python` / `script.go`:

- Default `maxAttempts=0` → `409` `retry-denied`
- Non-retrySafe or missing key/verification → `409` `retry-denied`
- `indeterminate` without retrySafe → stays indeterminate; retry denied
- retrySafe + key + verification + remaining attempts → `201` queues a new attempt that **must verify first** (never a blind re-run)

Out of scope: `apps/web` rewrite; artifact revocation + emergency stop (E9.4 below).

## Artifact revocation and emergency stop (E9.4)

Workspace-scoped revoke plus authorized emergency-stop. Relates to #95 / Part of #91. **Keep #95 open** until Chloe's revoke/stop UI lands. Do not treat this API story as closing the issue.

**UI route map (Chloe):** do **not** rewrite `apps/web` in this API story. Cookie session + `credentials: "include"`; send `X-CSRF-Token` on POST. JSON is camelCase. Host-supplied `id` / `workspaceId` is `400`. Cross-workspace UUIDs are `404`. Read `GET /scripts/catalog` → `revocation` + `emergencyStop` + `errors[]`.

Suggested UI flow:

1. Inspect artifact: `GET /scripts/{artifactId}` — show `revokedAt` when present. Never show package blobs / `storageRef`.
2. Revoke: `POST /scripts/{artifactId}/revoke` `{reason?}` (`script.revoke`, operator/admin). Viewer → `403`. Idempotent `200` with `revokedAt`. Optional reason is secret-free (≤256 bytes).
3. After revoke, new starts fail closed (`409` `artifact-revoked`) before a run is created. Claim and first-heartbeat revalidate the same way and fail the unstarted job — they do not start a runner.
4. Emergency stop a running script: `POST /executions/{id}/emergency-stop` `{stepId?, uncertain?}` or `POST /executions/{id}/steps/{stepId}/emergency-stop`. Requires `script.emergencyStop`. A bound `kind=script` policy may set `allowEmergencyStop: false` (`403`). Viewer → `403`.
5. Queued / claimed (no heartbeat) → status `canceled` (runner never started). Running or `uncertain=true` → `indeterminate` until a verification hook resolves it. Never render success or failure from an uncertain stop. Unmistakable `indeterminate` badge (same as E9.3).
6. Audit: `script.artifact.revoke` and `script.emergency_stop` are identifiers only (artifact digest, actor, outcome). No secrets, package bytes, or storage locators.

RBAC: operator/admin have `script.revoke` and `script.emergencyStop`. Viewer/editor/publisher/approver do not.

| Route | Purpose | Success | Failure |
| --- | --- | --- | --- |
| `POST /api/v1/scripts/{artifactId}/revoke` | Revoke. Requires `script.revoke`. | `200` artifact | `400` `401` `403` `404` |
| `POST /api/v1/executions/{executionId}/emergency-stop` | Stop script steps. Requires `script.emergencyStop`. Policy-gated. | `200` detail | `400` `401` `403` `404` `409` |
| `POST /api/v1/executions/{executionId}/steps/{stepId}/emergency-stop` | Stop one script step. | `200` detail | `400` `401` `403` `404` `409` |

Out of scope: `apps/web` rewrite; new engine features beyond revoke/stop.

## Workflow YAML contract (E3.1)

Ephemeral parse/normalize/validate. Persistence is E3.2 below. Browser callers use the E2.3 session + CSRF pair; header-only callers skip CSRF.

**UI route map (Chloe):** `/workflows` is the E3.1 YAML operator, the E3.2 draft/publish/history operator, and the E3.3 core-neutral node palette/inspector (not the E6 canvas). Debounce YAML edits against validate; on Save-preview or import, call normalize and replace the editor buffer with `definitionYaml`. Show digest + `summary` counts; do not guess a graph on `invalid-workflow` — render `errors[]` (`path`, `line`, `column`, `code`, `message`). Catalog palette is `phase: core` only (`next` / `provider` fail closed). The E3.3 action palette further limits insert to the seven core neutral node types and never places triggers as graph nodes. Do not persist credentials or host-supplied workspace IDs in YAML.

The Next UI proxies E3.1 routes under `/api/control-plane/workflows/{catalog,validate,normalize}` and E3.2 routes under `/api/control-plane/workflows`, `/{workflowId}`, `.../draft`, `.../publish`, `.../compare`, `.../versions`, `.../export`, `.../restore`, and `.../executions` with session cookies, CSRF on POST/PUT, `If-Match` on draft save, workspace tenant + workbench headers, and preserved `application/problem+json` including `errors[]`.

| Route | Purpose | Success | Failure |
| --- | --- | --- | --- |
| `GET /api/v1/workflows/catalog` | Core trigger/node types, ports, and required `with` fields. E3.3 adds `rules` plus per-node `allowedWith`, `policy`, `bounds`, `redaction`, and port `classification` / `maxBytes` for the seven core neutral nodes. E7.2 adds the same metadata on `kubernetes.apply` / `get` / `list`. E7.3 adds `kubernetes.rolloutStatus` (`verb=watch`, `cancellation=stop-wait`). E8.2/E8.3 add `ssh.run` (`allowedWith`, `policy.defaultMaxAttempts=0`, `policy.verification=profile-declared-idempotent-probe`, redaction). E9.1/E9.3 add `script.python` / `script.go` (`source`, `entrypoint`, `runtimeProfileId`, `timeoutSeconds`, schemas, `retrySafe` / `idempotencyKey` / `verification` / `retryPolicy`, `policy.defaultMaxAttempts=0`, `policy.verification=node-declared-idempotent-hook`). E10.1 adds `triggers[type=manual].start` (route, CSRF, `workflow.execute`, published `workflowVersionId`, required idempotency key, 16 KiB typed input, status map) plus `allowedWith` / `bounds` / `redaction` on the manual trigger. E10.2 adds `triggers[type=webhook].ingress` (public `POST /hooks/{publicId}`, raw-body HMAC, replay/skew/rate, no session/CSRF) and `.admin` (cookie CRUD/rotate, `workflow.edit` / `workflow.view`, secret never returned) plus `allowedWith` (`schema` / `inputSchema` / `contentType`). Requires `workflow.view`. | `200` `{apiVersion,rules,triggers,nodes}` | `401` `403` |
| `POST /api/v1/workflows/validate` | Parse + graph validation. Body `application/yaml` or JSON `{definitionYaml}`. Requires `workflow.edit`. | `200` `{valid,summary,warnings}` | `400` `invalid-workflow` (with `errors`) / `401` `403` `413` |
| `POST /api/v1/workflows/normalize` | Validate, emit deterministic YAML, SHA-256 digest. Same body as validate. Requires `workflow.edit`. | `200` `{definitionYaml,digest,summary,warnings}` | `400` `invalid-workflow` (with `errors`) / `401` `403` `413` |

Parser limits: 256 KiB document, 4096 YAML nodes, depth 32, 64 KiB scalars, 128 workflow nodes. Rejected: custom tags, aliases, merge keys, duplicate keys, multiple documents, templates (`{{`, `${`, `{%`), unknown fields, next/provider node types, cycles, disconnected nodes, invalid/incompatible ports, non-UUID resource refs, secret/credential keys, Secret manifests, raw SSH commands.

**E3.3 core neutral contracts** (`flow.condition`, `flow.delay`, `data.set`, `data.map`, `data.validate`, `flow.stop`, `flow.fail`): allowlisted `with` only; 16 KiB port/`with` caps; 32 aggregation items; delay max `P7D`; `data.set` public/internal literals only; mapping/condition paths are dotted identifiers (no expression language); `flow.fail` requires `code`. New field codes: `classification-denied`, `output-too-large`, `aggregation-limit`, `invalid-schema`, `duration-limit`, `expression-forbidden`. Triggers remain `spec.triggers`, never graph nodes. Full catalog/schema map: [core node contracts](core-node-contracts.md). Evaluation is a Go contract package (deterministic, no durable worker sleep) used by validate when literal inputs are present — not the E5 engine.

Digest format: `sha256:<hex>` of normalized YAML. Normalization sorts labels, triggers, nodes, edges, and outputs by id/name and emits a single trailing newline. Literal blocks (`manifests`, `source`) keep inner text except trailing-newline normalization.

## Drafts, publish, and versions (E3.2)

Server-derived workspace scope, FORCE RLS, and composite `(workspace_id, id)` FKs apply. Only **normalized** YAML is stored. Published `workflow_versions` rows are immutable (trigger + `flowforge_app` has INSERT/SELECT only). Execution start pins a version/digest and, as of E5.1, persists redacted steps, jobs, and audit events.

**UI route map (Chloe):** persist drafts through these shapes. `/workflows` and the Next proxies under `/api/control-plane/workflows/...` are in place. JSON field names are camelCase (`definitionYaml`, `draftRevision`, `workflowVersionId`). Host-supplied `id` / `workspace_id` / `workspaceId` on write bodies is `400`. Cross-workspace UUIDs are `404`. Cookie sessions send `X-CSRF-Token` on POST/PUT.

Suggested UI flow:

1. `POST /workflows` (import/create) → keep `workflow.id` and `draft.revision`.
2. Debounced `POST /workflows/validate` while editing; Save calls `PUT /workflows/{id}/draft` with the last seen `revision`.
3. On `200`, replace the editor buffer with `draft.definitionYaml` and store `draft.revision` / `draft.digest`.
4. On `409` `conflict`, `GET` the draft and offer reload (stale tab).
5. Publish: `POST /workflows/{id}/publish` `{revision, note}` (`workflow.publish`).
6. History: `GET /workflows/{id}/versions`; export `GET .../versions/{versionId}/export`; compare `POST /workflows/{id}/compare`; restore `POST .../versions/{versionId}/restore`.
7. Run: only `POST /workflows/{id}/executions` `{workflowVersionId, idempotencyKey, input?}`. Never send `draft: true` / omit the version. E10.1 run-dialog contract is below.

| Route | Purpose | Success | Failure |
| --- | --- | --- | --- |
| `GET /api/v1/workflows` | List summaries (no YAML). Requires `workflow.view`. | `200` `{items}` | `401` `403` |
| `POST /api/v1/workflows` | Create workflow + draft revision 1. JSON `{definitionYaml, slug?, name?}`. Requires `workflow.edit`. | `201` `{workflow,draft}` | `400` `invalid-workflow` / `401` `403` `409` (slug) |
| `GET /api/v1/workflows/{workflowId}` | Summary including `draftRevision`, `draftDigest`, latest version. | `200` workflow | `401` `403` `404` |
| `GET /api/v1/workflows/{workflowId}/draft` | Current mutable draft. | `200` `{workflowId,revision,definitionYaml,digest,summary,warnings,validationState}` | `401` `403` `404` |
| `PUT /api/v1/workflows/{workflowId}/draft` | Conflict-safe save. JSON `{revision,definitionYaml}` or YAML + `If-Match: <revision>`. Requires `workflow.edit`. | `200` `{workflow,draft}` (revision incremented) | `400` `invalid-workflow` / `409` revision mismatch / `401` `403` `404` |
| `POST /api/v1/workflows/{workflowId}/publish` | Copy current draft to an immutable version. JSON `{revision?,note?}`. Requires `workflow.publish`. Script nodes are packaged, scanned, signed, and pinned (`scriptArtifacts[]`). | `201` `{workflow,version,pins,scriptArtifacts}` | `409` duplicate digest or stale revision / `400` invalid script / `401` `403` `404` |
| `GET /api/v1/workflows/{workflowId}/versions` | Version history, newest first. | `200` `{items}` | `401` `403` `404` |
| `GET /api/v1/workflows/{workflowId}/versions/{versionId}` | One frozen snapshot (includes YAML). | `200` version | `401` `403` `404` |
| `GET /api/v1/workflows/{workflowId}/versions/{versionId}/export` | Immutable export. JSON `{filename,definitionYaml,digest,...}`; `Accept: application/yaml` returns raw YAML. | `200` | `401` `403` `404` |
| `POST /api/v1/workflows/{workflowId}/compare` | Diff two refs. `{left:{kind:"draft"}, right:{kind:"version",versionId}}` (or `versionNumber`). | `200` `{equal,digestMatch,left,right,leftDigest,rightDigest,changes[]}` | `400` `401` `403` `404` |
| `POST /api/v1/workflows/{workflowId}/versions/{versionId}/restore` | Restore version as a **new** draft revision. JSON `{expectedRevision?}`. Requires `workflow.edit`. Version is unchanged. | `200` `{workflow,draft}` | `409` stale draft / `401` `403` `404` |
| `POST /api/v1/workflows/{workflowId}/executions` | **E10.1 authenticated manual start** (same route as E5). **Requires** published `workflowVersionId`. Drafts / missing version → `400`. Requires `workflow.execute` (+ engine perms as today). Pins `workflowVersionId` + `workflowDigest`. Run dialog **must** send `idempotencyKey` or `Idempotency-Key` (1–128 `[A-Za-z0-9._~:-]`). Unique on `(workspace, workflowVersionId, key)`. Same fingerprint → `200` `{replayed:true}` (no new steps/jobs). Different fingerprint → `409`. Bounded typed `input` (16 KiB; JSON-schema subset when the published manual trigger declares `schema` / `inputSchema` / `with.schema`). Secrets redacted before persist. Policy evaluate before dispatch: deny → `403`; approval-required without a valid bound approval → `409`. Secret-free `execution.start` audit records actor, version/digest, correlation, idempotency key, and outcome (`created` / `replayed` / `denied`). Script nodes also require `script.run` + `runtimeProfile.use` and a published, scanned, signed pin (`artifact-*` fail closed before a run is created). | `201` / `200` execution | `400` drafts cannot run / `400` invalid input / `400` artifact-* / `401` `403` `404` `409` |
| `GET /api/v1/workflows/{workflowId}/executions` | List runs for one workflow. Requires `execution.view`. Query `status`, `limit`. | `200` `{items}` | `401` `403` `404` |
| `GET /api/v1/workflows/{workflowId}/executions/{executionId}` | Execution detail (redacted `input`, `steps`, `jobs`, `pins`, `auditEvents`). Requires `execution.view`. Later draft edits do not change digest/version. | `200` | `401` `403` `404` |

## Authenticated manual starts (E10.1)

First-class E10 trigger. **Do not invent** `POST /executions` or webhook/schedule/wait-resume routes here. Extend the existing E5 start path.

**UI route map (Chloe):** do **not** rewrite `apps/web` in this API story. Cookie session + `credentials: "include"`; send `X-CSRF-Token` on POST. JSON is camelCase. Host-supplied `id` / `workspace_id` / `workspaceId` is `400`. Cross-workspace UUIDs are `404`. Suggested screen: workflow run dialog (published-version picker, typed input, idempotency field, CSRF). Catalog: `GET /workflows/catalog` `triggers[]` where `type=manual` (`start`, `allowedWith`, `bounds`, `redaction`). Next proxies stay `/api/control-plane/workflows/{id}/executions`. Webhook admin/ingress is E10.2 below. Schedule + durable `flow.approval` wait/resume are E10.3 below.

Suggested run-dialog flow:

1. List published versions only: `GET /workflows/{id}/versions`. Never offer the draft.
2. Read typed input schema from the selected version YAML (`GET /workflows/{id}/versions/{versionId}`): `triggers[].schema` / `inputSchema` / `with.schema` / `with.inputSchema`. Same fields are documented on `GET /workflows/catalog` `triggers[type=manual].start.schemaFields`.
3. Collect bounded JSON `input` (16 KiB). Strip secret field names in the UI; the API redacts before persist and rejects undeclared keys when `additionalProperties: false`.
4. Require an idempotency key (generate a letter-prefixed 1–128 token, or accept `Idempotency-Key`). Same key + same input/actor → `200` `replayed: true`. Same key + different fingerprint → `409` `conflict`. Do not retry 409 with a new key unless the operator intends a new run.
5. Optional pre-run: `POST /policy/evaluate` `{workflowId, workflowVersionId}`.
6. Start: `POST /workflows/{id}/executions` `{workflowVersionId, idempotencyKey, input?}` + CSRF. `201` new / `200` replay / `400` draft or invalid input / `403` missing `workflow.execute` or policy deny / `409` approval-required or fingerprint mismatch.
7. Confirmation / audit: render version digest, key, and redacted input. Server audit `execution.start` is secret-free and includes `actorId`, `workflowVersionId`, `workflowDigest`, `correlationId`, `idempotencyKey`, and `outcome`.

| Field | Required | Notes |
| --- | --- | --- |
| `workflowVersionId` | yes | Published version UUID. Missing / `draft: true` / `source: draft` → `400` |
| `idempotencyKey` | run dialog yes | Or `Idempotency-Key` header. Unique on `(workspace, workflowVersionId, key)` |
| `input` | no | Object, max 16 KiB. Validated against the published manual trigger schema when declared |
| `X-CSRF-Token` | browser yes | Cookie session. Header-only callers skip CSRF |

Out of scope for E10.1: webhook triggers (E10.2 below), schedules + durable `flow.approval` wait/resume (E10.3 below), `http.request` / notification actions (E10.4), `apps/web` rewrite.

## Replay-safe webhooks (E10.2)

First-class E10 trigger. Opaque `publicId` (`wh_` + 64 hex) is generated server-side and is not guessable. Secrets live in the vault as type `webhook_secret` (`secret` field) and are **never** returned, logged, or placed in the URL. YAML may declare only `schema` / `inputSchema` / `contentType`; trigger IDs and secret refs stay outside YAML.

**UI route map (Chloe):** do **not** rewrite `apps/web` in this API story. Relates to #107 / Part of #105 — **Keep #107 open**. Cookie session + `credentials: "include"`; send `X-CSRF-Token` on admin POST/PATCH/DELETE. JSON is camelCase. Host-supplied `id` / `workspace_id` / `workspaceId` is `400`. Cross-workspace UUIDs are `404`. Catalog: `GET /workflows/catalog` `triggers[type=webhook].ingress` + `.admin`. Suggested screens: workflow trigger settings (create/rotate/disable, copy ingress path, field mapping, limits). Public ingress is origin-less server-to-server; hostile `Origin` still fails closed. Next proxies can expose `/api/control-plane/workflows/{id}/triggers` and `/api/control-plane/triggers/{id}`. Public `POST /api/v1/hooks/{publicId}` is not a browser session route. Schedule + approval wait/resume are E10.3 below.

Suggested admin flow:

1. Publish the workflow. Triggers must pin a published `workflowVersionId` (`GET /workflows/{id}/versions`). Drafts are `400`.
2. Create or pick a vault `webhook_secret`: `POST /credentials` `{type:"webhook_secret",displayName,secret:{secret}}` **or** inline `{secret:{secret}}` on trigger create.
3. Create: `POST /workflows/{id}/triggers` `{type:"webhook",workflowVersionId,secretCredentialId?,fieldMapping?,contentType?,maxBodyBytes?,clockSkewSeconds?,replayRetentionSeconds?,rateLimitPerMinute?,workspaceRatePerMinute?,maxConcurrency?,workspaceMaxConcurrency?}`. Response includes `id`, opaque `publicId`, `ingressPath`, `secretCredentialId`, `status`, mapping, and limits — never `secret`.
4. Copy `ingressPath` (`/api/v1/hooks/{publicId}`) and tell senders to sign `v1.{timestamp}.{rawBody}` with HMAC-SHA256. Headers: `X-FlowForge-Timestamp` (unix seconds) and `X-FlowForge-Signature: v1=<hex>`. Optional `Idempotency-Key`; otherwise the server derives `w` + 32 hex.
5. Rotate: `POST /triggers/{id}/rotate` `{secret:{secret}}`. Same credential id; plaintext never returned. PATCH rejecting `secret` is intentional — rotate is the only write path.
6. Disable/enable: `POST /triggers/{id}/disable` / `.../enable`. Disabled or unknown public IDs are `404` on ingress (do not leak existence vs disabled).
7. List/get: `GET /workflows/{id}/triggers`, `GET /triggers/{id}` (UUID or `publicId`). Viewer (`workflow.view`) can list/get; create/update/rotate/disable/enable/delete require `workflow.edit`.
8. Credential usage/deletion-impact includes `triggers[]`. Delete of a referenced `webhook_secret` is `409`.

Public ingress (`POST /api/v1/hooks/{publicId}`):

1. Lookup opaque id → workspace (no session). Unknown/disabled/unpublished → `404`.
2. Read the **raw** body first (per-trigger `maxBodyBytes`, default 64 KiB, hard 256 KiB). Oversize → `413`.
3. `Content-Type` must be `application/json` (MVP). Else `400`.
4. Timestamp skew (default 300s) → `401`. Signature (`v1` HMAC over `v1.{timestamp}.{raw}`) is verified **before JSON parse**. Bad sig / missing secret → `401`.
5. Replay of the same signed payload (sha256 retained ≥ skew, default 600s) → `409`. Rate/concurrency (default 60/min trigger, 300 workspace, 5 / 20 in-flight) → `429` `rate-limited`.
6. Parse JSON object, map allowlisted dotted identifier paths into bounded typed input (16 KiB; schema when the published webhook trigger declares one). Then start with E10.1 idempotency/fingerprint (`triggerType=webhook`, empty actor). `201` new / `200` same fingerprint / `409` fingerprint mismatch. Policy deny `403`; approval-required `409`.
7. Audit `execution.start` is secret-free and includes `triggerType`, `triggerId`, version/digest, correlation, idempotency key, and outcome. Raw bodies and secrets are never logged.

| Field | Required | Notes |
| --- | --- | --- |
| `workflowVersionId` | create yes | Published version UUID |
| `secretCredentialId` | create unless `secret` | Active vault `webhook_secret` |
| `secret` | create alt / rotate yes | `{secret:"..."}` only. Never returned |
| `fieldMapping` | no | Destination identifier → dotted source path. Empty copies the root object |
| `contentType` | no | `application/json` only in MVP |
| `maxBodyBytes` | no | Default 65536, hard 262144 |
| `clockSkewSeconds` | no | Default 300, hard 3600 |
| `replayRetentionSeconds` | no | ≥ skew, default 600, hard 7200 |
| `rateLimitPerMinute` | no | Default 60, hard 600 |
| `workspaceRatePerMinute` | no | Default 300, hard 3000 |
| `maxConcurrency` | no | Default 5, hard 20 |
| `workspaceMaxConcurrency` | no | Default 20, hard 100 |
| `X-CSRF-Token` | admin browser yes | Cookie session. Header-only callers skip CSRF |
| `X-FlowForge-Timestamp` | ingress yes | Unix seconds |
| `X-FlowForge-Signature` | ingress yes | `v1=<hex>` HMAC-SHA256 |
| `Idempotency-Key` | ingress no | Else derived from publicId+timestamp+raw |

| Route | Purpose | Success | Failure |
| --- | --- | --- | --- |
| `GET /api/v1/workflows/{workflowId}/triggers` | List webhook triggers for one workflow. Requires `workflow.view`. | `200` `{items}` | `401` `403` `404` |
| `POST /api/v1/workflows/{workflowId}/triggers` | Create. Pins published version + vault secret. Requires `workflow.edit` + CSRF. | `201` trigger | `400` `401` `403` `404` |
| `GET /api/v1/triggers/{triggerId}` | Metadata (UUID or `publicId`). Requires `workflow.view`. | `200` trigger | `401` `403` `404` |
| `PATCH /api/v1/triggers/{triggerId}` | Safe config (version, mapping, limits, credential ref). `secret` rejected. | `200` trigger | `400` `401` `403` `404` |
| `DELETE /api/v1/triggers/{triggerId}` | Delete trigger. Requires `workflow.edit` + CSRF. | `204` | `401` `403` `404` |
| `POST /api/v1/triggers/{triggerId}/rotate` | Rotate vault `webhook_secret`. Body `{secret:{secret}}`. | `200` trigger | `400` `401` `403` `404` |
| `POST /api/v1/triggers/{triggerId}/disable` | Disable; ingress becomes `404`. | `200` trigger | `401` `403` `404` |
| `POST /api/v1/triggers/{triggerId}/enable` | Re-enable. | `200` trigger | `401` `403` `404` |
| `POST /api/v1/hooks/{publicId}` | Public replay-safe ingress. No session/CSRF. | `201` / `200` execution | `400` `401` `404` `409` `413` `429` |

Out of scope: `apps/web` rewrite (Chloe), schedules + durable `flow.approval` wait/resume (E10.3 below), `http.request` / `notification.webhook` / `notification.email` (E10.4).

## Schedules and durable flow.approval (E10.3)

Timezone-explicit, version-pinned schedules plus mid-run `flow.approval` wait/resume that survives worker/pod loss. Relates to #108 / Part of #105 — **Keep #108 open** (Chloe enables schedule UI + approval decide UX against this map). Do **not** rewrite `apps/web` in this API story.

**Safe schedule defaults (documented + enforced):** `overlapPolicy=skip` (one active execution unless the workflow is verified idempotent), `misfirePolicy=ignore`, `catchUp=0` (no missed-slot replay). Timezone is a required IANA name — no implicit local TZ. Dispatcher starts with E10.1 idempotency (`sched-{scheduleId}-{unix}`), authz, and policy. Fail closed when the schedule is disabled or the pinned version is unpublished.

**UI route map (Chloe):** Cookie session + `credentials: "include"`; send `X-CSRF-Token` on POST/PATCH/DELETE. JSON is camelCase. Host-supplied `id` / `workspace_id` / `workspaceId` is `400`. Cross-workspace UUIDs are `404`. Catalog: `GET /workflows/catalog` `triggers[type=schedule].admin` + `GET /schedules/catalog`. Suggested screens: workflow schedule settings (timezone, cron XOR interval, overlap/catch-up, enable/disable) and approval inbox decide (resume). Next proxies can expose `/api/control-plane/schedules`. `POST /schedules/dispatch` is an operator/tick route, not a public ingress.

Suggested schedule flow:

1. Publish the workflow. Schedules must pin a published `workflowVersionId`. Drafts are `400`.
2. Create: `POST /schedules` `{workflowId,workflowVersionId,timezone,cron|interval,overlapPolicy?,misfirePolicy?,catchUp?}`. YAML schedule `with` fields are copied when omitted. Response includes `nextFireAt`.
3. List/get: `GET /schedules?workflowId=`, `GET /schedules/{scheduleId}`. Viewer (`workflow.view`) can list/get; create/update/enable/disable/delete require `workflow.edit`.
4. Enable/disable: `POST /schedules/{id}/enable` / `.../disable`. Disabled schedules are not due.
5. Tick: `POST /schedules/dispatch` `{scheduleId?}`. Requires `workflow.execute`. Overlap skip/reject produces no fire while another run for that schedule is `queued`/`running`/`waiting`. Catch-up `0` fires only the current slot.

Suggested approval wait flow:

1. Start a published version that contains `flow.approval`. Evaluate lists wait requirements with `wait: true` and still allows start.
2. Worker `POST /jobs/claim` parks the node: job/step/execution become `waiting` with **no lease**. Wait survives `POST /jobs/recover` and pod loss.
3. A bound approval row is materialized with `executionId`. Fingerprint includes version, target, policy, operation, node, and execution.
4. Approver decides: `POST /approvals/{id}/decide` `{decision}`. Fresh `approval.decide` + membership. Requester self-approval is `403`. Resume writes output port `approved` / `rejected`.
5. Expiry (`availableAt`) or binding change (policy/target/version digest) resumes `expired` and never `approved`.

| Field | Required | Notes |
| --- | --- | --- |
| `workflowId` | create yes | Workflow UUID |
| `workflowVersionId` | create yes | Published version UUID |
| `timezone` | create yes | IANA name (`UTC`, `America/Chicago`) |
| `cron` | XOR interval | 5-field cron |
| `interval` | XOR cron | ISO-8601 duration, max `P7D` |
| `overlapPolicy` | no | Default `skip`. `reject` / `queue` |
| `misfirePolicy` | no | Default `ignore`. `fire-once` |
| `catchUp` | no | Default `0`, max `5` |
| `X-CSRF-Token` | browser yes | Cookie session. Header-only callers skip CSRF |

| Route | Purpose | Success | Failure |
| --- | --- | --- | --- |
| `GET /api/v1/schedules/catalog` | Vocabulary + safe defaults. Requires `workflow.view`. | `200` catalog | `401` `403` |
| `GET /api/v1/schedules` | List. Query `workflowId`. Requires `workflow.view`. | `200` `{items}` | `401` `403` |
| `POST /api/v1/schedules` | Create. Pins published version. Requires `workflow.edit` + CSRF. | `201` schedule | `400` `401` `403` `404` |
| `GET /api/v1/schedules/{scheduleId}` | Get one. Requires `workflow.view`. | `200` schedule | `401` `403` `404` |
| `PATCH /api/v1/schedules/{scheduleId}` | Update pin or schedule fields. Requires `workflow.edit` + CSRF. | `200` schedule | `400` `401` `403` `404` |
| `POST /api/v1/schedules/{scheduleId}/enable` | Enable. | `200` schedule | `401` `403` `404` |
| `POST /api/v1/schedules/{scheduleId}/disable` | Disable; dispatcher fails closed. | `200` schedule | `401` `403` `404` |
| `DELETE /api/v1/schedules/{scheduleId}` | Delete. Requires `workflow.edit` + CSRF. | `204` | `401` `403` `404` |
| `POST /api/v1/schedules/dispatch` | Tick due schedules. Requires `workflow.execute` + CSRF. | `200` `{items}` | `401` `403` |
| `GET /api/v1/approvals/catalog` | Now `waitResumeEnabled: true`. Resume via decide. | `200` catalog | `401` `403` |
| `POST /api/v1/approvals/{approvalId}/decide` | Fresh-auth decide **and** resume wait. | `200` approval | `401` `403` `409` |

Out of scope: `apps/web` rewrite (Chloe). HTTP and notification action nodes are E10.4 below.

## HTTP and notification actions (E10.4)

Last story on epic #105. Relates to #109 / Part of #105 — **Keep #109 open** (Chloe still has library/wizard UI pending). Do **not** rewrite `apps/web` in this API story.

`http.request`, `notification.webhook`, and `notification.email` use pinned, server-authorized connection / recipient-list / message-template / response-schema revisions. YAML stores **resource UUIDs only** (`connectionId`, `recipientListId`, `templateId`, `responseSchemaRef`, `policyId`). Publish and execution start pin the published revision; later draft edits do not retarget a pin.

**Integration gate:** the nodes are catalog-enabled because the negative suite is implemented (SSRF, redirect, DNS-rebinding, oversize, secret redaction, wrong connection type, unpublished pin, tenancy, email recipient deny). `GET /workflows/catalog` exposes `rules.integrationActionsEnabled` and `integrationGate`. Set `INTEGRATION_ACTIONS_ENABLED=false` to reject the three types at validate/publish.

**UI route map (Chloe):** do **not** rewrite `apps/web` in this API story. Cookie session + `credentials: "include"`; send `X-CSRF-Token` on POST. JSON is camelCase. Host-supplied `id` / `workspace_id` / `workspaceId` is `400`. Cross-workspace UUIDs are `404`. Wizard/library should read `GET /workflows/catalog` (`allowedWith`, `policy`, `bounds`, `redaction`, `integrationGate`) and `GET /http/catalog` / `GET /ops-config/catalog` (`httpNotificationEngine`). Connection pickers list workspace connections whose `type` matches the node (`http` / `webhook` / `smtp`). Next proxies can expose `/api/control-plane/http/catalog`.

### Node / contract map

| Node | Required `with` | Optional `with` | Connection type | Permissions |
| --- | --- | --- | --- | --- |
| `http.request` | `connectionId` | `method`, `path`, `host`, `timeoutSeconds` (1–60, default 15), `responseSchemaRef`, `policyId` | `http` | `workflow.execute`, `connection.use`, `responseSchema.use` (when a schema is pinned) |
| `notification.webhook` | `connectionId` | `path`, `host`, `timeoutSeconds`, `idempotencyKey`, `policyId` | `webhook` | `workflow.execute`, `connection.use` |
| `notification.email` | `connectionId`, `recipientListId`, `templateId` | `policyId` | `smtp` | `workflow.execute`, `connection.use`, `recipientList.use`, `messageTemplate.use` |

Forbidden YAML keys (fail closed): `http.request` cannot declare `url`, `insecureSkipVerify`, `authorization`, `headers`. `notification.webhook` cannot declare `url`, `secret`, `endpoint`. `notification.email` cannot declare `to`, `recipients`, `body`, `html`.

HTTP/webhook delivery:

1. Normalize host + relative path into an absolute URL. Full URLs, userinfo, and credentials in YAML are denied.
2. Resolve through the approved resolver, then check every destination address (including redirects). DNS names without `endpointPolicy.allowedAddresses` are denied (anti DNS-rebinding).
3. Loopback (`127.0.0.0/8`, `::1`, `localhost` after resolve), RFC1918 (`10/8`, `172.16/12`, `192.168/16`), IPv6 ULA, and CGNAT (`100.64/10`) are denied by default (`ssrf-denied`). Opt in only with explicit `endpointPolicy.allowPrivateDestinations=true` on the pinned connection, or `policy.allowPrivateDestinations=true` on a published `kind=http` / `kind=notification` policy. Unset is fail-closed. There is no global “allow all private” switch.
4. Link-local and metadata addresses (`169.254.0.0/16`, `fe80::/10`, `169.254.169.254`) are always denied, even when private destinations are opted in.
5. Denied problems use a redacted reason (`destination resolved to a non-public address` or `link-local and metadata addresses are denied`) and do not echo resolved private IPs.
6. Connect only to the verified address. TLS verification cannot be skipped. `tlsRequired` defaults true.
7. Redirects default deny. When `allowRedirects=true`, each hop is re-resolved and re-checked for host/method/path/TLS/address and private/loopback policy (max 5).
8. Request/response bodies are capped (`maxRequestBytes` / `maxResponseBytes`, default 16 KiB, hard 1 MiB).
9. Secret-bearing payload fields require `endpointPolicy.secretFields`. Results and audit records are redacted.

Email delivery uses only the pinned recipient-list emails/domains and the pinned message-template revision. `{name}` placeholders may interpolate explicit typed string inputs; `{{` / `${` are denied. Payload `to` / `recipients` is `recipient-denied`.

Policy kind must be `http` for `http.request` and `notification` for the notification nodes. Allowlists fail closed when present.

| Route | Purpose | Success | Failure |
| --- | --- | --- | --- |
| `GET /api/v1/workflows/catalog` | Live node contracts + `integrationGate`. Requires `workflow.view`. | `200` catalog | `401` `403` |
| `GET /api/v1/http/catalog` | Engine isolation, errors, node fields. Requires `opsconfig.view`. | `200` catalog | `401` `403` |
| `GET /api/v1/ops-config/catalog` | Includes `httpNotificationEngine`. | `200` catalog | `401` `403` |

Out of scope: `apps/web` rewrite (Chloe). No new trigger types.

## Durable executions (E5.1)

PostgreSQL model for executions, steps, jobs, and append-only `audit_events`. E5.2 uses the reserved lease/fencing columns for claim/heartbeat/recovery. Artifact downloads are E5.3.

**UI route map (Chloe):** do **not** stack on another feature branch. These paths are stable against `main`. Cookie session + `credentials: "include"`; send `X-CSRF-Token` on POST. JSON is camelCase. Host-supplied `id` / `workspace_id` / `workspaceId` on write bodies is `400`. Cross-workspace UUIDs are `404`. Do not rewrite `apps/web` in this API story. Suggested screens: `/executions` (workspace history) and `/executions/{id}` (detail with redacted steps). Artifact list/download is E5.3 below. Next proxies can rewrite `/api/control-plane/executions` and `/api/control-plane/workflows/{id}/executions`.

Suggested UI flow:

1. Run: `POST /workflows/{workflowId}/executions` `{workflowVersionId, idempotencyKey, input?}`. Keep `id`. Never send `draft: true`. E10.1 run dialog always sends a key (see above).
2. Same `idempotencyKey` + same input/actor → `200` with the original `id` and `replayed: true`. Do not treat that as a second run.
3. Same key + different `input` (or actor) → `409` `conflict`. Show a safe message; do not retry with a new key unless the operator intends a new run.
4. Workspace history: `GET /executions?status=&workflowId=&limit=`. Per-workflow: `GET /workflows/{workflowId}/executions`.
5. Detail: `GET /executions/{executionId}` (or the workflow-scoped twin). Render `status`, version/digest pin, redacted `input`, bounded `steps[]` (`outputTruncated`), `jobs[]`, `pins[]`, and `artifacts[]` metadata (E5.3).
6. Optional extra fetches: `GET /executions/{id}/steps`, `/jobs`, `/audit-events`, `/artifacts`. Workspace audit: `GET /audit-events?resourceType=execution&resourceId=`.
7. Secret values are already `[redacted]` in JSON. Never persist `input` from the run form into `localStorage`.

Statuses: `queued`, `pinned` (legacy stub), `running`, `waiting` (E10.3 durable `flow.approval`), `succeeded`, `failed`, `canceled`, `indeterminate`. New starts are `queued` with one step+job per published node (`attempt=1`). Workers claim jobs via `/jobs/*`; the UI cancels/retries via `/executions/{id}/cancel` and `/retry`. Do not claim jobs from the browser. Waiting jobs hold no lease — resume via `POST /approvals/{id}/decide`.

Retention: executions `retentionUntil` default 90 days; audit events 365 days. Monthly partitions apply to `audit_events` only.

| Route | Purpose | Success | Failure |
| --- | --- | --- | --- |
| `GET /api/v1/executions` | Workspace history. Query `workflowId`, `status`, `limit` (1–100, default 50). Requires `execution.view`. | `200` `{items}` | `401` `403` |
| `GET /api/v1/executions/{executionId}` | Detail + redacted steps/jobs/pins/audit + artifact metadata. | `200` | `401` `403` `404` |
| `GET /api/v1/executions/{executionId}/steps` | Redacted step list. | `200` `{items}` | `401` `403` `404` |
| `GET /api/v1/executions/{executionId}/steps/{stepId}` | One step. | `200` | `401` `403` `404` |
| `GET /api/v1/executions/{executionId}/jobs` | Dispatch records. | `200` `{items}` | `401` `403` `404` |
| `GET /api/v1/executions/{executionId}/audit-events` | Redacted start/replay audit for that run. | `200` `{items}` | `401` `403` `404` |
| `GET /api/v1/audit-events` | Workspace audit log (`resourceType`, `resourceId`, `action`, `limit`). Distinct from E2.2 `GET /workspace/audit-events`. | `200` `{items}` | `401` `403` |

## Durable dispatch (E5.2)

Authenticated jobs, single active claim, heartbeat, fencing tokens, lease expiry, cancel, and retry. Workers must re-validate the claim `binding` (workspace, workflow version/digest, policy digest, expiry) before any provider call. Altered HMAC `jobToken`s are `403`. Expired tickets/leases are `409`. Cross-workspace job IDs are `404`. Lease loss after claim/heartbeat is `indeterminate` — never a silent provider retry.

**UI route map (Chloe):** do **not** stack on another feature branch. These paths are stable against `main`. Cookie session + `credentials: "include"`; send `X-CSRF-Token` on POST. JSON is camelCase. Host-supplied `id` / `workspace_id` / `workspaceId` on write bodies is `400`. Cross-workspace UUIDs are `404`. Do not rewrite `apps/web` in this API story. Suggested screens: execution detail cancel + retry buttons, unmistakable `indeterminate` badge. Next proxies can rewrite `/api/control-plane/executions/{id}/cancel`, `.../retry`, `.../steps/{stepId}/retry`. Worker routes stay off the browser.

Suggested UI flow:

1. Status: keep polling `GET /executions/{id}` (`steps[]`, `jobs[]`). Show `leaseExpiresAt`, `heartbeatAt`, `workerId`, `fencingToken` as diagnostics only.
2. Cancel: `POST /executions/{id}/cancel` `{}` with CSRF. Requires `execution.cancel` (operator/admin). Viewer/approver → `403`. Already canceled → `200` (idempotent). `succeeded` / `failed` / `indeterminate` → `409`.
3. Retry: `failed` or `canceled` **core** `data.*` / `flow.*` steps, `ssh.run` when E8.3 allows it (`retrySafe` + verification + `maxAttempts>0`), or `script.python` / `script.go` when E9.3 allows it (`retrySafe` + idempotency key + verification + `maxAttempts>0`). `POST /executions/{id}/steps/{stepId}/retry` `{}` or `POST /executions/{id}/retry` `{stepId?}`. Requires `workflow.execute`. `201` `{execution,step,job}` with `attempt+1` queued. Other provider nodes → `409`. SSH/script that is not retry-safe, including `indeterminate` lease loss, → `409` `retry-denied`.
4. Do **not** call `/jobs/claim` from the UI. That is the worker client.

Worker client (not the UI):

1. `POST /jobs/claim` `{workerId, leaseSeconds?}` → `200` `{claimed, jobToken, binding, job, step, execution}` or `204`.
2. Reject the job if `binding.workspaceId` is not this worker's workspace, `binding.expiresAt` is past, or `workflowVersionId` / `workflowDigest` do not match the pinned execution.
3. `POST /jobs/{jobId}/heartbeat` `{jobToken, workerId, fencingToken, leaseSeconds?}` — first heartbeat marks `running` (the provider fence). Then call the provider at most once.
4. `POST /jobs/{jobId}/complete` `{jobToken, workerId, fencingToken, output?}` or `.../fail` `{..., error?}`.
5. Graceful idle release (no heartbeat yet): `POST /jobs/{jobId}/release`. After heartbeat, release becomes `indeterminate`.
6. Crash/lease loss: `POST /jobs/recover` (also runs on the next claim). Expired `claimed`/`running` jobs become `indeterminate`. A stale `jobToken` cannot complete.

Default lease **30s** (min 1s, max 5m). `JOB_BINDING_SECRET` (32-byte base64/hex) HMACs tickets; an unset secret is an ephemeral process key.

| Route | Purpose | Success | Failure |
| --- | --- | --- | --- |
| `POST /api/v1/jobs/claim` | Claim next queued job. Recovers expired leases first. Requires `workflow.execute`. | `200` ticket or `204` empty | `400` `401` `403` |
| `POST /api/v1/jobs/recover` | Sweep expired leases to `indeterminate`. | `200` `{recovered}` | `401` `403` |
| `POST /api/v1/jobs/{jobId}/heartbeat` | Extend lease; mark `running`. Requires matching `jobToken` + fence. | `200` | `400` `401` `403` `404` `409` |
| `POST /api/v1/jobs/{jobId}/release` | Requeue if not yet running; otherwise `indeterminate`. | `200` | `400` `401` `403` `404` `409` |
| `POST /api/v1/jobs/{jobId}/complete` | Succeed with redacted `output`. | `200` | `400` `401` `403` `404` `409` |
| `POST /api/v1/jobs/{jobId}/fail` | Fail with redacted `error`. | `200` | `400` `401` `403` `404` `409` |
| `POST /api/v1/executions/{executionId}/cancel` | Cancel open steps/jobs. Requires `execution.cancel`. Idempotent. | `200` detail | `401` `403` `404` `409` |
| `POST /api/v1/executions/{executionId}/emergency-stop` | E9.4: stop a script step. Requires `script.emergencyStop`. Uncertain/running → `indeterminate`. | `200` detail | `401` `403` `404` `409` |
| `POST /api/v1/executions/{executionId}/steps/{stepId}/emergency-stop` | E9.4: stop one script step. | `200` detail | `401` `403` `404` `409` |
| `POST /api/v1/executions/{executionId}/retry` | Retry latest failed/canceled eligible step, E8.3-eligible `ssh.run`, or E9.3-eligible script. Requires `workflow.execute`. | `201` | `401` `403` `404` `409` (`conflict` or `retry-denied`) |
| `POST /api/v1/executions/{executionId}/steps/{stepId}/retry` | Retry one step. | `201` | `401` `403` `404` `409` (`conflict` or `retry-denied`) |

## Execution artifacts (E5.3)

Redacted step state, bounded logs/output, envelope-encrypted artifact metadata, short-lived download grants, retention deletion, and legal hold. Object payloads are encrypted at rest (same `CREDENTIAL_KEK` envelope as the vault). Local MVP storage is the filesystem under `ARTIFACT_STORE_DIR` (compose/k8s: `/tmp/flowforge-artifacts` on the read-only container tmpfs). Empty `ARTIFACT_STORE_DIR` uses in-process memory (lost on restart). The API **never** returns `storageRef`, DEK/envelope fields, bucket names, or durable public URLs.

**UI route map (Chloe):** do **not** stack on this feature branch. Paths are intended to be stable on `main`. Cookie session + `credentials: "include"`; send `X-CSRF-Token` on POST. JSON is camelCase. Host-supplied `id` / `workspaceId` / `storageRef` / `url` / `bucket` / `key` on write bodies is `400`. Cross-workspace UUIDs are `404`. Do not rewrite `apps/web` in this API story. Do not call object-store APIs. Do not persist download `href`s. Isolation hook `GET /workspace/artifacts/{id}` is **not** the product artifact API.

Suggested Next proxies: `/api/control-plane/executions/{id}/artifacts`, `.../steps/{stepId}/logs`, `/artifacts/{id}`, `.../downloads`, `/artifact-downloads/{grantId}`, `.../legal-hold`, `/retention/purge`.

Suggested UI flow:

1. Poll `GET /executions/{id}` — `steps[]` (bounded, `outputTruncated`) and `artifacts[]` (metadata only). Optional `GET /executions/{id}/artifacts?stepId=&kind=`.
2. Logs: `GET /executions/{id}/steps/{stepId}/logs?limit=&offset=&maxBytes=`. Default window 200 lines / 16KiB; max 200 lines / 256KiB. Tokens are already `[redacted]` in stored logs.
3. Download: `POST /artifacts/{id}/downloads` `{}` → `{download:{id,artifactId,expiresAt,href,method:"GET"}}` then `GET {href}` with cookies. Re-request a grant if `404` (expired). Default grant TTL **60s** (`ARTIFACT_DOWNLOAD_TTL`), max 5m. Auth is re-evaluated on **every** grant and stream request.
4. Never render or store `storageRef`, `dekEnvelope`, `ciphertext`, bucket URLs, or a grant `href` past its expiry.
5. Legal hold / purge are admin-only (`workspace.administer`); not required for the artifact viewer.

Worker/operator upload (not the browser viewer): `POST /executions/{id}/artifacts` or `POST /executions/{id}/steps/{stepId}/artifacts` (or `.../logs`) with `{kind,filename,contentType,contentClassification,content|contentBase64}`. Scan rejects PEM private keys, kubeconfig, K8s Secret manifests, AWS secret keys, and `secret`/`restricted` classification **before** persist (`400`, audit `artifact.upload.rejected`). Allowed `contentType`: `text/plain`, `application/json`, `application/octet-stream`. Caps: files 1MiB (`ARTIFACT_MAX_BYTES`), logs 256KiB, output 16KiB. Filename paths are stripped.

| Method | Path | Perm | CSRF | Notes |
| --- | --- | --- | --- | --- |
| `GET` | `/api/v1/executions/{executionId}` | `execution.view` | no | Includes `artifacts[]` metadata + bounded `steps[]` |
| `GET` | `/api/v1/executions/{executionId}/artifacts` | `execution.view` | no | `{items}` metadata. Query `stepId`, `kind` |
| `POST` | `/api/v1/executions/{executionId}/artifacts` | `workflow.execute` | yes | Upload. Host locators → `400`. Missing KEK → `503` |
| `POST` | `/api/v1/executions/{executionId}/steps/{stepId}/artifacts` | `workflow.execute` | yes | Upload bound to a step |
| `GET` | `/api/v1/executions/{executionId}/steps/{stepId}/logs` | `execution.view` | no | `{lines,offset,nextOffset,truncated,maxBytes}` |
| `POST` | `/api/v1/executions/{executionId}/steps/{stepId}/logs` | `workflow.execute` | yes | Upload; default `kind=log` |
| `GET` | `/api/v1/artifacts/{artifactId}` | `execution.view` | no | Metadata only. Expired without hold → `404` |
| `POST` | `/api/v1/artifacts/{artifactId}/downloads` | `execution.view` | yes | `{download:{href,method,expiresAt}}` same-origin grant |
| `GET` | `/api/v1/artifact-downloads/{grantId}` | `execution.view` | no | Stream bytes. Re-evals workspace + perm + retention + grant. `Cache-Control: no-store` |
| `POST` | `/api/v1/artifacts/{artifactId}/legal-hold` | `workspace.administer` | yes | `{hold, reason}` — reason required to place. Audit `artifact.legal_hold.*` |
| `POST` | `/api/v1/retention/purge` | `workspace.administer` | yes | Deletes metadata + object payload. Holds skipped. `{purged,held,executions,audits}` |

Artifact JSON fields: `id`, `executionId`, `executionStepId?`, `kind`, `filename`, `contentType`, `digest`, `sizeBytes`, `contentClassification` (`public`/`internal`/`confidential`), `redacted`, `expiresAt` (defaults to the execution `retentionUntil`), `legalHold`, `legalHoldReason?`, `legalHoldBy?`, `legalHoldAt?`, `createdAt`, `updatedAt`.

Out of scope: provider engines, `apps/web` rewrite.

## Audit integrity and operational alerts (E5.4)

`audit_events` are append-only for the `flowforge_app` role (SELECT + INSERT only). UPDATE always fails. DELETE of live rows fails; expired rows are removed only by `app.purge_expired_audit_events` (SECURITY DEFINER), which `POST /retention/purge` already calls. Tamper attempts fail closed.

Authorization, replay (idempotency fingerprint mismatch), policy deny, and redaction/unsafe-artifact failures emit an operational alert plus a secret-free `alert.{kind}` audit row. Alert JSON is identifiers only: no `details`, tokens, headers, bodies, or storage locators.

**UI route map (Chloe):** do **not** stack on this feature branch. Paths are intended to be stable on `main`. Cookie session + `credentials: "include"`; send `X-CSRF-Token` on POST. JSON is camelCase. Host-supplied `id` / `workspaceId` on ack is `400`. Cross-workspace UUIDs are `404`. Do not rewrite `apps/web` in this API story. Suggested screens: `/alerts` (open queue) and `/alerts/{id}` (detail + ack). Next proxies can rewrite `/api/control-plane/alerts`, `/{id}`, `/{id}/ack`.

Suggested UI flow:

1. Nav: show Alerts when `GET /workspace` includes `alert.view`. Ack controls require `alert.ack` (operator/admin). Viewer/approver can read.
2. Queue: `GET /alerts?kind=&status=open&resourceType=&resourceId=&limit=`. Kinds: `authorization`, `replay`, `policy`, `redaction`. Status: `open` | `acked`.
3. Detail: `GET /alerts/{alertId}`. Render `kind`, `severity` (`warning` for authorization/replay, `critical` for policy/redaction), `action`, `resourceType` / `resourceId`, `correlationId`, `requestId`, `actorId`, `code`, `occurredAt`.
4. Ack: `POST /alerts/{id}/ack` `{}` with CSRF. Idempotent `200`. Viewer → `403`.
5. Correlate: optional `GET /audit-events?action=alert.{kind}&resourceId=` or jump to `GET /executions/{resourceId}` when `resourceType=execution`.
6. Never persist or display unexpected secret-shaped fields. If a field like `token` / `authorization` / `details` appears, strip it.

| Method | Path | Perm | CSRF | Notes |
| --- | --- | --- | --- | --- |
| `GET` | `/api/v1/alerts` | `alert.view` | no | `{items}`. Query `kind`, `status`, `resourceType`, `resourceId`, `limit` (1–100, default 50) |
| `GET` | `/api/v1/alerts/{alertId}` | `alert.view` | no | One row. Cross-workspace → `404` |
| `POST` | `/api/v1/alerts/{alertId}/ack` | `alert.ack` | yes | `{}` → updated row. Idempotent |

Alert JSON fields: `id`, `kind`, `severity`, `action?`, `resourceType?`, `resourceId?`, `correlationId?`, `requestId?`, `actorId?`, `outcome`, `code`, `acknowledgedAt?`, `acknowledgedBy?`, `occurredAt`. No `details` object.

Kinds emitted by the API (safe fixtures in tests):

| Kind | When | Typical `code` | `resourceType` |
| --- | --- | --- | --- |
| `authorization` | Authenticated member missing the requested permission; rejected job binding | `forbidden` | `workspace` / `job` |
| `replay` | Idempotency key reused with a different fingerprint | `conflict` | `execution` |
| `policy` | Dispatch policy decision is deny | `forbidden` | `workflow` |
| `redaction` | Artifact scan rejects unsafe content before persist | `invalid-request` | `execution` |

Out of scope: SIEM integrations, provider engines, `apps/web` rewrite.

RBAC: viewer can list/get/compare/export; editor can create/save/restore; publisher can publish; operator can start a pinned execution (not edit). `workflow.status` is `draft` until the first publish, then `published`. Slug defaults to `metadata.name` and stays stable; display `name` tracks the draft summary on save.

Every request receives `X-Request-ID`. A caller-supplied value is accepted only when it is 16–128 ASCII letters, digits, or hyphens; otherwise the API generates one. The same identifier is present on the response header, in `application/problem+json` as `request_id`, and in structured request logs so an API flow can be traced end to end.

Errors use `application/problem+json` and include `type`, `title`, `status`, `detail`, `instance`, `code`, and `request_id`. Documented codes:

| Code | Status | When |
| --- | --- | --- |
| `invalid-request` | 400 | Malformed JSON, missing body, or unsupported `Content-Type` |
| `invalid-workflow` | 400 | Workflow YAML failed parse/normalize/validation; `errors` lists path/line/column/code/message |
| `unauthenticated` | 401 | Missing or invalid credentials |
| `forbidden` | 403 | Authenticated caller is not authorized |
| `not-found` | 404 | Unknown path or missing tenant/workspace/user |
| `conflict` | 409 | Unique identity collision, last-admin protection, draft revision mismatch, duplicate published digest, idempotency fingerprint mismatch, fencing/lease mismatch, or a retry/cancel that is not allowed |
| `retry-denied` | 409 | SSH/script retry rejected: default `maxAttempts=0`, not `retrySafe`, missing verification or idempotency key, or no attempts remain. Indeterminate non-retrySafe steps stay closed. |
| `artifact-mutable` | 400 | Draft or unsigned script package cannot execute. Publish first. |
| `artifact-unscanned` | 400 | Script artifact `scanStatus` is pending or missing. |
| `artifact-unsigned` | 400 | Script artifact signature is missing or does not verify. |
| `artifact-scan-failed` | 400 | Script artifact `scanStatus` is failed. |
| `method-not-allowed` | 405 | Known path, unsupported method |
| `request-too-large` | 413 | Body exceeds 1048576 bytes |
| `internal-error` | 500 | Unexpected failure |
| `dependency-unavailable` | 503 | PostgreSQL is not reachable |

Foundation responses also set restrictive content, referrer, and permissions policies. When the request is HTTPS (direct TLS or `X-Forwarded-Proto: https` from a CIDR in `TRUSTED_PROXY_CIDRS`), responses also set `Strict-Transport-Security`. If `REQUIRE_TLS` is true, plain HTTP is rejected as `invalid-request`, except `GET /api/v1/health` and `GET /api/v1/readiness` so Kubernetes HTTP probes can reach the pod without Ingress TLS. Structured logs are JSON and secret-free: they record method, path, route, status, duration, bytes, and `request_id`, and never record `Authorization`, cookies, query strings, or request bodies. Session audit logs add `event_type`, `outcome`, `reason`, `user_id`, and `session_id` only. Metrics labels are method, route, and status only.
