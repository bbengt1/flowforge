# Deployment and local development

Release/ops landing: [operations](operations/index.md) (API/OpenAPI,
incident/recovery, retention/backup, threat-model review). This page is
the deploy + configuration inventory. **Operator UI guide — Chloe / E12.3.**
**Accessibility review — Chloe / E12.3.**

## Local startup

1. Copy `env-template.txt` to `.env` and replace the local PostgreSQL password.
2. Run `docker compose up --build`.
3. Verify `GET http://localhost:8080/api/v1/health` returns `200`, then `GET http://localhost:8080/api/v1/readiness` returns `200` after migrations finish.
4. Open `http://localhost:3000`. The UI response includes `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, and `X-Frame-Options: DENY` (CSP `frame-ancestors 'none'`). `Strict-Transport-Security` is omitted on this HTTP origin so local HTTP is not pinned to HTTPS. `/membership` is the E2.1 operator for tenant/workspace membership (requires the E2.1 API from PR #17). `/isolation` is the E2.2 negative isolation exercise (requires the E2.2 API from PR #19). Local compose sets `APP_ENV=development`, `TRUSTED_DEV_IDENTITY_HEADERS=1`, and a sample `PLATFORM_ADMINS` so the membership bootstrap still works; do not copy those into production. After readiness, the API also seeds one local tenant/workbench and demo vault credentials (see [Local default tenant seed](#local-default-tenant-seed)).

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
| `CREDENTIAL_KEK` | empty (compose: documented local-only default) | 32-byte AES-256 credential envelope KEK (base64 or hex). Generate with `openssl rand -base64 32`. Required to create/rotate vault secrets and to seed demo credentials. Compose may default a local-only value (`CREDENTIAL_KEK_ID=local:compose`). Never copy that default to k8s. |
| `CREDENTIAL_KEK_FILE` | empty | Optional KEK file path (same encoding, or raw 32 bytes). |
| `CREDENTIAL_KEK_ID` | `env:CREDENTIAL_KEK` | Key reference stored with ciphertext (not the key). |
| `ARTIFACT_STORE_DIR` | empty | Encrypted artifact payload root. Empty = in-process memory. Read-only containers should use `/tmp/flowforge-artifacts`. |
| `ARTIFACT_DOWNLOAD_TTL` | `60s` | Short-lived download grant lifetime (max 5m). |
| `ARTIFACT_MAX_BYTES` | `1048576` | File artifact upload cap. |
| `WEB_HSTS` | unset | Force Next.js HSTS when a TLS terminator does not forward proto. Leave unset for local HTTP. |
| `WEB_CSP_CONNECT_SRC` | unset | Extra CSP `connect-src` origins (space-separated). `NEXT_PUBLIC_API_URL` is always included. |
| `EMBED_SIGNING_KEY` | **required in production** (boot-fail) | Durable Ed25519 **PKCS#8 PEM** (`crypto/x509.ParsePKCS8PrivateKey`). Generate with `openssl genpkey -algorithm ED25519`. Empty/`production` `APP_ENV` or `REQUIRE_TLS` refuses to start without it. Compose mounts a local-only PKCS#8 file. A raw 32-byte seed / 64-byte key as base64 or hex is accepted only for compatibility. Ephemeral process keys are non-production only and come from `crypto/rand` — never a committed Go seed. |
| `EMBED_SIGNING_KEY_FILE` | empty | File form of `EMBED_SIGNING_KEY` (preferred: PKCS#8 PEM). Used when the env value is empty. |
| `EMBED_SIGNING_KEY_ID` | `env:EMBED_SIGNING_KEY` | Public `kid`. Never a secret. Never `ephemeral:process` in production. |
| `EMBED_AUDIENCE` | `flowforge` | Must stay `flowforge`. |
| `EMBED_ASSERTION_TTL` | `60s` | Default mint TTL (15s–5m). |
| `EMBED_NBF_LEEWAY` | `30s` | Clock-skew for embed assertion `nbf` only (ADV-017). Hard max `60s` (clamped). `exp` is exact. |
| `EMBED_OVERLAP_KEYS` | empty | JSON JWKS / array of previous public keys for the embed overlap window. Each key requires `overlapUntil` (RFC3339, max 4h from boot). Missing, zero, or far-future is a boot-fail. The active `EMBED_SIGNING_KEY` is not an overlap key and does not use `overlapUntil`. |
| `PLATFORM_ADMINS` / `PLATFORM_ADMIN` | empty | Comma-separated `issuer\|subject` pairs that may `POST /tenants`, `POST /workspaces`, `POST /embed/keys/rotate`, read `GET /metrics` / OpenAPI / swagger, and mint an assertion for another subject (`embed.impersonate`). Empty is fail-closed (`403`). |
| `APP_ENV` / `FLOWFORGE_ENV` | empty (production) | Process environment. Empty, `production`, and unknown values are production-locked. Trusted-dev identity and local seed require `development`, `dev`, `local`, or `test`. |
| `TRUSTED_DEV_IDENTITY_HEADERS` | unset / false | **Local/dev only.** When `1`/`true`/`yes`/`on` **and** `APP_ENV` is an explicit non-production value **and** `REQUIRE_TLS` is false, the API accepts self-asserted `X-FlowForge-Issuer` / `X-FlowForge-Subject` and `POST /session` principal upsert. Empty/missing config denies that path. The process **refuses to start** if the flag is set in production or with `REQUIRE_TLS=true`, so it cannot stay on accidentally. Production identity is the cookie session from `POST /embed/exchange`. Compose local defaults enable this; `deploy/k8s` must not set the flag. |
| `SEED_LOCAL_DEFAULTS` | unset (on in local/dev/test) | **Local/dev only.** When `APP_ENV` is `development`/`dev`/`local`/`test` and `REQUIRE_TLS` is false, the API seeds one tenant (`local`), workbench (`default`), attaches `PLATFORM_ADMINS` as workspace admin, and writes demo vault credentials if `CREDENTIAL_KEK` is set. Set `0`/`false`/`off` to opt out. Explicit `1` with production-locked `APP_ENV` or `REQUIRE_TLS=true` is a **boot-fail**. `deploy/k8s` must not set this. |
| `EMBED_ISSUER` / `EMBED_ISSUER_ALLOWLIST` | empty | Required allowed assertion `iss` for embed mint. Empty fails closed (`403` on mint; exchange also `403` when Portal is empty). Compose seeds `https://idp.example`. Production ConfigMap must set an explicit **https** list — `http://`, relative, or opaque issuers are a boot-fail when `APP_ENV` is empty/`production` or `REQUIRE_TLS=true` (ADV-018). Mint/exchange also `403` a non-https `iss`. Local/dev/test may use `http://`. |
| `EMBED_EXCHANGE_RATE_LIMIT_IP` | `120` | Max `POST /embed/exchange` per client IP per window. Raise if a Portal shared egress IP remounts many iframes. Negative is unlimited. |
| `EMBED_EXCHANGE_RATE_LIMIT_PRINCIPAL` | `30` | Max exchange per peekable `iss\|sub` per window. |
| `EMBED_MINT_RATE_LIMIT_PRINCIPAL` | `60` | Max mint per authenticated principal per window (`/embed/assertions` and Portal adapter mint). |
| `EMBED_RATE_LIMIT_WINDOW` | `1m` | Window for the embed rate-limit counters. |
| `PORTAL_ISSUER` / `PORTAL_ISSUER_ALLOWLIST` | empty | Required Portal mint `iss` allowlist. Empty fails closed (`403`). Merged into embed exchange. Compose seeds `https://portal.cp-ops.example`. Production requires every entry to be an absolute `https://` URI (ADV-018; boot-fail). |
| `WEB_EMBED_FRAME_ANCESTORS` | unset | Shared host allowlist (merged with `WEB_PORTAL_FRAME_ANCESTORS` and `PORTAL_FRAME_ANCESTORS`). Exact origins allowed to frame `/embed/v1` and send embed postMessage. Empty keeps `frame-ancestors 'none'` and denies postMessage. `*` / `null` are ignored. Set the same values on the API so the catalog matches. |
| `WEB_PORTAL_FRAME_ANCESTORS` | unset | Same shared list (Portal-origin name). |
| `PORTAL_FRAME_ANCESTORS` | unset | Same shared list (API catalog name). |
| `HTTP_ADDR` / `PORT` | `:8080` | Listen address. `PORT` becomes `:PORT` when `HTTP_ADDR` is unset. |
| `DATABASE_URL` | built from `POSTGRES_*` | Preferred DSN. Compose URL-encodes the password into this. |
| `POSTGRES_HOST` / `USER` / `PASSWORD` / `DB` / `PORT` / `SSLMODE` | see `env-template.txt` | Used only when `DATABASE_URL` is unset. Production ConfigMap sets `POSTGRES_SSLMODE=require`. |
| `SHUTDOWN_TIMEOUT` | `10s` | Graceful HTTP shutdown. |
| `MIGRATE_TIMEOUT` | `5m` | Deadline for applying migrations after PostgreSQL is reachable (separate from the 5s connect/ping). |
| `JOB_BINDING_SECRET` | ephemeral process key | 32-byte HMAC (base64 or 64 hex) for worker job tickets. Unset = tickets die on API restart. **Set in production.** |
| `SCRIPT_SIGNING_KEY` | ephemeral process key | 32-byte HMAC (base64 or 64 hex) for script artifact signatures. Unset = signatures die on restart. **Set in production.** |
| `INTEGRATION_ACTIONS_ENABLED` | `true` | Set `false` to disable `http.request`, `notification.webhook`, and `notification.email` at validate/publish/execute. |
| `BACKUP_ENCRYPTION_KEY` | (scripts only) | Passphrase for `scripts/backup/*` (AES-256-CBC + PBKDF2). Wrap with KMS before production. Not an API process env. |

