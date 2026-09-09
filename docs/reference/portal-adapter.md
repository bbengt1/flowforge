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
| 3. Mint | Portal backend | After Portal RBAC, `POST /api/v1/portal/adapter/assertions` `{portalRoles,subject?,ttlSeconds?}` with identity headers + `X-FlowForge-Tenant-ID` + `X-FlowForge-Workbench-Key`. Receives compact JWS **once**. Same as `POST /api/v1/embed/assertions` after mapping. `aud` is `flowforge`. `iss` is the portal issuer. |
| 4. Mount | Portal frontend / Chloe | Load `/embed/v1/…` (same standalone hrefs). Frame only when the Portal origin is in `WEB_PORTAL_FRAME_ANCESTORS` and/or `WEB_EMBED_FRAME_ANCESTORS`. Host query `tenant` / `workbench` is display-only. |
| 5. Exchange | Embed shell | `POST /api/v1/embed/exchange` `{assertion,sdk:"embed.v1"}` body only. Issues `ff_session` bound to `(tenant_id, workbench_key)`. Replay is `409`. The bound session cannot create tenants or sibling workbenches. |
| 6. Authorize | FlowForge | Later calls: cookie session + `X-CSRF-Token` + exchanged tenant/workbench headers. Disagreeing host tenant/workbench is `403`. |

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
| `portal.admin` | `admin` | Full workspace administration **if** the subject is a FlowForge member. Does **not** include `platform.administer` (rotate / tenant-workspace bootstrap). Cannot bootstrap membership from the embed session. |

## API

| Method | Path | Auth | CSRF | Notes |
| --- | --- | --- | --- | --- |
| `GET` | `/api/v1/portal/adapter` | none | no | Contract, capability map, host wiring |
| `POST` | `/api/v1/portal/adapter/assertions` | session or identity headers + membership | yes if `ff_session` | Maps roles, checks portal issuer, signs with E11.1 mint |
| `POST` | `/api/v1/embed/assertions` | same | yes if cookie | Same mint without role mapping |
| `POST` | `/api/v1/embed/exchange` | assertion | no | E11.1/E11.2 exchange. Not Portal-specific. Bound sessions cannot `POST /tenants` or `POST /workspaces`. |
| `GET` | `/api/v1/embed/catalog` | none | no | Embed SDK |
| `GET` | `/api/v1/embed/jwks` | none | no | Public keys only |
| `POST` | `/api/v1/embed/keys/rotate` | `platform.administer` (`PLATFORM_ADMINS`) | yes if `ff_session` | Not a Portal host control. `portal.admin` / `workspace.administer` cannot register overlap keys. |

Mint JSON (camelCase): `{subject?,displayName?,issuer?,tenantId?,workbenchKey?,workspaceId?,portalRoles?,capabilities?,ttlSeconds?}`.

`portalRoles` and/or `capabilities` required. Unknown role or capability is
`400`. Explicit `platform.administer` is `400`. Issuer not on
`PORTAL_ISSUER_ALLOWLIST` (when set) is `403`.
Host-supplied `workspaceId` that does not match server resolution is
forbidden. Success is the same minted assertion as E11.1 (`201`, compact
JWS once). Problem details never echo the JWS or private keys.

## Config

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORTAL_ISSUER` | empty | Default / single allowed Portal `iss` |
| `PORTAL_ISSUER_ALLOWLIST` | empty | Comma-separated Portal issuers. Empty adds no extra mint constraint |
| `PORTAL_FRAME_ANCESTORS` | empty | Exact Portal origins published on the adapter catalog |
| `WEB_PORTAL_FRAME_ANCESTORS` | empty | Exact origins allowed to frame `/embed/v1` (merged with `WEB_EMBED_FRAME_ANCESTORS`) |
| `WEB_EMBED_FRAME_ANCESTORS` | empty | Existing embed frame allowlist |
| `EMBED_ISSUER` / `EMBED_ISSUER_ALLOWLIST` | empty | Embed exchange allowlist. Portal issuers are merged in |

Production must set a stable `EMBED_SIGNING_KEY` and an explicit Portal
issuer allowlist. `*` / `null` frame ancestors are ignored.

## Negative tests (epic #120)

These fail closed on the FlowForge adapter:

- Hostile host issuer (not on the Portal allowlist)
- Replayed assertion (`409` on `POST /embed/exchange`)
- Cross-tenant / cross-workbench headers after exchange (`403`)
- Credential plaintext and raw runner-log secrets absent from Portal-session
  reads, problem details, and logs
- Portal entry (mint for a non-member) does not grant FlowForge membership
- Portal `admin` / elevated capabilities do not include `platform.administer`
- Embed session `POST /tenants` or `POST /workspaces` is `403` (no sibling
  workbench / membership bootstrap)

## Out of scope

- A full external Portal product
- Sharing FlowForge PostgreSQL, queues, or workers with Portal
- Replacing Portal’s own RBAC
- Rewriting `apps/web` product pages (Chloe wires the host using this map)
