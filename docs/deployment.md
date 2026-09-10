# Deployment and local development

## Local startup

1. Copy `env-template.txt` to `.env` and replace the local PostgreSQL password.
2. Run `docker compose up --build`.
3. Verify `GET http://localhost:8080/api/v1/health` returns `200`, then `GET http://localhost:8080/api/v1/readiness` returns `200` after migrations finish.
4. Open `http://localhost:3000`. The UI response includes `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, and `X-Frame-Options: DENY` (CSP `frame-ancestors 'none'`). `Strict-Transport-Security` is omitted on this HTTP origin so local HTTP is not pinned to HTTPS. `/membership` is the E2.1 operator for tenant/workspace membership (requires the E2.1 API from PR #17). `/isolation` is the E2.2 negative isolation exercise (requires the E2.2 API from PR #19). Local compose sets `APP_ENV=development`, `TRUSTED_DEV_IDENTITY_HEADERS=1`, and a sample `PLATFORM_ADMINS` so the membership bootstrap still works; do not copy those into production.

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
| Workspace runner SA / Role / RoleBinding templates (E7.1 cluster targets) | [`deploy/kubernetes/`](../deploy/kubernetes/) |
| TLS/proxy (Ingress + local Caddy terminator; API `REQUIRE_TLS` / `TRUSTED_PROXY_CIDRS` / `TLS_*`) | [`deploy/tls/`](../deploy/tls/), [`apps/api/README.md`](../apps/api/README.md) |
| Supply-chain policy (approved bases, vuln gates, provenance) | [`deploy/supply-chain/policy.md`](../deploy/supply-chain/policy.md) |
| CI gates | [`.github/workflows/supply-chain.yml`](../.github/workflows/supply-chain.yml) |
| Encrypted backup + restore rehearsal | [`scripts/backup/`](../scripts/backup/) |

The Kubernetes files are a foundation only: configure the database egress policy, TLS ingress host/secret (or cert-manager), backup encryption key wrapping, KMS references, and environment-specific registry credentials before deployment. TLS terminates at the ingress/proxy boundary, not inside the Next.js container.

Web image and Next.js headers (`#11`):

- `apps/web/Dockerfile`: `USER 65532:65532` (same UID as `apps/api`), digest-pinned `node:22-alpine`, writable paths limited to `/tmp` and `/app/.next/cache`.
- Next.js secure headers via `apps/web/next.config.ts` and `apps/web/src/proxy.ts`. CSP uses a per-request nonce (`script-src 'nonce-…' 'strict-dynamic'`) so App Router inline bootstrap/RSC scripts hydrate. HSTS is emitted only when the request is HTTPS, `X-Forwarded-Proto: https`, or `WEB_HSTS=1`. CSP `frame-ancestors 'none'` / `X-Frame-Options: DENY` is the standalone default; `/embed/v1` relaxes `frame-ancestors` only when the shared host allowlist (`WEB_EMBED_FRAME_ANCESTORS` ∪ `WEB_PORTAL_FRAME_ANCESTORS` ∪ `PORTAL_FRAME_ANCESTORS`) lists exact host origins. That same list is published on `GET /embed/catalog` `frameAncestors` and drives postMessage. Empty fails closed. Do not set `WEB_HSTS=1` for `http://localhost:3000`.
- Local Compose still uses a tag for `postgres:16-alpine`. Production must replace that tag (and any unpinned registry references) with a digest. The web image already pins `node:22-alpine` by digest.

API TLS/proxy environment (local defaults are HTTP; production ConfigMap requires TLS):

