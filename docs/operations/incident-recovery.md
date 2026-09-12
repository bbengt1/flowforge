# Incident and recovery runbook

Relates to #184 / Part of #181. **Keep #184 open.**

Control-plane runbook for health signals, worker-loss, restore, and
escalation. It documents existing APIs, scripts, and E12 evidence. It
does not add dashboards or operator chrome.
**Operator UI guide — Chloe / E12.3** (alerts / execution
`indeterminate` screens).

Companion pages: [deployment](../deployment.md),
[retention and backup](retention-backup.md),
[E12.2 resilience and capacity](../reference/e12-resilience-capacity.md),
[security model](../reference/security-model.md).

## Health vs readiness

| Probe | Path | Auth | Meaning | Typical fail |
| --- | --- | --- | --- | --- |
| Liveness | `GET /api/v1/health` | none | Process is serving. Does **not** check PostgreSQL. | Process down / crash-loop. `200 {"status":"ok"}` otherwise. |
| Readiness | `GET /api/v1/readiness` | none | PostgreSQL is reachable. | `503` RFC 9457 `dependency-unavailable` while the DB is down or migrations have not finished. `200 {"status":"ready"}` after connect + migrate. |

Kubernetes (`deploy/k8s/api-deployment.yaml`):

- Liveness: `/api/v1/health` every 15s
- Readiness: `/api/v1/readiness` every 5s

There are no `/healthz` / `/readyz` aliases. Probe paths stay reachable
over plain HTTP even when `REQUIRE_TLS=true`, so kubelet can hit the
pod without Ingress TLS.

**How to read the pair**

| Health | Readiness | Interpretation |
| --- | --- | --- |
| 200 | 200 | Accept traffic. |
| 200 | 503 | Process up, database (or migrate) not ready. Do not send application traffic. Compose `--wait` only waits on `/health` — wait for readiness before dump or smoke. |
| fail | — | Restart / page the API deployment. |

The process boots even if PostgreSQL is down. On connect it applies
forward-only migrations recorded in `schema_migrations`. Re-running
migrate is a no-op for applied versions. Concurrent migrate runners
serialize on advisory lock `881726401` (E12.2).

`GET /api/v1/metrics` is **not** a probe. It requires
`platform.administer`. Do not point kubelet at it.

## Worker-loss and fencing

Workers claim with `POST /api/v1/jobs/claim` (`FOR UPDATE SKIP LOCKED`).
A claim returns `fencing_token` plus an HMAC job ticket
(`JOB_BINDING_SECRET`) bound to workspace, workflow version/digest,
policy digest, and expiry.

Local compose starts a **dev-only** `worker` service that uses this
same claim path so Start published can leave `queued`. It is not a
production worker. `deploy/k8s` must not run `/usr/local/bin/worker`.
See [deployment — local compose worker](../deployment.md#local-compose-worker).
When jobs sit `queued` with no `workerId` for 15s, execution detail
includes additive `statusReason: "no-worker"`.

On lease expiry or a disconnected worker:

1. `POST /api/v1/jobs/recover` (also runs on the next claim) marks
   expired `claimed` / `running` jobs `indeterminate`.
2. A stale `jobToken` cannot complete or overwrite a later claim.
3. After the first heartbeat, `POST /jobs/{id}/release` is also
   `indeterminate` (not a silent requeue).
4. Do **not** infer that a provider side effect did not occur. Require
   verification or an explicitly authorized recovery action
   ([security model — Incident-safe behavior](../reference/security-model.md#incident-safe-behavior)).

Retry of `indeterminate` provider steps is denied unless the node is
explicitly retry-safe (`409` `retry-denied`). Cancel of terminal /
`indeterminate` executions is `409`.

**Evidence (do not weaken):** E12.2 domain 2 and E12.1 domain 7.

| Proof | Location |
| --- | --- |
| Capacity + worker-loss | `internal/e12resilience` `TestE12CapacityHeadroomAndWorkerLoss` |
| Postgres skip-locked / lease loss | `wfstore` `TestPostgresDispatchSkipLockedAndLeaseLoss` |
| HTTP dispatch fence | `httpapi` `TestDispatchClaimFenceCancelAndLeaseLoss` |
| Suite map | [e12-resilience-capacity.md](../reference/e12-resilience-capacity.md) |

Default lease **30s** (min 1s, max 5m). Unset `JOB_BINDING_SECRET` is an
ephemeral process key — tickets die on API restart. Production must set
a durable secret (see [deployment](../deployment.md)).

## Restore rehearsal

A successful backup job is **not** recovery evidence. Restore into an
isolated environment, confirm schema, then verify health/readiness (and
an application smoke test in production).

| Rehearsal | Script | What it proves | CI |
| --- | --- | --- | --- |
| Encrypted compose dump + hardened API boot | `scripts/backup/restore-rehearsal.sh` | Decrypt → throwaway Postgres → `schema_migrations` → API `/health` + `/readiness` | `supply-chain.yml` job `restore-rehearsal` |
| Schema-level isolated restore (no compose API) | `scripts/backup/restore-schema-rehearsal.sh` | Encrypted `pg_dump` of `TEST_DATABASE_URL`, restore into a throwaway database, version match, `execution_jobs` present | E12.2 `e12-resilience.yml` |
| Encrypted dump only | `scripts/backup/encrypt-pg-dump.sh` | AES-256-CBC + PBKDF2 ciphertext on disk | used by the compose rehearsal |

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
| `correlation_id` | Executions, audit events, operational alerts | Tie a run / decision across API and workers. |
| Structured logs | API stdout JSON | `method`, `path`, `route`, `status`, `duration`, `bytes`, `request_id`. Secret-free. |
| `GET /api/v1/metrics` | Prometheus text | Request count/duration by method/route/status. `platform.administer` only. |
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

## Chloe map

| Surface | This PR | Chloe / E12.3 |
| --- | --- | --- |
| Health/readiness, recover, restore scripts | This runbook | No new chrome |
| `/alerts` queue and ack | API contract already in the backend map | **Operator UI guide — Chloe / E12.3** |
| Execution `indeterminate` badge | Existing E5/E12.1 contract | **Operator UI guide — Chloe / E12.3** |
| Accessibility of alert/execution screens | Out of scope | **Accessibility review — Chloe / E12.3** |
