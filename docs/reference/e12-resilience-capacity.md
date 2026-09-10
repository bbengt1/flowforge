# E12.2 operational resilience and capacity

Relates to #183 / Part of #181. **Keep #183 open.** This document is the
control map, how each rehearsal is run, and the ≥2× headroom claims.
**Chloe: no product UI** — headroom and queue lag stay harness + docs.

Harness: `scripts/e12-resilience-suite.sh` (catalog
`scripts/e12-resilience-suite.json`). CI job:
`.github/workflows/e12-resilience.yml` (`Resilience and capacity suite`).
Last-run pointer:
[e12-resilience-evidence/last-run.json](e12-resilience-evidence/last-run.json).

The suite **fails closed**. A skipped Postgres path, a missing capacity
JSON, or any headroom ratio below 2× fails the PR/main job. It does not
skip or weaken the E12.1 security suite
([e12-security-verification.md](e12-security-verification.md)) or ADV
hardenings.

## How to run

```bash
# CI-sized bound (default). Requires Postgres + pg_dump/psql.
TEST_DATABASE_URL='postgres://flowforge:…@127.0.0.1:5432/flowforge?sslmode=disable' \
  bash scripts/e12-resilience-suite.sh

# Fuller local load (more jobs / higher write-budget planning number)
E12_LOAD_MODE=full TEST_DATABASE_URL='…' bash scripts/e12-resilience-suite.sh
```

CI starts Postgres 16, installs `postgresql-client`, and sets
`E12_LOAD_MODE=ci`. Heavy saturation stays local; CI still measures real
peaks and asserts 2× headroom against the production pool limit, a
documented write budget (capped by a measured insert ceiling), a queue-lag
SLO, and a 1 GiB storage-growth budget.

## Rehearsals and how they are tested

| # | Domain | Primary proof | What runs |
| --- | --- | --- | --- |
| 1 | Backup / restore | Script + sibling CI | `scripts/backup/restore-schema-rehearsal.sh` — encrypted `pg_dump` of the migrated test database, restore into a throwaway database, `schema_migrations` version match, `execution_jobs` present. **Sibling (required on the same PR):** `supply-chain.yml` `restore-rehearsal` (`scripts/backup/restore-rehearsal.sh`) — encrypted compose dump, isolated Postgres, hardened API `/health` + `/readiness`. |
| 2 | Worker-loss / lease / fencing | Go | `internal/e12resilience` `TestE12CapacityHeadroomAndWorkerLoss` (expire lease → `indeterminate`, stale complete rejected); `wfstore` `TestPostgresDispatchSkipLockedAndLeaseLoss`, `TestMemoryDispatchLeaseFenceCancelRetry`; `httpapi` `TestDispatchClaimFenceCancelAndLeaseLoss`. |
| 3 | Queue lag under load | Go + JSON | Same capacity test enqueues a bounded job burst, drains with two slow workers, and records peak queued age and depth. |
| 4 | Migration serialization | Go | `internal/postgres` `TestMigrateSerializesConcurrentRunners` (advisory lock `881726401`) plus migration name/load checks. Re-running migrate is a no-op for applied versions. |
| 5 | Bounded load + 2× headroom | Go + JSON | Capacity test writes [capacity-last-run.json](e12-resilience-evidence/capacity-last-run.json). Gate: each required ratio ≥ 2.0. |

## Headroom claims (required ≥2×)

Ratios are `capacity / observed_peak`. Capacities are the production API
pool (`DefaultMaxConns=8` in `internal/postgres`), a conservative write
budget (200/s CI, 500/s full) **capped by** a measured `INSERT` ceiling,
a queue-lag SLO (15s CI, 30s full), a queue-depth budget (64 CI, 256 full),
and a 1 GiB storage-growth budget for the rehearsal window.

| Metric | Capacity | Observed peak (see last-run) | Claim |
| --- | --- | --- | --- |
| Database connections | Pool `MaxConns=8` (Postgres `max_connections` also recorded) | `peaks.dbConnections` | Pool ≥ 2× peak backends used by `application_name=e12-resilience` |
| Database writes | `min(budget, measuredWriteCeilingPerSec)` | `peaks.dbWritesPerSec` | Write capacity ≥ 2× peak inserts+updates/s |
| Queue lag | SLO seconds | `peaks.queueLagSeconds` | SLO ≥ 2× oldest queued job age |
| Storage growth | 1 GiB budget | `peaks.storageGrowthBytes` | Budget ≥ 2× `pg_database_size` delta |

Do not hand-edit pass/fail flags. Re-run the harness and commit the
updated JSON when the load shape or pool limit changes.

## Last-run pointer

- Suite summary: [e12-resilience-evidence/last-run.json](e12-resilience-evidence/last-run.json)
- Capacity peaks/ratios: [e12-resilience-evidence/capacity-last-run.json](e12-resilience-evidence/capacity-last-run.json)
- Schema restore: [e12-resilience-evidence/restore-schema-last-run.json](e12-resilience-evidence/restore-schema-last-run.json)
- CI artifact name: `e12-resilience-suite`

## Chloe map

Prefer docs + harness. Do **not** add operator chrome for connection
headroom, queue lag, or storage growth on this story.

| Surface | Needed? | Notes |
| --- | --- | --- |
| Headroom / lag dashboard | **No UI** | Operators read this document and last-run JSON. Prometheus metrics stay `platform.administer` (ADV-020) — no new scrape or screen. |
| Restore / worker-loss | **No UI** | Existing execution `indeterminate` + retry contract is enough. E12.1 already covers stale-session / approval chrome. |
| Migration lock | **No UI** | API boot / `cmd/migrate` only. |

Keep #183 open after this PR.

## Ownership

- **jonny:** harness, restore/worker/load evidence, CI gate, this map.
- **Chloe:** no UI on this story unless a later ops surface is explicitly
  requested. Do not close #183 on a UI PR alone.
