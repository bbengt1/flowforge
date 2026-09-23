# Retention and backup operations

Relates to #184 / Part of #181. **Keep #184 open.** G.1.4 / #435
ships the Kubernetes CronJob and RPO/RTO rehearsal.

How backups are encrypted, how restore is rehearsed, and how retention
purge / legal hold work. Schema and invariants stay in the
[database specification](../reference/database.md). Security
requirements stay in the [security model](../reference/security-model.md)
(Secret, artifact, and output handling). Capacity proof stays in
[E12.2](../reference/e12-resilience-capacity.md).

**Operator UI guide — Chloe / E12.3** for legal-hold badges and purge
confirmation screens. This page is API + scripts only.

## What is retained

| Data | Default retention | Purge path | Notes |
| --- | --- | --- | --- |
| Executions / steps / jobs | `retention_until` **90 days** | `POST /api/v1/retention/purge` | Unique idempotency stays on `(workspace_id, workflow_version_id, idempotency_key)` while the row lives. |
| Audit events | **365 days** | Same purge → `app.purge_expired_audit_events` | Monthly `RANGE (occurred_at)` partitions. `flowforge_app` cannot UPDATE or DELETE live rows. |
| Execution artifacts | `expires_at` defaults to the execution `retentionUntil` | Same purge deletes **metadata and** the encrypted object payload | Legal hold skips purge. Download of expired-without-hold is `404`. |
| Artifact download grants | `ARTIFACT_DOWNLOAD_TTL` default **60s** (max 5m) | Deleted with the artifact; expired grants 404 | Re-authz on every grant and stream. |
| Embed `jti` rows | JWT `exp` + **24h** (`retain_until`) | `PurgeExpired` deletes only `WHERE retain_until <= now` | Replay of a used `jti` stays `409` during the retain window (ADV-009). |
| Webhook replay ids | ≥ clock-skew window | Table `webhook_replays.expires_at` | Not the execution retention job. |

`POST /api/v1/retention/purge` requires `workspace.administer` and CSRF
on a cookie session. Response `{purged,held,executions,audits}`. Holds
are counted, not deleted. Audit: `artifact.retention.held` when a hold
blocks purge.

The API leader scheduler calls that same purge on `SCHEDULER_INTERVAL`
(default 30s) for every active workspace. Only the replica holding
advisory lock `881726402` ticks. Set `SCHEDULER_ENABLED=0` to opt out.
That loop does not take a backup.

Legal hold: `POST /api/v1/artifacts/{artifactId}/legal-hold`
`{hold, reason}` (`workspace.administer`). Reason is required to place.
Audit `artifact.legal_hold.*`.

Artifact payloads use the same envelope encryption as the vault
(`CREDENTIAL_KEK`). `storage_ref` is an opaque server locator and is
never returned. Ciphertext is stored in an S3-compatible bucket
(`ARTIFACT_S3_*`) at `{tenant}/{workspace}/{ref}`. Compose runs MinIO
with a data volume so an API restart keeps the objects. A
production-locked process refuses filesystem and in-process stores
and does not fall back to a directory when the bucket or credentials
are missing. Those remain non-production fallbacks
(`ARTIFACT_STORE_DIR`, or memory when that is also empty) and are not
a backup. `ARTIFACT_S3_PREFIX` is rejected. Object-store credentials
and the bucket name are never returned and are not written to logs.
A draft execution cannot attach a run artifact.

## RPO and RTO

| Target | Value | How it is met |
| --- | --- | --- |
| **RPO** | **24 hours** | `deploy/k8s/backup-cronjob.yaml` schedule `0 2 * * *` (UTC). Maximum acceptable Postgres data loss is one successful CronJob interval. Tighten the schedule only with a matching load test. |
| **RTO** | **≤ 30 minutes** (CI-sized) | Wall-clock for encrypted DSN dump → decrypt → isolated restore → `schema_migrations` + `execution_jobs` check. Gate: `scripts/backup/rpo-rto-rehearsal.sh` (`BACKUP_RTO_BUDGET_SECONDS`, default `1800`). Production-sized dumps need a measured budget in the same runbook before go-live. |

