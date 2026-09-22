# FlowForge — Enterprise Architecture Gap Analysis

**Date:** 2026-09-21
**Repository:** `bbengt1/flowforge` @ `main` (`e4d0c9d`)
**Reviewer role:** Enterprise software architect — adversarial readiness review
**Baseline assumption:** This repository is intended to become an enterprise-class,
multi-tenant automation platform that operates Kubernetes clusters, SSH targets, and
signed script artifacts on behalf of customers.

---

## 1. Executive summary

FlowForge has an unusually strong **control-plane security design** and an unusually
weak **delivery, execution, and operability story**. The gap between what the
documentation asserts and what the code can actually do at runtime is the single
largest risk in this repository.

The codebase is substantial and disciplined: ~60k LOC of Go, ~150k LOC of
TypeScript, 51 tables, forced row-level security with a `NOBYPASSRLS` application
role, envelope-encrypted credentials, HMAC-fenced job leases, replay-resistant
webhook ingress, and RFC 9457 problem responses across 251 registered routes. The security
model is better than most commercial products at this stage. All Go tests and all
1,035 web tests pass.

However:

- **The product cannot execute its own value proposition.** The only worker that
  exists refuses every provider node. Kubernetes, SSH, Python, Go, and HTTP actions
  validate, authorize, policy-check, and dispatch — then fail. Six node types out of
  eighteen can actually run.
- **The control plane cannot be scaled or safely restarted.** Two HMAC keys default
  to per-process random values, so a second replica or a rolling restart invalidates
  in-flight job tickets and previously published script signatures.
- **Nothing is scheduled.** Schedule dispatch, lease recovery, retention purge, and
  backups all require an external caller that this repository does not ship.
- **Execution artifacts are stored on `tmpfs` and are lost on every pod restart** —
  in direct contradiction of the architecture's durability claims.
- **There is no enterprise identity story.** No OIDC, no SAML, no SCIM, no MFA, no
  account lockout. Standalone authentication is an 8-character local password.
- **The UI has no error boundaries, no route-level loading states, no server-side
  data fetching, two competing styling systems, and zero component or end-to-end
  tests.** 449 assertions verify UI behavior by regex-matching component *source
  text*.
- **CI never type-checks, never lints, and never builds the web application** — and
  when those gates are run locally, `eslint` **fails** with two
  `react-hooks/set-state-in-effect` errors that are on `main` today. `next build`
  and its TypeScript pass; the 139 test files are excluded from type-checking and
  hide 29 type errors.

**Verdict:** This is a credible **security-hardened prototype with a production
veneer**, not an enterprise-ready platform. The security foundations are worth
keeping. The execution layer, the operational layer, and the frontend quality
engineering layer need real investment before an enterprise customer could deploy
this.

### Readiness scorecard

| Domain | Grade | One-line assessment |
| --- | --- | --- |
| Security model & authorization | **A−** | Genuinely strong; fails closed nearly everywhere; a few fail-open defaults |
| Data isolation & tenancy | **A−** | FORCE RLS, composite FKs, non-bypass role, transaction-local scope |
| Functional completeness | **D** | Provider execution is entirely absent at runtime |
| Scalability & HA | **D** | Single replica by construction; ephemeral keys break horizontal scale |
| Resilience & recovery | **C−** | Good fencing/lease design; no automation, no durable artifact storage |
| Observability | **D+** | HTTP metrics only; no tracing, no business metrics, no alerts, no SLOs |
| Enterprise identity | **F** | No SSO, no MFA, no SCIM, no lockout |
| Frontend architecture | **C−** | RSC unused, god components, two design systems, no primitives |
| Accessibility | **B−** | Thoughtful and self-aware; no focus traps, no automated gate |
| Test strategy | **C** | High volume, low fidelity; source-text assertions; no UI/E2E tests |
| CI/CD & supply chain | **C** | Good scanning for Go; web is unscanned, unbuilt, unlinted, unpinned |
| Documentation | **C+** | Deep and accurate, but written for the build process, not for adopters |
| Governance | **F** | No LICENSE, CODEOWNERS, SECURITY.md, CONTRIBUTING, versioning, or releases |

---

## 2. Scope and method

**Inspected:** all Go source and tests (`apps/api`), all TypeScript source and tests
(`apps/web`), 27 SQL migrations, 4 GitHub Actions workflows, Docker/Compose/Kubernetes
manifests, supply-chain and backup scripts, and all 49 documents under `docs/`.

**Executed:**

- `go build ./...` — clean
- `go vet ./...` — clean
- `go test ./...` — 32 packages, all pass
- `go test ./... -cover` with and without a live PostgreSQL 16 container
- `node --experimental-strip-types --test src/lib/*.test.ts` — 1,035 tests, all pass
- `pnpm install --filter @flowforge/web...` then `next build` — passes (TypeScript clean)
- `eslint .` — **fails** (2 errors, 1 warning)
- `tsc --noEmit` over the test files that `tsconfig.json` excludes — **29 errors**

**Severity model**

| Severity | Meaning |
| --- | --- |
| **S1 — Blocker** | Prevents enterprise production deployment, or causes data loss / security failure |
| **S2 — Major** | Materially degrades reliability, scale, security posture, or adoption |
| **S3 — Moderate** | Erodes maintainability, operability, or user experience |
| **S4 — Minor** | Hygiene, consistency, polish |

---

## 3. Findings

### A. Functional completeness

---

#### A1 — S1 — No production worker exists; every provider node fails at runtime

The architecture states workers "execute one step at a time in short-lived isolated
pods" against Kubernetes, SSH, and signed artifacts. In reality, the only worker
binary is `cmd/worker`, which is explicitly local/dev only and refuses to start in a
production-locked environment (`apps/api/cmd/worker/main.go:36-40`).

That worker's entire execution decision is:

```go
// apps/api/internal/localworker/decide.go:27
if !workflow.IsCoreNeutral(step.NodeType) {
    return unsupported("Compose local worker cannot execute provider nodes. Deploy an isolated production worker.")
}
if step.NodeType == "flow.delay" {
    return unsupported("Compose local worker does not schedule durable flow.delay waits.")
}
```

Executable node types: `flow.condition`, `flow.stop`, `flow.fail`, `data.set`,
`data.map`, `data.validate` — **6 of 18 defined types**.

Non-executable: `kubernetes.apply`, `kubernetes.get`, `kubernetes.list`,
`kubernetes.read`, `ssh.run`, `script.python`, `script.go`, `http.request`,
`flow.delay`, `flow.approval`, plus registry-disabled `data.filter`, `data.merge`,
`data.sort`, `flow.join`, `flow.parallel`, `flow.switch`.

The engine packages are libraries with **no production caller**.
`kubernetes.NewLiveClient` is referenced only from `kubernetes/handle.go` inside its
own package; nothing wires an engine to a claimed job. Every importer of
`internal/kubernetes`, `internal/ssh`, `internal/scripts`, and `internal/httpnotify`
is a validator, policy evaluator, or dispatch-preparer.

`deploy/kubernetes/script-runner-deployment.yaml` declares `replicas: 0` and points
at `ghcr.io/bbengt1/flowforge-script-runner:foundation` — an image no Dockerfile in
this repository builds.

**Impact:** The platform's entire reason to exist — operating clusters and hosts —
does not function in any shipped deployment. A customer can author, validate,
publish, pin, approve, and dispatch a Kubernetes deployment workflow, and it will
terminate in `failed` with "Deploy an isolated production worker."

**Recommendation:** Build `cmd/runner` as a first-class, production-locked worker
that resolves scoped credential handles, dispatches to the existing engine packages,
and creates isolated Kubernetes Jobs from the script-runner template. Ship the
runner image and a Deployment manifest. Until then, the README and `docs/architecture.md`
must state plainly that provider execution is not implemented.

