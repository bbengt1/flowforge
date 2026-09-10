# CP Ops Portal adapter (E11.3)

FlowForge-side adapter that replaces or adapts CP Ops Portal’s protected
workflow surface **without sharing the FlowForge database or executor**.
Portal entry RBAC stays on the Portal host. FlowForge authorization stays
on FlowForge.

Relates to #123 / Part of #120. **Keep #123 open** — Chloe still owns host
wiring / UI adaptation. This document is the contract and field map.

Adapter: `apps/web/src/lib/portal-adapter-contract.ts` (Chloe).
API catalog: `GET /api/v1/portal/adapter`.
Builds on [embed SDK](embed-sdk.md) (E11.1 mint/exchange + E11.2 validation).

## Boundary

| Rule | Value |
| --- | --- |
| Shares FlowForge database | no |
| Shares FlowForge executor / workers | no |
| Portal entry is FlowForge authorization | no |
| Host tenant / workbench is authorization | no |
| Assertion accepted from a URL | no |
| Credentials or raw runner logs to the host | no |
| Auth path | E11.1 `embed.Mint` + `POST /embed/exchange` only |

A Portal “admin” who is not a FlowForge workspace member cannot administer
FlowForge and cannot become a member by creating a tenant or sibling
workbench. Mapped capabilities are a **request**. Mint still requires a
subset of the minting caller’s FlowForge permissions. `platform.administer`
is never mapped and is rejected if requested as an extra capability.
After exchange, FlowForge membership ∩ minted capabilities is the grant.
The embed session is bound to the assertion’s `(tenant_id, workbench_key)`
and cannot call `POST /tenants` or `POST /workspaces` (`403`).

## Host wiring map (Chloe)

Portal owns steps 1–2. FlowForge owns 3 and 5. The embed shell owns 4.

| Step | Actor | What to do |
| --- | --- | --- |
| 1. Entry | Portal | Portal navigation + Portal RBAC decide whether the user may enter the add-in (`/portal/workflows` or the host’s equivalent). Do not share FlowForge cookies, DB, or the executor. |
| 2. Map roles | Portal backend | Map Portal roles → FlowForge capabilities from `GET /api/v1/portal/adapter` `capabilityMap`. Unknown roles fail closed. |
| 3. Mint | Portal backend | After Portal RBAC, `POST /api/v1/portal/adapter/assertions` `{portalRoles,subject?,ttlSeconds?}` with identity headers + `X-FlowForge-Tenant-ID` + `X-FlowForge-Workbench-Key`. Receives compact JWS **once**. Same as `POST /api/v1/embed/assertions` after mapping. `aud` is `flowforge`. `iss` is the portal issuer (always the authenticated caller). A `subject` other than the caller requires `embed.impersonate` (`PLATFORM_ADMINS`). |
| 4. Mount | Portal frontend / Chloe | Load `/embed/v1/…` (same standalone hrefs). Frame and postMessage only when the Portal origin is on the **shared host allowlist** (`WEB_PORTAL_FRAME_ANCESTORS` ∪ `WEB_EMBED_FRAME_ANCESTORS` ∪ `PORTAL_FRAME_ANCESTORS`). Read `GET /portal/adapter` `frameAncestors` (same list as `GET /embed/catalog`). Host query `tenant` / `workbench` is display-only. |
| 5. Exchange | Embed shell | `POST /api/v1/embed/exchange` `{assertion,sdk:"embed.v1"}` body only. Send `X-FlowForge-Host-Issuer` set to the configured `PORTAL_ISSUER` (never peeked from the assertion) and `X-FlowForge-Host-Context: portal`. Signature and claims are verified before any workspace lookup. `iss` must equal that Portal issuer. Issues CHIPS `ff_session` / `ff_csrf` (`SameSite=None; Secure; Partitioned`) bound to `(tenant_id, workbench_key)`. Replay is `409`. The bound session cannot create tenants or sibling workbenches. Keep `credentials: "include"`. Do not request Storage Access / unpartitioned cookies. |
| 6. Authorize | FlowForge | Later calls: cookie session + `X-CSRF-Token` + exchanged tenant/workbench headers. Disagreeing host tenant/workbench is `403`. If the partitioned cookie is not sent: `401` / CSRF `403`. HTTPS + Partitioned support required. Manual two-host iframe check is ADV-013. |