A successful CronJob is **not** recovery evidence. RTO proof is the
rehearsal (CI + pre-prod), not the backup Job status.

Point-in-time recovery (WAL archiving) is out of scope for G.1.4.

## Backup encryption

Hooks from E1.3 / G.1.4 (`scripts/backup/`). Cipher is **AES-256-GCM**
(AEAD) with **PBKDF2-HMAC-SHA256** (default **600 000** iterations) via
`scripts/backup/aead.py` (format **FFB1**). Passphrase in
`BACKUP_ENCRYPTION_KEY`. Scripts never print that key, `DATABASE_URL`,
`POSTGRES_PASSWORD`, or object-store credentials. The whole dump is
sealed — vault rows in Postgres are already envelope-encrypted with
`CREDENTIAL_KEK`, and the backup blob itself carries no plaintext
secrets. Tampered ciphertext fails authentication on open.

| Path | Script | When |
| --- | --- | --- |
| Compose (local) | `scripts/backup/encrypt-pg-dump.sh` | `docker compose exec` into the postgres service |
| DSN / Kubernetes | `scripts/backup/run-encrypted-backup.sh` | CronJob image `flowforge-backup`; CI RPO/RTO rehearsal |

```bash
# Compose
export POSTGRES_PASSWORD=...
export BACKUP_ENCRYPTION_KEY=...   # passphrase; wrap with KMS before production
bash scripts/backup/encrypt-pg-dump.sh
# default outfile: flowforge-YYYYmmddTHHMMSSZ.sql.enc

# DSN (same cipher; used by the CronJob)
export DATABASE_URL='postgres://…'
export BACKUP_ENCRYPTION_KEY=...
export BACKUP_S3_BUCKET=...        # required when BACKUP_REQUIRE_S3=1
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
bash scripts/backup/run-encrypted-backup.sh
```