**Status (G.1.1 / G.1.2):** `cmd/runner` ships (#439). `apps/api/Dockerfile.script-runner`
builds `ghcr.io/bbengt1/flowforge-script-runner`. `deploy/kubernetes/script-runner-deployment.yaml`
is a Job template (not `replicas: 0`). The production runner creates one Job from
that template for `script.python` / `script.go` only when `CONTROL_PLANE_API_CIDR`
(or a same-namespace Service) is set and the live script NetworkPolicy allows
DNS plus that control-plane API. Missing config refuses the Job.

---

#### A2 — S1 — No enterprise identity: no SSO, MFA, SCIM, or account lockout

Standalone authentication is local username/password only
(`apps/api/internal/httpapi/login.go`, `internal/localauth/password.go`). OIDC is
explicitly deferred: *"OIDC Authorization Code + PKCE is deferred (V.0c)"*
(`login.go:26`). There is no SAML, no SCIM, no directory sync, no MFA/TOTP/WebAuthn
code anywhere in the repository.

Supporting weaknesses in the local path:

- `MinPasswordLength = 8` (`localauth/password.go:31`), no complexity rule, no
  breached-password check, no history, no expiry.
- `bcrypt.DefaultCost` (cost 10) — below the cost 12+ commonly required by
  enterprise baselines in 2026.
- **No account lockout.** Brute-force protection is an in-process fixed-window IP
  and identifier counter that resets on restart and is not shared across replicas.
- The `X-FlowForge-Issuer` / `X-FlowForge-Subject` identity model implies an external
  IdP, but no code ever talks to one; those headers are trusted only under the
  dev-only `TRUSTED_DEV_IDENTITY_HEADERS` flag.

**Impact:** No enterprise will grant a platform that holds Kubernetes and SSH
credentials an authentication story with no SSO, no MFA, and no deprovisioning path.
An offboarded employee's local password remains valid indefinitely.

**Recommendation:** Treat OIDC Authorization Code + PKCE as an S1 deliverable, not a
deferred item. Add SCIM 2.0 for provisioning/deprovisioning, enforce MFA for
`platform.administer` and `credential.*` permissions, add durable account lockout,
raise bcrypt cost to 12+, and adopt a password policy with a breach-list check.

---

#### A3 — S1 — Scheduled triggers, lease recovery, retention, and backups never run

Four business-critical operations are HTTP endpoints with no caller:

| Operation | Endpoint | Ships a scheduler? |
| --- | --- | --- |
| Schedule tick | `POST /api/v1/schedules/dispatch` | **No** |
| Lease recovery | `POST /api/v1/jobs/recover` | **No** |
| Retention purge | `POST /api/v1/retention/purge` | **No** |
| Encrypted backup | `scripts/backup/encrypt-pg-dump.sh` | **No** |

There is no `CronJob` anywhere in `deploy/` (verified by search), no in-process
ticker, and no documented external scheduler. `docs/operations/retention-backup.md`
concedes: *"The Kubernetes foundation does not ship a CronJob — schedule the encrypt
script."*

Worse, three of the four require a **cookie session plus a CSRF token** and
`workflow.execute` or `workspace.administer`. A Kubernetes `CronJob` cannot easily
present a browser session, so even an operator-built scheduler faces friction.

**Impact:** Every cron-triggered workflow silently never fires. Expired job leases are
swept only opportunistically on the next claim, so an idle queue accumulates stuck
jobs. Retention obligations (90-day execution, 365-day audit) are never met, so the
database grows without bound and data-minimisation commitments are violated. There
are no backups unless an operator builds the automation themselves.

**Recommendation:** Ship a leader-elected internal scheduler in the API (or a
dedicated `cmd/scheduler`) driving dispatch, recovery, and purge on intervals, plus
a `CronJob` for encrypted backups. Add a service-principal / machine-token
authentication path so automation does not need a browser session.

---

#### A4 — S2 — Real-time execution visibility is 2-second polling with no throttling

`EXECUTION_STATUS_POLL_MS = 2000` (`apps/web/src/lib/execution-contract.ts:60`).
`EventSource` and `WebSocket` are explicitly forbidden — several tests assert their
absence. The polling loop in `ExecutionDetail.tsx:505-548` has:

- no exponential backoff on failure,
- no jitter,
- no pause when the tab is hidden (`document.visibilityState` appears **nowhere** in
  the codebase),
- no `AbortController` — stale responses are discarded client-side but the network
  request still completes,
- silent swallowing of all non-403 errors, so a user watching a run sees a frozen
  screen during an outage with no indication anything is wrong.

Meanwhile the API exposes `POST /api/v1/workspace/realtime/channels/{id}/subscribe`
and the architecture claims workspace-scoped "realtime channels" — capability the UI
does not use.

**Impact:** Every open execution page generates 30 requests/minute forever, including
in background tabs. With 50 operators this is a sustained ~25 req/s floor against a
pool capped at 8 connections (see B2). Step-level progress lags up to 2 seconds.

**Recommendation:** Implement Server-Sent Events for execution status; keep polling as
a documented fallback. In the interim, gate polling on `visibilityState`, add
exponential backoff with jitter, and surface transient failures in the UI.

---

### B. Architecture and scalability

---

#### B1 — S1 — Two HMAC keys default to ephemeral per-process values (fail-open)

```go
// apps/api/internal/wfstore/jobticket.go:36
func LoadJobBindingKey() []byte {
    raw := strings.TrimSpace(os.Getenv(EnvJobBindingSecret))
    if raw == "" {
        return NewJobBindingKey()   // random, per process
    }
    if key, err := parseJobBindingKey(raw); err == nil {
        return key
    }
    return NewJobBindingKey()       // malformed value -> silently random
}
```

`scripts.LoadSigningKey()` (`internal/scripts/signer.go:27`) is identical.

Three distinct failures:

1. **Horizontal scale is impossible.** Pod A mints a job ticket; pod B cannot verify
   it. Any deployment with `replicas > 1` produces spurious worker authorization
   failures. This is consistent with `deploy/k8s/api-deployment.yaml` hard-coding
   `replicas: 1`.
2. **Every restart orphans in-flight work.** Rolling deploys invalidate all
   outstanding job tickets; jobs drift to `indeterminate`.
3. **Published script artifacts become unverifiable.** Artifacts signed before a
   restart fail `VerifySignature` afterwards, so previously published scripts stop
   being dispatchable.

A **malformed** value silently falls back to random rather than failing — so a typo in
a Kubernetes Secret produces no error, no log line, and no alert.

This directly contradicts the architecture's stated principle that *"every boundary
fails closed"*, and it is inconsistent with `EMBED_SIGNING_KEY`, which correctly
boot-fails in production (ADV-006).

Both variables are **commented out** in `deploy/k8s/api-secret.example.yaml` and are
**absent from `env-template.txt`** and from the k8s README's "Replace before any real
environment" checklist.

**Recommendation:** Boot-fail when `JOB_BINDING_SECRET` or `SCRIPT_SIGNING_KEY` is
missing or malformed in a production-locked process, matching `EMBED_SIGNING_KEY`.
Uncomment them in the Secret example, add them to `env-template.txt`, and add them to
the deploy checklist. Add a key-ring so both can be rotated with overlap.

---

#### B2 — S2 — Single-replica by construction; no HA primitives

`deploy/k8s/` contains **only** the API. There is:

- no `web` Deployment or Service — yet `api-networkpolicy.yaml` selects a `web` pod
  that no manifest creates;
- no worker Deployment;
- no PostgreSQL manifest and no documented managed-database contract;
- no `PodDisruptionBudget`, `HorizontalPodAutoscaler`, `topologySpreadConstraints`,
  or anti-affinity;
- no `terminationGracePeriodSeconds`, no `preStop` hook for load-balancer drain, no
  `startupProbe`, no `initialDelaySeconds`/`failureThreshold` tuning.

`postgres.DefaultMaxConns = 8` per pod, and `applyPoolHooks` issues one to two extra
round trips on **every** connection checkout (`SELECT set_config(...)` plus
`SET ROLE`), adding latency to every request.

**Impact:** No high availability, no zero-downtime deploys, no autoscaling. The UI is
not deployable to Kubernetes from this repository at all.

**Recommendation:** After fixing B1, raise replicas, add PDB/HPA/anti-affinity, add
web and worker manifests, document the managed-PostgreSQL contract (version, TLS,
connection limits, extensions), and add graceful-drain configuration.

---

#### B3 — S2 — Execution artifacts are stored on ephemeral `tmpfs`

**Status (G.1.5):** addressed. Object keys are `{tenant}/{workspace}/{ref}`
UUIDs only. A production-locked process boot-fails without an S3 bucket
and credentials (no tmpfs fallback). Draft executions cannot attach run
artifacts. The notes below are the original finding.

`ARTIFACT_STORE_DIR: "/tmp/flowforge-artifacts"` on an `emptyDir` volume
(`api-configmap.yaml`, `api-deployment.yaml`). With `ARTIFACT_STORE_DIR` unset, the
store falls back to **in-process memory** (`cmd/api/main.go:loadArtifactObjects`).

`docs/operations/retention-backup.md` states it outright: *"Empty store dir =
in-process memory (lost on restart) — not a backup."*

Consequences:

- Step logs, execution outputs, and encrypted artifact payloads vanish on every pod
  restart, while their metadata survives in PostgreSQL — producing permanent dangling
  references.
- With more than one replica, a download grant issued by pod A 404s when the request
  lands on pod B.
- This contradicts `docs/architecture.md`: *"the queue, leases, execution state, audit
  events, and artifact metadata survive pod loss."*

**Recommendation:** Implement an S3-compatible object-storage backend for
`artifact.Objects` with server-side encryption, and make filesystem/memory stores
non-production. Fail closed in a production-locked process when no durable store is
configured.

---

#### B4 — S2 — God object and monolithic route registration

`apps/api/internal/httpapi/server.go` is 755 lines containing a single `Server` struct
with **40 fields** and one `newServer` function registering **251 route patterns** inline (152 static plus 9 ops-config kinds x 11 routes each).
The `Deps` struct carries 30 fields. There is no router library, no route grouping, no
per-domain middleware, and no modular handler registration.

`opsconfig/validate.go` is 1,607 lines. `wfstore/postgres_dispatch.go` is 1,076.

**Impact:** Every new endpoint touches the same file, guaranteeing merge conflicts.
There is no place to attach per-domain concerns (rate limits, caching, tracing) other
than the global chain. Testing a subsystem requires constructing the whole server.

**Recommendation:** Split into per-domain routers with a `RegisterRoutes(mux)`
convention. Group dependencies into cohesive service structs (`ExecutionService`,
`VaultService`) rather than a flat 40-field struct.

---

#### B5 — S2 — The route table is maintained by hand in three places

The same route list is duplicated across:

1. `httpapi/server.go` — the actual `http.ServeMux` registrations;
2. `apps/web/src/lib/identity-proxy.ts` — a hand-written `ALLOWED_ROUTES` allowlist
   (801 lines) in the BFF proxy;
3. `apps/api/openapi/openapi.yaml` — a **hand-written** 10,042-line specification with
   208 paths.

The only drift guard, `TestOpenAPIDocumentsImplementedRoutesAndProblems`
(`conventions_test.go:213`), is itself a fourth hand-maintained list of path strings.
It verifies that listed paths exist in the spec — it does **not** derive the list from
the mux. Adding a route to the mux without touching OpenAPI passes CI silently.

This also contradicts E1.2's acceptance criterion, which calls for *"OpenAPI
generation/publishing."* Nothing is generated.

**Impact:** Guaranteed drift. The most common symptom is a working API endpoint that
returns 404 through the UI proxy because nobody updated the allowlist.

**Recommendation:** Make the mux the single source of truth. Generate OpenAPI from
route metadata, generate the proxy allowlist from the OpenAPI document at build time,
and add a CI check that fails on any divergence.

---

#### B6 — S2 — Next.js App Router is used as a static shell; RSC is unused

- 105 of 132 components are `"use client"`.
- 25 of 28 pages declare `export const dynamic = "force-dynamic"`.
- **Zero** pages perform server-side data fetching (`await fetch` in a `page.tsx`:
  0 occurrences).

Every page renders an empty shell, hydrates, then begins a client-side fetch waterfall
through the BFF proxy.

**Impact:** Slow first meaningful paint on every navigation, oversized JavaScript
bundles, a request waterfall on each route, and no streaming/Suspense benefit — while
paying the full complexity cost of the App Router.

**Recommendation:** Move first-paint data (workflow list, execution list, credential
metadata) into Server Components with streaming Suspense boundaries. Keep client
components for interaction, not for initial load.

---

### C. Resilience and operations

---

#### C1 — S1 — Observability is insufficient to operate this system

`GET /api/v1/metrics` exposes exactly two hand-rolled metric families
(`internal/observability/metrics.go`):

- `flowforge_http_requests_total{method,route,status}`
- `flowforge_http_request_duration_seconds{method,route}`

Absent entirely:

- **Distributed tracing.** No OpenTelemetry, no spans, no trace context propagation.
  The Go module has three direct dependencies (`pgx`, `x/crypto`, `yaml.v3`) — no
  telemetry library at all. `docs/master-implementation-plan.md` E1.2 requires *"every
  API-to-worker flow can be traced by correlation ID"*; there is an `X-Request-ID`
  header but no trace store, no sampling, and no span propagation to workers.
- **Business metrics.** No queue depth, queue lag, lease expiry rate, execution
  outcome counters, `indeterminate` rate, approval expiry, webhook rejection rate,
  credential-use rate, or vault decrypt failures. These are precisely the signals an
  operator needs.
- **Database metrics.** No pool saturation, wait time, or query duration.
- **Alerting.** No `PrometheusRule`, no Alertmanager config, no alert definitions.
- **Dashboards.** None; `docs/reference/rewrite-ui-surfaces.md` explicitly forbids
  adding them to the product UI, and nothing replaces them.
- **SLOs.** A 15-second queue-lag SLO exists only inside a CI evidence script
  (`scripts/e12-resilience-suite.py`). There are no production SLOs, no error budgets,
  and no burn-rate alerts.
- **Build/version identity.** No commit SHA, build time, or version is exposed
  anywhere. `/api/v1/health` returns `{"status":"ok"}`. **You cannot determine which
  build is running.**

Additionally, `/api/v1/metrics` requires `platform.administer` via an `ff_session`
bearer token, which is awkward for a Prometheus scraper and has no documented
machine-credential path.

**Recommendation:** Adopt OpenTelemetry for traces and metrics with W3C trace-context
propagation into workers. Instrument the queue, lease, execution, and vault paths.
Publish version metadata on `/health`. Define production SLOs with alert rules. Add a
scrape-credential mechanism that is not a browser session.

---

#### C2 — S2 — No circuit breakers, no database timeouts, no bulkheads

- **Circuit breakers:** none anywhere in the codebase.
- **Database timeouts:** `statement_timeout`, `lock_timeout`, and
  `idle_in_transaction_session_timeout` appear **nowhere** in migrations, pool
  configuration, or deployment manifests. A single pathological query can occupy one
  of eight pool connections until the client disconnects.
- **Bulkheads:** a single 8-connection pool serves health checks, interactive UI
  reads, worker claims, and bulk list queries. Worker polling can starve the UI.
- **Retries:** `ssh/retry.go` and `scripts/retry.go` define retry *policy*, but there
  is no shared client-side retry with jitter for any outbound dependency.

**Recommendation:** Set `statement_timeout` and `lock_timeout` in `BeforeAcquire`.
Separate pools (or reserve connections) for worker traffic versus interactive traffic.
Add circuit breakers around outbound provider calls once A1 is implemented.

---

#### C3 — S2 — Backup encryption is unauthenticated and under-iterated; no RPO/RTO

```bash
# scripts/backup/encrypt-pg-dump.sh:23
| openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:BACKUP_ENCRYPTION_KEY
```

- **AES-256-CBC has no authentication tag.** A tampered backup is undetectable before
  decryption; CBC is malleable and bit-flipping attacks are feasible. This backup
  contains the encrypted credential vault and the full audit log.
- **No `-iter` flag** — OpenSSL's PBKDF2 default is 10,000 iterations, far below the
  600,000+ that OWASP recommends for PBKDF2-SHA256 in 2026.
- No separate HMAC, no signature, no integrity manifest.
- No key rotation procedure and no re-encryption tooling.
- No offsite or immutable/WORM storage guidance.
- **No RPO or RTO is defined anywhere in the documentation** (verified by search).
- No point-in-time recovery: `pg_dump` only, no WAL archiving.

**Recommendation:** Switch to AES-256-GCM (or `age`), set explicit high PBKDF2
iterations or use a KDF appropriate to a high-entropy key, add an integrity manifest,
define and test RPO/RTO, enable WAL archiving for PITR, and document immutable offsite
retention.

---

#### C4 — S2 — Credential KEK has no KMS/HSM integration or rotation path

The vault KEK is a plaintext 32-byte key read from `CREDENTIAL_KEK` or a file
(`internal/vault/keys.go`). The code comments concede the gap: *"Production should wrap
this KEK with a KMS; the process still loads only the unwrapped 32-byte key from the
environment."*

There is no KMS/HSM code path, no envelope-wrapping of the KEK itself, no per-workspace
DEK hierarchy, no automated rotation, and **no re-encryption tooling** — rotating the
KEK would require re-encrypting every credential and artifact with no shipped mechanism
to do so. `CREDENTIAL_KEK_ID` is stored as `key_reference`, so the schema anticipates
rotation that the code cannot perform.

**Recommendation:** Integrate AWS KMS / GCP KMS / Azure Key Vault / HashiCorp Vault for
KEK wrapping. Implement online re-encryption with dual-key read support during
rotation. Document key custody, rotation cadence, and the FIPS posture.

---

#### C5 — S3 — Rate limiting is per-process, narrow, and resets on restart

`embed.Limiter` is an in-process fixed-window counter capped at 4,096 keys
(`internal/embed/ratelimit.go:98`), applied to exactly two paths: embed
mint/exchange and `POST /login`.

Everything else is unlimited: workflow validate/normalize (which parse
attacker-supplied YAML), publish, execution start, list endpoints, artifact download,
and all ops-config writes. Only webhook ingress has its own separate limit.

Fixed windows permit 2× burst at boundaries, counters reset on every restart, and
limits are per-pod so effective capacity multiplies with replica count.

**Recommendation:** Add a shared (PostgreSQL- or Redis-backed) token-bucket limiter with
per-workspace quotas covering all mutating and expensive endpoints. Add per-workspace
concurrency caps for execution starts.

---

#### C6 — S3 — Migrations auto-apply on API boot with no drift detection

`postgres.Migrate` runs on every API start under a session advisory lock
(`internal/postgres/migrate.go`). Migrations are forward-only with:

- **no checksum validation** — an edited applied migration is silently ignored;
- **no down migrations or rollback path**;
- **no dry-run or pre-flight verification**;
- coupling of schema change to application deploy, so a rollback of the application
  cannot roll back the schema.

`docs/deployment.md` has no Upgrade, Rollback, Zero-Downtime Deploy, or Capacity
Planning section.

**Recommendation:** Record and verify a checksum per applied migration. Separate
migration execution from application boot (an `initContainer` or pipeline step).
Document an expand/contract change protocol and a tested rollback procedure.

---

### D. Security and compliance

The security work here is the strongest part of the repository and deserves explicit
credit: `FORCE ROW LEVEL SECURITY` with a `NOBYPASSRLS` role, transaction-local scope
set only after authorization, pool reset on checkout, composite `(workspace_id, id)`
foreign keys, `REVOKE UPDATE, DELETE` on immutable tables, HMAC job fencing, replay
protection with `jti` retention, and per-boundary negative tests.

The findings below are gaps in that otherwise-strong posture.

---

#### D1 — S2 — Web dependencies are never scanned; the web image ignores the lockfile

`.github/workflows/supply-chain.yml` runs Trivy `fs` scanning on **`apps/api` only**
and image scanning on the API image only. The Next.js dependency tree — the code that
renders the operator console — is never scanned, has no SBOM, and no image scan.

Separately, `apps/web/Dockerfile` does this:

```dockerfile
FROM base AS deps
COPY package.json ./
RUN pnpm install
```

The **lockfile is never copied**, and `--frozen-lockfile` is not used. Docker builds
therefore resolve dependencies fresh at build time, bypassing `pnpm-lock.yaml`
entirely. Two builds of the same commit can ship different dependency trees. This is
both a reproducibility failure and a supply-chain exposure.

Also missing: no Dependabot or Renovate configuration, no CodeQL or any SAST for
TypeScript, and `govulncheck` is installed from `@latest` (unpinned) inside the
supply-chain gate.

**Recommendation:** Copy `pnpm-lock.yaml` and use `pnpm install --frozen-lockfile`.
Extend Trivy `fs` and image scanning plus SBOM generation to `apps/web`. Add
Dependabot/Renovate, add CodeQL for JS/TS, and pin `govulncheck` to a release.

---

#### D2 — S2 — "Provenance" is an unsigned JSON file, not an attestation

`scripts/write-provenance.sh` emits a SLSA-shaped JSON document as a CI artifact. It
is:

- **unsigned** — no cosign, no Sigstore, no in-toto attestation;
- **unattached** — never pushed to a registry or bound to an image digest;
- **unverified** — nothing in the pipeline or at deploy time checks it;
- often self-referential, falling back to the local image ID when no repo digest
  exists.

No image signing exists. No admission policy (Kyverno/Gatekeeper/cosign verify) is
provided. `deploy/k8s/api-deployment.yaml` uses a mutable tag
(`ghcr.io/bbengt1/flowforge-api:foundation`) with a comment instructing operators to
pin a digest themselves.

Trivy image scanning gates on **CRITICAL only** with `--ignore-unfixed` — HIGH severity
image vulnerabilities do not fail the build.

**Recommendation:** Sign images with cosign, generate in-toto SLSA provenance via the
official GitHub generator, attach attestations to the registry, and enforce signature
and digest pinning with an admission controller. Gate on HIGH for images.

---

#### D3 — S2 — API base images are not digest-pinned

```dockerfile
# apps/api/Dockerfile
FROM golang:1.26-alpine AS build
FROM alpine:3.20
```

`apps/web/Dockerfile` correctly pins `node:22-alpine@sha256:c610fcd...`. The API image
does not, so its builds are not reproducible and a compromised or re-pushed upstream
tag silently changes the runtime. Neither image declares a `HEALTHCHECK`. The Go
builder installs `git` without using it.

**Recommendation:** Digest-pin both API base images, add `HEALTHCHECK`, drop the unused
`git` install, and extend `scripts/check-approved-bases.sh` to enforce digest pinning.

---

#### D4 — S3 — Secrets and local artifacts are present in the working tree

`.env` (7,336 bytes) and `.env.bak` are on disk at the repository root. Both are
correctly covered by `.gitignore` (`.env`, `.env.*`) and neither is tracked — this is
a hygiene issue, not a leak.

A documented local-only signing key is deliberately committed at
`deploy/local/embed-signing.pem` with a `.gitignore` exception. The intent is clear and
labelled, but a committed PEM is a standing false-positive for secret scanners and a
copy-paste hazard.

There is **no secret-scanning gate** in CI (no gitleaks, no trufflehog, no GitHub
push protection configuration).

**Recommendation:** Add a secret-scanning job to CI. Generate the local embed key at
first `docker compose up` rather than committing a PEM. Delete `.env.bak`.

---

#### D5 — S3 — CORS, CSP, and proxy trust are broad by default in the shipped manifests

`api-configmap.yaml` sets `TRUSTED_PROXY_CIDRS: "10.0.0.0/8,192.168.0.0/16,172.16.0.0/12"`
— all RFC1918 space. Any pod in the cluster that can reach the API can assert
`X-Forwarded-Proto: https` and `X-Forwarded-For`. In a shared cluster this weakens the
TLS-required boundary and client-IP-based rate limiting.

`CORS_ALLOWED_ORIGINS` is shipped commented out (correctly fail-closed, but it means
the reference manifest does not work as-is and invites a permissive value).

**Recommendation:** Narrow `TRUSTED_PROXY_CIDRS` to the ingress controller's pod CIDR or
service IP. Document how to determine it.

---

### E. Data and persistence

---

#### E1 — S2 — List endpoints are unpaginated and unbounded

`GET /api/v1/workflows` executes with no `LIMIT`:

```go
// apps/api/internal/wfstore/postgres.go:102
q := listWorkflowSQL + listWorkflowFolderClause(filter)
rows, err := tx.Query(ctx, q, listWorkflowFolderArgs(filter)...)
```

Across the 208-path OpenAPI document there are exactly **5 `limit` parameters and 1
`offset`** — and **no cursor pagination anywhere**. `identity/postgres.go` (28 SELECTs)
and `vault/postgres.go` (4 SELECTs) contain **zero** `LIMIT` clauses.

Unpaginated: workflows, credentials, workspace members, ops-config collections
(9 kinds), workflow folders, triggers, schedules, and version lists.

The UI compounds this: `WorkflowHome.tsx` loads the entire workflow set and filters,
searches, and sorts client-side.

**Impact:** A workspace with 10,000 workflows returns a multi-megabyte JSON payload,
holds a pool connection for the duration, and renders 10,000 client-side rows. This
fails at exactly the tenant size that justifies buying an enterprise platform.

**Recommendation:** Adopt keyset (cursor) pagination with a default and maximum page
size across every collection endpoint, and move search/filter/sort server-side.

---

#### E2 — S3 — Dual store implementations double the persistence surface

Nearly every domain ships both a `memory.go` and a `postgres.go` implementation
(`wfstore`, `opsconfig`, `identity`, `isolation`, `vault`, `webhook`, `schedule`,
`approval`, `session`, `scripts`, `artifact`, `embed`). `wfstore/memory.go` alone is
880 lines and `memory_dispatch.go` another 732.

Two consequences:

1. **Roughly 30–40% of the persistence layer is test scaffolding shipped in the
   production binary.**
2. **Behavioral divergence is unguarded.** There is no shared conformance test suite
   proving the two implementations agree on transaction semantics, RLS behavior,
   conflict handling, or ordering — so tests that pass against memory can mask real
   PostgreSQL bugs (see H2).

`inferStores()` silently selects the memory store whenever the `Checker` is not a
`*postgres.Pool` — a production misconfiguration would quietly run entirely in memory.

**Recommendation:** Extract a shared conformance suite run against both
implementations. Move memory stores behind a build tag or into `_test` packages. Make
production boot fail closed if a memory store is selected.

---

### F. Frontend architecture and UX

---

#### F1 — S1 — No error boundaries, loading states, or custom 404

The `apps/web/src/app` tree contains **zero** `error.tsx`, `global-error.tsx`,
`loading.tsx`, or `not-found.tsx` files across 28 routes.

**Impact:** An uncaught render error anywhere inside a 3,917-line client component
blanks the entire page with Next.js's default error screen — no recovery affordance,
no request ID, no support path. Every route transition shows a blank frame until
client-side fetching resolves, because pages are `force-dynamic` shells with no
Suspense boundary. A bad URL renders the framework's stock 404.

This is the single highest-leverage UX fix in the repository: four files.

**Recommendation:** Add a root `global-error.tsx` and per-segment `error.tsx` with retry
and the correlation ID, `loading.tsx` skeletons for each route group, and a branded
`not-found.tsx`. Report boundary errors to a telemetry sink.

---

#### F2 — S2 — Two styling systems, no shared component primitives

- 61 component files use raw Tailwind `zinc-*` utilities (826 occurrences).
- 26 component files use the `--ff-*` design-token system (138 occurrences).
- Only **1** file uses both — meaning the two systems are cleanly partitioned into two
  visually distinct halves of the product.

There is **no UI primitive library**. No `Button`, `Input`, `Select`, `Dialog`,
`Table`, or `Badge` component exists — `components/chrome/` holds three small status
components. The codebase contains **245 raw `<button>` elements**, each styled
independently.

The theme is hard-locked to dark (`html { color-scheme: dark }`,
`globals.css:10`), with **zero** `dark:` variants and no `prefers-color-scheme`
handling — no light mode and no respect for OS preference.

**Impact:** Visual inconsistency between migrated and unmigrated surfaces; every design
change requires touching dozens of files; no way to enforce consistent focus, disabled,
loading, or error states.

**Recommendation:** Build a small primitive layer (Button, Input, Select, Dialog with a
focus trap, Table, Badge, EmptyState) on the `--ff-*` tokens. Migrate the 61 `zinc-*`
files behind it. Add a light theme driven by tokens.

---

#### F3 — S2 — God components with unmanaged local state

| Component | Lines | `useState` | `useEffect` |
| --- | --- | --- | --- |
| `WorkflowHome.tsx` | 3,917 | 37 | 14 |
| `WorkflowOperator.tsx` | 2,438 | **66** | 11 |
| `ActionWizard.tsx` | 2,000 | — | — |
| `ExecutionDetail.tsx` | 1,313 | 26 | 3 |

There is no state-management library and no data-fetching cache (no SWR, React Query,
Zustand, or Redux). Every component hand-rolls fetch, loading, error, and staleness —
with no request deduplication, no shared cache, no stale-while-revalidate, and no
automatic revalidation.

This is not hypothetical complexity debt. ESLint flags two hard errors in
`WorkflowHome.tsx` today (`react-hooks/set-state-in-effect` at lines 1085 and 1089) —
`setPaneSelection` called synchronously inside effect bodies, which triggers cascading
renders — plus an `exhaustive-deps` warning at line 1370. Because lint is not in CI
(**H3**), these have merged to `main` unchallenged.

`apps/web/src/lib` is a **single flat directory of 304 files** with no domain
sub-structure.

**Impact:** 66 independent state variables in one component is effectively untestable
and unreasonable to reason about. Identical data is refetched independently by sibling
components.

**Recommendation:** Introduce a data-fetching cache (TanStack Query) and a reducer or
state machine for editor state. Decompose the four largest components along feature
seams. Reorganize `lib/` into domain folders.

---

#### F4 — S2 — Destructive actions are inconsistently guarded

Confirmation is applied unevenly:

- **Credentials** get a proper `DeleteImpactDialog` showing blast radius. Good.
- **Workflow folders** delete on a single click with no confirmation and no undo
  (`WorkflowHome.tsx:2238` → `removeFolder`:959). Mitigated only by a server-side
  "folder must be empty" rule.
- **Schedule triggers** delete on a single click with no confirmation
  (`ScheduleTriggerPanel.tsx:249`). Deleting a schedule silently and permanently stops
  automation, and because of A3 the operator will not notice.
- **Webhook triggers** follow the same pattern.
- **Workspace member removal** (`DELETE /workspace/members/{userID}`) has no impact
  preview.

`window.confirm` appears zero times, and only 6 components use `role="dialog"`.

**Recommendation:** Standardize one `ConfirmDestructive` primitive with impact preview
and require it for every `DELETE`. Add undo (soft-delete with a grace window) for
folders and triggers.

---

#### F5 — S3 — No global error surface for transient failures

The polling loop in `ExecutionDetail.tsx:518-524` returns silently on any non-403
error. A network partition, a 500, or a database outage presents as a page that simply
stops updating. There is a `NotificationCenter` component, but transient fetch failures
are not routed to it.

**Recommendation:** Route all non-success responses through the notification center with
the `X-Request-ID` shown, and render an explicit "connection lost — retrying" state on
polling surfaces.

---

### G. Accessibility

The team has done real, self-aware a11y work — skip links, `:focus-visible`,
`prefers-reduced-motion`, `aria-current`, combobox/listbox wiring, non-color-only
status, and a documented review with an honest gap list in
`docs/reference/e12-accessibility-review.md`. The findings below extend that list.

---

#### G1 — S2 — Form validation is not programmatically associated

Across 132 component files:

- `aria-invalid`: **0 occurrences**
- `aria-describedby`: **2 occurrences**
- `aria-errormessage`: 0
- `role="alert"` / inline validation: 13

**Impact:** Screen-reader users cannot perceive which field failed or why. Errors are
rendered visually and announced only at page level, if at all. This fails WCAG 2.2
SC 3.3.1 (Error Identification), 3.3.3 (Error Suggestion), and 4.1.2 (Name, Role,
Value) across credential creation, workflow settings, ops-config, schedule, and
webhook forms — the highest-risk data-entry surfaces in the product.

**Recommendation:** Build a `Field` primitive that wires `<label htmlFor>`,
`aria-invalid`, `aria-describedby`, and a live error region, and use it everywhere.

---

#### G2 — S2 — No focus trap in any dialog

The team's own review lists `dialog-focus-trap` as a known gap. Six components use
`role="dialog"`; all rely on Escape and initial focus, and `Tab` escapes the overlay
into the page behind it. `<img alt=...>`: 0 occurrences (no `<img>` tags in use).

**Recommendation:** Ship a single `Dialog` primitive with focus trap, inert background,
restore-focus-on-close, and `aria-modal`. Replace all six ad-hoc implementations.

---

#### G3 — S2 — No automated accessibility gate

There is no axe-core, no Lighthouse CI, and no Playwright in the repository. The a11y
contracts are enforced only by regex-matching component source text (see H1), which
proves a string exists in a file — not that the rendered DOM is accessible.

**Recommendation:** Add Playwright with `@axe-core/playwright` over the primary
operator routes, and gate CI on zero serious/critical violations.

---

#### G4 — S3 — The workflow canvas is not usable by screen readers

`role="application"` with per-node labels and a polite selection announcement. The
review is candid that no screen-reader graph representation exists. Keyboard
pan/select/zoom exist, but the graph structure — which nodes connect to which — is not
conveyed.

**Recommendation:** Provide an accessible alternative view: a structured tree or table
of nodes and edges that supports the same authoring operations. This is also useful for
sighted power users.

---

### H. Testing and quality engineering

---

#### H1 — S1 — 449 UI assertions verify source text, not behavior

**60 of 139** web test files call `readFileSync` on component source and assert with
regex or substring matching against **71 component files**, producing **449** such
assertions. Representative:

```ts
// e12-accessibility-contract.test.ts
assert.equal(E12_A11Y_STORY, 184);          // constant is defined as 184
assert.equal(E12_A11Y_RULES.keep184Open, true);
assert.equal(E12_A11Y_DOCS.guide, "docs/guides/operator-admin.md");
```

This pattern has three compounding problems:

1. **Tautology.** Many assertions compare a constant to its own literal definition. They
   can never fail and inflate the 1,035-test count without testing the product.
2. **False confidence.** Asserting that `aria-pressed` appears somewhere in
   `WorkflowHome.tsx` does not prove the rendered DOM has it on the right element, with
   the right value, in the right state.
3. **Refactor hostility.** A behavior-preserving refactor breaks the suite; a real
   regression that preserves the string passes.

The supporting scaffolding is large: **27 `*-contract.ts` modules totaling 19,452 lines**
exist largely to hold constants that the tests then assert against — non-shipping code
that is bundled and maintained as if it were product code.

**Impact:** Roughly 150k lines of TypeScript UI have **zero** behavioral test coverage.

**Recommendation:** Adopt React Testing Library for component behavior and Playwright
for end-to-end operator journeys (author → publish → run → inspect; create credential →
use → rotate → delete). Delete the source-text assertions as they are replaced, and
collapse the contract modules into ordinary constants.

---

#### H2 — S2 — The required CI test gate never touches the persistence layer

`supply-chain.yml`'s `api-tests` job runs `go test ./...` with **no `TEST_DATABASE_URL`**,
so every PostgreSQL-backed path is skipped in that gate. Measured coverage:

| Package | Without DB (the required gate) | With DB |
| --- | --- | --- |
| `internal/postgres` | **6.1%** | 32.6% |
| `internal/vault` | **13.4%** | 26.0% |
| `internal/schedule` | **19.2%** | 19.2% |
| `internal/webhook` | **31.5%** | 31.5% |
| `internal/wfstore` | **35.3%** | 48.5% |
| `internal/httpapi` | — | 67.6% |
| **Total** | — | **58.6%** |

The e12 workflows do run with a database, but the structural point stands: the
credential vault (26%), the durable execution store (48.5%), the webhook ingress
(31.5%), and the scheduler (19.2%) — the four most security- and correctness-critical
subsystems — are all under 50% even in the best case.

There is **no coverage threshold, no coverage reporting, and no ratchet** in any
workflow.

**Recommendation:** Give `api-tests` a PostgreSQL service. Publish coverage and enforce
a per-package floor (start at the current value, ratchet up). Target 80%+ on `vault`,
`wfstore`, `webhook`, and `schedule`.

---

#### H3 — S2 — CI never type-checks, lints, or builds the web application, and the lint gate is red today

`.github/workflows/supply-chain.yml`'s `web-tests` job runs `pnpm install` then
`pnpm test`. There is **no `pnpm build`**, **no `pnpm lint`**, and **no type-check**
job in any workflow — even though `lint` is defined in `package.json`. Next.js 16 with
Turbopack does **not** run ESLint during `next build` (the build output shows a
TypeScript step and no lint step), so nothing lints this repository at any point.

I installed dependencies and ran all three gates locally. Results:

| Gate | Result |
| --- | --- |
| `next build` (includes typegen + TypeScript) | **Passes.** Compiled in 5.1s, TypeScript clean, 32 routes emitted |
| `eslint .` | **Fails — 2 errors, 1 warning** |
| `tsc --noEmit` standalone | 1 error, but see note below |

**The lint gate is currently broken.** Both errors are
`react-hooks/set-state-in-effect` in `WorkflowHome.tsx`:

```
src/components/home/WorkflowHome.tsx
  1085:5  error  Avoid calling setState() directly within an effect
  1089:5  error  Avoid calling setState() directly within an effect
  1370:6  warning  useEffect has a missing dependency: 'startInlineRename'
```

These are not cosmetic. `setPaneSelection` is called synchronously inside two effect
bodies in a 3,917-line component that already runs 14 effects and polls on a timer —
exactly the cascading-render pattern that makes this component's performance and
correctness hard to reason about (see **F3**).

**Note for future readers:** running `tsc --noEmit -p tsconfig.json` on a clean
checkout reports one error, `src/app/layout.tsx(22,56): Cannot find name 'LayoutProps'`.
This is **not** a real defect — `LayoutProps` is a Next.js generated global type in
`.next/types/`, which `tsconfig.json` includes but which does not exist until
`next build` or `next dev` has run. The correct type-check command for this project is
`next build` (or `next typegen && tsc --noEmit`), and it passes.

Similarly on the Go side there is no `gofmt -l` check, no `go vet` job, and no
`golangci-lint` — though `go vet ./...` is clean today.

**Impact:** A broken production build or a type error can merge to `main` and be
discovered only at image build time. Lint violations already have: the two errors above
are on `main` right now and nothing in the pipeline objects.

**Recommendation:** Fix the two `set-state-in-effect` errors, then add required CI jobs
for `pnpm build`, `pnpm lint` (with `--max-warnings=0`), `gofmt -l`, `go vet`, and
`golangci-lint`. Use `next build` as the type-check gate rather than bare `tsc`, or add
`next typegen` ahead of it.

---

#### H4 — S2 — Test code is never type-checked; 29 type errors are hiding in it

`apps/web/tsconfig.json` sets `"exclude": ["node_modules", "**/*.test.ts"]`, so all 139
test files are outside the type-check scope. The test runner —
`node --experimental-strip-types` — *strips* types rather than checking them. The result
is that **no tool anywhere verifies the types of the test suite**, and ESLint does not
reach it either.

I type-checked the test files explicitly with the project's own compiler settings.
**29 errors across 17 of 139 test files:**

| Error code | Count | Meaning |
| --- | --- | --- |
| `TS2741` / `TS2740` | 9 | Test fixture is missing required properties of the type it claims to be |
| `TS2353` | 6 | Test fixture has properties the type does not declare |
| `TS2345` | 6 | Wrong argument type passed to the function under test |
| `TS2367` | 3 | **Comparison between types with no overlap — the assertion can never fail** |
| `TS2339` | 3 | Property accessed on a type that does not have it |

Two categories matter:

1. **Incomplete fixtures silently weaken tests.** For example
   `credential-vault.test.ts:286` passes a `ProblemDetails` missing `instance` and
   `request_id`, and `editor-inspector.test.ts:146` passes a `CredentialRecord` missing
   eight required fields. The code under test is being exercised with shapes it would
   never receive in production, so the tests do not prove the behavior they claim to.

2. **`TS2367` is compiler-verified proof of tautological assertions.** The compiler is
   reporting that these comparisons have no overlapping types — they are guaranteed
   true and test nothing:

   ```ts
   // peak-end-operate-endings.test.ts:135-136
   assert.equal(PEAK_END_INBOX_LABELS.success !== PEAK_END_INBOX_LABELS.indeterminate, true);
   assert.equal(PEAK_END_NDV_LABELS.success !== PEAK_END_NDV_LABELS.indeterminate, true);
   ```

   These compare two distinct string literal constants for inequality. This independently
   corroborates **H1** — the compiler itself can identify assertions in this suite that
   cannot fail.

**Recommendation:** Remove `**/*.test.ts` from `tsconfig.json`'s `exclude`, fix the 29
errors, and add the test files to both the type-check and the lint gate. Prefer a
runner that type-checks (`tsx`, `vitest`, or `tsc && node --test`) over
`--experimental-strip-types`.

---

#### H5 — S3 — No performance, load, or chaos testing of the real system

`scripts/e12-resilience-suite.py` computes queue-lag and depth figures, but it is a Go-test
harness, not a load test against a running system. There is no k6/Gatling/Locust
scenario, no soak test, no chaos/fault-injection testing (pod kill, network partition,
database failover), and no frontend performance budget (bundle size, Core Web Vitals).

**Recommendation:** Add a k6 scenario against the compose stack in CI (nightly), plus a
bundle-size budget check on the web build.

---

### I. Documentation and governance

---

#### I1 — S1 — No governance, licensing, or release management

Absent from the repository:

| File | Status |
| --- | --- |
| `LICENSE` | **Missing** |
| `SECURITY.md` (vulnerability disclosure) | **Missing** |
| `CONTRIBUTING.md` | **Missing** |
| `CODEOWNERS` | **Missing** |
| `CHANGELOG.md` | **Missing** |
| `.github/PULL_REQUEST_TEMPLATE.md` | **Missing** |
| `.github/dependabot.yml` / `renovate.json` | **Missing** |
| Root `CLAUDE.md` / developer guide | **Missing** |
| Architecture Decision Records | **Missing** |

Release management is equally absent: **0 git tags**, no semantic version for the API
(the web package is `0.1.0`), no changelog, no release workflow, and no published
container images. 216 commits from a single author over 11 days, with no build identity
exposed at runtime (see C1).

**Impact:** No license means no enterprise can legally deploy this. No `SECURITY.md`
means researchers have no disclosure channel. No versioning means no upgrade path, no
support matrix, and no way to say what is deployed.

**Recommendation:** Add a license, `SECURITY.md` with a disclosure process and SLA,
`CONTRIBUTING.md`, `CODEOWNERS`, and a PR template. Adopt semantic versioning with
signed tags, a generated changelog, and a release workflow that publishes signed images.
Start an ADR log for the decisions already embedded in the docs (YAML canonicality,
publish-then-run, fail-closed boundaries, no-realtime).

---

#### I2 — S2 — Documentation is written for the build process, not for adopters

The `docs/` tree is 8,831 lines and technically accurate, but it is structured as a
project-management artifact:

- **1,329** GitHub issue references (`#NNN`)
- **88** "Keep #NNN open" directives
- **576** references to individual contributor names (Chloe / jonny / Arie / Brent)
- Ownership tables ("Chloe owns…", "jonny owns…") inside normative reference documents
- Story identifiers (E12.3, ADV-013, UX.10, R7.4, B.8) used as primary section anchors

Worse, **680 of these contributor-name references appear in shipping source code** —
Go files and TypeScript modules that will be compiled into the product.

The documentation also lacks the sections an adopting enterprise needs:
`docs/deployment.md` has no Upgrade, Rollback, Scaling, Capacity Planning, Monitoring
Setup, or Disaster Recovery section. There is no developer onboarding guide, no code
layout map, no local test instructions, and no API client/SDK guide beyond the embed
contract.

**Impact:** A new engineer or an evaluating customer cannot distinguish normative
architecture from transient sprint bookkeeping. When the referenced issues close, the
documentation becomes actively misleading.

**Recommendation:** Split into `docs/` (durable, adopter-facing: architecture, API
reference, operations, security) and `docs/internal/` (backlog, evidence, ownership).
Strip issue numbers and personal names from normative documents and from all source
code. Add Upgrade/Rollback/Scaling/DR/Monitoring sections and a developer onboarding
guide.

---

#### I3 — S2 — Documentation asserts capabilities the code does not have

The most serious documentation problem is not structure — it is accuracy. Specific
claims in `docs/architecture.md` that the code contradicts:

| Documented claim | Reality |
| --- | --- |
| "Workers execute one step at a time in short-lived isolated pods" | No production worker exists (**A1**) |
| "Workers revalidate an authenticated job's version/policy/lease before calling a provider" | No provider is ever called (**A1**) |
| "Every boundary fails closed" | Two HMAC keys fail open to random values (**B1**) |
| "Artifact metadata survives pod loss" | Artifact payloads live on `tmpfs` and do not (**B3**) |
| E1.2: "OpenAPI generation/publishing" | The spec is 10,042 hand-written lines (**B5**) |
| E1.2: "every API-to-worker flow can be traced by correlation ID" | No tracing exists (**C1**) |
| Architecture: "realtime channels" scoped by workspace | The UI polls every 2s; SSE/WS are forbidden (**A4**) |

**Recommendation:** Add an explicit "Implemented vs. Specified" matrix to
`docs/architecture.md` and the README. Mark every unimplemented capability as such. For
an enterprise buyer, a documented gap is acceptable; a documented capability that does
not exist is a credibility failure.

---

## 4. Prioritized remediation roadmap

### Phase 0 — Truth and safety (1–2 weeks)

Cheap, high-leverage, mostly non-code.

| # | Action | Finding |
| --- | --- | --- |
| 1 | Add `LICENSE`, `SECURITY.md`, `CODEOWNERS`, `CONTRIBUTING.md`, PR template | I1 |
| 2 | Add "Implemented vs. Specified" matrix to README and architecture | I3 |
| 3 | Boot-fail on missing/malformed `JOB_BINDING_SECRET` and `SCRIPT_SIGNING_KEY` | B1 |
| 4 | Add `error.tsx`, `global-error.tsx`, `loading.tsx`, `not-found.tsx` | F1 |
| 5 | Fix the 2 `react-hooks/set-state-in-effect` errors in `WorkflowHome.tsx` (lint is red on `main`) | **H3**, F3 |
| 6 | Add CI jobs: `pnpm build`, `pnpm lint --max-warnings=0`, `gofmt -l`, `go vet`, `golangci-lint` | H3 |
| 7 | Remove `**/*.test.ts` from `tsconfig` `exclude`; fix the 29 test type errors | H4 |
| 8 | Copy `pnpm-lock.yaml` into the web image; use `--frozen-lockfile` | D1 |
| 9 | Give `api-tests` a PostgreSQL service; publish coverage | H2 |
| 10 | Digest-pin API base images; add `HEALTHCHECK` | D3 |
| 11 | Expose build SHA and version on `/api/v1/health` | C1 |
| 12 | Set `statement_timeout` and `lock_timeout` on connection checkout | C2 |
| 13 | Gate polling on `visibilityState`; add backoff and jitter | A4 |
| 14 | Delete `.env.bak`; add a secret-scanning CI job | D4 |

### Phase 1 — Make it work (4–8 weeks)

| # | Action | Finding |
| --- | --- | --- |
| 15 | Build `cmd/runner`: a production worker wired to the k8s/ssh/script/http engines | **A1** |
| 16 | Build and publish the isolated script-runner image; wire Job creation | A1 |
| 17 | Ship a leader-elected scheduler for dispatch, recovery, and retention | **A3** |
| 18 | Add a `CronJob` for encrypted backups; define and test RPO/RTO | A3, C3 |
| 19 | Implement S3-compatible durable artifact storage | **B3** |
| 20 | Add a machine/service-principal credential for automation and scrapers | A3, C1 |
| 21 | Add web Deployment/Service and worker manifests to `deploy/k8s` | B2 |

### Phase 2 — Make it enterprise (8–16 weeks)

| # | Action | Finding |
| --- | --- | --- |
| 22 | OIDC Authorization Code + PKCE; enforce MFA on privileged permissions | **A2** |
| 23 | SCIM 2.0 provisioning and deprovisioning; durable account lockout | A2 |
| 24 | KMS-wrapped KEK with online re-encryption and rotation | **C4** |
| 25 | OpenTelemetry traces and metrics; business metrics; SLOs and alert rules | **C1** |
| 26 | Keyset pagination and server-side search across all collections | **E1** |
| 27 | Multi-replica HA: PDB, HPA, anti-affinity, graceful drain | B2 |
| 28 | AEAD backups (GCM/age) with integrity manifest; WAL archiving for PITR | C3 |
| 29 | Shared distributed rate limiting with per-workspace quotas | C5 |
| 30 | cosign image signing, in-toto attestations, admission enforcement | D2 |
| 31 | Extend Trivy/SBOM/CodeQL to `apps/web`; add Dependabot | D1 |

### Phase 3 — Make it maintainable (ongoing)

| # | Action | Finding |
| --- | --- | --- |
| 32 | UI primitive library (Dialog with focus trap, Field with `aria-invalid`, Button, Table) | F2, G1, G2 |
| 33 | Playwright + axe-core E2E suite; retire source-text assertions | **H1**, G3 |
| 34 | React Testing Library coverage for the top 20 components | H1 |
| 35 | TanStack Query; decompose the four god components | F3 |
| 36 | Generate OpenAPI and the proxy allowlist from the route table | **B5** |
| 37 | Migrate the 61 `zinc-*` files onto design tokens; add a light theme | F2 |
| 38 | Split `httpapi` into per-domain routers; break up 1,000+ line files | B4 |
| 39 | Store conformance suite; move memory stores out of the production binary | E2 |
| 40 | Split `docs/` from `docs/internal/`; strip issue numbers and names from source | I2 |
| 41 | Standardize destructive-action confirmation with impact preview and undo | F4 |
| 42 | Migration checksums; decouple migration from boot; document upgrade/rollback | C6 |

---

## 5. Appendix — measurements

All figures were measured directly against `e4d0c9d` on 2026-09-21.

### Codebase

| Metric | Value |
| --- | --- |
| Go source (excl. tests) | 59,561 LOC across 228 files |
| Go tests | 30,886 LOC across 133 files |
| TypeScript/TSX | 150,099 LOC across 471 files |
| Web test files | 139 (all in `src/lib`; **0** component tests) |
| SQL migrations | 27 files, 51 tables |
| Documentation | 38 Markdown files (49 files incl. evidence artifacts), 8,831 LOC |
| API routes registered | 251 (152 static + 9 ops-config kinds x 11) |
| OpenAPI paths (hand-written) | 208 |
| Go direct dependencies | 3 |
| Web runtime dependencies | 3 (`next`, `react`, `react-dom`) |
| Git history | 216 commits, 1 author, 11 days, **0 tags** |

### Verification results

| Check | Result | Gated by CI? |
| --- | --- | --- |
| `go build ./...` | Pass | Indirectly (via `go test`) |
| `go vet ./...` | Pass — clean | **No** |
| `gofmt -l` | Not run | **No** |
| `go test ./...` | Pass — 32 packages | Yes |
| Go coverage (with PostgreSQL) | **58.6%** total | No threshold |
| Go coverage (no DB, as the required `api-tests` gate runs) | `postgres` 6.1%, `vault` 13.4% | No threshold |
| Web tests (`node --test`, types stripped not checked) | Pass — 1,035 tests, 225 suites | Yes |
| **`next build`** (typegen + TypeScript + production build) | **Pass** — 5.1s compile, TypeScript clean, 32 routes | **No** |
| **`eslint .`** | **FAIL — 2 errors, 1 warning** | **No** |
| Test-file type-check (excluded from `tsconfig`) | **FAIL — 29 errors in 17 of 139 files** | **No** |

*Dependencies were installed with `pnpm@10.33.3` to run the web gates; `node_modules/`
and `.next/` are both git-ignored.*

### Build output characteristics

| Metric | Value |
| --- | --- |
| Routes emitted | 32 — **all** marked `ƒ (Dynamic) server-rendered on demand` |
| Statically prerendered routes | **0** (corroborates **B6**) |
| Client JS shipped | 2,284 KB uncompressed across 54 chunks |
| Largest chunk | 224 KB |
| Custom `not-found` | None — the emitted `/_not-found` is the framework default (**F1**) |
| ESLint run during `next build`? | **No** — Next 16 + Turbopack performs no lint step |

### Test-file type errors (29 across 17 files)

| Error code | Count | Meaning |
| --- | --- | --- |
| `TS2741` / `TS2740` | 9 | Fixture missing required properties of its declared type |
| `TS2353` | 6 | Fixture has properties the type does not declare |
| `TS2345` | 6 | Wrong argument type passed to the function under test |
| `TS2367` | 3 | **Comparison with no type overlap — assertion can never fail** |
| `TS2339` | 3 | Property accessed on a type that lacks it |

### Test-fidelity indicators

| Metric | Value |
| --- | --- |
| Web test files reading component source via `readFileSync` | **60 of 139** |
| Source-text assertions (`source(...)` / `assert.match`) | **449** |
| Distinct component files asserted as text | **71** |
| `*-contract.ts` scaffolding modules | 27 modules, **19,452 LOC** |
| Component render tests | **0** |
| End-to-end tests | **0** |
| Accessibility automation (axe/Lighthouse) | **0** |
| Load / chaos tests | **0** |
| Test files inside the type-check scope | **0 of 139** (`tsconfig` excludes `**/*.test.ts`) |
| Type errors hiding in test files | **29 across 17 files** |
| Compiler-confirmed impossible assertions (`TS2367`) | **3** |

### Frontend indicators

| Metric | Value |
| --- | --- |
| Components total / `"use client"` | 132 / **105** |
| Pages with `force-dynamic` | 25 of 28 |
| Pages with server-side data fetching | **0** |
| `error.tsx` / `loading.tsx` / `not-found.tsx` | **0 / 0 / 0** |
| Files on `zinc-*` utilities / on `--ff-*` tokens | 61 / 26 |
| Raw `<button>` elements | 245 |
| Largest component | `WorkflowHome.tsx` — 3,917 LOC |
| Most `useState` in one component | `WorkflowOperator.tsx` — **66** |
| Files in flat `src/lib/` | **304** |
| `aria-invalid` / `aria-describedby` occurrences | **0** / 2 |
| `dark:` variants | 0 (dark-locked) |
| `visibilityState` usage | 0 |
| Client JS shipped (production build) | 2,284 KB across 54 chunks |
| Routes statically prerendered | 0 of 32 |
| ESLint errors on `main` | **2** (+1 warning) |

### Documentation indicators

| Metric | Value |
| --- | --- |
| GitHub issue references in docs | **1,329** |
| "Keep #NNN open" directives | 88 |
| Contributor-name references in docs | 576 |
| Contributor-name references **in shipping source** | **680** |
| Governance files present (of 9 checked) | **0** |
| RPO / RTO definitions | **None** |
| Production SLOs / alert rules / dashboards | **None** |

---

*Prepared by adversarial static and dynamic review of the repository at `e4d0c9d`.
Every claim above is anchored to a file path, a line reference, or an executed command.*
