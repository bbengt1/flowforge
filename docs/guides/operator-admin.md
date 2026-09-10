# Operator and admin UI guide

Relates to #184 / Part of #181. **Keep #184 open.**

Product-shell walkthrough for operators and workspace admins using
the Next.js UI (`apps/web`). This is the Chloe E12.3 **UI** guide.
It is **not** an API→UI contract map — that stays in
[frontend-ui.md](../reference/frontend-ui.md).

Control-plane / ops (jonny, #188) stay on
[operations](../operations/index.md): OpenAPI, deploy, incident,
retention/backup, threat-model. Do not duplicate those here.

| Need | Authority |
| --- | --- |
| Ops landing + ownership | [Release and operations](../operations/index.md) |
| Published OpenAPI | [openapi.md](../reference/openapi.md) (`platform.administer`) |
| Deploy / config | [deployment.md](../deployment.md) |
| Incident / restore | [incident-recovery.md](../operations/incident-recovery.md) |
| Retention / backup | [retention-backup.md](../operations/retention-backup.md) |
| Threat-model gate | [e12-threat-model-review.md](../reference/e12-threat-model-review.md) |
| Route/RBAC contracts | [Backend API map](../reference/backend-api-map.md) |
| Embed / Portal wiring | [Embed SDK](../reference/embed-sdk.md), [Portal adapter](../reference/portal-adapter.md) |
| Accessibility review | [e12-accessibility-review.md](../reference/e12-accessibility-review.md) |

Evidence is secret-free: no tokens, KEK material, webhook secrets, or
assertion JWS.

## Walkthroughs

1. [Workspace shell](#workspace-shell)
2. [Workflow home and authoring](#workflow-home-and-authoring)
3. [Membership](#membership)
4. [Credential vault](#credential-vault)
5. [Approvals](#approvals)
6. [Executions](#executions)
7. [Alerts](#alerts)
8. [Embed chrome](#embed-chrome)
9. [Admin screens](#admin-screens)
10. [Session, CHIPS, and CSRF](#session-chips-and-csrf)

## Workspace shell

Standalone UI (`http://localhost:3000` in compose) is the E6.1 product
shell.

1. Tab once for **Skip to main content** (`#main-content`). Route pages
   already ship `<main>` + `<h1>` — the shell does not nest a second
   `main`.
2. Confirm the **workspace switcher** (name, first role, environment /
   `workbench_key`). Embed sessions lock it to the FlowForge-verified
   tenant/workbench.
3. Use **left nav** — fail-closed from `GET /workspace`. Authoring:
   Workflows, Actions, Credentials, Targets, Profiles, Config.
   Operations: Executions, Templates, Approvals, Alerts, Audit.
   Foundation: Settings always; **Membership / Isolation only** with
   `workspace.administer` or `platform.administer` (ADV-024); Portal
   host is the E11.3 demo.
4. **Search** indexes workflows, catalog action types, credential
   **display names/tags**, execution IDs, alert identifiers, and docs.
   Unexpected secret fields are stripped and never searchable.
5. **Commands** — Ctrl+Shift+K or the Commands button. Arrows move,
   Enter runs, Esc returns focus. Commands that need a capability are
   omitted.
6. Read the **session chip / banner**. Idle/absolute countdown comes
   from `GET /session`. Stale (`401`) and expired reuse existing chrome
   — re-establish a cookie session.

Inaccessible capabilities never flash in nav or search.

## Workflow home and authoring

`/workflows` is the operational home.

1. Filter by search, folder (`ops/…`, `ops: …`, or slug `ops--name`),
   tag, owner, trigger, environment, status, last run, last modified.
2. Toggle **List** / **Cards** (`aria-pressed`).
3. Create, import YAML, duplicate, and templates all `POST` a **draft**.
   Export is the immutable published version.
4. Drafts never execute. Start a **published** version from home
   (`?start=1` or Commands → Start published version) with typed input
   and an idempotency key.
5. Webhook and schedule admin open from home when the role can see
   those triggers. Webhook secrets are shown **once**, then discarded.

Editor `/workflows/{id}` — one draft, two views. YAML is the only
persisted definition.

1. **Action library** — enabled catalog only. Triggers stay
   workflow-level; they are not canvas nodes. Library is a drawer;
   Esc closes it and returns focus to **Library**.
2. **Canvas** — pan, zoom, select, connect compatible ports. Invalid
   YAML never draws a guessed graph. State uses icon + text. Keyboard:
   focus the canvas, then Zoom in / Zoom out / Reset. Selecting a node
   announces enough to use the inspector. This is not a screen-reader
   graph rewrite.
3. **Add action wizard** — type → authorized target/credential →
   configure → map ports → review. Esc closes. Secrets never appear in
   selectors.
4. **YAML / runs / inspector drawers** — labeled top-bar toggles. Esc
   closes the open drawer and returns focus. On narrow viewports
   (`max-width: 767px`) the inspector stacks first — a documented
   breakpoint, not a mobile app. Selecting a run overlays step status
   on this canvas; the inspector shows redacted last-run I/O for the
   selected node. **Open execution** still goes to `/executions/{id}`.
5. **YAML editor** — labeled editor, line/column jump, debounced
   validate. Save normalizes and replaces the buffer with API YAML +
   digest.
6. **Validation** — live region; errors link to a node or YAML path.
   Save stays disabled while invalid.
7. **Publish** — last **saved** draft only. Restore creates a new draft.

Catalog library: `/actions`. Templates: `/templates`.

## Membership

`/membership` — foundation **admin** surface (ADV-024). Nav shows it
only when `GET /workspace` grants `workspace.administer` or
`platform.administer`. Embed catalog omits the route unless the peeked
session grants the same (`rules.membershipIsolationGranted`).

Walkthrough (admin session required):

1. Open **Membership** from left nav (or Settings → Membership).
2. Confirm cookie session via the session chip. Local-only header
   identity is a labeled fallback — not production.
3. Tenant + workbench live in tab `sessionStorage` (not secrets). The
   UI never sends `X-FlowForge-Workspace-ID` as the lookup key.
4. Create tenant / workspace only with `platform.administer`. Creating
   a workspace makes the caller workspace admin.
5. List members, add/update/remove (`GET|PUT /workspace/members`,
   `DELETE /workspace/members/{userID}`). Last-admin conflict is a
   problem+json — do not force-remove the last admin.
6. Read the permission matrix (`GET /permission-matrix`) — captions
   and `sr-only` cell text, not color ticks alone.
7. Soft-delete (`DELETE /workspace`) revokes bound embed sessions
   including CHIPS. Later cookies are `401`. Use existing stale-session
   chrome (ADV-019) — no “workspace deleted” banner.

Isolation (`/isolation`) is a **negative** exercise on the same
identity: cross-workspace clicks must fail closed. Success is a
denial, not a row of foreign data.

## Credential vault

`/credentials` → `/credentials/new` → `/credentials/{id}`.

1. List/search is **metadata only** (display name, type, status, tags,
   fingerprint, timestamps). Filter by name/tag/type/status.
2. **Add credential:** choose type from `GET /credentials/catalog`,
   enter display name/tags, paste into masked `SecretField`s. Submit
   once. Fields clear on success and unmount. Never in `localStorage`,
   URL, or analytics.
3. **Rotate / test / disable:** same mask-and-clear rule. Test status
   is safe metadata, not a secret dump.
4. **Delete:** load `deletion-impact`, then `DELETE` with
   `{confirm:true}`.
5. Workflow selectors show **display names** only. The UI never reads
   `CREDENTIAL_KEK`.

If a response ever shows plaintext, treat it as a backend contract
bug (`role="status"` stripped-keys banner) and stop. Do not paste it
into tickets or screenshots.

## Approvals

`/approvals` → `/approvals/{id}`.

1. Filter by operation/target/digest and documented `?status=`
   (default pending).
2. Open a row. Binding is version + target + policy revision +
   operation + expiry.
3. **Decide** (Approve/Reject) needs `approval.decide` and CSRF. The
   requester cannot self-approve — controls stay disabled.
4. Expired or rebound rows show `Approval expired`; Approve/Reject
   stay disabled. The server recheck is authoritative
   (`POST /approvals/{id}/decide`).
5. Durable `flow.approval` wait survives worker/pod loss. Resume is
   **decide**, not a new start.

E12.1 UI evidence: [approval-expired.svg](../reference/e12-security-evidence/approval-expired.svg).

## Executions

`/executions` → `/executions/{id}`.

1. Filter by workflow and documented status. Focus the history
   listbox: Arrow keys move, Enter opens detail.
2. `indeterminate` uses a stronger border plus icon + text — never
   “it probably did not run.”
3. Start only a **published** version (home or the start panel).
   Duplicate idempotency key → `200` replay; same key + different
   input → `409`.
4. Detail: graph replay, redacted logs, artifacts (short-lived
   authorized download), cancel (`execution.cancel`), safe retry when
   policy allows. Skip-to-error / skip-to-indeterminate links are on
   the detail page.
5. Compare two redacted runs or versions. Secrets stay redacted.

Capacity, queue lag, and restore are **not** UI — read
[E12.2](../reference/e12-resilience-capacity.md) and
[incident-recovery](../operations/incident-recovery.md).

## Alerts

`/alerts` → `/alerts/{id}`.

1. Nav appears with `alert.view`. Default list is **open**.
2. Cards show kind, severity (icon + text, not color alone), action,
   outcome, code, timestamps, and correlation / request / resource
   ids — **never** a details payload or secret.
3. Unexpected secret fields are stripped and announced.
4. **Ack** is CSRF + empty `{}` and requires `alert.ack`
   (operator/admin). Viewer can read; ack stays disabled.
5. Correlate to an execution when a resource id is present — do not
   invent a second incident console.

On-call escalation (metrics, `X-Request-ID`, restore) is
[incident-recovery](../operations/incident-recovery.md), not this
screen.

## Embed chrome

`/embed/v1/…` — thin chrome on the same product routes. Do not treat
this section as the host contract; wire from
[embed-sdk](../reference/embed-sdk.md) and
[portal-adapter](../reference/portal-adapter.md).

Operator expectations:

1. Host frames `{origin}/embed/v1/…` with **display** query only.
   `assertion=` in the URL is rejected and stripped.
2. Compact JWS arrives body-only (allowlisted postMessage or the
   exchange form). `POST /embed/exchange` uses `credentials: include`.
3. Chrome waits for `GET /session` `session.embed` (ADV-021): mode,
   tenant/workbench/workspace, capped capabilities, subject. Host
   `?tenant=` / `?workbench=` is never authorization.
4. Missing `session.embed` is an **alert** (`EMBED_CHROME_MISSING_SESSION_MESSAGE`).
5. Replay of the same assertion is `409`. Existing ProblemBanner
   (`Conflict (409)`) — forget the JWS.
6. Gated embed nav follows the same ADV-024 grant as standalone.
   Workspace switcher stays locked.
7. Portal demo: `/portal/workflows` → mint → iframe `/embed/v1`.
   Production Portal is two HTTPS origins. Empty host allowlist fails
   closed.

E12.1 iframe/session evidence:
[chloe-ui.md](../reference/e12-security-evidence/chloe-ui.md).

## Admin screens

These are workspace-admin / platform-admin surfaces, not daily
operator chrome.

| Screen | Route | When it appears | What to do |
| --- | --- | --- | --- |
| Settings | `/settings` | Always | Session panel (`#session`), foundation links, OpenAPI links (ADV-020: `platform.administer` or the link 403s) |
| Membership | `/membership` | ADV-024 grant | Members, roles, matrix — [Membership](#membership) |
| Isolation | `/isolation` | ADV-024 grant | Negative cross-workspace clicks; expect denials |
| Config / Targets / Profiles | `/config`, `?group=` | `opsconfig.view` | Draft → publish versioned cluster/SSH/runtime/policy/connection resources. Selectors are authorized metadata only |
| Audit | `/audit` | `alert.view` | Append-only `GET /audit-events`. No edit/delete. Not the isolation stub `GET /workspace/audit-events` |
| Portal host | `/portal/workflows` | Demo entry | Portal RBAC → mint → embed iframe. Not FlowForge authorization |

Do not add swagger/metrics screens for non-admins. Do not invent
headroom, queue-lag, or fencing dashboards.

## Session, CHIPS, and CSRF

| Context | Cookies | Operator expectation |
| --- | --- | --- |
| Standalone (first-party) | `ff_session` HttpOnly `SameSite=Lax`; `ff_csrf` readable `SameSite=Strict`; both `Path=/api/v1` | Same-origin `/api/v1` rewrite. Mutations send `X-CSRF-Token`. |
| Embed / Portal iframe | **CHIPS** `SameSite=None; Secure; Partitioned` on both cookies | Keep `credentials: "include"`. Do **not** use Storage Access / unpartitioned cookies. |

- Idle default **30m**, absolute **12h**. Refresh extends idle only;
  it cannot pass the absolute cap.
- Chip/banner warn in the last five minutes. Expired is `role="alert"`
  (`Session expired`); `401` latches `Stale session`.
- Missing CSRF with a session cookie fails closed (`403`) before the
  mutation is treated as done.
- Hostile `Origin` is `403` with no CORS grant.
- Bearer tokens are never stored in `localStorage` or the URL.
- Trusted-dev `POST /session` + identity headers are **local only**.
  Production identity is `POST /embed/exchange`.

Cookie flags and session API:
[Frontend UI — E2.3](../reference/frontend-ui.md#e23-browser-session-contract-api--ui).
Threat model: [Security model](../reference/security-model.md).

## What not to do in the UI

- Do not paste assertions, webhook secrets, or credential plaintext
  into tickets, chat, or screenshots.
- Do not treat [frontend-ui.md](../reference/frontend-ui.md) as this
  guide — it is the contract map for implementers.
- Do not retry a `403` with host tenant/workbench values.
- Do not treat Portal RBAC as FlowForge authorization.

## Accessibility

Review: [e12-accessibility-review.md](../reference/e12-accessibility-review.md).

Keyboard-first path: skip link → nav → search → Ctrl+Shift+K → Esc
back to Commands. Then `/workflows` List/Cards, vault labeled secret
fields, `/executions` listbox arrows, `/approvals` disabled decide
when expired.

## Local smoke (secret-free)

```bash
pnpm --filter @flowforge/web test
pnpm --filter @flowforge/web lint

# Full stack: copy env-template.txt → .env, then
docker compose up --build
# UI http://localhost:3000  API health http://localhost:8080/api/v1/health
```

Compose seeds tenant `local` / workbench `default` and demo vault
credentials for `https://idp.example|admin-1` (opt out with
`SEED_LOCAL_DEFAULTS=0`). How to point the membership form at that
context: [deployment.md](../deployment.md#local-default-tenant-seed).

Compose and production env stay on [deployment.md](../deployment.md).
Do not copy `TRUSTED_DEV_IDENTITY_HEADERS`, sample `PLATFORM_ADMINS`,
`SEED_LOCAL_DEFAULTS`, or the compose local KEK into production.