`pg_dump` uses `--no-owner --no-acl`. After restore the API recreates
`flowforge_app` and GRANTs on connect (see
[database — Isolation model](../reference/database.md#isolation-model)).
FORCE RLS stays on; the dump role is not `flowforge_app`. Drafts never
run — backups do not start executions.

**Production:** wrap `BACKUP_ENCRYPTION_KEY` with KMS (or equivalent).
Do not store the raw passphrase next to the ciphertext. Retention purge
is the in-process leader scheduler, not a CronJob. Encrypted backups are
the `flowforge-db-backup` CronJob in `deploy/k8s` (image
`ghcr.io/bbengt1/flowforge-backup`, built from
`scripts/backup/Dockerfile`). Apply the example Secret
`backup-secret.example.yaml`, digest-pin the image, and open allowlisted
object-store egress on `flowforge-backup` (and Postgres ingress already
allows the `backup` component). Ciphertext lands in `BACKUP_S3_BUCKET`
under `flowforge-db/` — **not** the `ARTIFACT_S3_*`
`{tenant}/{workspace}/{ref}` layout.

A successful dump is not recovery evidence and is not supply-chain
provenance ([supply-chain policy](../../deploy/supply-chain/policy.md)).

## Restore rehearsal cadence

| Cadence | What runs | Gate |
| --- | --- | --- |
| Every PR and `main` push | `supply-chain.yml` `restore-rehearsal` → `scripts/backup/restore-rehearsal.sh` | Encrypted compose dump, isolated Postgres, hardened API `/health` + `/readiness` |
| Every PR and `main` push | E12.2 `e12-resilience.yml` → `scripts/backup/restore-schema-rehearsal.sh` | Isolated schema restore + `execution_jobs` present |
| Every PR and `main` push | E12.2 → `scripts/backup/rpo-rto-rehearsal.sh` | DSN path used by the CronJob; records RPO hours + RTO seconds; fails if RTO budget exceeded |
| Before production enablement | All rehearsals in an environment that matches production pinning / TLS / secrets | Required by the [security model](../reference/security-model.md) operational controls and E12 epic acceptance |
| After schema migrations land | Re-run the rehearsals; commit updated E12.2 last-run JSON when the resilience suite changes | Do not hand-edit pass/fail flags |

```bash
# Compose + hardened API (needs postgres + api up and /readiness 200)
export POSTGRES_PASSWORD=...
export BACKUP_ENCRYPTION_KEY=...
bash scripts/backup/restore-rehearsal.sh

# Schema-only (needs pg_dump/psql + migrated TEST_DATABASE_URL)
TEST_DATABASE_URL='postgres://flowforge:…@127.0.0.1:5432/flowforge?sslmode=disable' \
  bash scripts/backup/restore-schema-rehearsal.sh

# RPO/RTO (same DSN path as the CronJob)
TEST_DATABASE_URL='postgres://flowforge:…@127.0.0.1:5432/flowforge?sslmode=disable' \
  bash scripts/backup/rpo-rto-rehearsal.sh
```

The compose rehearsal boots an isolated API **production-locked** (no
`APP_ENV`), so it mounts the local-only PKCS#8 PEM
(`deploy/local/embed-signing.pem`) and uses the compose MinIO bucket
(`ARTIFACT_S3_*`, no `ARTIFACT_S3_CREATE_BUCKET`). Do not copy that key
or the MinIO password to Kubernetes. Production still boot-fails
without a unique Secret `EMBED_SIGNING_KEY` (ADV-006 / ADV-022) and
without an S3 bucket and credentials.

Last-run pointers:

- [e12-resilience-evidence/restore-schema-last-run.json](../reference/e12-resilience-evidence/restore-schema-last-run.json)
- [e12-resilience-evidence/rpo-rto-last-run.json](../reference/e12-resilience-evidence/rpo-rto-last-run.json)
- [e12-resilience-evidence/last-run.json](../reference/e12-resilience-evidence/last-run.json)
- CI artifact `e12-resilience-suite`; sibling job name
  `restore-rehearsal` on `supply-chain.yml`

Incident steps after a real restore:
[incident and recovery](incident-recovery.md#restore-rehearsal).

## Operator checklist (existing controls only)

1. `BACKUP_ENCRYPTION_KEY` is set and KMS-wrapped in production
   (`flowforge-backup` Secret).
2. `flowforge-db-backup` CronJob is applied; image is digest-pinned;
   object-store egress is allowlisted.
3. The data KEK is recoverable: production uses `CREDENTIAL_KEK_WRAPPED`
   with `KMS_PROVIDER` ([KEK rotation](kek-rotation.md)). A lost KEK or
   a lost KMS key leaves credentials and artifacts undecryptable.
4. `JOB_BINDING_SECRET` and `SCRIPT_SIGNING_KEY` are set (boot-fail if
   missing or malformed). They are not in the dump; generate unique
   values and do not copy compose defaults.
5. Restore + RPO/RTO rehearsals are green on `main`.
6. Retention purge is exercised in a non-prod workspace (`POST /retention/purge`)
   and legal hold is verified to skip deletion.
7. Audit rows older than 365 days leave only via
   `app.purge_expired_audit_events`.

## Chloe map

| Surface | This PR | Chloe / E12.3 |
| --- | --- | --- |
| Backup scripts, CronJob, RPO/RTO, cadence | This page | **No UI** |
| `POST /retention/purge`, legal hold API | Linked from the backend map | **Operator UI guide — Chloe / E12.3** |
| Legal-hold badge / denied download copy | Out of scope (optional E12.1 Chloe row) | **Operator UI guide — Chloe / E12.3** |
| Accessibility of hold/purge dialogs | Out of scope | **Accessibility review — Chloe / E12.3** |
