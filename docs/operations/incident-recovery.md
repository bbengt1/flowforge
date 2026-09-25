# Incident and recovery runbook

Control-plane runbook for health signals, worker-loss, restore, and
escalation. It documents existing APIs, scripts, and E12 evidence. It
does not add dashboards or operator chrome.
**Operator UI guide — E12.3** (alerts / execution
`indeterminate` screens).

Companion pages: [deployment](../deployment.md),
[retention and backup](retention-backup.md),
[E12.2 resilience and capacity](../reference/e12-resilience-capacity.md),
[security model](../reference/security-model.md).

## Health vs readiness

| Probe | Path | Auth | Meaning | Typical fail |
| --- | --- | --- | --- | --- |
| Liveness | `GET /api/v1/health` | none | Process is serving. Does **not** check PostgreSQL. Body includes non-secret `version` / `sha`. | Process down / crash-loop. `200 {"status":"ok","version":"…","sha":"…"}` otherwise. Missing identity is `dev`/`unknown`. |
| Readiness | `GET /api/v1/readiness` | none | PostgreSQL is reachable. Ready body repeats `version` / `sha`. | `503` RFC 9457 `dependency-unavailable` while the DB is down or migrations have not finished. `200 {"status":"ready","version":"…","sha":"…"}` after connect + migrate. |

Kubernetes (`deploy/k8s/api-deployment.yaml`):

- Liveness: `/api/v1/health` every 15s
- Readiness: `/api/v1/readiness` every 5s

The API image `HEALTHCHECK` and compose `api.healthcheck` use the same
liveness path (`GET /api/v1/health` every 15s). Compose `--wait` waits
on that probe only. The local `worker` service disables the inherited
check because `/usr/local/bin/worker` does not listen on 8080.

There are no `/healthz` / `/readyz` aliases. Probe paths stay reachable
over plain HTTP even when `REQUIRE_TLS=true`, so kubelet can hit the
pod without Ingress TLS.

**How to read the pair**

| Health | Readiness | Interpretation |
| --- | --- | --- |
| 200 | 200 | Accept traffic. |
| 200 | 503 | Process up, database (or migrate) not ready. Do not send application traffic. Compose `--wait` only waits on `/api/v1/health` — wait for readiness before dump or smoke. |
| fail | — | Restart / page the API deployment. |