Sources for this inventory (prefer these over copying compose):
[`env-template.txt`](../env-template.txt),
[`apps/api/README.md`](../apps/api/README.md) Environment table,
[`deploy/k8s/api-configmap.yaml`](../deploy/k8s/api-configmap.yaml),
[`deploy/k8s/api-secret.example.yaml`](../deploy/k8s/api-secret.example.yaml).

Published OpenAPI for operators: [openapi.md](reference/openapi.md).

ADV-013 two-origin Portal→embed rehearsal (Portal host ≠ embed, local HTTPS):
`docs/reference/portal-adapter.md` and `bash scripts/adv013-cross-origin.sh`.

## Production vs local pitfalls

Local compose is intentionally loose so membership/embed bootstrap works.
**Do not copy these into Kubernetes or any production Secret/ConfigMap.**

| Local (compose / `env-template.txt`) | Production (`deploy/k8s`) |
| --- | --- |
| `APP_ENV=development` | `APP_ENV=production` (empty also production-locks). |
| `TRUSTED_DEV_IDENTITY_HEADERS=1` | **Unset.** Process **refuses to start** if the flag is set with production `APP_ENV` or `REQUIRE_TLS=true`. |
| Sample `PLATFORM_ADMINS=https://idp.example\|admin-1` | Explicit real `issuer\|subject` pairs on the Secret/ConfigMap. Empty is fail-closed (`403` on tenant/workspace bootstrap, metrics, OpenAPI, key rotate, impersonate). Not in the foundation ConfigMap — you must add it. |
| Compose-mounted `deploy/local/embed-signing.pem` / template PEM | Unique PKCS#8 `EMBED_SIGNING_KEY` on the Secret. **Boot-fail** if missing. Do not copy the local key. |
| `EMBED_ISSUER` may be `http://` in dev | Absolute `https://` only (ADV-018). `http://` is a boot-fail. |
| `REQUIRE_TLS` unset / false; HTTP on :8080 | `REQUIRE_TLS=true` + `TRUSTED_PROXY_CIDRS` for cluster ranges. TLS terminates at Ingress (`deploy/k8s/ingress.yaml`, `deploy/tls/`). |
| `POSTGRES_SSLMODE=disable` in compose DSN | `POSTGRES_SSLMODE=require` (ConfigMap). |
| `CORS_ALLOWED_ORIGINS=http://localhost:3000` | Exact https UI origins. Empty + foreign `Origin` fails closed. |
| Postgres image tag `postgres:16-alpine` | Digest-pin every production image. CI rejects `:latest` in `deploy/k8s`. Web already pins `node:22-alpine` by digest. |
| `JOB_BINDING_SECRET` / `SCRIPT_SIGNING_KEY` unset (ephemeral) | Durable secrets. Tickets and script signatures die on restart if unset. |
| `CREDENTIAL_KEK` optional to boot; compose may set a local-only default | Required to create/rotate vault secrets and to decrypt artifacts after restore. Generate a unique KEK. Do not copy `local:compose`. |
| Local tenant/workbench seed (`SEED_LOCAL_DEFAULTS` unset in `APP_ENV=development`) | **Unset.** Production-locked `APP_ENV` or `REQUIRE_TLS=true` keeps the path inactive. Explicit `1` in that state is a boot-fail. |
| `WEB_HSTS` unset (correct for `http://localhost:3000`) | HSTS from HTTPS / `X-Forwarded-Proto` / `WEB_HSTS=1` behind a terminator that does not forward proto. |
| OpenAPI/metrics via trusted-dev headers | `Authorization: Bearer <ff_session>` for a `PLATFORM_ADMINS` principal. |

