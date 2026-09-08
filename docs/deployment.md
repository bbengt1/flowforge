# Deployment and local development

## Local startup

1. Copy `env-template.txt` to `.env` and replace the local PostgreSQL password.
2. Run `docker compose up --build`.
3. Verify `GET http://localhost:8080/api/v1/health` returns `200`, then `GET http://localhost:8080/api/v1/readiness` returns `200` after migrations finish.
4. Open `http://localhost:3000`.

Migrations are forward-only and recorded in `schema_migrations`; re-running the migration service is safe.

The compose `api` service runs as UID/GID **65532** with a read-only root filesystem, `cap_drop: ALL`, `no-new-privileges`, a `/tmp` tmpfs, and CPU/memory/PID limits. The web image should use the same UID; web compose/header work is owned separately.

## Deployment controls

Production images must be digest-pinned, built from approved provenance, vulnerability-scanned, and run non-root with read-only filesystems, dropped capabilities, `no_new_privs`, resource limits, TLS at the ingress/proxy boundary, and default-deny network policy.

Foundation files:

| Area | Location |
| --- | --- |
| Kubernetes (Deployment, Service, default-deny + API/Postgres NetworkPolicy, TLS Ingress) | [`deploy/k8s/`](../deploy/k8s/) |
| TLS/proxy (Ingress + local Caddy terminator; API `REQUIRE_TLS` / `TRUSTED_PROXY_CIDRS` / `TLS_*`) | [`deploy/tls/`](../deploy/tls/), [`apps/api/README.md`](../apps/api/README.md) |
| Supply-chain policy (approved bases, vuln gates, provenance) | [`deploy/supply-chain/policy.md`](../deploy/supply-chain/policy.md) |
| CI gates | [`.github/workflows/supply-chain.yml`](../.github/workflows/supply-chain.yml) |

The Kubernetes files are a foundation only: configure the database egress policy, TLS ingress host/secret (or cert-manager), backup encryption key wrapping, KMS references, and environment-specific registry credentials before deployment.

API TLS/proxy environment (local defaults are HTTP; production ConfigMap requires TLS):

| Variable | Default | Purpose |
| --- | --- | --- |
| `TRUSTED_PROXY_CIDRS` | empty | Comma-separated CIDRs allowed to set `X-Forwarded-Proto`. Empty ignores forwarded headers. |
| `REQUIRE_TLS` | `false` | Reject requests that are not HTTPS (direct TLS or a trusted proxy). |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | empty | Optional process-level TLS. Both must be set or neither. |

## Recovery

Backups must be encrypted and restoration rehearsed before production enablement. Restore into an isolated environment, run migrations, then verify health/readiness and an application smoke test. Do not treat a successful backup job as recovery evidence.

Hooks (AES-256-CBC + PBKDF2 via `BACKUP_ENCRYPTION_KEY`; wrap that key with KMS before production):

```bash
export POSTGRES_PASSWORD=...
export BACKUP_ENCRYPTION_KEY=...
# compose postgres + api already up
bash scripts/backup/encrypt-pg-dump.sh
bash scripts/backup/restore-rehearsal.sh
```

`restore-rehearsal.sh` writes an encrypted dump, restores it into a throwaway Postgres container, checks `schema_migrations`, then boots the hardened API image against the restored database and asserts `/api/v1/health` and `/api/v1/readiness`. CI runs the same script.