Do **not** invent a Portal-specific exchange, cookie, or audience. Do **not**
put the assertion in the query, hash, path, `localStorage`, or logs.

## Capability map

Portal roles (or the short FlowForge aliases) expand to the seeded
permission sets. Extra `capabilities` must be known FlowForge keys.

| Portal role | Alias | FlowForge grant (summary) |
| --- | --- | --- |
| `portal.viewer` | `viewer` | `workflow.view`, `execution.view`, `approval.view`, `opsconfig.view`, `alert.view` |
| `portal.editor` | `editor` | Viewer + draft edit + credential view |
| `portal.publisher` | `publisher` | Editor + publish |
| `portal.operator` | `operator` | Run / cancel / use credentials and targets. No edit or administer |
| `portal.approver` | `approver` | View + `approval.decide` |
| `portal.admin` | `admin` | Full workspace administration **if** the subject is a FlowForge member. Does **not** include `platform.administer` or `embed.impersonate` (rotate / tenant-workspace bootstrap / mint-for-another-subject). Cannot bootstrap membership from the embed session. |

## API

| Method | Path | Auth | CSRF | Notes |
| --- | --- | --- | --- | --- |
| `GET` | `/api/v1/portal/adapter` | none | no | Contract, capability map, host wiring |
| `POST` | `/api/v1/portal/adapter/assertions` | session or identity headers + membership | yes if `ff_session` | Maps roles, checks portal issuer, binds subject to the caller unless `embed.impersonate`, signs with E11.1 mint |
| `POST` | `/api/v1/embed/assertions` | same | yes if cookie | Same mint without role mapping. Subject/issuer bind to the caller |
| `POST` | `/api/v1/embed/exchange` | assertion | no | E11.1/E11.2 exchange. Not Portal-specific. Binds `iss` to the minting Portal host issuer (`X-FlowForge-Host-Issuer` + `hostContext=portal`). Issues CHIPS cookies (`SameSite=None; Secure; Partitioned`). Bound sessions cannot `POST /tenants` or `POST /workspaces`. Cookie not sent is `401`/`403`. |
| `GET` | `/api/v1/embed/catalog` | none | no | Embed SDK |
| `GET` | `/api/v1/embed/jwks` | none | no | Public keys only |
| `POST` | `/api/v1/embed/keys/rotate` | `platform.administer` (`PLATFORM_ADMINS`) | yes if `ff_session` | Not a Portal host control. `portal.admin` / `workspace.administer` cannot register overlap keys. |

Mint JSON (camelCase): `{subject?,displayName?,issuer?,tenantId?,workbenchKey?,workspaceId?,portalRoles?,capabilities?,ttlSeconds?}`.

`portalRoles` and/or `capabilities` required. Unknown role or capability is
`400`. Explicit `platform.administer` or `embed.impersonate` is `400`.
`subject` defaults to the caller; a different subject requires
`embed.impersonate` (`PLATFORM_ADMINS`) or the mint is `403`. A client
`issuer` that differs from the caller is `403`. Issuer not on a
non-empty `PORTAL_ISSUER` / `PORTAL_ISSUER_ALLOWLIST` is `403`. An
empty/unset Portal allowlist fails closed at mint (`403`); it does not
accept any issuer. Production (empty/`production` `APP_ENV` or
`REQUIRE_TLS`) requires every configured Portal (and embed) issuer to
be an absolute `https://` URI — `http://`, relative, or opaque values
are a boot-fail, and mint/exchange still `403` a non-https `iss`
(ADV-018). Local/dev/test may use `http://` issuers. Successful impersonation is audited (`reason=impersonated`).
Host-supplied `workspaceId` that does not match server resolution is
forbidden. Success is the same minted assertion as E11.1 (`201`, compact
JWS once). Problem details never echo the JWS or private keys.

## Config

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORTAL_ISSUER` | empty | Single allowed Portal `iss`. Empty (with an empty allowlist) fails closed at Portal mint (`403`). Production requires `https://` (ADV-018; boot-fail) |
| `PORTAL_ISSUER_ALLOWLIST` | empty | Comma-separated Portal issuers. Empty fails closed — mint returns `403`. Compose seeds `https://portal.cp-ops.example` for local/dev. Production requires every entry to be an absolute `https://` URI |
| `PORTAL_FRAME_ANCESTORS` | empty | Shared host allowlist (API-side). Merged with the `WEB_*` vars. Published on `GET /portal/adapter` and `GET /embed/catalog` as `frameAncestors` |
| `WEB_PORTAL_FRAME_ANCESTORS` | empty | Same shared list (web + API). Drives `/embed/v1` CSP **and** postMessage |
| `WEB_EMBED_FRAME_ANCESTORS` | empty | Same shared list (embed-origin name) |
| `EMBED_ISSUER` / `EMBED_ISSUER_ALLOWLIST` | empty | Embed mint allowlist. Empty fails closed at embed mint. Exchange uses this list only when `X-FlowForge-Host-Context: embed` (or merges it with Portal issuers when context is omitted). |