Image and runtime defaults that production must keep: digest-pinned
images from approved provenance, non-root UID **65532**, read-only
root, `cap_drop: ALL`, `no_new_privs`, resource limits, default-deny
NetworkPolicy, TLS at the ingress/proxy boundary. See
[supply-chain policy](../deploy/supply-chain/policy.md) and
[`deploy/k8s/README.md`](../deploy/k8s/README.md).

## Local default tenant seed

Relates to #191. Fresh `docker compose up` seeds one tenant, one workbench,
and placeholder vault credentials so the UI can be exercised without a
manual `POST /tenants` / `POST /workspaces` bootstrap.

This path is **local/dev only**. It does not run in production-like
`APP_ENV` (empty, `production`, or unknown) or when `REQUIRE_TLS=true`.
ADV-002 (fail-closed identity), ADV-003 (embed-session bootstrap), and
ADV-010 stay unchanged: seed writes rows; it does not accept
self-asserted headers or let an embed session create tenants.

### What is seeded

| Object | Value |
| --- | --- |
| Tenant slug / name | `local` / `Local demo` |
| Workbench key / name | `default` / `Local workbench` |
| Workspace admin | Each `PLATFORM_ADMINS` principal (compose default `https://idp.example\|admin-1`) |
| Demo credentials | `Local demo token`, `Local demo webhook`, `Local demo provider` (tag `local-demo`) |