The process boots even if PostgreSQL is down. On connect it applies
forward-only migrations recorded in `schema_migrations` and checks each
applied file's SHA-256 before serving traffic. Re-running migrate is a
no-op for applied versions whose checksums match. A mismatched, renamed,
or missing applied file refuses boot: the log names the version and
filename, the application pool stays closed, and readiness stays `503`.
That failure is not retried. Recover by restoring the file from the
release that applied it and restarting — see
[schema migrations](schema-migrations.md#refused-boot). Concurrent
migrate runners serialize on advisory lock `881726401` (E12.2).

`version` / `sha` on a 200 health or readiness body identify the
running binary (image ldflags or `BUILD_VERSION` / `BUILD_SHA`). They
are never secrets. Missing values are `dev` / `unknown` and do not
change probe status.

`GET /api/v1/metrics` is **not** a probe. It requires
`platform.administer` or a machine principal with `ops.metrics.read`.
When `MACHINE_REQUIRE` includes `metrics`, a missing principal is
`503`. Do not point kubelet at it.

## Worker-loss and fencing

Workers claim with `POST /api/v1/jobs/claim` (`FOR UPDATE SKIP LOCKED`).
A claim returns `fencing_token` plus an HMAC job ticket
(`JOB_BINDING_SECRET`) bound to workspace, workflow version/digest,
policy digest, and expiry.

Local compose starts a **dev-only** `worker` service
(`/usr/local/bin/worker`) that claims over HTTP so Start published can
leave `queued`. It refuses provider nodes. `deploy/k8s` must not run
that binary.

Production runs `/usr/local/bin/runner`. It claims in-process under
FORCE RLS, mints and re-parses the same HMAC job ticket, and completes
or fails with the fencing token. It refuses the local/dev path.
See [deployment — local compose worker](../deployment.md#local-compose-worker)
and [deployment — production runner](../deployment.md#production-runner).
When jobs sit `queued` with no `workerId` for 15s, execution detail
includes additive `statusReason: "no-worker"`.

On lease expiry or a disconnected worker:

1. The API leader scheduler calls lease recovery on its interval
 (`SCHEDULER_INTERVAL`, default 30s). `POST /api/v1/jobs/recover`
 (also runs on the next claim) does the same sweep: expired
 `claimed` / `running` jobs become `indeterminate`.
2. A stale `jobToken` cannot complete or overwrite a later claim.
3. After the first heartbeat, `POST /jobs/{id}/release` is also
 `indeterminate` (not a silent requeue).
4. Do **not** infer that a provider side effect did not occur. Require
 verification or an explicitly authorized recovery action
 ([security model — Incident-safe behavior](../reference/security-model.md#incident-safe-behavior)).

Retry of `indeterminate` provider steps is denied unless the node is
explicitly retry-safe (`409` `execution_not_retryable`, reason
`retry_not_allowed`). Cancel of terminal / `indeterminate` executions
is `409`.

**Evidence (do not weaken):** E12.2 domain 2 and E12.1 domain 7.

| Proof | Location |
| --- | --- |
| Capacity + worker-loss | `internal/e12resilience` `TestE12CapacityHeadroomAndWorkerLoss` |
| Postgres skip-locked / lease loss | `wfstore` `TestPostgresDispatchSkipLockedAndLeaseLoss` |
| HTTP dispatch fence | `httpapi` `TestDispatchClaimFenceCancelAndLeaseLoss` |
| Suite map | [e12-resilience-capacity.md](../reference/e12-resilience-capacity.md) |

Default lease **30s** (min 1s, max 5m). `JOB_BINDING_SECRET` is required
at boot (32-byte base64 or 64 hex). Missing or malformed **refuses to
start** — there is no per-process random default. Compose uses a
documented local-only value so restarts stay stable (see
[deployment](../deployment.md)).

## Restore rehearsal

A successful backup job is **not** recovery evidence. Restore into an
isolated environment, confirm schema, then verify health/readiness (and
an application smoke test in production).

| Rehearsal | Script | What it proves | CI |
| --- | --- | --- | --- |
| Encrypted compose dump + hardened API boot | `scripts/backup/restore-rehearsal.sh` | Decrypt → throwaway Postgres → `schema_migrations` → API `/health` + `/readiness` | `supply-chain.yml` job `restore-rehearsal` |
| Schema-level isolated restore (no compose API) | `scripts/backup/restore-schema-rehearsal.sh` | Encrypted `pg_dump` of `TEST_DATABASE_URL`, restore into a throwaway database, version match, `execution_jobs` present | E12.2 `e12-resilience.yml` |
| RPO/RTO (CronJob DSN path) | `scripts/backup/rpo-rto-rehearsal.sh` | Same `run-encrypted-backup.sh` entrypoint as `flowforge-db-backup`; verifies the FFB1 integrity manifest; tamper fails closed; records logical RPO (24h), PITR RPO (300s), and RTO | E12.2 `e12-resilience.yml` |
| Integrity manifest + WAL/PITR | `scripts/backup/manifest-pitr-rehearsal.sh` | Sealed WAL, physical base backup, replay of a row written after the base backup. Refuses non-local Postgres | E12.2 `e12-resilience.yml` |
| Encrypted dump only (compose) | `scripts/backup/encrypt-pg-dump.sh` | FFB1 AES-256-GCM + PBKDF2 ciphertext on disk | used by the compose rehearsal |
| Encrypted dump (DSN / k8s) | `scripts/backup/run-encrypted-backup.sh` | Same AEAD format; optional `BACKUP_S3_BUCKET` upload under `flowforge-db/` | CronJob + RPO/RTO rehearsal |

Commands and key wrapping: [retention and backup](retention-backup.md).
Headroom / queue-lag after restore stays
[e12-resilience-capacity.md](../reference/e12-resilience-capacity.md).

After a real restore: the API recreates `flowforge_app` and table
grants on connect (`pg_dump --no-acl` drops GRANTs). Do not serve
traffic until `/api/v1/readiness` is 200.

## Escalation signals

Correlate with identifiers only. Never put `Authorization`, cookies,
credential material, webhook bodies, or unredacted provider output in
tickets or alert payloads.

| Signal | Where | Use |
| --- | --- | --- |
| `X-Request-ID` / `request_id` | Response header, problem JSON, structured request logs | Trace one HTTP call end to end. Caller values accepted only when 16–128 ASCII letters, digits, or hyphens. |
| `traceparent` / `tracestate` | Response headers, `execution_jobs` columns, worker claim/complete | W3C trace context for one enqueue-to-worker flow. Invalid or secret-like values are dropped. Not a credential. |
| `correlation_id` | Executions, audit events, operational alerts | Tie a run / decision across API and workers. |
| Structured logs | API stdout JSON | `method`, `path`, `route`, `status`, `duration`, `bytes`, `request_id`. Secret-free. |
| `GET /api/v1/metrics` | Prometheus text | HTTP count/duration plus OpenTelemetry business series (queue, lease, execution outcome, vault). `platform.administer` or machine `ops.metrics.read`. SLOs: [slo-alerts.md](slo-alerts.md). |
| `GET /api/v1/alerts` | API | Kinds `authorization`, `replay`, `policy`, `redaction`. Identifiers only (`correlationId`, `requestId`, `resourceType`, `resourceId`, `code`). Ack: `POST /alerts/{id}/ack` (`alert.ack`). |
| `GET /api/v1/audit-events` | API | Append-only, redacted. `flowforge_app` cannot UPDATE or DELETE live rows. |
| Session audit | `GET /api/v1/session/audit-events` | `session.created` / `revoked` / `expired` / `csrf_rejected` / … — no cookie values. |

**Page / escalate when**

- Readiness stays 503 after Postgres and migrate should be up.
- Liveness fails or the API crash-loops (check embed signing key,
 `TRUSTED_DEV_IDENTITY_HEADERS` accidentally set, bad
 `EMBED_OVERLAP_KEYS`, non-https issuer allowlist — those are
 boot-fails in production).
- Burst of `authorization` / `replay` / `policy` / `redaction` alerts
 with the same `correlationId` or `resourceId`.
- Queue lag or connection peaks approaching the E12.2 ≥2× headroom
 claims ([capacity-last-run.json](../reference/e12-resilience-evidence/capacity-last-run.json)).
- Restore rehearsal or `supply-chain.yml` `restore-rehearsal` fails on
 `main`.
- E12.1 security suite or E12.2 resilience suite red on `main`.

**Do not**

- Enable `TRUSTED_DEV_IDENTITY_HEADERS` to “unblock” production identity.
 Trusted-dev headers are never rewrite login.
- Point scrapers at OpenAPI/metrics without a platform-admin session.
- Retry `indeterminate` provider steps without verification.
- Treat compose `/health` 200 as “ready to dump.”

## Operator UI map

| Surface | This PR | E12.3 |
| --- | --- | --- |
| Health/readiness, recover, restore scripts | This runbook | No new chrome |
| `/alerts` queue and ack | API contract already in the backend map | **Operator UI guide — E12.3** |
| Execution `indeterminate` badge | Existing E5/E12.1 contract | **Operator UI guide — E12.3** |
| Accessibility of alert/execution screens | Out of scope | **Accessibility review — E12.3** |