Production must set a durable `EMBED_SIGNING_KEY` (boot-fail if missing
when `APP_ENV` is empty/`production` or `REQUIRE_TLS=true`) and explicit
Portal and embed issuer allowlists. Empty allowlists fail closed at
request time (`403` on mint/exchange); the process still starts so other
API routes stay up. A configured production issuer that is not
`https://` is a boot-fail (ADV-018). Local compose seeds a local-only signing key and
the lists — it does not fail open. `*` / `null` frame ancestors are ignored.
Empty host allowlist fails closed: CSP `frame-ancestors 'none'` and no
postMessage (ADV-011). Set the same origins on the API and web processes so
the catalog matches Next CSP. `NEXT_PUBLIC_EMBED_FRAME_ANCESTORS` is not a
source. Contract: `embedHostAllowlist`, `parseCatalogFrameAncestors`,
`isAllowedEmbedMessageOrigin`, `deliverPortalAssertion(..., allowlist)`.

## Negative tests (epic #120)

These fail closed on the FlowForge adapter:

- Empty Portal issuer allowlist (mint/exchange `403`)
- Hostile host issuer (not on the Portal allowlist)
- Production `http://` / relative / opaque Portal or embed issuer (boot-fail; request-time `403`)
- Cross-host issuer reuse: assertion minted under issuer A exchanged when the host expects issuer B (`403`)
- Replayed assertion (`409` on `POST /embed/exchange`)
- Cross-tenant / cross-workbench headers after exchange (`403`)
- Credential plaintext and raw runner-log secrets absent from Portal-session
  reads, problem details, and logs
- Portal entry (mint for a non-member) does not grant FlowForge membership
- Portal `admin` / elevated capabilities do not include `platform.administer`
  or `embed.impersonate`
- Mint for another subject without `embed.impersonate` / `PLATFORM_ADMINS` is `403`
- Client-supplied issuer that differs from the caller is `403`
- Embed session `POST /tenants` or `POST /workspaces` is `403` (no sibling
  workbench / membership bootstrap)
- Cross-site iframe session without CHIPS (`SameSite=None` without
  `Partitioned`, or dropping `Secure`) is not used. Cookie not sent is
  `401`/`403`. A full two-host iframe check is ADV-013 (below).

## ADV-013 — cross-origin Portal adapter evidence

Relates to #144 / Part of #130. **Keep #144 open** until the two-origin
evidence is reviewed. This is proof + harness, not a new auth path.

The in-repo demo at `/portal/workflows` is **same-origin** as FlowForge.
ADV-013 requires **two distinct HTTPS origins**: Portal host ≠ embed
(`/embed/v1`). `.test` names are on the public suffix list, so
`https://portal.test:8443` and `https://embed.test:8444` are different
sites (CHIPS / third-party cookies). `127.0.0.1:port` pairs are **not**
cross-site.

| Origin | Role |
| --- | --- |
| `https://portal.test:8443` | Portal entry, role map, mint proxy, iframe parent |
| `https://embed.test:8444` | FlowForge web + `/embed/v1` + same-origin `/api/v1` proxy |
| `https://evil.test:8445` | Hostile ancestor (must not appear in `frame-ancestors`) |

`/etc/hosts`:

```text
127.0.0.1 portal.test embed.test evil.test
```

Or Chrome `--host-resolver-rules="MAP portal.test 127.0.0.1, MAP embed.test 127.0.0.1, MAP evil.test 127.0.0.1"`.

### Re-run locally

Contract checklist (this is what CI runs):

```bash
pnpm --filter @flowforge/web test
# or
bash scripts/adv013-cross-origin.sh --checklist
```

Full two-origin run (local HTTPS, no Docker required if PostgreSQL and
the API/web already run):

