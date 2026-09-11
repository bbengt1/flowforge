# Rewrite draft: control-plane / execution / credential contracts vs n8n-class parity

**Status:** draft for Gracie fold-in. Jonny slice. Not an epic backlog and **not** an issue-creation brief.

**Audience:** Gracie (rewrite package: vision, IA, keep vs replace vs retire), Chloe (UI/editor surfaces + operator migration notes), Arie (later epic themes only).

**Baseline:** `main` at the time this draft was written. Normative contracts remain the documents listed under [Sources](#sources-on-main). If those pages and this draft disagree, those pages win until the agreed rewrite package lands.

This page is a **contract and gap analysis**. It does not change OpenAPI, handlers, YAML schema, or ADV/E12 posture.

---

## Purpose

Brent asked for a “full clone of n8n” rewrite. The team agreement is:

- **Not** a literal clone. No n8n source, assets, branding, trademarks, colors, icons, or pixel layouts.
- **Independent FlowForge rewrite** aimed at **n8n-class UX/feature parity** under FlowForge’s own information architecture and security model.

Jonny’s slice: what the control plane, execution engine, and credential vault already guarantee; where n8n-class operator expectations exceed those contracts; and which gaps are **additive fields / new `/api/v1` resources** versus **greenfield**.

Honest baseline: FlowForge already has a substantial control plane (E1–E12 on `main`). Most “parity” work is contract extension, catalog enablement, or operator-facing completeness — not a new API product.

---

## IP / behavior-reference boundary (explicit)

| Allowed | Forbidden |
| --- | --- |
| Describe n8n-class *capabilities* in plain language (workflow history, credential picker, webhook trigger, queue workers, …). | Copy, transcribe, or reconstruct n8n source, SQL, REST paths, JSON schemas, CSS, icons, or copy. |
| Use n8n as a **behavior reference** for operator expectations (same class of job). | Match n8n URL shapes, resource names, expression syntax (`{{ }}`), item/binary model, or queue product (Redis/Bull). |
| Keep FlowForge IA: YAML `flowforge/v1`, workspace + `(tenant_id, workbench_key)`, ADV fail-closed, E12 evidence. | Import n8n workflow JSON as a persisted format, or persist a canvas graph beside YAML. |
| Cite public product behavior at a high level. | Vendor n8n nodes, credentials, or marketplace listings. |

Chloe’s landed chrome already states the same rule ([frontend UI](../reference/frontend-ui.md): “Not an n8n clone”). This draft applies that rule to **API, data model, and workers**.

---

## Non-negotiable keeps

These must survive any rewrite — including a full UI/IA refresh. A rewrite story that cannot meet them stays disabled (security-model gate).

| Keep | Why it is non-negotiable | Normative source |
| --- | --- | --- |
| **YAML is the persisted source of truth** (`flowforge/v1`). Canvas is a projection. No UI-only graph format. | Portability, audit, digest pinning, import/export. Invalid YAML must never guess a graph. | [workflow-model](../reference/workflow-model.md), [workflow-yaml-schema](../reference/workflow-yaml-schema.md), [architecture](../architecture.md) |
| **Drafts never run. Published-only execute.** Start requires a published `workflowVersionId`. Versions are immutable once published/run. | Prevents unreviewed side effects; executions stay reproducible. | E3.2 / E10.1 in [backend-api-map](../reference/backend-api-map.md) |
| **Workspace isolation + RBAC + ADV fail-closed.** Server-derived workspace; host tenant/workbench/workspace UUID is never authorization. FORCE RLS + composite FKs. Cross-workspace UUIDs are `404`. | Tenancy leak is a ship-stopper. | [security-model](../reference/security-model.md), [database](../reference/database.md) |
| **Encrypted credential vault. No plaintext to the UI.** Accept secret only on create/rotate over TLS; envelope-encrypt before persist; never return in JSON, problem details, logs, YAML, jobs, or audit `details`. | Credential exfil via rewrite UI/API is out of scope for “parity.” | E4.1 [backend-api-map](../reference/backend-api-map.md#encrypted-credential-vault-e41) |
| **Durable executions, leases/fencing, redacted step I/O.** PostgreSQL jobs; `SKIP LOCKED` claim; HMAC job ticket; heartbeat + fencing token; lease loss → `indeterminate` (never silent retry). Step I/O redacted before persist/display. | Worker crash must not double-apply; operators must not see secrets in last-run I/O. | E5.1–E5.3, E12.2 |
| **Embed signed assertion + CHIPS sessions** (if the rewrite keeps embed). Ed25519, `aud=flowforge`, durable `jti`, host/issuer bind, capability cap. Embed cookies: `SameSite=None; Secure; Partitioned`. No unpartitioned `SameSite=None`. | Portal/host iframe without weakening first-party cookies. | E11 + ADV-007/021/023, [embed-sdk](../reference/embed-sdk.md) |
| **E12 evidence / production-gates mindset.** Features that cannot meet the security model stay off. Do not weaken E12.1 / E12.2 harnesses or invent trusted-host shortcuts. | Production enablement is evidence-backed, not “looks like n8n.” | [e12-security-verification](../reference/e12-security-verification.md), [e12-resilience-capacity](../reference/e12-resilience-capacity.md), [e12-threat-model-review](../reference/e12-threat-model-review.md) |

Related keeps that rewrite planning often under-counts:

- Triggers stay **workflow-level** (`spec.triggers`), never canvas nodes.
- Resource refs in YAML are **workspace UUIDs** (targets, profiles, connections, policies) — never display names, hostnames, or plaintext credentials.
- Provider engines stay policy-bounded (no free-form `kubectl`, SSH terminal, or unrestricted HTTP URL).
- Script artifacts stay packaged/scanned/signed/pinned at publish; drafts/unsigned/unscanned cannot execute.
- Audit events stay append-only and secret-free.
- `/api/v1` stays the control-plane prefix. There is no unversioned alias and no `/api/v2` today ([openapi](../reference/openapi.md)).

---

## Current control-plane inventory (honest baseline)

FlowForge on `main` already implements the class of control plane an n8n-like product needs for **author, publish, pin, start, run, observe, cancel/retry, retain**. Gaps below are mostly missing *operator conveniences* or *catalog phases*, not missing tables.

| Area | What exists on `main` | Product routes (stable `/api/v1`) |
| --- | --- | --- |
| Sessions | Cookie `ff_session` + CSRF; embed CHIPS; trusted-dev headers non-prod only | `/session`, `/session/refresh`, `/session/logout` |
| Tenancy / RBAC | Tenant + workspace unique on `(tenant_id, workbench_key)`; permission matrix; membership | `/permission-matrix`, `/tenants`, `/workspaces`, `/workspace`, `/workspace/members` |
| Workflows | Validate/normalize, one mutable draft, immutable versions, compare, export, restore-as-new-draft | `/workflows`, `/draft`, `/publish`, `/versions`, `/compare`, `/export`, `/restore` |
| Catalog / nodes | Typed catalog + `allowedWith` / policy / bounds / redaction; core + K8s/SSH/script/HTTP | `/workflows/catalog`, `/kubernetes/catalog`, `/ssh/catalog`, `/scripts/catalog`, `/http/catalog` |
| Credentials | Envelope vault, rotate/test/use/usage/deletion-impact; types `kubernetes`, `ssh_private_key`, `token`, `webhook_secret`, `provider` | `/credentials`, `/credentials/catalog` |
| Ops-config pins | Versioned targets, profiles, connections, templates, schemas, policies; publish pins exact revisions | `/{collection}`, `/ops-config/select`, `/workflows/{id}/versions/{vid}/pins` |
| Executions | History, redacted steps/jobs, cancel, gated retry, emergency-stop, artifacts + short-lived grants | `/executions`, `/cancel`, `/retry`, `/artifacts`, `/jobs/*` (workers only) |
| Triggers | Manual start + idempotency; replay-safe webhooks; timezone schedules + dispatcher | `/workflows/{id}/executions`, `/hooks/{publicId}`, `/triggers`, `/schedules` |
| Approvals | Policy evaluate; bound approval; wait/resume via decide (no separate resume route) | `/policy/evaluate`, `/approvals`, `/approvals/{id}/decide` |
| Embed / Portal | Mint/exchange/JWKS/rotate; Portal adapter; tenancy bind on session | `/embed/*`, `/portal/adapter` |
| Isolation hooks | E2.2 stub records (cache/realtime/audit/credential/artifact/job) — **not** the product vault/artifacts/queue | `/workspace/records`, `/workspace/realtime/...` |
| Evidence | E12.1 security suite, E12.2 restore/worker/queue/headroom, E12.3 threat-model + ops docs | docs + `scripts/e12-*.sh` |

UI already consumes most of this (Chloe UX.1–UX.12). Known **API** gaps Chloe already filed as non-blocking: no execution-vs-execution compare route; no replay-projection endpoint (client joins version YAML + steps). See [frontend-ui E6.4](../reference/frontend-ui.md#e64-execution-history-and-replay).

---

## Parity gap matrix

**How to read the gap column**

- **Keep / no clone** — n8n-class product has a similar *job*, FlowForge already meets it with a stricter contract. Do not loosen to look like n8n.
- **Extension** — additive `/api/v1` fields or resources on existing aggregates.
- **Catalog enablement** — type already designed (`phase: next`) and rejected at validate/publish until a gated epic.
- **Out of scope (flag)** — n8n-class feature that must not become a silent rewrite assumption.
- **Greenfield-ish** — no durable product resource today (still prefer `/api/v1` additive design, not a new public API family).

n8n is a **behavior reference only**. Rows describe capability class, not n8n APIs.

| n8n-class capability | FlowForge today | Gap / contract change needed |
| --- | --- | --- |
| **Workflow CRUD + versioning** | Full draft/publish/history/compare/export/restore. Slug unique per workspace. Status `draft` until first publish. | **Keep** the draft/publish split (stronger than “save + activate”). **Extension:** archive/unarchive, server-side duplicate, list filters (tag/folder/owner) if those become first-class. `workflow_templates` table exists; **no template CRUD API on `main`** (UI copies YAML into a new draft). No execution-vs-execution compare route (client-side only). |
| **Node / catalog contracts** | Live `GET /workflows/catalog` with typed ports, `allowedWith`, policy, bounds, redaction. Core + K8s + SSH + script + HTTP/notification. `next` / `provider` fail closed (`unsupported-node`). | **Keep** typed catalog + fail-closed unknown fields. **Catalog enablement** for designed-but-disabled types (`flow.switch`, `flow.parallel`/`join`, `flow.forEach`, `data.merge`, `event` trigger, `workflow.call`, …) — each needs its own contract, threat review, and gate. **Out of scope:** connector marketplace / generic node runtime. |
| **Credentials vault + node pin** | Envelope vault; plaintext never returned. Nodes pin **ops-config resource UUIDs** (`clusterTargetId`, `sshTargetId`, `connectionId`, …). Those resources pin `credentialId`. Webhook trigger pins `secretCredentialId` **outside YAML**. Inspector shows display names + create-without-leave. | **Keep** “YAML never holds secrets; pin is a published resource revision.” **Extension (UX completeness):** richer `permittedActions` / type catalog for inspector pickers; usage already lists draft/version/execution/trigger refs. **Do not** add a generic “credential id on every node” field that bypasses target/connection policy. `type=provider` is a reserved vault type, not a marketplace. |
| **Executions / history / retry / cancel** | Workspace + per-workflow history; redacted steps; cancel (`execution.cancel`, idempotent); retry only for retry-safe core / declared SSH / declared script; `indeterminate` is terminal without verification; emergency-stop for scripts. Retention 90 days. | **Keep** gated retry and `indeterminate`. **Extension:** cursor/filter (status, time, trigger, actor) beyond `status`/`workflowId`/`limit`; optional execution-compare and replay-projection routes Chloe noted. **Not a gap to close by cloning:** partial execution of a draft, pin-data, or “run this node only” against unpublished YAML. |
| **Webhooks / schedules / triggers** | Manual (CSRF + idempotency + typed 16 KiB input). Webhook: opaque `wh_` id, vault HMAC, raw-body verify, replay/skew/rate/concurrency. Schedule: IANA TZ, cron XOR interval, safe defaults `overlap=skip`, `misfire=ignore`, `catchUp=0`. Dispatcher is `POST /schedules/dispatch` (operator/tick), not public ingress. | **Keep** signed webhooks and safe schedule defaults. **Catalog enablement:** `event` trigger (`phase: next`). **Extension:** richer webhook content types (JSON-only MVP); first-class last-delivery / dead-letter metadata if operators need n8n-class ingress debug without logging raw bodies. **Out of scope:** secret-in-URL, unsigned public POST, implicit local TZ. |
| **Variables / expressions** | **No expression language.** Parser rejects `{{`, `${`, `{%`. Mapping/condition paths are dotted identifiers. `data.set` is public/internal literals only. Email templates allow `{name}` against typed inputs only. Code `expression-forbidden` / `template-forbidden`. | **Keep / no clone** of n8n `{{ $json }}` / `$env` / `$vars` as a default. If rewrite UX needs “variables,” that is a **new bounded resource** (workspace non-secret settings + allowlisted interpolation) with a threat review — not enabling YAML templating. Secret material must stay in the vault and resolve only as worker handles. |
| **Environments / projects / folders** | **Environment** today = `workbench_key` on the workspace (switcher shows it). **Project** ≈ workspace (isolation boundary). **Folders** on home are a **client-side name/slug prefix** (`ops/…`, `ops: …`, `ops--name`). Labels live in YAML `metadata.labels`. No folder/project API. | **Flag out of scope for the first rewrite package** unless Gracie’s IA promotes them. If in scope later: **extension** — `folderId` / tags on `workflows` (not a second tenancy axis). Do **not** invent a sibling isolation boundary that bypasses workspace RLS. Do **not** treat n8n “environments” as credential-override magic; FlowForge already pins published target/credential revisions per workbench. |
| **Sub-workflows** | Designed as `workflow.call` (`phase: next`): pinned `workflowVersionId`, declared I/O schemas, caller/callee policy, no recursion, lineage in audit. Validate/publish reject it today. | **Catalog enablement + execution-plan expansion.** Not greenfield design. Must not become an implicit “call any workflow by name.” Child runs stay same-workspace; cancellation of parent/ancestor stays policy-gated ([action-catalog](../reference/action-catalog.md)). |
| **Binary data / artifacts** | Encrypted execution artifacts + short-lived same-origin download grants; log windows; legal hold; retention purge. Scan rejects secrets before persist. Port outputs are schema-bounded JSON (16 KiB typical); oversized ports **fail**, they do not auto-promote to artifacts. `artifact.write` / `artifact.read` are `phase: next`. | **Keep** grant/re-auth model (no durable public URLs, no bucket creds). **Catalog enablement** for explicit artifact nodes. **Do not** adopt an implicit binary-on-every-item bus. Large files stay object storage + metadata in PostgreSQL. |
| **SSO / auth** | Production identity: `POST /embed/exchange` (host-minted assertion) or trusted-dev headers in non-prod. Docs already name a **future OIDC login**. Users table is `(issuer, external_subject)`. No standalone OIDC/SAML/password login on `main`. Metrics/OpenAPI require `platform.administer`. | **Greenfield-ish extension:** first-party OIDC (and later SAML if required) that upserts the existing `users` row and issues the same `ff_session` + CSRF pair. **Keep** fail-closed production (no header identity). Embed remains a host-session exchange, not “SSO inside the iframe.” |
| **Multi-tenant vs tenant / workbench** | Isolation root is `tenants`; operational boundary is `workspaces` unique on `(tenant_id, workbench_key)`. Embed binds that pair onto the session and cannot create tenants/sibling workbenches. Host tenant is context, never authz. Portal `admin` cannot mint `platform.administer`. | **Keep / map, do not clone.** n8n-class “instance vs cloud tenant vs project” collapses here to **tenant → workbench → workspace**. Rewrite UX may *label* workbench as environment and workspace as project, but APIs and RLS stay as they are. Cross-workbench credential sharing is a **new threat** — default deny. |
| **Realtime updates** | Product UI **polls** `GET /executions/{id}`. E2.2 `POST /workspace/realtime/channels/{id}/subscribe` is an **isolation hook**, not a push product. Embed tenancy is specified to travel through realtime when it exists. | **Greenfield-ish extension:** workspace-authorized SSE (preferred) or websocket for execution/step transitions and approval-wait. Same RBAC as `execution.view` / `workflow.view`; no secret payloads; fail closed on workspace mismatch. Do not put job tickets or credential handles on a push channel. Polling remains a valid fallback. |
| **Queue / workers** | Durable `execution_jobs` in PostgreSQL; worker `POST /jobs/claim` + heartbeat/complete/fail/release/recover; HMAC binding (workspace, version/digest, policy digest, expiry); default lease 30s. E12.2 proves queue-lag headroom. No Redis/Bull. | **Keep** Postgres-backed leases (survives pod loss without a second broker). **Extension:** worker pool labels / concurrency caps as **config**, not a new public queue product. **Do not** move leases to an in-memory or unauthenticated queue to “match n8n queue mode.” Browser must never call `/jobs/claim`. |

### Additional honesty rows (often requested, already decided)

| Topic | FlowForge position |
| --- | --- |
| Error / recovery workflow | No `errorWorkflow` resource. Failures are step status + alerts + optional `flow.fail`. A pinned child via future `workflow.call` could cover recovery **after** a gated epic — not a hidden side workflow. |
| Source control / Git | Export/import YAML + immutable versions. No git-sync API. Treat as later ops, not rewrite-blocking. |
| Dry-run of a draft | Kubernetes has server-side dry-run **on a published node against a pinned target**, not “execute the unsaved canvas.” Keep. |
| Sharing credentials across workspaces | Forbidden by composite FKs + RLS. n8n-class “share to project” would be a new grant table **inside one workspace** (already sketched as `credential_permissions`) — not cross-tenant. |

---

## Proposed contract directions

High-level only. **No full OpenAPI rewrite** in this draft. Additive changes stay on `/api/v1` and land in `apps/api/openapi/openapi.yaml` + [backend-api-map](../reference/backend-api-map.md) in the same PR as handlers (existing publishing rule).

### What stays `/api/v1`

Keep these families and their fail-closed codes. Rewrite UI should retarget; it should not invent twins.

- Foundation: `/health`, `/readiness`, `/metrics`, OpenAPI/swagger (platform-admin).
- Session + CSRF cookies (`Path=/api/v1`).
- Workspace identity, membership, permission matrix.
- Workflows: catalog, validate, normalize, CRUD draft, publish, versions, compare, export, restore, executions start/list.
- Credentials vault (metadata-only reads).
- Ops-config collections + `/ops-config/select` + version pins.
- Executions, steps, logs, artifacts, download grants, legal hold, retention purge.
- Worker `/jobs/*` (not a browser surface).
- Triggers + public `/hooks/{publicId}` + `/schedules` + `/schedules/dispatch`.
- Policy evaluate + `/approvals/{id}/decide` (resume = decide).
- Embed `/embed/*` + Portal `/portal/adapter` if embed stays.
- RFC 9457 problem details, camelCase JSON, `X-Request-ID`, `X-CSRF-Token`.

URL prefix stays `/api/v1`. A future `/api/v2` is **not** required for parity and should not be opened just to resemble another product.

### What needs new resources or fields (parity)

Additive, each with its own threat note. None of these replace YAML or the vault.

| Direction | Sketch | Notes |
| --- | --- | --- |
| Workflow list metadata | Optional `tags[]`, `folderId` / `folderPath`, `archivedAt` on `workflows` | Only if IA promotes folders/tags from client prefix filters. Unique slug stays. |
| Templates API | CRUD on existing `workflow_templates` (reviewed YAML, never executed) | UI already “create from template” by POSTing a draft. |
| Duplicate / archive | `POST /workflows/{id}/duplicate`, `POST …/archive` | Duplicate = new draft in the **same** workspace; no cross-workspace copy. |
| Execution query | Cursor, time range, `triggerType`, `requestedBy`, `correlationId` | Additive query params on `GET /executions`. |
| Execution compare / replay projection | Optional `POST /executions/compare`, `GET /executions/{id}/replay` | Closes Chloe’s non-blocking API gaps; still redacted. |
| Workspace variables (if wanted) | New resource: non-secret, allowlisted keys, classification `public`/`internal` | Interpolation allowlist at validate time; secrets remain vault-only. |
| `workflow.call` | Enable catalog type + execution expansion | Pinned child version, schemas, no recursion, lineage audit. |
| `artifact.write` / `artifact.read` | Enable catalog types on top of E5.3 | Same grant/scan/KEK rules. |
| `event` trigger | New trigger type + subscription verification | Same version-pin + idempotency as E10.1. |
| Standalone OIDC | `POST /session/oidc/*` (or equivalent) issuing existing cookies | Same idle/absolute expiry, CSRF, ADV-019 revoke. |
| Realtime | `GET /executions/events` (SSE) scoped by workspace | Subscribe requires `execution.view`; payloads identifiers + status only. |
| Ingress delivery log | Metadata-only last N webhook outcomes on the trigger | No raw body, no signature, no secret. |

Credential **node pin** stays: node → published ops-config resource → vault credential. A rewrite inspector can look like a “credential picker” while the contract remains `select` + pin.

### What should be retired or replaced (product IA)

| Candidate | Action | Why |
| --- | --- | --- |
| E2.2 isolation **stubs** as operator surfaces (`/workspace/credentials/{id}/use`, `/workspace/artifacts/{id}`, `/workspace/jobs`, `/workspace/records?kind=credential`) | **Retire from product IA / Chloe maps.** Keep as isolation-test hooks or fold into negative suites. | They collide with the product vault, artifacts, and job queue. Rewrite docs should say “do not build screens on stubs.” |
| Trusted-dev `POST /session` + identity headers | **Keep for non-prod only.** Never a rewrite login. | Production fail-closed already. |
| Legacy execution status `pinned` | **Do not revive** in new UI copy. | Stub leftover; new starts are `queued`. |
| Unversioned `/healthz` / `/readyz` / `/api` aliases | **Do not add** for “familiarity.” | Probes and OpenAPI already document `/api/v1/health` + `/readiness`. |
| Draft-run, pin-data, expression-in-YAML, secret-in-URL webhook, unpartitioned embed cookies | **Reject** if proposed as parity. | Contradicts keeps. |
| Second persisted graph format / n8n workflow JSON | **Reject.** | YAML-only rule. |
| Redis/Bull (or similar) as the source of truth for jobs | **Reject** unless it is a cache in front of `execution_jobs` with the same lease/fence invariants. | Durability + fencing already proven in Postgres. |

Replace-at-IA-only (no API break): Chloe may relabel workbench as “environment” and workspace as “project” in chrome **if** requests still send `X-FlowForge-Tenant-ID` + `X-FlowForge-Workbench-Key` and never a host-supplied workspace UUID as authz.

### Migration risk notes (operators / data model)

Rewrite planning should assume **in-place contract evolution**, not a dump-and-reload to a foreign schema.

| Risk | Operator impact | Mitigation |
| --- | --- | --- |
| YAML stay/leave | Existing drafts/versions remain valid only if `flowforge/v1` and parser limits stay. | Additive optional fields; unknown fields still fail closed. No silent expression enablement. |
| Draft vs published | Operators who expect “save = runnable” will hit `400` drafts-cannot-run. | Chloe migration notes: Start published only; publish is a deliberate gate. |
| Pin snapshots | Running/historical executions keep `workflowDigest` + `ops_pins`. Editing a target draft does not retarget old runs. | Document; do not “fix” history by mutating pins. |
| Credential KEK | Vault ciphertext is unreadable without `CREDENTIAL_KEK`. | Rewrite must not re-encrypt as a side effect of UI work. KMS wrap remains the production direction. |
| Webhook callers | Ingress path `/api/v1/hooks/{publicId}` + `X-FlowForge-Timestamp` / `X-FlowForge-Signature`. | Do not rename for familiarity. Rotation stays `POST /triggers/{id}/rotate`. |
| Schedule dispatcher | Tick is an authenticated `POST /schedules/dispatch`, not an in-process cron inside the UI. | Ops keep the tick (or a worker) across rewrite. |
| Embed/Portal hosts | Assertion claims, CHIPS cookies, `session.embed` chrome, ADV-019 revoke-on-workspace-disable. | If rewrite keeps embed, do not change mint/exchange shapes in the same breath as chrome. |
| Session cookies `Path=/api/v1` | Next rewrite already maps `/api/v1` → control plane so cookies send. | A new UI origin that drops the rewrite breaks auth. |
| Isolation stubs vs product APIs | Operators/docs that followed E2.2 paths will see empty/stub data. | Point all product docs at `/credentials`, `/artifacts`, `/executions`, `/jobs/*`. |
| Retention | Executions ~90d, audit ~365d, artifact legal hold. | Rewrite history UX must honor `retentionUntil` / `404` on expired artifacts. |
| Worker fencing | A rewritten worker that completes without `jobToken` + `fencingToken` will `403`/`409`. | Keep the ticket contract; treat `indeterminate` as evidence, not a bug. |
| Cross-workbench “promotion” | Copying a workflow YAML to another workbench does **not** copy credentials/targets. UUIDs 404. | Export YAML + re-select pins in the destination workspace. That is the supported promote path unless a later epic adds a reviewed promote API. |

---

## Suggested high-level epic themes (Arie later)

**Do not open GitHub issues or epics from this list.** Themes only, acceptance-shaped. Sequence and sizing wait for the agreed Gracie package.

- **Control-plane parity:** Operators can list/filter/archive/duplicate/export published workflows and reviewed templates on `/api/v1` without a second persisted graph format; drafts still cannot run.
- **Execution parity:** Operators can query, compare, and (optionally) stream redacted run status with the same lease/fence/`indeterminate`/cancel/retry rules already on `main`.
- **Credential / expression parity:** Inspector pin UX stays vault-metadata + ops-config select; any workspace variable/interpolation epic ships allowlisted, non-secret, and still rejects `{{` / `${` / secret keys in YAML.
- **Trigger parity:** Manual/webhook/schedule contracts stay version-pinned and replay-safe; any `event` trigger epic verifies source, dedupes, and starts through the existing E10.1 idempotency/policy path.
- **Tenancy / auth parity:** Standalone OIDC (if in IA) issues the existing cookie session; embed/CHIPS/`session.embed` remain if embed stays; tenant/workbench/workspace isolation is not replaced by a host-supplied project id.

---

## Out of scope for this draft

- Creating or closing GitHub issues, epics, or story checklists.
- Rewriting OpenAPI, Go handlers, workers, or `apps/web`.
- Weakening ADV controls, E12.1/E12.2 harnesses, or RLS.
- Connector marketplace, arbitrary expression language, draft execution, n8n JSON import, or branding/layout clone.
- Chloe’s full UI inventory (she owns editor surfaces + operator migration notes).
- Gracie’s vision / keep-vs-replace-vs-retire package (this page is an input).

---

## Handoff

### Gracie

Fold this into the rewrite package as the **control-plane / execution / credential** chapter. Recommended keep vs replace vs retire:

- **Keep:** YAML + draft/publish, vault, pins, durable jobs, ADV/E12, embed/CHIPS if embed remains, `/api/v1` families in [What stays `/api/v1`](#what-stays-apiv1).
- **Replace (IA only):** chrome labels (environment/project/folder) that still map to workbench/workspace; retire stub routes from operator IA.
- **Retire (later, carefully):** E2.2 stub product exposure — not the isolation tests.
- **Defer:** folders/projects as first-class resources, OIDC, SSE, `workflow.call`, artifact nodes, event triggers, workspace variables.

### Chloe

Use the matrix for **operator migration notes**:

- Start published / drafts never run will feel like a regression vs n8n-class “save and execute” — call it a keep.
- Credential picker = ops-config select + vault metadata, not plaintext and not a credential UUID dumped into YAML.
- Runs drawer can keep polling; SSE is optional later and must stay redacted.
- Do not build product screens on `/workspace/records` stubs.
- Embed: keep `session.embed`, CHIPS, host-issuer bind; no Storage Access / unpartitioned cookies.
- Folders/environment filters on `/workflows` are client conventions until a control-plane epic exists.

### Arie

Wait for the agreed doc. When you open epics, start from the five themes above; do not treat this file as a story dump.

---

## Sources on `main`

| Document | Use |
| --- | --- |
| [Architecture](../architecture.md) | Control-plane / worker / embed boundaries |
| [Backend API map](../reference/backend-api-map.md) | Implemented `/api/v1` routes (E2–E11) |
| [OpenAPI publishing](../reference/openapi.md) | `/api/v1` versioning; spec at `apps/api/openapi/openapi.yaml` |
| [Security model](../reference/security-model.md) | ADV fail-closed, sessions, triggers, secrets |
| [Workflow model](../reference/workflow-model.md) | Resources and acceptance |
| [Workflow YAML schema](../reference/workflow-yaml-schema.md) | Canonical document; no expressions |
| [Action catalog](../reference/action-catalog.md) | Core vs next vs provider, including `workflow.call` |
| [Core node contracts](../reference/core-node-contracts.md) | Typed ports; `expression-forbidden` |
| [Database](../reference/database.md) | RLS, vault, executions, leases, artifacts |
| [Frontend UI](../reference/frontend-ui.md) | Landed IA; keep list; Chloe API gaps |
| [Embed SDK](../reference/embed-sdk.md) / [Portal adapter](../reference/portal-adapter.md) | E11 assertion + CHIPS |
| Engines: [Kubernetes](../reference/kubernetes-engine.md), [SSH](../reference/ssh-engine.md), [script](../reference/script-engine.md) | E7–E9 pin + isolation |
| E12: [security verification](../reference/e12-security-verification.md), [resilience](../reference/e12-resilience-capacity.md), [threat-model review](../reference/e12-threat-model-review.md) | Production-gate mindset |
| [Master implementation plan](../master-implementation-plan.md) | Historical E1–E12 backlog (do not reopen from this draft) |
