# Retention and backup operations

Relates to #184 / Part of #181. **Keep #184 open.**

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

Legal hold: `POST /api/v1/artifacts/{artifactId}/legal-hold`
`{hold, reason}` (`workspace.administer`). Reason is required to place.
Audit `artifact.legal_hold.*`.

Artifact payloads use the same envelope encryption as the vault
(`CREDENTIAL_KEK`). `storage_ref` is an opaque server locator and is
never returned. Local MVP objects live under `ARTIFACT_STORE_DIR`
(compose/k8s: `/tmp/flowforge-artifacts` on tmpfs). Empty store dir =
in-process memory (lost on restart) — not a backup.

## Backup encryption

Hooks from E1.3 (`scripts/backup/`). Cipher is **AES-256-CBC** with
**PBKDF2** via OpenSSL, passphrase in `BACKUP_ENCRYPTION_KEY`. Scripts
never print that key, `DATABASE_URL`, or `POSTGRES_PASSWORD`.

```bash
export POSTGRES_PASSWORD=...
export BACKUP_ENCRYPTION_KEY=...   # passphrase; wrap with KMS before production
bash scripts/backup/encrypt-pg-dump.sh
# default outfile: flowforge-YYYYmmddTHHMMSSZ.sql.enc
```

`pg_dump` uses `--no-owner --no-acl`. After restore the API recreates
`flowforge_app` and GRANTs on connect (see
[database — Isolation model](../reference/database.md#isolation-model)).

**Production:** wrap `BACKUP_ENCRYPTION_KEY` with KMS (or equivalent).
Do not store the raw passphrase next to the ciphertext. The Kubernetes
foundation does not ship a CronJob — schedule the encrypt script (or
your platform dump) against the production DSN and keep ciphertext off
the API disk.

A successful dump is not recovery evidence and is not supply-chain
provenance ([supply-chain policy](../../deploy/supply-chain/policy.md)).

## Restore rehearsal cadence

| Cadence | What runs | Gate |
| --- | --- | --- |
| Every PR and `main` push | `supply-chain.yml` `restore-rehearsal` → `scripts/backup/restore-rehearsal.sh` | Encrypted compose dump, isolated Postgres, hardened API `/health` + `/readiness` |
| Every PR and `main` push | E12.2 `e12-resilience.yml` → `scripts/backup/restore-schema-rehearsal.sh` | Isolated schema restore + `execution_jobs` present |
| Before production enablement | Both rehearsals in an environment that matches production pinning / TLS / secrets | Required by the [security model](../reference/security-model.md) operational controls and E12 epic acceptance |
| After schema migrations land | Re-run both scripts; commit updated E12.2 last-run JSON when the resilience suite changes | Do not hand-edit pass/fail flags |

```bash
# Compose + hardened API (needs postgres + api up and /readiness 200)
export POSTGRES_PASSWORD=...
export BACKUP_ENCRYPTION_KEY=...
bash scripts/backup/restore-rehearsal.sh

# Schema-only (needs pg_dump/psql + migrated TEST_DATABASE_URL)
TEST_DATABASE_URL='postgres://flowforge:…@127.0.0.1:5432/flowforge?sslmode=disable' \
  bash scripts/backup/restore-schema-rehearsal.sh
```

The compose rehearsal boots an isolated API **production-locked** (no
`APP_ENV`), so it mounts the local-only PKCS#8 PEM
(`deploy/local/embed-signing.pem`). Do not copy that key to Kubernetes.
Production still boot-fails without a unique Secret
`EMBED_SIGNING_KEY` (ADV-006 / ADV-022).

Last-run pointers:

- [e12-resilience-evidence/restore-schema-last-run.json](../reference/e12-resilience-evidence/restore-schema-last-run.json)
- [e12-resilience-evidence/last-run.json](../reference/e12-resilience-evidence/last-run.json)
- CI artifact `e12-resilience-suite`; sibling job name
  `restore-rehearsal` on `supply-chain.yml`

Incident steps after a real restore:
[incident and recovery](incident-recovery.md#restore-rehearsal).

## Operator checklist (existing controls only)

1. `BACKUP_ENCRYPTION_KEY` is set and KMS-wrapped in production.
2. `CREDENTIAL_KEK` is set (vault + artifact envelopes). Lost KEK =
   undecryptable credentials/artifacts after restore.
3. `JOB_BINDING_SECRET` and `SCRIPT_SIGNING_KEY` are durable in
   production (ephemeral keys die on restart; they are not in the dump).
4. Restore rehearsal is green on `main` (both CI jobs).
5. Retention purge is exercised in a non-prod workspace (`POST /retention/purge`)
   and legal hold is verified to skip deletion.
6. Audit rows older than 365 days leave only via
   `app.purge_expired_audit_events`.

## Chloe map

| Surface | This PR | Chloe / E12.3 |
| --- | --- | --- |
| Backup scripts, encryption, cadence | This page | **No UI** |
| `POST /retention/purge`, legal hold API | Linked from the backend map | **Operator UI guide — Chloe / E12.3** |
| Legal-hold badge / denied download copy | Out of scope (optional E12.1 Chloe row) | **Operator UI guide — Chloe / E12.3** |
| Accessibility of hold/purge dialogs | Out of scope | **Accessibility review — Chloe / E12.3** |