Demo secret payloads are documented placeholders
(`local-demo-token-not-a-secret` and siblings). They are **not**
third-party credentials and must never be used outside local compose.

The seed is idempotent. Restarting the API, or re-running against a
volume that already has these rows, reuses the same tenant, workbench,
membership, and credential display names.

### Opt in / opt out

| Setting | Effect |
| --- | --- |
| `APP_ENV=development\|dev\|local\|test` and `REQUIRE_TLS` false (compose default) | Seed runs after migrate, before readiness. |
| `SEED_LOCAL_DEFAULTS=0` / `false` / `off` | Opt out in local/dev. |
| `SEED_LOCAL_DEFAULTS=1` with empty/`production`/unknown `APP_ENV` or `REQUIRE_TLS=true` | **Boot-fail** (leftover flag cannot stay on). |
| Empty `PLATFORM_ADMINS` | Seed no-ops (nothing is invented). |
| `CREDENTIAL_KEK` unset | Tenant/workbench still seed; demo credentials are skipped (fail-closed). |

Compose sets a documented local-only KEK
(`CREDENTIAL_KEK_ID=local:compose`, ASCII
`flowforge-local-dev-kek-32by!` as base64) so demo credentials can be
created. Prefer `openssl rand -base64 32` for a private local key.
**Do not copy that compose default into `deploy/k8s` or any production
Secret.** Production still fails closed on vault write until a real KEK
is set.

### Using the seeded workspace in the UI

