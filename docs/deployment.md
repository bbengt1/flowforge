# Deployment and local development

## Local startup

1. Copy `env-template.txt` to `.env` and replace the local PostgreSQL password.
2. Run `docker compose up --build`.
3. Verify `GET http://localhost:8080/api/v1/health` returns `200`, then `GET http://localhost:8080/api/v1/readiness` returns `200` after migrations finish.
4. Open `http://localhost:3000`. The UI response includes `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, and `X-Frame-Options: DENY` (CSP `frame-ancestors 'none'`). `Strict-Transport-Security` is omitted on this HTTP origin so local HTTP is not pinned to HTTPS.

Migrations are forward-only and recorded in `schema_migrations`; re-running the migration service is safe.

Compose hardening (both services, UID/GID **65532**):

- **api** (`#10`): read-only root filesystem, `cap_drop: ALL`, `no-new-privileges`, `/tmp` tmpfs, and CPU/memory/PID limits. Matches `deploy/k8s`.
- **web** (`#11`): the same least-privilege defaults via the `x-security` YAML anchor, plus tmpfs on `/tmp` and `/app/.next/cache`, and `mem_limit` / `cpus` / `pids_limit` (same compose-native limits as `api`; do not also set `deploy.resources`, which conflicts with `pids_limit`).
- **postgres**: `no-new-privileges` only. The official image starts as root then drops; `cap_drop: ALL` would break that.

## Deployment controls

Production images must be digest-pinned, built from approved provenance, vulnerability-scanned, and run non-root with read-only filesystems, dropped capabilities, `no_new_privs`, resource limits, TLS at the ingress/proxy boundary, and default-deny network policy.

Foundation files (API / supply-chain / backup from `#10`):

| Area | Location |
| --- | --- |
| Kubernetes (Deployment, Service, default-deny + API/Postgres NetworkPolicy, TLS Ingress) | [`deploy/k8s/`](../deploy/k8s/) |
| TLS/proxy (Ingress + local Caddy terminator; API `REQUIRE_TLS` / `TRUSTED_PROXY_CIDRS` / `TLS_*`) | [`deploy/tls/`](../deploy/tls/), [`apps/api/README.md`](../apps/api/README.md) |
| Supply-chain policy (approved bases, vuln gates, provenance) | [`deploy/supply-chain/policy.md`](../deploy/supply-chain/policy.md) |
| CI gates | [`.github/workflows/supply-chain.yml`](../.github/workflows/supply-chain.yml) |
| Encrypted backup + restore rehearsal | [`scripts/backup/`](../scripts/backup/) |

The Kubernetes files are a foundation only: configure the database egress policy, TLS ingress host/secret (or cert-manager), backup encryption key wrapping, KMS references, and environment-specific registry credentials before deployment. TLS terminates at the ingress/proxy boundary, not inside the Next.js container.

Web image and Next.js headers (`#11`):

- `apps/web/Dockerfile`: `USER 65532:65532` (same UID as `apps/api`), digest-pinned `node:22-alpine`, writable paths limited to `/tmp` and `/app/.next/cache`.
- Next.js secure headers via `apps/web/next.config.ts` and `apps/web/src/proxy.ts`. CSP uses a per-request nonce (`script-src 'nonce-…' 'strict-dynamic'`) so App Router inline bootstrap/RSC scripts hydrate. HSTS is emitted only when the request is HTTPS, `X-Forwarded-Proto: https`, or `WEB_HSTS=1`. CSP `frame-ancestors 'none'` / `X-Frame-Options: DENY` is the standalone default; E11 embed will relax `frame-ancestors` to allowlisted hosts. Do not set `WEB_HSTS=1` for `http://localhost:3000`.
- Local Compose still uses a tag for `postgres:16-alpine`. Production must replace that tag (and any unpinned registry references) with a digest. The web image already pins `node:22-alpine` by digest.

API TLS/proxy environment (local defaults are HTTP; production ConfigMap requires TLS):

| Variable | Default | Purpose |
| --- | --- | --- |
| `TRUSTED_PROXY_CIDRS` | empty | Comma-separated CIDRs allowed to set `X-Forwarded-Proto`. Empty ignores forwarded headers. |
| `REQUIRE_TLS` | `false` | Reject requests that are not HTTPS (direct TLS or a trusted proxy). |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | empty | Optional process-level TLS. Both must be set or neither. |
| `WEB_HSTS` | unset | Force Next.js HSTS when a TLS terminator does not forward proto. Leave unset for local HTTP. |
| `WEB_CSP_CONNECT_SRC` | unset | Extra CSP `connect-src` origins (space-separated). `NEXT_PUBLIC_API_URL` is always included. |

## Recovery

Backups must be encrypted and restoration rehearsed before production enablement. Restore into an isolated environment, run migrations, then verify health/readiness and an application smoke test. Do not treat a successful backup job as recovery evidence.

Hooks from `#10` (AES-256-CBC + PBKDF2 via `BACKUP_ENCRYPTION_KEY`; wrap that key with KMS before production):

```bash
export POSTGRES_PASSWORD=...
export BACKUP_ENCRYPTION_KEY=...
# compose postgres + api already up
bash scripts/backup/encrypt-pg-dump.sh
bash scripts/backup/restore-rehearsal.sh
```

`restore-rehearsal.sh` writes an encrypted dump, restores it into a throwaway Postgres container, checks `schema_migrations`, then boots the hardened API image against the restored database and asserts `/api/v1/health` and `/api/v1/readiness`. CI runs the same script.