| Variable | Default | Purpose |
| --- | --- | --- |
| `TRUSTED_PROXY_CIDRS` | empty | Comma-separated CIDRs allowed to set `X-Forwarded-Proto`. Empty ignores forwarded headers. |
| `REQUIRE_TLS` | `false` | Reject requests that are not HTTPS (direct TLS or a trusted proxy). |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | empty | Optional process-level TLS. Both must be set or neither. |
| `CORS_ALLOWED_ORIGINS` | empty | Exact browser origins allowed to make credentialed API calls. Empty fails closed. Wildcard is rejected. |
| `SESSION_IDLE_TIMEOUT` | `30m` | Browser session idle lifetime. |
| `SESSION_ABSOLUTE_TIMEOUT` | `12h` | Browser session absolute lifetime. |
| `CREDENTIAL_KEK` | empty | 32-byte AES-256 credential envelope KEK (base64 or hex). Generate with `openssl rand -base64 32`. Required to create/rotate vault secrets. |
| `CREDENTIAL_KEK_FILE` | empty | Optional KEK file path (same encoding, or raw 32 bytes). |
| `CREDENTIAL_KEK_ID` | `env:CREDENTIAL_KEK` | Key reference stored with ciphertext (not the key). |
| `ARTIFACT_STORE_DIR` | empty | Encrypted artifact payload root. Empty = in-process memory. Read-only containers should use `/tmp/flowforge-artifacts`. |
| `ARTIFACT_DOWNLOAD_TTL` | `60s` | Short-lived download grant lifetime (max 5m). |
| `ARTIFACT_MAX_BYTES` | `1048576` | File artifact upload cap. |
| `WEB_HSTS` | unset | Force Next.js HSTS when a TLS terminator does not forward proto. Leave unset for local HTTP. |
| `WEB_CSP_CONNECT_SRC` | unset | Extra CSP `connect-src` origins (space-separated). `NEXT_PUBLIC_API_URL` is always included. |
| `EMBED_SIGNING_KEY` | **required in production** (boot-fail) | Durable Ed25519 seed/key (base64, hex, or PKCS8 PEM) used to mint embed assertions. Empty/`production` `APP_ENV` or `REQUIRE_TLS` refuses to start without it. Compose seeds a local-only key. Ephemeral process keys are non-production only and come from `crypto/rand` — never a committed Go seed. |
| `EMBED_SIGNING_KEY_FILE` | empty | File form of `EMBED_SIGNING_KEY`. |
| `EMBED_SIGNING_KEY_ID` | `env:EMBED_SIGNING_KEY` | Public `kid`. Never a secret. Never `ephemeral:process` in production. |
| `EMBED_AUDIENCE` | `flowforge` | Must stay `flowforge`. |
| `EMBED_ASSERTION_TTL` | `60s` | Default mint TTL (15s–5m). |
| `EMBED_NBF_LEEWAY` | `30s` | Clock-skew for embed assertion `nbf` only (ADV-017). Hard max `60s` (clamped). `exp` is exact. |
| `EMBED_OVERLAP_KEYS` | empty | JSON JWKS / array of previous public keys for the embed overlap window. Each key requires `overlapUntil` (RFC3339, max 4h from boot). Missing, zero, or far-future is a boot-fail. The active `EMBED_SIGNING_KEY` is not an overlap key and does not use `overlapUntil`. |
| `PLATFORM_ADMINS` / `PLATFORM_ADMIN` | empty | Comma-separated `issuer\|subject` pairs that may `POST /tenants`, `POST /workspaces`, `POST /embed/keys/rotate`, and mint an assertion for another subject (`embed.impersonate`). Empty is fail-closed (`403`). |
| `APP_ENV` / `FLOWFORGE_ENV` | empty (production) | Process environment. Empty, `production`, and unknown values are production-locked. Trusted-dev identity requires `development`, `dev`, `local`, or `test`. |
| `TRUSTED_DEV_IDENTITY_HEADERS` | unset / false | **Local/dev only.** When `1`/`true`/`yes`/`on` **and** `APP_ENV` is an explicit non-production value **and** `REQUIRE_TLS` is false, the API accepts self-asserted `X-FlowForge-Issuer` / `X-FlowForge-Subject` and `POST /session` principal upsert. Empty/missing config denies that path. The process **refuses to start** if the flag is set in production or with `REQUIRE_TLS=true`, so it cannot stay on accidentally. Production identity is the cookie session from `POST /embed/exchange`. Compose local defaults enable this; `deploy/k8s` must not set the flag. |
| `EMBED_ISSUER` / `EMBED_ISSUER_ALLOWLIST` | empty | Required allowed assertion `iss` for embed mint. Empty fails closed (`403` on mint; exchange also `403` when Portal is empty). Compose seeds `https://idp.example`. Production ConfigMap must set an explicit list. |
| `EMBED_EXCHANGE_RATE_LIMIT_IP` | `120` | Max `POST /embed/exchange` per client IP per window. Raise if a Portal shared egress IP remounts many iframes. Negative is unlimited. |
| `EMBED_EXCHANGE_RATE_LIMIT_PRINCIPAL` | `30` | Max exchange per peekable `iss\|sub` per window. |
| `EMBED_MINT_RATE_LIMIT_PRINCIPAL` | `60` | Max mint per authenticated principal per window (`/embed/assertions` and Portal adapter mint). |
| `EMBED_RATE_LIMIT_WINDOW` | `1m` | Window for the embed rate-limit counters. |
| `PORTAL_ISSUER` / `PORTAL_ISSUER_ALLOWLIST` | empty | Required Portal mint `iss` allowlist. Empty fails closed (`403`). Merged into embed exchange. Compose seeds `https://portal.cp-ops.example`. |
| `WEB_EMBED_FRAME_ANCESTORS` | unset | Shared host allowlist (merged with `WEB_PORTAL_FRAME_ANCESTORS` and `PORTAL_FRAME_ANCESTORS`). Exact origins allowed to frame `/embed/v1` and send embed postMessage. Empty keeps `frame-ancestors 'none'` and denies postMessage. `*` / `null` are ignored. Set the same values on the API so the catalog matches. |
| `WEB_PORTAL_FRAME_ANCESTORS` | unset | Same shared list (Portal-origin name). |
| `PORTAL_FRAME_ANCESTORS` | unset | Same shared list (API catalog name). |

ADV-013 two-origin Portal→embed rehearsal (Portal host ≠ embed, local HTTPS):
`docs/reference/portal-adapter.md` and `bash scripts/adv013-cross-origin.sh`.

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

`restore-rehearsal.sh` writes an encrypted dump, restores it into a throwaway Postgres container, checks `schema_migrations`, then boots the hardened API image against the restored database and asserts `/api/v1/health` and `/api/v1/readiness`. The isolated API is production-locked (no `APP_ENV`), so the script sets a local-only `EMBED_SIGNING_KEY` (same seed as compose; override via env). CI runs the same script. Production still boot-fails without a unique Secret key.