`GET /api/v1/workspaces` and `GET /api/v1/credentials` already return
the seeded rows for `admin-1` once workspace lookup is
`tenant slug=local` + `workbench_key=default`. Trusted-dev header
identity (or a cookie session for that principal) is still required —
the seed does not change authentication.

On `/membership`, enable the temporary header fallback if you are not
using a session, then set:

- Issuer `https://idp.example`, subject `admin-1`
- Tenant slug `local`, workbench key `default`

List workspaces / open Credentials. The switcher lists memberships only
after that workspace lookup is in tab `sessionStorage` (existing UI
contract; see the Chloe note on the #191 PR).

### Production

`deploy/k8s/api-configmap.yaml` must not set `SEED_LOCAL_DEFAULTS`.
Empty/`production` `APP_ENV` plus `REQUIRE_TLS=true` keeps the seed
inactive even if someone copies the compose file.

## Metrics and OpenAPI scrape (ADV-020)

`GET /api/v1/metrics`, `/openapi.yaml`, `/openapi.json`, and `/swagger` are
not anonymous. Scrapers must authenticate as a `PLATFORM_ADMINS` principal
(`platform.administer`). Fail closed when the allowlist is empty.

Prometheus example (Bearer is the session token from `POST /embed/exchange`
or trusted-dev `POST /session`; refresh before idle/absolute expiry):

```yaml
scrape_configs:
  - job_name: flowforge-api
    metrics_path: /api/v1/metrics
    authorization:
      type: Bearer
      credentials_file: /var/run/secrets/flowforge/scrape-session
```

Local compose may instead send `X-FlowForge-Issuer` / `X-FlowForge-Subject`
matching `PLATFORM_ADMINS` because `TRUSTED_DEV_IDENTITY_HEADERS=1`. Do not
enable that in production. Kubernetes liveness/readiness stay
`GET /api/v1/health` and `GET /api/v1/readiness` with no credentials.

## Recovery

Operator runbooks (do not duplicate here):

- [Incident and recovery](operations/incident-recovery.md) — health vs readiness, worker-loss/fencing, escalation (`X-Request-ID`, alerts, metrics).
- [Retention and backup](operations/retention-backup.md) — encryption, restore cadence, `POST /retention/purge`, legal hold.
- [E12.3 threat-model review](reference/e12-threat-model-review.md) — production-gate sign-off.

Backups must be encrypted and restoration rehearsed before production enablement. Restore into an isolated environment, run migrations, then verify health/readiness and an application smoke test. Do not treat a successful backup job as recovery evidence.

Hooks from `#10` (AES-256-CBC + PBKDF2 via `BACKUP_ENCRYPTION_KEY`; wrap that key with KMS before production):

```bash
export POSTGRES_PASSWORD=...
export BACKUP_ENCRYPTION_KEY=...
# compose postgres + api already up
bash scripts/backup/encrypt-pg-dump.sh
bash scripts/backup/restore-rehearsal.sh
```

`restore-rehearsal.sh` writes an encrypted dump, restores it into a throwaway Postgres container, checks `schema_migrations`, then boots the hardened API image against the restored database and asserts `/api/v1/health` and `/api/v1/readiness`. The isolated API is production-locked (no `APP_ENV`), so the script mounts the same local-only PKCS#8 PEM as compose (`deploy/local/embed-signing.pem`; override via `EMBED_SIGNING_KEY` / `EMBED_SIGNING_KEY_FILE`). CI runs the same script. Production still boot-fails without a unique Secret key.

E12.2 adds a fail-closed resilience suite (worker-loss, queue lag, migrate serialization, bounded load, ≥2× headroom) plus a schema-level isolated restore that does not need compose:

```bash
TEST_DATABASE_URL='postgres://flowforge:…@127.0.0.1:5432/flowforge?sslmode=disable' \
  bash scripts/e12-resilience-suite.sh
```

See [e12-resilience-capacity.md](reference/e12-resilience-capacity.md). CI job: `.github/workflows/e12-resilience.yml`. The E12.1 security suite is unchanged.

Operator/admin **UI** procedures (shell, vault, embed/Portal expectations,
session/CHIPS/CSRF) are [guides/operator-admin.md](guides/operator-admin.md).
Do not duplicate OpenAPI/deploy/incident/backup there.
