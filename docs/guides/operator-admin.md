# Operator and admin UI guide

Relates to #184 / Part of #181. **Keep #184 open.**
Relates to #207 / Part of #195. **Keep #207 open.**

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
| Rewrite surfaces (Chloe → charter §11.1) | [rewrite-ui-surfaces.md](../reference/rewrite-ui-surfaces.md) — docs-only; not this walkthrough |

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
   host is the E11.3 demo. On `/workflows/{id}` the nav collapses to
   an icon-rail (or overlay) so the canvas can take the viewport.
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

`/workflows` is the **product home** (UX.8). `/` with `workflow.view`
lands here. Health, OpenAPI, cookie session, and Example context live
under Settings (or Membership). The list leads; session chrome does
not. This is **not** an n8n clone — n8n is a behavior reference only
(canvas-first shell, left library, right inspector, executions drawer).
Do not copy n8n assets or source. ADV/embed/membership meaning is
unchanged.

Rewrite surface map and operator migration notes (Chloe, docs only;
charter [§11.1](../architecture/flowforge-rewrite-n8n-class-parity.md#111-chloe--ui-surfaces--operator-migration-notes)):
[rewrite-ui-surfaces.md](../reference/rewrite-ui-surfaces.md).

1. Filter by search, folder (`ops/…`, `ops: …`, or slug `ops--name`),
   tag, owner, trigger, environment, status, **activation**, last run,
   last modified.
2. Toggle **List** / **Cards** (`aria-pressed`). The **Activation**
   column/status (R6.2 / #271 — **keep #271 open**) shows whether a
   published version is active for webhook/schedule. Drafts read
   **Draft — not live**. Opening the status goes to the editor
   Triggers tab (`#activation`), not the three home drawers.
3. Create, import YAML, duplicate, and templates all `POST` a **draft**.
   Templates then open the editor. Export is the immutable published
   version.
4. Drafts never execute. Start a **published** version from home
   (`?start=1` or Commands → Start published version) with typed input
   and an idempotency key.
5. Webhook and schedule admin still open from home when the role can
   see those triggers (`?webhooks=`, `?schedules=`). They are not the
   activation path. Webhook secrets are shown **once**, then discarded.

Open a row → `/workflows/{id}` (same page under `/embed/v1`). YAML
(`flowforge/v1`) is the only persisted definition; the canvas is a
projection. Optional `metadata.ui.layout` is a non-authoritative
position hint on that YAML: the editor applies it on load and writes
it back on Save draft (R2.5 / #238 — **keep #238 open**). Walkthrough:
**home → editor top bar → palette → inspector → YAML mode → runs
drawer.**

### Editor top bar

Sticky workflow context. Left nav collapses to an icon-rail (or overlay)
so the canvas can take the viewport. Commands bind to this route id.

1. **← Workflows** returns to product home.
2. Read name, slug, status, revision, and **Unsaved** / **Saved**.
3. **Add action** opens the wizard. **Undo (Ctrl+Z)** / **Redo
   (Ctrl+Shift+Z)** reverse canvas graph edits (move/add/remove/connect)
   before save. Relates to #236 / Part of #228. Keep #236 open.
   **Library**, **YAML**, **Inspector**, and **Runs** toggle satellites
   (`aria-pressed` / `aria-expanded`). Library, Inspector, and Runs
   remember open/closed; closed is still a rail.
4. **Save draft** normalizes then `PUT`s the draft and replaces the
   buffer with API YAML + digest. Disabled while invalid.
5. **Publish** is last **saved** draft only. Optional publish note.
6. **Start published** lists published versions only. Drafts never run.
7. **Activation** (R6.1 / #270 — **keep #270 open**) shows whether a
   **published** version is active (at least one enabled webhook or
   schedule pin). Gracie + jonny R6 confirmation: D2 compose of enable
   + version pin (no new resource); D3 triggers stay workflow-level;
   drafts never run / never look live. **Draft — not live** when
   nothing is published. Opening **Activation** focuses the inspector
   Triggers tab — not the home webhook/schedule drawers. Home column
   is #271; one-gesture test-run is #272.

### Palette / library

The action library is a **left drawer** that opens with the editor
(remembered-open) and stays a **Library** satellite when hidden —
not hide-by-default only. Relates to #234 / Part of #228. Keep
#234 open.

1. **Library** or a canvas **+** opens the enabled catalog. Triggers
   stay workflow-level; they are not canvas nodes. Hide remembers
   closed for the next visit in this tab.
2. **Add action** wizard — type → authorized target/credential →
   configure → map ports → review. Esc closes. Secrets never appear in
   selectors.
3. Drag from the library still inserts defaults. Catalog 403 / empty
   list fail closed. `/actions` is the catalog reference, not a third
   app.

Canvas: pan, zoom, select, drag nodes, connect compatible ports.
Undo (Ctrl+Z) / Redo (Ctrl+Shift+Z) reverse graph edits before save.
Shift+click or Shift+drag multi-selects nodes; Ctrl+A selects all.
**Fit (F)** frames the selection (or the graph). **Snap (G)** locks
drops to the 16px grid (R2.4 / #237 — **keep #237 open**). Delete
removes the selection. Node positions persist as optional
`metadata.ui.layout` on draft save/load (R2.5 / #238 — **keep #238
open**). Missing or invalid layout uses auto-layout. Invalid YAML
never draws a guessed graph. State uses icon + text.
Keyboard: focus the canvas, then Zoom in / Zoom out / Fit / Snap /
Reset. Selecting nodes announces enough to use the inspector — this is
not a screen-reader graph rewrite.
Esc on an open drawer restores focus to the matching top-bar control.
On narrow viewports (`max-width: 767px`) the inspector stacks first —
a documented breakpoint, not a mobile app.

### Inspector

The inspector is a **right drawer** that opens with the editor
(remembered-open) and stays an **Inspector** satellite when hidden —
not hide-by-default only. Selecting a node focuses the conversation
shell. Relates to #235 / Part of #228. Keep #235 open.

1. **Node** — conversation chrome for this step: type-specific
   parameters / `with` (cataloged core / Kubernetes / SSH / script /
   HTTP — not a bare JSON blob; R3.1 / #246 — keep #246 open) /
   typed field-path mapping between ports (`allowedWith` / catalog
   port types; R3.2 / #247 — keep #247 open) / pins / credentials by
   **display name**. Pick an existing vault item or **add** one; secret
   entry stays in the masked wizard (modal or `/credentials/new`
   return-to-editor). The rail never shows `SecretField` / plaintext /
   rotate. No expression language. Incompatible mappings are blocked
   or explained.
2. **Workflow** (nothing selected) — tabs **Triggers / Versions /
   Pins**. Triggers leads with “this published version is active”
   (enable + version pin; R6.1 / #270 — **keep #270 open**). Same
   webhook/schedule contracts as home. Restore creates a new draft.
   Pins are authorized metadata only.
3. **Edge** — port compatibility and field-path mapping. Edges stay
   `nodeId.port`. Nested paths persist on `data.map` / `flow.condition`.
4. **Validation** — live region; errors link to a node or YAML path.
5. **Hide** remembers closed for the next visit in this tab. The
   **Inspector** satellite stays on the canvas so the shell is never
   missing.
   Save stays disabled while invalid.
5. **Last run** — when a run is selected in the Runs overlay, redacted
   input / output / logs for this node. Secrets stay `[redacted]`.
   `indeterminate` is icon + text.

### YAML mode

YAML is a **mode** (drawer under the canvas), not a permanent stack.

1. Open **YAML**. Labeled editor, line/column jump, debounced validate.
2. **Validate** and **Normalize** live here (or Commands). Normalize is
   not a Save peer.
3. Starter / invalid fixtures are **Developer samples** or Settings →
   Developer — not primary chrome.
4. Import stays on `/workflows` and still validates before create.

### Runs overlay

1. **Runs** is a remembered-open satellite scoped to this workflow
   (closed still shows a **Runs** rail — it does not bury the canvas).
   `/executions` remains the workspace inbox.
2. Status chips filter this workflow’s runs. **Skip to failed** /
   **Skip to indeterminate** jump to the matching run or step without
   leaving the graph. Arrow keys move; Enter / Space overlays the
   focused run on **this** canvas. Do not expect a second replay graph.
3. Inspector shows redacted last-run step I/O at operate density for the
   selected node (overlay-selected run, or the latest published run when
   no overlay is active). Failures and indeterminate steps jump to the
   node. Secrets stay `[redacted]`.
4. **Cancel / Retry / Stop** use the existing execution routes on the
   selected overlay run. Retry appears only when
   `result.retry.allowed` is true. `indeterminate` stays loud — never
   silent success.
5. **Open execution** goes to `/executions/{id}`. **Clear run overlay**
   removes the overlay and falls back to latest. Still no draft execute.
   Do not invent `/replay`.

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

1. Workbench find (R5.1): **metadata only**. Search by **display name**
   (type / status chips and exact tag). Columns are display name, type,
   status, tags, last test, rotated, and Open. Focus the listbox: Arrow
   keys move, Enter opens existing `/credentials/{id}` detail. Filters
   stay on this page and are not sent to `GET /credentials`. Gracie
   R5 security line (inherit R5.2 / #265, R5.3 / #266): no KEK in
   the browser; display-name + UUID only; secrets never in YAML /
   search / analytics; unexpected plaintext is a contract bug
   (strip + stop — do not paste into chrome).
2. **Add credential:** choose type from `GET /credentials/catalog`,
   enter display name/tags, paste into masked `SecretField`s. Submit
   once. Fields clear on success and unmount. Never in `localStorage`,
   URL, or analytics.
3. **NDV add (R5.3):** from the selected-node inspector, **Add
   credential** opens the same guided masked wizard without abandoning
   the graph (modal, or `/credentials/new` return-to-editor). After
   add, the picker selects the new credential by **display name**; YAML
   stores the UUID only. Wizard stays add; the NDV stays edit/pick.
   No `SecretField` / plaintext in the rail.
4. **Operate (R5.2):** test, rotate, usage, and deletion-impact sit on
   `/credentials/{id}` at operate density using existing vault routes.
   Test status is safe metadata. Rotate is mask-and-clear; after
   submit, chrome shows **display-name + UUID only**. Disable/enable
   stay explicit. CSRF on mutations. Unexpected plaintext is strip +
   stop — do not paste into chrome.
5. **Delete:** deletion-impact is already on the page; type the
   display name, then `DELETE` with `{confirm:true}`.
6. Workflow selectors show **display names** only. The UI never reads
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

1. Operate inbox (R4.1): filter by workflow and documented status
   (`GET /executions` `status` / `workflowId` / `limit` — also in the
   URL). Columns are status, workflow, version, started, duration,
   correlation, and Open. Focus the listbox: Arrow keys move, Enter
   opens existing `/executions/{id}` detail — this inbox is not a
   second replay graph. Cancel / Retry / Stop stay on the row (R4.4)
   using existing cancel, retry, and emergency-stop routes. Retry is
   shown only when `result.retry.allowed` is true. Waiting rows expose
   Approve / Reject on the bound approval (`POST /approvals/{id}/decide`,
   R4.5) — the requester cannot self-approve, and there is no invented
   resume route. Do not expect cursor / time / trigger / actor filters
   yet. The editor **Runs** overlay (R4.2) filters and highlights this
   workflow’s runs on the same canvas; waiting overlay rows use the same
   decide path.
2. `indeterminate` uses a stronger border plus icon + text +
   explanation — never silent success, never “it probably did not run.”
3. Start only a **published** version (home or the start panel).
   Duplicate idempotency key → `200` replay; same key + different
   input → `409`.
4. Detail: graph replay, redacted logs, artifacts (short-lived
   authorized download), cancel (`execution.cancel`), safe retry when
   `result.retry.allowed`, and script emergency stop. Skip-to-error /
   skip-to-indeterminate links are on the detail page.
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
- Product lists and wizards stay primary. Establish or debug the cookie
  session from the session chip (`Settings` `#session`) or Membership
  **Example context**. Do not expect BROWSER SESSION + WORKSPACE CONTEXT
  blocks on `/workflows`, `/credentials`, or `/executions`.
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
back to Commands. Then `/workflows` List/Cards, open an editor, Tab
the labeled top bar, Esc a library / YAML / runs drawer (focus
returns), vault labeled secret fields, `/executions` listbox arrows,
`/approvals` disabled decide when expired.

## Local smoke (secret-free)

```bash
pnpm --filter @flowforge/web test
pnpm --filter @flowforge/web lint

# Full stack: copy env-template.txt → .env, then
docker compose up --build
# UI http://localhost:3000  API health http://localhost:8080/api/v1/health
# worker claims /api/v1/jobs/claim so Start published leaves queued
```

Compose seeds tenant `local` / workbench `default` and demo vault
credentials for `https://idp.example|admin-1` (opt out with
`SEED_LOCAL_DEFAULTS=0`). How to point the membership form at that
context: [deployment.md](../deployment.md#local-default-tenant-seed).
The compose `worker` is required for published runs; opt out with
`--scale worker=0` or `LOCAL_WORKER=0`.

Compose and production env stay on [deployment.md](../deployment.md).
Do not copy `TRUSTED_DEV_IDENTITY_HEADERS`, sample `PLATFORM_ADMINS`,
`SEED_LOCAL_DEFAULTS`, `LOCAL_WORKER`, or the compose local KEK into production.