```bash
# PostgreSQL on 127.0.0.1:5432, role/db flowforge (or set DATABASE_URL)
export POSTGRES_PASSWORD=replace-with-local-password
bash scripts/adv013-cross-origin.sh
# Skip the unit checklist after a green `pnpm --filter @flowforge/web test`:
# ADV013_SKIP_UNIT=1 bash scripts/adv013-cross-origin.sh
```

Compose overlay (when Docker is available) seeds the shared allowlist
on **both** API and web, then attach the prover:

```bash
export POSTGRES_PASSWORD=...
export WEB_PORTAL_FRAME_ANCESTORS=https://portal.test:8443
export PORTAL_FRAME_ANCESTORS=https://portal.test:8443
docker compose -f docker-compose.yml -f deploy/adv013/docker-compose.yml up --build
# in another shell, with API/web already up:
ADV013_WEB_URL=http://127.0.0.1:3000 bash scripts/adv013-cross-origin.sh --attach
```

The script writes redacted evidence to
[`docs/reference/adv-013-evidence/`](adv-013-evidence/RUN.md) (no compact
JWS). It exercises:

1. Portal entry → `POST /portal/adapter/assertions` (adapter mint)
2. Frame `/embed/v1` with allowlisted ancestors (CSP + catalog)
3. Body-only `POST /embed/exchange` through the embed origin
4. CHIPS `Set-Cookie` (`SameSite=None; Secure; Partitioned`) +
   `credentials: include` session read
5. postMessage only when the Portal sender is on the shared list
   (`deliverCrossOriginPortalAssertion`)
6. Negatives: hostile ancestor absent from CSP; assertion in the URL
   rejected (`x-flowforge-embed-rejected`); empty allowlist fail-closed

TLS material is generated under `deploy/adv013/tls/` (gitignored). The
Node terminator in `deploy/adv013/portal-host/server.mjs` fronts the
three origins. Optional Caddy: `deploy/adv013/Caddyfile`.

### Chloe map (host wiring gaps)

The product adapter is unchanged. A real Portal host still owns steps
1–2 and the iframe parent.

| Gap | Do |
| --- | --- |
| In-repo `PortalHost` uses a relative `/embed/v1` src and `postMessage(..., window.location.origin)` | Production Portal must iframe the **absolute embed origin** and call `deliverCrossOriginPortalAssertion({embedOrigin, portalOrigin, allowlist})`. The ADV-011 helper `deliverPortalAssertion` is same-origin (target must be on the host allowlist). |
| Catalog vs CSP | Set the same Portal HTTPS origin on the **API** (`PORTAL_FRAME_ANCESTORS` / `WEB_PORTAL_FRAME_ANCESTORS`) and the **web** process. `NEXT_PUBLIC_EMBED_FRAME_ANCESTORS` is not a source (ADV-011). |
| Embed exchange gate | Allowlisted postMessage fills the assertion; `POST /embed/exchange` stays body-only with `credentials: "include"`. Do not put the JWS in the URL. Auto-exchange is optional host UX. |
| Host issuer bind (ADV-023) | `EmbedExchangeGate` sends `X-FlowForge-Host-Issuer` set to the **configured** `PORTAL_ISSUER` (adapter `issuers` / server env) and `X-FlowForge-Host-Context: portal` when the frame is Portal. Never copy `iss` from the assertion. Wrong-issuer-for-host is `403`. Prefer no chrome rewrite beyond those headers (`PORTAL_HOST_ISSUER_RULES`). |
| Production https issuers (ADV-018) | **No UI change.** Production ConfigMaps must use `https://` Portal/embed issuers. `http://` is local/dev only. |
| CHIPS | Both origins must be HTTPS. Do not drop `Secure` or `Partitioned`. Cookie not sent is `401`/`403`. |
| API process stores | `cmd/api` builds the handler with `NewWithDeps` and a postgres pool. Identity / session / workflow stores must be inferred from that pool (otherwise `POST /tenants` is `503` and Portal mint cannot bind a workspace). |

Contract exports: `apps/web/src/lib/adv013-cross-origin-contract.ts`,
`buildCrossOriginPortalEmbedSrc`, `deliverCrossOriginPortalAssertion`.

## Out of scope

- A full external Portal product
- Sharing FlowForge PostgreSQL, queues, or workers with Portal
- Replacing Portal’s own RBAC
- Rewriting `apps/web` product pages (Chloe wires the host using this map)
