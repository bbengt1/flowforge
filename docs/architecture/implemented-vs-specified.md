# Implemented vs Specified

**Status:** runtime honesty for `main`. Fail-closed: a library, test harness, OpenAPI path, or dispatch-preparer is **not** a live capability.

**Grounding:** [Enterprise architecture gap analysis](../internal/claude-code-gap-analysis.md) (Brent / 2026-09-21, review SHA `e4d0c9d`, finding **I3**) plus current code and docs. Epic [G](https://github.com/bbengt1/flowforge/issues/401) / phase [G.0](https://github.com/bbengt1/flowforge/issues/402). This page is G.0.2.

This repository is a **security-hardened prototype with a production veneer**, not an enterprise-ready platform. Specified contracts stay normative for how the product *must* work when a slice ships. They do not mean that slice runs today.

## Hard lines (unchanged)

Do not weaken these because a capability is unimplemented:

| Line | Rule |
| --- | --- |
| YAML SoT | `flowforge/v1` is the only persisted workflow definition. Canvas is a projection. Invalid YAML never guesses a graph. |
| Drafts never run | Publish (or an explicitly approved published test version) then start. Organizing or editing a draft does not make it live. |
| Vault | Display-name + UUID only in chrome, search, and APIs. No KEK, PEM, password, or secret material in browser, room, YAML, logs, or `localStorage`. |
| ADV-021 | Embed chrome from `GET /session` `session.embed` only. Host query is display-only. Missing bind is a visible alert. |
| ADV-024 | Membership / isolation stay grant-gated. Isolation success is a **denial**. |
| Fail-closed authz | Server-derived workspace scope. Host-supplied workspace IDs are `400`. Cross-workspace UUIDs are `404`. |
| Not an n8n clone | Parity of interaction and coverage, not pixels, orange, or a marketplace. |

## Vocabulary

| Status | Meaning |
| --- | --- |
| **Runs today** | Shipped on the default compose or API path and used by operators or hosts. |
| **Partial** | API, chrome, or library exists; the production caller, scheduler, or provider call does not. |
| **Specified only** | Documented contract and/or in-repo engine. Nothing in a shipped deployment invokes it for real work. |
| **Deferred** | Explicitly not this phase (named stub or later epic). |

## Matrix

| Area | Specified | Runs today | Status |
| --- | --- | --- | --- |
| **Production provider worker** | Isolated, production-locked worker pods execute Kubernetes, SSH, signed scripts, and HTTP one step at a time after revalidating job/version/policy/lease ([architecture](../architecture.md), engines). | `apps/api/cmd/runner` is production-locked and dispatches to the existing engine packages. Compose `apps/api/cmd/worker` still refuses provider nodes and refuses to start when production-locked. `deploy/k8s` runs the runner, not `/usr/local/bin/worker`. Default-deny egress does not open provider networks. | **Partial** (G.1.1 / #432) |
| **Kubernetes / SSH / script / HTTP nodes** | `kubernetes.apply` / `get` / `list` / rollout, `ssh.run`, `script.python` / `script.go`, `http.request` contact real targets from a worker. | The production runner calls those engines after a published pin and HMAC fence. Compose still fails the step (`local-worker-unsupported`). Live dials fail at the network until an operator allowlist exists. `notification.email` fails closed without a mailer. `script.python` / `script.go` create an isolated Job from `deploy/kubernetes/script-runner-deployment.yaml` using `ghcr.io/bbengt1/flowforge-script-runner` (built from `apps/api/Dockerfile.script-runner`). The script NetworkPolicy allows DNS plus `CONTROL_PLANE_API_CIDR` only; a missing CIDR or a policy that does not match refuses the Job. | **Partial** |
| **Compose local worker** | Dev claim loop so **Start published** can leave `queued`, same lease / HMAC ticket / fencing as any worker ([deployment](../deployment.md#local-compose-worker)). | **Runs locally** for six core nodes: `flow.condition`, `flow.stop`, `flow.fail`, `data.set`, `data.map`, `data.validate`. `flow.approval` is parked `waiting` by the API (worker skips). `flow.delay` and every provider node fail closed. Not a Kubernetes workload. | **Partial** (core eval only) |
| **Schedules / dispatch** | Timezone-explicit schedules fire published versions; `POST /api/v1/schedules/dispatch` is the tick. | CRUD, enable/disable, and the dispatch **endpoint** exist (`workflow.execute` + CSRF). **This repository ships no CronJob, in-process ticker, or external scheduler.** Due schedules silently never fire unless an operator calls the endpoint. | **Partial** (gap **A3**) |
| **Lease recovery** | Expired claims become `indeterminate` via fencing; `POST /api/v1/jobs/recover`. | Endpoint exists; next `claim` can also recover. **No shipped periodic caller.** Idle queues can sit stuck until the next claim. | **Partial** (gap **A3**) |
| **Retention purge / backups** | 90-day execution / 365-day audit purge; encrypted `pg_dump`. | `POST /api/v1/retention/purge` and `scripts/backup/encrypt-pg-dump.sh` exist. **No CronJob.** Runbooks tell operators to schedule the script themselves. | **Partial** (gap **A3**) |
| **OIDC / SSO / MFA / SCIM** | Enterprise identity; architecture mentions host/OIDC subjects. | **OIDC Authorization Code + PKCE is deferred (V.0c).** No SAML, SCIM, MFA, or durable account lockout. | **Deferred** (gap **A2**) |
| **Standalone Login** | Local email/username + password mints `ff_session` / `ff_csrf`. | **Runs today.** `POST /api/v1/login`. First-run one-time `admin` / `admin` sets `must_change_password` until `POST /api/v1/session/password`. Never on `/embed/v1`. Trusted-dev `POST /session` is local/dev only — not the product door. | **Runs today** |
| **Embed exchange** | Host backend exchanges a signed assertion; chrome reads `session.embed` only (ADV-021). | **Runs today.** `POST /embed/exchange`. Embed never mounts Login, the first-run wizard, or change-password. Host `?tenant=` / `?workbench=` stay display-only. | **Runs today** |
| **Bootstrap / TLS skip** | Standalone first-run wizard: persistence → admin → public URL → TLS (create, upload, or skip). | **Runs today (B.1–B.8).** Incomplete → wizard only. Complete or `401` → Login, not wizard. **Skip for now** POSTs `{action:"skip"}` (no PEM); instance stays HTTP until Settings. Localseed / migrate backfill can mark complete + skipped. **Never on `/embed/v1`.** ACME is out of scope. | **Runs today** |
| **Explorer chrome** | `/workflows` Explorer: server-backed folder tree, content pane, breadcrumb, grant-gated menus (F.1–F.7, X.1–X.8). | **Runs today (chrome + API).** Same `WorkflowHome` on standalone and `/embed/v1/workflows` after `session.embed`. Tree is not `localStorage`. Folder membership is **not** in YAML. This is organizer chrome, not provider execution. | **Runs today** |
| **Web route boundaries** | App Router `error` / `loading` / `not-found` on primary segments; retry on error ([gap F1](../internal/claude-code-gap-analysis.md)). | **Runs today.** Root `global-error.tsx` + segment `error.tsx` with Try again. `loading.tsx` and `not-found.tsx` on primary product segments. Embed ADV-021 fail-closed unchanged. | **Runs today** (gap **F1**; G.0.4) |
| **Realtime channels** | Workspace-scoped realtime for execution visibility. | API has subscribe routes. **UI polls ~2s when the tab is visible** (backoff/jitter; hidden tabs pause). `EventSource` / `WebSocket` are forbidden in current chrome tests. | **Specified only** (gap **A4**; G.0.12 gates polling) |
| **HMAC job / script keys** | Every boundary fails closed; production secrets required. | `JOB_BINDING_SECRET` and `SCRIPT_SIGNING_KEY` are **required at boot**. Missing or malformed refuses to start (no per-process random default). Compose/dev uses documented local-only values so restarts stay stable. `EMBED_SIGNING_KEY` already boot-fails in production. | **Runs today** (G.0.3 / gap **B1**) |
| **Artifact durability** | Queue, leases, execution state, audit, and artifact metadata survive pod loss. | Metadata is in PostgreSQL. **Payloads default to `tmpfs` `/tmp/flowforge-artifacts` or in-process memory** — lost on restart; not shared across replicas. | **Partial** (gap **B3**) |
| **OpenAPI / tracing (E1.2)** | Generated OpenAPI; API-to-worker flows traced by correlation ID. | OpenAPI is **hand-written**. `X-Request-ID` exists; **no trace store, sampling, or worker span propagation.** `GET /api/v1/health` now publishes non-secret `version` / `sha` (G.0.10 / C1 build identity). | **Partial** (gaps **B5**, **C1**) |
| **DB session timeouts** | `statement_timeout` / `lock_timeout` on checkout so one query cannot pin the pool. | Application-pool `PrepareConn` (pgx v5 checkout) sets `15s` / `5s` (`STATEMENT_TIMEOUT` / `LOCK_TIMEOUT`). Circuit breakers and worker/UI bulkheads are still out of scope. | **Partial** (gap **C2**; G.0.11) |
| **HA / web on Kubernetes** | Isolated worker pods + UI in cluster. | `deploy/k8s` runs API and runner at `replicas: 1`. No web Deployment, no PDB/HPA. | **Specified only** (gap **B2**) |

## Provider execution

`cmd/runner` is production-locked and calls the engine packages. Compose `cmd/worker` does not.

- Do say: the production runner dispatches `kubernetes.*`, `ssh.run`, `script.python` / `script.go`, and `http.request` / `notification.webhook` after a published pin, HMAC ticket, and fence.
- Do say: compose still fails those nodes with `local-worker-unsupported`.
- Do **not** say clusters, SSH hosts, or webhooks are reachable from `deploy/k8s` until an operator adds that provider egress. Script Jobs are created only after `CONTROL_PLANE_API_CIDR` (or a same-namespace Service) is set and `flowforge-script-runner` allows DNS plus that destination. Default-deny stays. A world CIDR is rejected.
- Engine references ([Kubernetes](../reference/kubernetes-engine.md), [SSH](../reference/ssh-engine.md), [script](../reference/script-engine.md)) describe the libraries the runner calls.

Executable on compose today: **6 of 18** defined node types (`flow.condition`, `flow.stop`, `flow.fail`, `data.set`, `data.map`, `data.validate`). Non-executable on that worker: provider nodes, `flow.delay`, plus registry-disabled `data.filter` / `data.merge` / `data.sort` / `flow.join` / `flow.parallel` / `flow.switch`. `flow.approval` waits in the API. The production runner also evaluates those six core nodes, parks `flow.approval`, and fails `flow.delay` with `runner-unsupported`.

## Identity doors (do not merge)

| Door | Who | Endpoint | Notes |
| --- | --- | --- | --- |
| Standalone Login | Operator | `POST /api/v1/login` | Local password. Product door after bootstrap complete. |
| Embed exchange | Host backend | `POST /embed/exchange` | ADV-021. Never Login chrome. |
| Trusted-dev session | Local/dev only | `POST /api/v1/session` + identity headers | Fail-closed outside non-prod + `TRUSTED_DEV_IDENTITY_HEADERS`. Not rewrite login. |
| OIDC | — | — | **Deferred (V.0c).** No start/callback, no IdP-admin API. |

## What this page is not

- A license to weaken drafts-never-run, vault metadata-only, ADV-021/024, or YAML SoT.
- A substitute for the [gap analysis](../internal/claude-code-gap-analysis.md) findings (A–I) or the E1–E12 [master implementation plan](../master-implementation-plan.md).
- A claim that the scheduler or the rest of G.1 has shipped. The production runner (G.1.1) has. The scheduler has not.

When a later story makes a row **Runs today**, update this table in the same PR as the code.
