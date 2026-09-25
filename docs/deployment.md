# Deployment and local development

Release/ops landing: [operations](operations/index.md) (API/OpenAPI,
incident/recovery, retention/backup, threat-model review). This page is
the deploy + configuration inventory. **Operator UI guide — E12.3.**
**Accessibility review — E12.3.**

## Local startup

1. Copy `env-template.txt` to `.env` and replace the local PostgreSQL password.
2. Run `docker compose up --build`. Compose starts `postgres`, **`minio`**, `api`, **`worker`**, and `web`. MinIO (`minio_data`) holds envelope-encrypted artifact payloads so they survive an API restart. Local-only MinIO credentials are not production secrets. The worker is required for **Start published** to leave `queued` (it claims `POST /api/v1/jobs/claim`). Opt out with `docker compose up --scale worker=0` or `LOCAL_WORKER=0` (process exits 0). Do not add this service to `deploy/k8s`. Production provider dispatch is the runner Deployment (`/usr/local/bin/runner`); see [Production runner](#production-runner). The API process also runs the [leader-elected scheduler](#leader-elected-scheduler) (`SCHEDULER_ENABLED`, default on) so schedule dispatch, lease recovery, and retention purge do not need an external cron. Set `SCHEDULER_ENABLED=0` to opt out.
3. Verify `GET http://localhost:8080/api/v1/health` returns `200`, then `GET http://localhost:8080/api/v1/readiness` returns `200` after migrations finish.
4. Open `http://localhost:3000`. The UI response includes `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, and `X-Frame-Options: DENY` (CSP `frame-ancestors 'none'`). `Strict-Transport-Security` is omitted on this HTTP origin so local HTTP is not pinned to HTTPS. Product home is `/workflows`. `/membership` is grant-gated members admin (off product chrome after R7.2; Settings may link carefully). `/isolation` is the negative isolation check (success is a denial). Local compose sets `APP_ENV=development`, `TRUSTED_DEV_IDENTITY_HEADERS=1`, and a sample `PLATFORM_ADMINS` so local bootstrap still works; do not copy those into production, and do not treat trusted-dev headers as rewrite login. After readiness, the API also seeds one local tenant/workbench and demo vault credentials (see [Local default tenant seed](#local-default-tenant-seed)). When `local_logins` is empty it also seeds the **one-time** local Login operator — see [First-run local Login](#first-run-local-login). To walk the first-run wizard instead (path-2 / B.5 TLS), see [Path-2 first-run wizard](#path-2-first-run-wizard). Published runs need the worker (see [Local compose worker](#local-compose-worker)).

Migrations are forward-only and recorded in `schema_migrations` (version, name, SHA-256 checksum). Re-running migrate is safe when those checksums match the files embedded in the binary. A drifted or missing applied file refuses boot (readiness stays 503; `cmd/migrate` exits 1). `000034_execution_edges.sql` requires a superuser or `BYPASSRLS` migration role. `000035_retry_gates_and_approval_close.sql` does not. How to apply, verify, roll back, and recover: [schema migrations](operations/schema-migrations.md).

Compose hardening (UID/GID **65532** except postgres):

- **api** (`` / G.0.9): read-only root filesystem, `cap_drop: ALL`, `no-new-privileges`, `/tmp` tmpfs, CPU/memory/PID limits, and `HEALTHCHECK` on `GET /api/v1/health` (liveness; not PostgreSQL). Matches `deploy/k8s` probes for the health path.
- **worker** (local/dev only): same image and least-privilege defaults as `api`, `command: ["/usr/local/bin/worker"]`. Disables the inherited image `HEALTHCHECK` (the worker does not listen on 8080). Not present in `deploy/k8s`. The image also contains `/usr/local/bin/runner`; compose does not start it.
- **web** (``): the same least-privilege defaults via the `x-security` YAML anchor, plus tmpfs on `/tmp` and `/app/apps/web/.next/cache`, and `mem_limit` / `cpus` / `pids_limit` (same compose-native limits as `api`; do not also set `deploy.resources`, which conflicts with `pids_limit`). Compose builds `web` from the repository root so `pnpm-lock.yaml` is in the context.
- **postgres**: `no-new-privileges` only. The official image starts as root then drops; `cap_drop: ALL` would break that.
- **minio** (local/dev artifact store): built from the newest AGPL community tag in `deploy/local/minio` (no registry pull; Quay anonymous pull is 401 and AIStor denies S3 without a license). UID 65532, `cap_drop: ALL`, `no-new-privileges`. Volume `minio_data` keeps ciphertext across API restarts. Do not add this service to `deploy/k8s`. Production sets `ARTIFACT_S3_*` and opens allowlisted object-store egress.

## Deployment controls

Production images must be digest-pinned, built from approved provenance, vulnerability-scanned, and run non-root with read-only filesystems, dropped capabilities, `no_new_privs`, resource limits, TLS at the ingress/proxy boundary, and default-deny network policy.

Foundation files (API / supply-chain / backup from ``):

| Area | Location |
| --- | --- |
| Kubernetes (API, web, runner Deployments/Services; encrypted backup CronJob; default-deny + API/web/runner/backup/Postgres NetworkPolicy; TLS Ingress for `api.example.com` and `app.example.com`) | [`deploy/k8s/`](../deploy/k8s) |
| Workspace runner SA / Role / RoleBinding templates (E7.1 cluster targets) | [`deploy/kubernetes/`](../deploy/kubernetes) |
| TLS/proxy (Ingress + local Caddy terminator; API `REQUIRE_TLS` / `TRUSTED_PROXY_CIDRS` / `TLS_*`) | [`deploy/tls/`](../deploy/tls), [`apps/api/README.md`](../apps/api/README.md) |
| Supply-chain policy (approved bases, vuln gates, provenance) | [`deploy/supply-chain/policy.md`](../deploy/supply-chain/policy.md) |
| CI gates | [`.github/workflows/supply-chain.yml`](../.github/workflows/supply-chain.yml) |
| Encrypted backup CronJob + restore / RPO-RTO rehearsal | [`scripts/backup/`](../scripts/backup), [`deploy/k8s/backup-cronjob.yaml`](../deploy/k8s/backup-cronjob.yaml) |

The Kubernetes files are a foundation only: configure the database egress policy, TLS ingress host/secret (or cert-manager), backup encryption key wrapping, KMS references, and environment-specific registry credentials before deployment. TLS terminates at the ingress/proxy boundary, not inside the Next.js container.

API image (`` / G.0.9):

- `apps/api/Dockerfile`: `USER 65532:65532`, digest-pinned `golang:1.26-alpine` (build) and `alpine:3.20` (runtime) multi-arch indexes, `HEALTHCHECK` on `GET /api/v1/health`. Compose `worker` disables that probe. How to refresh pins: [Refreshing Dockerfile base digests](#refreshing-dockerfile-base-digests).

Web image and Next.js headers (``):

- `apps/web/Dockerfile`: `USER 65532:65532` (same UID as `apps/api`), digest-pinned `node:25-alpine`, copies the workspace `pnpm-lock.yaml` and runs `pnpm install --frozen-lockfile`, writable paths limited to `/tmp` and `/app/apps/web/.next/cache`. Node 25 does not ship corepack, so the build stage installs `pnpm@10.33.3` with npm. The runner stage removes npm and corepack, and installs `libcrypto3` / `libssl3` `3.5.8-r0` (CVE-2026-14456; the pinned Alpine 3.23 index still has `3.5.6-r0`). The process is `node apps/web/server.js`, and the base image's bundled npm `tar` 7.5.11 is CVE-2026-59873 (fixed in 7.5.19), which is not an app lockfile dependency.
- `deploy/k8s/web-deployment.yaml` runs that image as `node apps/web/server.js`. The manifest pins `ghcr.io/bbengt1/flowforge-web:foundation@sha256:…`. The committed digest is all zeros (not an image). Replace it with the `publish-images` digest. CI rejects a tag with no `@sha256:`. `emptyDir` covers `/tmp` and `/app/apps/web/.next/cache`. `API_INTERNAL_URL` is `http://flowforge-api:8080`. Rebuild with `NEXT_PUBLIC_API_URL` set to the public https API origin (the Deployment repeats that origin for server-rendered links; do not use localhost). There is no process-local health route — `/api/control-plane/health` proxies the Go API — so kubelet probes `GET /` on port 3000. Ingress host `app.example.com` targets `flowforge-web:3000`. The web NetworkPolicy allows ingress from `ingress-nginx` and egress only to the API Service pods (port 8080) and cluster DNS. Compose `/usr/local/bin/worker` stays out of `deploy/k8s`; production claims use `/usr/local/bin/runner`.
- Next.js secure headers via `apps/web/next.config.ts` and `apps/web/src/proxy.ts`. CSP uses a per-request nonce (`script-src 'nonce-…' 'strict-dynamic'`) so App Router inline bootstrap/RSC scripts hydrate. HSTS is emitted only when the request is HTTPS, `X-Forwarded-Proto: https`, or `WEB_HSTS=1`. CSP `frame-ancestors 'none'` / `X-Frame-Options: DENY` is the standalone default; `/embed/v1` relaxes `frame-ancestors` only when the shared host allowlist (`WEB_EMBED_FRAME_ANCESTORS` ∪ `WEB_PORTAL_FRAME_ANCESTORS` ∪ `PORTAL_FRAME_ANCESTORS`) lists exact host origins. That same list is published on `GET /embed/catalog` `frameAncestors` and drives postMessage. Empty fails closed. Do not set `WEB_HSTS=1` for `http://localhost:3000`.
- Local Compose still uses a tag for `postgres:16-alpine`. Production must replace that tag (and any unpinned registry references) with a digest. API, web, and backup Dockerfiles already pin their bases by digest.

Backup image (G.1.4):

- `scripts/backup/Dockerfile`: `USER 65532:65532`, digest-pinned `alpine:3.20`, `postgresql16-client`, `python3` + `py3-cryptography` (AEAD helper and integrity manifest), `aws-cli`, entrypoints `/usr/local/bin/run-encrypted-backup`, `receive-wal`, `archive-wal`, `pitr-basebackup`, and `pitr-restore`. Build from the repository root. `deploy/k8s/backup-cronjob.yaml`, `wal-archive-deployment.yaml`, and `pitr-base-cronjob.yaml` pin `ghcr.io/bbengt1/flowforge-backup:foundation@sha256:…`. The committed digest is all zeros (not an image). Replace it with the `publish-images` digest. CI rejects a tag with no `@sha256:`.

API TLS/proxy environment (local defaults are HTTP; production ConfigMap requires TLS):

| Variable | Default | Purpose |
| --- | --- | --- |
| `TRUSTED_PROXY_CIDRS` | empty | Comma-separated CIDRs allowed to set `X-Forwarded-Proto`. Empty ignores forwarded headers. |
| `REQUIRE_TLS` | `false` | Reject requests that are not HTTPS (direct TLS or a trusted proxy). |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | empty (compose: `/tmp/flowforge-tls/{cert,key}.pem`) | Optional process-level TLS. Both must be set or neither. First-run B.5 writes the created or uploaded PEM pair here (0600). `internal/tlsmaterial` creates the parent directory (0700) so UID **65532** can write on the existing `/tmp` tmpfs. Empty fails closed on create/upload (`503`); `{action:"skip"}` (B.7) writes no files and does not require the paths. Keys are never stored in PostgreSQL and never echoed. Compose defaults writable `/tmp` paths so [path-2](#path-2-first-run-wizard) wizard B.5 works on the read-only API container. Do not copy those localhost defaults into `deploy/k8s` — production mounts durable paths. Settings later reads `GET /bootstrap` `steps.tls.mode` only. |
| `CORS_ALLOWED_ORIGINS` | empty | Exact browser origins allowed to make credentialed API calls. Empty fails closed. Wildcard is rejected. |
| `SESSION_IDLE_TIMEOUT` | `30m` | Browser session idle lifetime. |
| `SESSION_ABSOLUTE_TIMEOUT` | `12h` | Browser session absolute lifetime. |
| `CREDENTIAL_KEK` | empty (compose: documented local-only default) | 32-byte AES-256 data-encryption KEK (base64 or hex). **Non-production only.** A production-locked process refuses a plaintext KEK and requires `CREDENTIAL_KEK_WRAPPED` plus `KMS_PROVIDER`. Compose may default a local-only value (`CREDENTIAL_KEK_ID=local:compose`). Never copy that default to k8s. |
| `CREDENTIAL_KEK_FILE` | empty | Optional plaintext KEK file. Same production refusal as `CREDENTIAL_KEK`. |
| `CREDENTIAL_KEK_ID` | `env:CREDENTIAL_KEK` or `kms:<provider>:<16 hex>` | Key reference stored with ciphertext (not the key). Data-KEK rotation must set a new id. |
| `CREDENTIAL_KEK_WRAPPED` | empty | KMS ciphertext of the data KEK (`ff1:<provider>:…`). The only at-rest KEK form in production. Never a plaintext key. |
| `KMS_PROVIDER` | empty | `aws`, `gcp`, `azure`, or `vault`. Required in production when any KEK is configured. Partial `KMS_*` config is a boot-fail. See [KEK rotation](operations/kek-rotation.md). |
| `ARTIFACT_S3_ENDPOINT` | empty (compose: `http://minio:9000`) | S3-compatible origin. Empty uses the regional AWS endpoint. No userinfo, path, query, or fragment. |
| `ARTIFACT_S3_BUCKET` | empty (compose: `flowforge-artifacts`) | Bucket for envelope-encrypted artifact payloads. Required with the access key and secret. Production-locked processes **boot-fail** without this set. |
| `ARTIFACT_S3_REGION` | `us-east-1` when S3 is enabled | Region for signing and for `CreateBucket` outside `us-east-1`. |
| `ARTIFACT_S3_ACCESS_KEY_ID` / `ARTIFACT_S3_SECRET_ACCESS_KEY` | empty (compose: MinIO root user/password) | Static credentials. Never logged. Compose defaults are local-only — do not copy them to k8s. |
| `ARTIFACT_S3_SESSION_TOKEN` | empty | Optional temporary-credential token. Never logged. |
| `ARTIFACT_S3_USE_PATH_STYLE` | true when an endpoint is set | Path-style URLs (MinIO). Set `false` for virtual-hosted AWS. |
| `ARTIFACT_S3_SSE` | empty | Optional server-side encryption: `AES256` or `aws:kms`. Payloads are already envelope-encrypted with `CREDENTIAL_KEK` before upload. |
| `ARTIFACT_S3_SSE_KMS_KEY_ID` | empty | Required when `ARTIFACT_S3_SSE=aws:kms`. Never logged. |
| `ARTIFACT_S3_PREFIX` | rejected | Setting this variable is a boot-fail. Object keys are `{tenant}/{workspace}/{ref}` (lowercase UUIDs only). No caller prefix, filename, or credential in the key or object metadata. |
| `ARTIFACT_S3_CREATE_BUCKET` | false (compose: `true`) | Create the bucket at boot when it is missing. **Boot-fail** in a production-locked process. |
| `ARTIFACT_STORE_DIR` | empty | Non-production filesystem root (`{dir}/{tenant}/{workspace}/{ref}`). Used only when every `ARTIFACT_S3_*` intent variable is unset. Empty then uses in-process memory. Both are refused when the process is production-locked. A production-locked process does not fall back to this directory. |
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
| `PLATFORM_ADMINS` / `PLATFORM_ADMIN` | empty | Comma-separated `issuer\|subject` pairs that may `POST /tenants`, `POST /workspaces`, `POST /embed/keys/rotate`, read `GET /metrics` / OpenAPI / swagger, and mint an assertion for another subject (`embed.impersonate`). Empty is fail-closed (`403`). This is a human allowlist, not the machine principal. |
| `MACHINE_REQUIRE` | empty | Opt-in consumers that must have a live principal: `metrics`, `scheduler`, `automation` (comma-separated). Empty does not change existing boots. A required consumer with a missing or invalid client id is a **boot-fail** in every environment. |
| `MACHINE_METRICS_CLIENT_ID` | empty | Public `client_id` for the metrics scraper. Required when `MACHINE_REQUIRE` includes `metrics`. The principal must grant `ops.metrics.read` or explicit `platform.administer`. A missing, revoked, or ungranted row is `503` on metrics/OpenAPI/swagger. |
| `MACHINE_SCHEDULER_CLIENT_ID` | empty | Public `client_id` for the scheduler consumer. Required when `MACHINE_REQUIRE` includes `scheduler`. The principal must grant `workflow.execute` and be bound to a workspace. Ticks do not run until that principal is healthy. |
| `MACHINE_AUTOMATION_CLIENT_ID` | empty | Public `client_id` for other automation. Required when `MACHINE_REQUIRE` includes `automation`. The principal must hold at least one grantable permission. |
| `APP_ENV` / `FLOWFORGE_ENV` | empty (production) | Process environment. Empty, `production`, and unknown values are production-locked. Trusted-dev identity and local seed require `development`, `dev`, `local`, or `test`. |
| `TRUSTED_DEV_IDENTITY_HEADERS` | unset / false | **Local/dev only.** When `1`/`true`/`yes`/`on` **and** `APP_ENV` is an explicit non-production value **and** `REQUIRE_TLS` is false, the API accepts self-asserted `X-FlowForge-Issuer` / `X-FlowForge-Subject` and `POST /session` principal upsert. Empty/missing config denies that path. The process **refuses to start** if the flag is set in production or with `REQUIRE_TLS=true`, so it cannot stay on accidentally. Production identity is the cookie session from `POST /embed/exchange`. Compose local defaults enable this; `deploy/k8s` must not set the flag. |
| `SEED_LOCAL_DEFAULTS` | unset (on in local/dev/test) | **Local/dev only.** When `APP_ENV` is `development`/`dev`/`local`/`test` and `REQUIRE_TLS` is false, the API seeds one tenant (`local`), workbench (`default`), attaches `PLATFORM_ADMINS` as workspace admin, writes demo vault credentials if `CREDENTIAL_KEK` is set, and marks first-run bootstrap **complete** (wizard skip) when that admin + public URL exist. Set `0`/`false`/`off` to opt out. Explicit `1` with production-locked `APP_ENV` or `REQUIRE_TLS=true` is a **boot-fail**. `deploy/k8s` must not set this. |
| `PUBLIC_BASE_URL` | empty (compose default `http://localhost:3000`) | Operator-facing origin stored server-side by localseed skip (B.1/B.4). `http` or `https` origin only — no userinfo, query, or fragment. Never returned by `GET /api/v1/bootstrap`. Do not copy the compose localhost default into `deploy/k8s`. |
| `EMBED_ISSUER` / `EMBED_ISSUER_ALLOWLIST` | empty | Required allowed assertion `iss` for embed mint. Empty fails closed (`403` on mint; exchange also `403` when Portal is empty). Compose seeds `https://idp.example`. Production ConfigMap must set an explicit **https** list — `http://`, relative, or opaque issuers are a boot-fail when `APP_ENV` is empty/`production` or `REQUIRE_TLS=true` (ADV-018). Mint/exchange also `403` a non-https `iss`. Local/dev/test may use `http://`. |
| `EMBED_EXCHANGE_RATE_LIMIT_IP` | `120` | Max `POST /embed/exchange` per client IP per window. Raise if a Portal shared egress IP remounts many iframes. Negative is unlimited. |
| `EMBED_EXCHANGE_RATE_LIMIT_PRINCIPAL` | `30` | Max exchange per peekable `iss\|sub` per window. |
| `EMBED_MINT_RATE_LIMIT_PRINCIPAL` | `60` | Max mint per authenticated principal per window (`/embed/assertions` and Portal adapter mint). |
| `EMBED_RATE_LIMIT_WINDOW` | `1m` | Window for the embed rate-limit counters. |
| `LOGIN_RATE_LIMIT_IP` | `60` | Max `POST /login` per client IP per window, applied before lookup/bcrypt. Negative is unlimited. Separate from embed exchange. |
| `LOGIN_RATE_LIMIT_IDENTIFIER` | `30` | Max `POST /login` per normalized identifier per window. Negative is unlimited. |
| `LOGIN_RATE_LIMIT_WINDOW` | `1m` | Window for the local-login rate-limit counters. |
| `QUOTA_MUTATE_PER_MINUTE` | `120` | Per-workspace token refill for mutating routes (validate, normalize, publish, ops-config writes, other POST/PUT/PATCH/DELETE). `0` or invalid uses 120. Negative is unlimited. |
| `QUOTA_MUTATE_BURST` | same as the per-minute rate | Token-bucket capacity for mutations. Unset follows `QUOTA_MUTATE_PER_MINUTE`. |
| `QUOTA_READ_PER_MINUTE` | `300` | Per-workspace refill for list and other expensive reads. |
| `QUOTA_READ_BURST` | same as the per-minute rate | Token-bucket capacity for those reads. |
| `QUOTA_DOWNLOAD_PER_MINUTE` | `60` | Per-workspace refill for artifact download grants and streams. |
| `QUOTA_DOWNLOAD_BURST` | same as the per-minute rate | Token-bucket capacity for downloads. |
| `QUOTA_EXECUTE_PER_MINUTE` | `30` | Per-workspace refill for `POST /workflows/{id}/executions`. |
| `QUOTA_EXECUTE_BURST` | same as the per-minute rate | Token-bucket capacity for execution starts. |
| `QUOTA_EXECUTE_CONCURRENCY` | `20` | Open (non-terminal) executions per workspace. Manual start, webhook ingress, and schedule dispatch share this cap. `0` or invalid uses 20. Negative disables the cap. `GET /api/v1/health` and `GET /api/v1/readiness` are not counted, so a full bucket or a down rate store cannot 429 those probes. |
| `LOCKOUT_MAX_FAILURES` | `5` | Durable failed-password threshold in `auth_lockouts` (survives restart). Integer 1–50. Unset uses 5. `0`, negative, and non-integers are a boot-fail — lockout cannot be disabled with a bad value. Applies to `POST /login` and OIDC callback. `LOGIN_RATE_LIMIT_*` stays a separate budget from lockout and from `QUOTA_*`. With PostgreSQL that window is shared across API replicas and survives restart. One process without PostgreSQL keeps an in-memory window. `FLOWFORGE_REPLICAS` above 1 refuses that in-memory window. |
| `SCIM_BEARER_TOKEN` | empty | Dedicated bearer for `/scim/v2`. 32–256 characters, no spaces or control characters. Never logged, stored, or returned. Empty together with the other `SCIM_*` leaves SCIM fail-closed (`503`). A token without an issuer (and without `OIDC_ISSUER`) is a boot-fail. Not an `ff_session`; it does not authorize Login, machine token, or embed exchange. |
| `SCIM_ISSUER` | `OIDC_ISSUER` when the bearer is set and this is omitted | Issuer stored on provisioned users. Must match `OIDC_ISSUER` when both are set, so SCIM and OIDC are the same principal. Production requires `https`. |
| `SCIM_DEFAULT_ROLE` | `viewer` | Workspace role granted when a SCIM Group member is added. Does not remove roles the user already has. `platform-admin` and any non-workspace role are a boot-fail. |
| `PORTAL_ISSUER` / `PORTAL_ISSUER_ALLOWLIST` | empty | Required Portal mint `iss` allowlist. Empty fails closed (`403`). Merged into embed exchange. Compose seeds `https://portal.cp-ops.example`. Production requires every entry to be an absolute `https://` URI (ADV-018; boot-fail). |
| `WEB_EMBED_FRAME_ANCESTORS` | unset | Shared host allowlist (merged with `WEB_PORTAL_FRAME_ANCESTORS` and `PORTAL_FRAME_ANCESTORS`). Exact origins allowed to frame `/embed/v1` and send embed postMessage. Empty keeps `frame-ancestors 'none'` and denies postMessage. `*` / `null` are ignored. Set the same values on the API so the catalog matches. |
| `WEB_PORTAL_FRAME_ANCESTORS` | unset | Same shared list (Portal-origin name). |
| `PORTAL_FRAME_ANCESTORS` | unset | Same shared list (API catalog name). |
| `HTTP_ADDR` / `PORT` | `:8080` | Listen address. `PORT` becomes `:PORT` when `HTTP_ADDR` is unset. |
| `DATABASE_URL` | built from `POSTGRES_*` | Preferred DSN. Compose URL-encodes the password into this. |
| `POSTGRES_HOST` / `USER` / `PASSWORD` / `DB` / `PORT` / `SSLMODE` | see `env-template.txt` | Used only when `DATABASE_URL` is unset. Production ConfigMap sets `POSTGRES_SSLMODE=require`. |
| `SHUTDOWN_TIMEOUT` | `10s` (`25s` on `deploy/k8s`) | Graceful HTTP shutdown after the scheduler resigns. Kubernetes `preStop` is 15s and `terminationGracePeriodSeconds` is 45, so 25s fits the remaining grace. |
| `FLOWFORGE_REPLICAS` | `1` when unset | API only. Integer 1–1000. `deploy/k8s` sets `2`, at least the Deployment replicas and the HPA minReplicas. Above 1, boot-fails when a session, store, or rate limiter is in-memory or a pod-local artifact filesystem. Shared Postgres and S3 stay. Do not set Service `sessionAffinity`. |
| `MIGRATE_TIMEOUT` | `5m` | Deadline for applying migrations after PostgreSQL is reachable (separate from the 5s connect/ping). |
| `BUILD_SHA` | `unknown` (ldflags) | Non-secret git SHA published on `GET /api/v1/health` and `/readiness`. Compose and CI pass it as a Docker **build arg** into Go ldflags (`apps/api/Dockerfile`). `smoke.yml` sets `BUILD_SHA=${{ github.sha }}`. Local: `BUILD_SHA=$(git rev-parse HEAD) docker compose up --build`. Runtime env overrides the baked value. Unsafe/missing → `unknown`. Never a secret. Health stays 200. |
| `BUILD_VERSION` | `dev` (ldflags) | Non-secret tag/version on the same probes. Same injection path as `BUILD_SHA`. Unsafe/missing → `dev`. |
| `STATEMENT_TIMEOUT` | `15s` | PostgreSQL `statement_timeout` on every application-pool checkout (`PrepareConn`). Go duration. Invalid/zero keeps `15s`. Clamped at `5m`. Not applied during migrate. |
| `LOCK_TIMEOUT` | `5s` | PostgreSQL `lock_timeout` on the same checkout. Go duration. Invalid/zero keeps `5s`. Clamped at `1m` and never above `STATEMENT_TIMEOUT`. |
| `JOB_BINDING_SECRET` | **required** (boot-fail) | 32-byte HMAC (base64 or 64 hex) for worker job tickets. Missing or malformed **refuses to start** — no per-process random default. Compose sets a documented local-only value so restarts stay stable. Generate with `openssl rand -base64 32`. **Do not copy the compose default to k8s.** |
| `LOCAL_WORKER` | unset (on in local/dev/test) | **Local/dev only.** Compose `worker` claims `/api/v1/jobs/claim`. Set `0`/`false`/`off` to opt out. Explicit `1` with production-locked `APP_ENV` or `REQUIRE_TLS=true` is a **boot-fail**. `deploy/k8s` must not set this or run `/usr/local/bin/worker`. |
| `SCHEDULER_ENABLED` | on | API leader ticks schedule dispatch, lease recovery, and retention purge. `0`/`false`/`no`/`off` opts out. Any other non-empty value is a **boot-fail**. See [Leader-elected scheduler](#leader-elected-scheduler). |
| `SCHEDULER_INTERVAL` | `30s` | Go duration `1s`–`24h` shared by those three ticks. Invalid is a **boot-fail**. |
| `RUNNER` | unset (on when production-locked) | **Production runner only.** `0`/`false`/`off`/`no` exits 0. Any value in `development`/`dev`/`local`/`test` with `REQUIRE_TLS` false is a **boot-fail** (`use cmd/worker`). |
| `RUNNER_USER_ID` | empty | Existing user UUID the runner claims as. Does not upsert. |
| `RUNNER_ISSUER` / `RUNNER_SUBJECT` | first `PLATFORM_ADMINS` pair | Lookup of an existing principal (`FindUser`, no upsert) when `RUNNER_USER_ID` is empty. Must have `workflow.execute`. |
| `API_URL` | `http://127.0.0.1:8080` (compose: `http://api:8080`) | Origin the local worker calls. The production runner does not use it. |
| `WORKER_ID` | `compose-local` (runner default `production-runner`) | Worker id sent on claim/heartbeat/complete. `deploy/k8s` sets this to the pod name so replicas are distinct fence holders. Do not pin every replica to one literal. |
| `WORKER_DRAIN_TIMEOUT` | `30s` | Production runner only. After SIGTERM, finish the in-flight claim for this long and do not start another. `deploy/k8s` sets `30s` inside `terminationGracePeriodSeconds: 40`. A claim that outlives the budget is left for lease recovery. A stale HMAC token still cannot complete. |
| `WORKER_ISSUER` / `WORKER_SUBJECT` | first `PLATFORM_ADMINS` pair | Trusted-dev identity the **compose** worker presents. Must have `workflow.execute`. |
| `SCRIPT_SIGNING_KEY` | **required** (boot-fail) | 32-byte HMAC (base64 or 64 hex) for script artifact signatures. Missing or malformed **refuses to start** — no per-process random default. Compose sets a documented local-only value so restarts stay stable. Generate with `openssl rand -base64 32`. **Do not copy the compose default to k8s.** |
| `INTEGRATION_ACTIONS_ENABLED` | `true` | Set `false` to disable `http.request`, `notification.webhook`, and `notification.email` at validate/publish/execute. |
| `BACKUP_ENCRYPTION_KEY` | (scripts / CronJob only) | Passphrase for `scripts/backup/*` (AES-256-GCM AEAD + PBKDF2, format FFB1). Wrap with KMS before production. Not an API process env. Kubernetes: `flowforge-backup` Secret. |
| `BACKUP_S3_BUCKET` / `BACKUP_S3_ENDPOINT` / `BACKUP_S3_REGION` | (CronJob) | Durable landing for encrypted dumps under `flowforge-db/`. Prefer a bucket separate from `ARTIFACT_S3_BUCKET`. Endpoint optional (AWS regional default). |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | (CronJob) | Object-store credentials for backup upload. Never logged. Do not copy compose MinIO defaults. |

Sources for this inventory (prefer these over copying compose):
[`env-template.txt`](../env-template.txt),
[`apps/api/README.md`](../apps/api/README.md) Environment table,
[`deploy/k8s/api-configmap.yaml`](../deploy/k8s/api-configmap.yaml),
[`deploy/k8s/api-secret.example.yaml`](../deploy/k8s/api-secret.example.yaml),
[`deploy/k8s/backup-secret.example.yaml`](../deploy/k8s/backup-secret.example.yaml).

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
| `REQUIRE_TLS` unset / false; HTTP on:8080 | `REQUIRE_TLS=true` + `TRUSTED_PROXY_CIDRS` for cluster ranges. TLS terminates at Ingress (`deploy/k8s/ingress.yaml`, `deploy/tls/`). |
| Compose `TLS_CERT_FILE` / `TLS_KEY_FILE` under `/tmp/flowforge-tls` (tmpfs; lost on recreate) | Durable mounted paths (or ingress-only TLS). Empty still fail-closed (`503`). Do not copy the localhost `/tmp` defaults. |
| `POSTGRES_SSLMODE=disable` in compose DSN | `POSTGRES_SSLMODE=require` (ConfigMap). |
| `CORS_ALLOWED_ORIGINS=http://localhost:3000` | Exact https UI origins. Empty + foreign `Origin` fails closed. |
| Postgres image tag `postgres:16-alpine` | Digest-pin every production image. CI rejects `:latest` in `deploy/k8s`. API and web Dockerfiles pin their bases by digest. |
| Compose-documented `JOB_BINDING_SECRET` / `SCRIPT_SIGNING_KEY` (local-only) | Unique durable secrets on the Secret. **Boot-fail** if missing or malformed. Do not copy the compose defaults. |
| Compose `worker` (`LOCAL_WORKER` unset, `APP_ENV=development`) | **Do not run `/usr/local/bin/worker` or set `LOCAL_WORKER`.** Run `/usr/local/bin/runner` (`deploy/k8s/runner-deployment.yaml`). The compose worker **boot-fails** if `APP_ENV` is production-locked or `REQUIRE_TLS=true`. The runner **boot-fails** on the local/dev path. |
| Compose web `API_INTERNAL_URL=http://api:8080` and `NEXT_PUBLIC_API_URL=http://localhost:8080` | `deploy/k8s/web-deployment.yaml` sets `API_INTERNAL_URL=http://flowforge-api:8080`. Rebuild the web image with the public https `NEXT_PUBLIC_API_URL`. Do not copy localhost. |
| `CREDENTIAL_KEK` optional to boot; compose may set a local-only plaintext default | Plaintext `CREDENTIAL_KEK` is a **boot-fail**. Set `KMS_PROVIDER` and `CREDENTIAL_KEK_WRAPPED` (see [KEK rotation](operations/kek-rotation.md)). Do not copy `local:compose`. |
| Compose MinIO (`ARTIFACT_S3_*`, `ARTIFACT_S3_CREATE_BUCKET=true`, local root password) | S3-compatible bucket required. **Boot-fail** without bucket + access key + secret. `ARTIFACT_S3_CREATE_BUCKET` is a boot-fail. Do not copy the MinIO password. Object-store egress is not opened by the default NetworkPolicy. |
| First-run local Login `admin` / `admin` when `local_logins` is empty (`must_change_password`) | **Rotate immediately.** Production Login still works, but chrome must stay on change-password until cleared. Leaving the one-time secret is fail-closed, not a permanent operator account. |
| Local tenant/workbench seed (`SEED_LOCAL_DEFAULTS` unset in `APP_ENV=development`) | **Unset.** Production-locked `APP_ENV` or `REQUIRE_TLS=true` keeps the path inactive. Explicit `1` in that state is a boot-fail. |
| `WEB_HSTS` unset (correct for `http://localhost:3000`) | HSTS from HTTPS / `X-Forwarded-Proto` / `WEB_HSTS=1` behind a terminator that does not forward proto. |
| OpenAPI/metrics via trusted-dev headers | `Authorization: Bearer <ff_session>` for a `PLATFORM_ADMINS` principal. |

Image and runtime defaults that production must keep: digest-pinned
images from approved provenance, non-root UID **65532**, read-only
root, `cap_drop: ALL`, `no_new_privs`, resource limits, default-deny
NetworkPolicy, TLS at the ingress/proxy boundary. See
[supply-chain policy](../deploy/supply-chain/policy.md) and
[`deploy/k8s/README.md`](../deploy/k8s/README.md).

## Refreshing Dockerfile base digests

`apps/api/Dockerfile`, `apps/api/Dockerfile.script-runner`, and `apps/web/Dockerfile` pin approved bases as
`name:tag@sha256:<digest>`. The digest must be the **multi-arch index**
(manifest list), not a single-architecture image id from a local
`docker pull`. `deploy/supply-chain/approved-bases.txt` stays `name:tag`
only; `scripts/check-approved-bases.sh` requires the `@sha256:` pin on
every registry `FROM`.

After an upstream rebuild or security patch, resolve the current index
digest and replace the matching `FROM` line:

```bash
# Preferred: Docker Buildx prints the index digest.
docker buildx imagetools inspect golang:1.26-alpine
docker buildx imagetools inspect alpine:3.20
docker buildx imagetools inspect node:25-alpine
```

Copy the `Digest: sha256:…` line. If Buildx is unavailable, `crane digest
<name>:<tag>` is the same value. Do **not** use `docker inspect … RepoDigests`
from a pulled amd64/arm64 image — that is a platform manifest, and a pin
to it breaks the other architecture.

Then rebuild and let `.github/workflows/supply-chain.yml` `image-scan`
(API and script-runner) and `web-image-scan` (web, repo-root context)
regenerate the SPDX SBOMs and re-run Trivy (`fs` HIGH/CRITICAL, image
CRITICAL). Do not relax `--severity`, `--exit-code`, or `--ignore-unfixed`
when refreshing pins.

## Local default tenant seed

Fresh `docker compose up` seeds one tenant, one workbench,
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
| Workspace admin | Each `PLATFORM_ADMINS` principal (compose default `https://idp.example\|admin-1`), granted through the same membership path other members use |
| Public URL | `PUBLIC_BASE_URL` or `http://localhost:3000`; stored server-side; first-run wizard **skipped** |
| Demo credentials | `Local demo token`, `Local demo webhook`, `Local demo provider` (tag `local-demo`) |

Demo secret payloads are documented placeholders
(`local-demo-token-not-a-secret` and siblings). They are **not**
third-party credentials and must never be used outside local compose.

The example-context principal (`https://idp.example`, subject
`admin-1`) is one of those workspace admins. The seed writes that
binding through the same membership grant other members use, and a
second run does not add another binding. It does not insert the row
as a superuser and it does not bypass row-level security. The one-time
Login user (`admin`, issuer `local`) is a different workspace admin
on the same workbench.

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
`flowforge-local-dev-kek-32bytes!` as base64) so demo credentials can be
created. Prefer `openssl rand -base64 32` for a private local key.
**Do not copy that compose default into `deploy/k8s` or any production
Secret.** Production still fails closed on vault write until a real KEK
is set.

### Using the seeded workspace in the UI

`GET /api/v1/workspaces` and `GET /api/v1/credentials` already return
the seeded rows for `admin-1` once workspace lookup is
`tenant slug=local` + `workbench_key=default`. A cookie session for
that principal is the path — the seed does not change authentication
and does not invent a rewrite login.

On `/membership` (Settings → Workspace members when ADV-024 is
granted), click the labeled **Example context** to fill issuer
`https://idp.example`, subject `admin-1`, tenant slug `local`, and
workbench key `default`. That button is local-only compose localseed
do not promote it into production Settings copy.

Trusted-dev identity headers and `POST /session` remain a labeled
local fallback when compose has `TRUSTED_DEV_IDENTITY_HEADERS=1`.
They are **never rewrite login**. Production identity is
`POST /embed/exchange`. Then list workspaces / open Credentials.
After a cookie session, `GET /workspaces` lists memberships without a
prior lookup; standalone chrome binds B.3 / localseed `local` /
`default` (or the sole membership) into tab `sessionStorage` so the
switcher is not an empty Select-a-workspace dead end.

### Production

`deploy/k8s/api-configmap.yaml` must not set `SEED_LOCAL_DEFAULTS`
or compose `PUBLIC_BASE_URL=http://localhost:3000`.
Empty/`production` `APP_ENV` plus `REQUIRE_TLS=true` keeps the seed
inactive even if someone copies the compose file.

## First-run local Login

**This is a one-time bootstrap credential, not a permanent default.**

When PostgreSQL is ready and **zero** `local_logins` rows exist (empty
volume / path-2 first boot), the API seeds identifier `admin` with
one-time password `admin` and `must_change_password=true`. It never
overwrites an existing credential. `PLATFORM_ADMINS` / trusted-dev
`POST /session` stay a separate identity.

`POST /login` with that one-time pair mints the usual `ff_session` /
`ff_csrf` cookies **and** `session.must_change_password`. Overview /
product chrome must stay blocked until `POST /session/password` (CSRF)
succeeds — no skip. The new password must be longer than the one-time
default, must not equal the current secret, and must not be `admin`.
Password POST once; never echoed.

After a successful change the one-time hash is dead. `admin` / `admin`
is the same `401` as an unknown identifier. Production-locked processes
still allow Login, but the same `must_change_password` gate stays up
until the operator rotates — do **not** leave `admin` / `admin` usable.

Incomplete installs still open the wizard first. After complete (or
localseed skip), signed-out standalone chrome is Login. Embed /
`POST /embed/exchange` / ADV-021 are untouched.

## Path-2 first-run wizard

Default compose localseed marks bootstrap **complete** (wizard skip).
To exercise the first-run wizard (path-2 / B.1–B.5), set
`SEED_LOCAL_DEFAULTS=0` and start against an empty postgres volume
(`docker compose down -v`, then `docker compose up --build`).
B.3 still create-or-binds tenant `local` / workbench `default` for the
first admin (no demo vault credentials). If B.3 omits a password and
`local_logins` is still empty, the one-time `admin` / `admin` seed
still runs — rotate it on first sign-in. After wizard complete +
`POST /login`, that workbench is listed and selectable.

The API container is read-only except `/tmp`. Compose defaults:

```text
TLS_CERT_FILE=/tmp/flowforge-tls/cert.pem
TLS_KEY_FILE=/tmp/flowforge-tls/key.pem
```

`internal/tlsmaterial` creates `/tmp/flowforge-tls` (0700) on the
existing `/tmp` tmpfs as UID **65532**. Wizard step 4
(`POST /api/v1/bootstrap/tls` `{action:"create-self-signed"}` or
upload) then succeeds without hand-setting env. Materials stay on
disk (0600). `instance_bootstrap` stores **status only** — never
PEM. Responses never echo the key. Local compose stays **HTTP**
until both files exist; a process restart is required for
`ListenAndServeTLS` to pick them up.

Those files live on tmpfs and are lost when the container is
recreated. Production / `deploy/k8s` must mount durable paths.
Empty `TLS_*` still fails closed (`503`). Do not copy the
localhost `/tmp` defaults into the ConfigMap.

## Local compose worker

 Fresh `docker compose up` starts a **local/dev**
`worker` service that claims `POST /api/v1/jobs/claim` so **Start
published** can leave `queued`. It uses the same lease, HMAC
`jobToken` (`JOB_BINDING_SECRET`), and fencing token checks as any
other worker. It does **not** bypass ADV fencing, drafts-never-run,
or E12 suites.

The binary is `/usr/local/bin/worker` in the API image
(`apps/api/cmd/worker`). Compose runs that command; the API process
does not start an in-process runner.

### What it executes

| Node | Local worker |
| --- | --- |
| Core `data.set` / `data.map` / `data.validate` / `flow.condition` / `flow.stop` / `flow.fail` | Evaluate via the existing Go contract, then `heartbeat` + `complete` / `fail`. Enough for the blank-draft smoke. |
| `flow.approval` | API parks the claim as `waiting` (no lease). Worker skips. |
| `flow.delay` | Fail-closed (`local-worker-unsupported`). Durable wait is not an in-worker sleep. |
| Provider (`k8s.*`, `ssh.run`, `script.*`, `http.request`, …) | Fail-closed (`local-worker-unsupported`). Use the [production runner](#production-runner). |

Identity is the compose trusted-dev principal (`PLATFORM_ADMINS`,
default `https://idp.example|admin-1`). The worker lists
`GET /workspaces` and claims each membership. Host-supplied workspace
ids are not sent (400).

### Opt in / opt out

| Setting | Effect |
| --- | --- |
| `APP_ENV=development\|dev\|local\|test` and `REQUIRE_TLS` false (compose default) | Worker runs. |
| `LOCAL_WORKER=0` / `false` / `off` | Process exits 0 (`restart: on-failure` stays down). |
| `docker compose up --scale worker=0` | Do not start the service. |
| Host `go run./cmd/worker` with `API_URL=http://127.0.0.1:8080` and `APP_ENV=development` | Same claim loop against a host API. |
| `LOCAL_WORKER=1` with empty/`production`/unknown `APP_ENV` or `REQUIRE_TLS=true` | **Boot-fail.** |
| Production-locked `APP_ENV` without the flag | Process **refuses to start** (exit 1). |

`deploy/k8s` must not set `LOCAL_WORKER` or run `/usr/local/bin/worker`.

## Production runner

`/usr/local/bin/runner` (`apps/api/cmd/runner`) is the production-locked
worker. `deploy/k8s/runner-deployment.yaml` runs it at `replicas: 2`
from the same API image. It refuses `APP_ENV=development|dev|local|test`
when `REQUIRE_TLS` is false, so compose keeps `cmd/worker`.

It claims in-process through PostgreSQL (`SET ROLE flowforge_app`,
FORCE RLS). It mints and re-parses an HMAC job ticket
(`JOB_BINDING_SECRET`) and completes or fails with the fencing token.
Draft version/digest bindings fail `draft-not-runnable` and never call
an engine. Credentials are unlocked in-process and wiped. Logs carry
job id, node type, and error code only.

| Node | Production runner |
| --- | --- |
| Core `data.set` / `data.map` / `data.validate` / `flow.condition` / `flow.stop` / `flow.fail` | Same in-process evaluate as the compose worker. |
| `flow.approval` | Parked with `WaitJob` until `expiresIn`. Not executed. |
| `flow.delay` | Parked with `WaitJob` until the duration elapses. Downstream steps stay blocked until that timer resolves. Not an in-process sleep. |
| `kubernetes.*` / `ssh.run` / `script.python` / `script.go` / `http.request` / `notification.webhook` | Existing engine packages, published pins only. |
| `notification.email` | `ExecuteEmail`. No mailer configured → `delivery-failed`. |
| `INTEGRATION_ACTIONS_ENABLED=false` | HTTP and notification nodes fail `integration-disabled` before `Execute`. |

Identity is `RUNNER_USER_ID` or `RUNNER_ISSUER` + `RUNNER_SUBJECT`
(else the first `PLATFORM_ADMINS` pair). Lookup does not upsert.
`CREDENTIAL_KEK` must be ready or the process exits 1.

The runner NetworkPolicy allows PostgreSQL and cluster DNS only.
Provider CIDRs are an operator allowlist. Do not open `0.0.0.0/0`.
Script steps create isolated Jobs (see [script-runner image](#script-runner-image)).
Do not run this binary from compose.

### Script-runner image

`script.python` and `script.go` do not run in the runner process. The
runner clones `deploy/kubernetes/script-runner-deployment.yaml` (a
`batch/v1` Job template, not a Deployment) and creates one Job in the
FlowForge namespace. The container image reference in that template is
`ghcr.io/bbengt1/flowforge-script-runner:foundation` (an identity check;
do not replace it with a digest). On create, the
runner rewrites it to `ghcr.io/bbengt1/flowforge-script-runner@<imageDigest>`
using the published runtime profile. That digest must be one `publish-images`
signed. Any other repository is rejected.
Draft workflow bindings fail `draft-not-runnable` before a Job is built.
Missing API configuration fails the step `runner-not-implemented` and
does not fall back to the in-process harness. `go test` uses
`HarnessRuntime` or a fake Job client and does not start pods.

Build and push locally from this repo:

```bash
docker build -f apps/api/Dockerfile.script-runner \
  -t ghcr.io/bbengt1/flowforge-script-runner:foundation \
  apps/api
```

The image CI publishes, signs, and attests is the `publish-images` job on
`main` (`.github/workflows/supply-chain.yml`). Record that job's digest as
the runtime profile `imageDigest` (`sha256:<64 hex>`). Do not change the
template tag: the process accepts only
`ghcr.io/bbengt1/flowforge-script-runner:foundation` and then rewrites the
Job to `repository@imageDigest`. Pull requests build
`flowforge-script-runner:ci` and do not push. Verification commands:
[supply-chain policy](../deploy/supply-chain/policy.md).

`deploy/k8s` runs the runner as ServiceAccount `flowforge-runner-scripts`
with a projected token (`SCRIPT_RUNNER_TOKEN_FILE`) and
`SCRIPT_RUNNER_API_SERVER=https://kubernetes.default.svc`. That token
is not mounted on script Jobs (`automountServiceAccountToken: false`).
The Role can create and get Jobs and read pod logs in the FlowForge
namespace. It cannot read Secrets. Apply the script-runner
NetworkPolicy (`deploy/kubernetes/script-runner-networkpolicy.yaml`);
do not apply the Job template itself.

Script Job egress is fail-closed. `deploy/kubernetes/script-runner-networkpolicy.yaml`
allows kube-system DNS and one control-plane API destination. The CIDR is
`CONTROL_PLANE_API_CIDR` from deploy config (canonical prefix, TCP 443 unless
`CONTROL_PLANE_API_PORT` is set). It is not baked into the script-runner
image. Substitute before apply:

```bash
envsubst '${CONTROL_PLANE_API_CIDR}' \
  < deploy/kubernetes/script-runner-networkpolicy.yaml \
  | kubectl apply -n flowforge -f -
envsubst '${CONTROL_PLANE_API_CIDR}' \
  < deploy/k8s/runner-controlplane-networkpolicy.yaml \
  | kubectl apply -n flowforge -f -
```

An unsubstituted placeholder is rejected by the API server. A world CIDR is
rejected by the runner. If the CIDR and the Service alternative are both
unset, the production runner logs `network-policy-unconfigured` and refuses
to create script Jobs (`network-policy-denied`). It still runs other node
types. Before each create it GETs `flowforge-script-runner` and requires
that live policy to be DNS plus that CIDR only.

The Service alternative is `CONTROL_PLANE_API_SERVICE` and
`CONTROL_PLANE_API_SERVICE_NAMESPACE` (same namespace as the runner; the
Role can `get` Services and NetworkPolicies there, not Secrets). The live
policy must select that Service's pods. A Service without a pod selector
is rejected; use a CIDR for the Kubernetes API server.

`SCRIPT_RUNNER_SKIP_NETWORK_POLICY=true` skips this check only when the
process is not production-locked (`APP_ENV` is `development`, `dev`,
`local`, or `test`, and `REQUIRE_TLS` is not set). `cmd/runner` is
production-locked and exits if the flag is set. Do not set it on the
`deploy/k8s` ConfigMap.

### Unclaimed jobs

When an execution stays `queued` and no job has a `workerId` for more
than **15s**, `GET /api/v1/executions/{id}` includes additive
`statusReason: "no-worker"`. Status stays `queued`. can show
“no worker is claiming jobs”. Production without a worker surfaces
the same hint.

## Leader-elected scheduler

The API process ticks three loops itself. No external cron caller is required for them:

| Hook | What it calls | Scope |
| --- | --- | --- |
| Schedule dispatch | The same path as `POST /api/v1/schedules/dispatch` | Due **enabled** schedules pinned to a **published** version. Drafts and missing versions are skipped. |
| Lease recovery | The same path as `POST /api/v1/jobs/recover` | Expired `claimed` / `running` leases become `indeterminate`. A stale HMAC `jobToken` still cannot complete. |
| Retention purge | The same path as `POST /api/v1/retention/purge` | Expired artifacts (payload + metadata), executions, and audits. Legal holds are skipped. |

Replicas campaign with Postgres `pg_try_advisory_lock` **881726402** (not the migration lock `881726401`). The winner holds one application-pool connection (`SET ROLE flowforge_app`) until it stops. Other replicas do not tick. Workspace rows still use `app.set_workspace_id` under FORCE RLS. The lock connection is not used for those queries.

Losing that session stops the replica immediately: the in-flight hook is cancelled, and dispatch, recovery, and purge do not start again until it holds the lock. A schedule fire uses one idempotency key, so a raced start replays the existing execution.

SIGTERM resigns before HTTP drain. The API cancels the scheduler context, unlocks `881726402` on a live context (a cancelled context must not skip `pg_advisory_unlock`), and then drains HTTP for `SHUTDOWN_TIMEOUT`. `deploy/k8s` sleeps 15s in `preStop` and allows 45s of termination grace, with `SHUTDOWN_TIMEOUT=25s`. See [Multi-replica HA](#multi-replica-ha).

| Variable | Default | Purpose |
| --- | --- | --- |
| `SCHEDULER_ENABLED` | on when unset | `1`/`true`/`yes`/`on` runs the loop. `0`/`false`/`no`/`off` opts out. Any other value is a **boot-fail**. |
| `SCHEDULER_INTERVAL` | `30s` | Go duration from `1s` to `24h`. Invalid values are a **boot-fail**. Dispatch, recover, and purge share this interval. |

Compose sets both (default on, `30s`). `deploy/k8s` ConfigMap does the same so multiple API replicas elect one leader. Logs record counts only (`started`, `recovered`, `purged`) and never secrets, tickets, or storage refs.

Encrypted `pg_dump` is **not** this loop. `deploy/k8s` ships
`flowforge-db-backup` (`scripts/backup/run-encrypted-backup.sh`, daily
UTC, logical RPO 24h) plus `flowforge-wal-archive` and
`flowforge-pitr-base` (PITR RPO 300s when the receiver is sealing).
Compose still uses `scripts/backup/encrypt-pg-dump.sh`.
RPO/RTO and restore cadence: [retention and backup](operations/retention-backup.md).
The HTTP endpoints stay for an operator session (`workflow.execute` or
`workspace.administer`, plus CSRF).

When `MACHINE_REQUIRE` includes `scheduler`, each tick checks
`MACHINE_SCHEDULER_CLIENT_ID` first. A missing, revoked, or ungranted
principal (needs `workflow.execute`) skips the hook. Create and rotate
that principal with `POST /api/v1/machine/principals` (secret is not
echoed). The in-process loop does not log in as the principal.

## Multi-replica HA

`deploy/k8s` runs the API, web, and runner at `replicas: 2`. Each has:

| Control | Setting |
| --- | --- |
| PodDisruptionBudget | `maxUnavailable: 1` |
| HorizontalPodAutoscaler | minimum 2 (API max 6, web max 4, runner max 4), CPU 70%, scale-down waits 300s |
| Anti-affinity | preferred, `topologyKey: kubernetes.io/hostname` |
| Rolling update | `maxUnavailable: 0`, `maxSurge: 1` |
| API / web drain | `preStop` `sleep 15`, `terminationGracePeriodSeconds: 45` |
| Runner drain | `WORKER_DRAIN_TIMEOUT=30s`, `terminationGracePeriodSeconds: 40`, `WORKER_ID` = pod name |

`JOB_BINDING_SECRET` and `SCRIPT_SIGNING_KEY` are keys on the shared `flowforge-api` Secret mounted by every API and runner replica. The process boot-fails if either is missing or malformed. It does not mint a per-pod key. A ticket or script signature from one replica verifies on the others. Fencing tokens stay in PostgreSQL; a different worker id or a stale token fails closed.

`FLOWFORGE_REPLICAS` (API container, `2`) must be at least Deployment `replicas` and HPA `minReplicas`. Unset means one process. Above one, boot refuses in-memory or pod-local session, store, and rate-limit backends (session, JTI, lockout, vault, workflow, artifact `memory` / `filesystem`, workspace quota, login, embed, and machine-token windows). Shared Postgres and S3 continue. Do not set Service `sessionAffinity`. Workspace quotas are a token bucket in `workspace_quotas` (FORCE RLS). Login, embed mint/exchange, and machine token keep separate fixed windows in `auth_rate_windows` (hashed keys, no workspace scope). A store error on either table is 503, not a silent in-memory fallback.

A single-node cluster can still schedule both pods (anti-affinity is preferred). `kubectl apply` of a Deployment resets the live replica count to 2; the HPA owns the count between applies. Size Postgres `max_connections` for `(6 + 4) × 8` application connections plus backup and admin headroom. Details: [deploy/k8s/README.md](../deploy/k8s/README.md).

## Metrics and OpenAPI scrape (ADV-020)

`GET /api/v1/metrics`, `/openapi.yaml`, `/openapi.json`, and `/swagger` are
not anonymous. A human caller needs `platform.administer`
(`PLATFORM_ADMINS`). A scraper uses a machine principal granted
`ops.metrics.read`. Fail closed when neither is present.

Create the principal once (platform-admin session + CSRF). The response
is display name, UUID, `client_id`, status, and grants. The secret is
not returned and must be stored in the operator secret manager:

```bash
curl -fsS -c /tmp/ff.cj -b /tmp/ff.cj \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${FF_CSRF}" \
  -d '{"display_name":"Prometheus","client_id":"prom-scrape","secret":"'"${MACHINE_SECRET}"'","grants":["ops.metrics.read"]}' \
  "${API_ORIGIN}/api/v1/machine/principals"
```

Mint the same `ff_session` humans use. Do not call `POST /login`,
`POST /session`, or `POST /embed/exchange` for this identity:

```bash
curl -fsS -c /tmp/scrape.cj \
  -H "Content-Type: application/json" \
  -d '{"client_id":"prom-scrape","secret":"'"${MACHINE_SECRET}"'"}' \
  "${API_ORIGIN}/api/v1/machine/token"
```

Rotate with `POST /api/v1/machine/principals/{id}/rotate` and revoke with
`POST /api/v1/machine/principals/{id}/revoke`. Both require
`platform.administer` and CSRF. Revoke disables the user and kills live
sessions. Put `MACHINE_REQUIRE=metrics` and
`MACHINE_METRICS_CLIENT_ID=prom-scrape` in the API environment when the
scraper must exist; a missing client id is a boot-fail, and a missing
or revoked row is `503` on the scrape routes.

Prometheus example (Bearer is the opaque `ff_session` from
`POST /machine/token`; refresh before idle/absolute expiry). Do not put
the client secret in the scrape file:

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
enable that in production, and do not use those headers as the machine
identity. Kubernetes liveness/readiness stay
`GET /api/v1/health` and `GET /api/v1/readiness` with no credentials.

The same scrape now includes OpenTelemetry business metrics (queue,
lease, execution outcome, vault). W3C `traceparent` is on API responses
and on `execution_jobs` for the worker. Optional trace export is
`OTEL_EXPORTER_OTLP_ENDPOINT` (unset does not dial a collector). SLOs
and example `PrometheusRule` text are in
[SLOs and alerts](operations/slo-alerts.md). Machine-principal auth on
this route is unchanged.

## Recovery

Operator runbooks (do not duplicate here):

- [Incident and recovery](operations/incident-recovery.md) — health vs readiness, worker-loss/fencing, escalation (`X-Request-ID`, `traceparent`, alerts, metrics).
- [SLOs and alerts](operations/slo-alerts.md) — availability, latency, queue lag, lease loss, vault decrypt, example Prometheus rules.
- [Retention and backup](operations/retention-backup.md) — encryption, CronJob, RPO/RTO, restore cadence, `POST /retention/purge`, legal hold.
- [E12.3 threat-model review](reference/e12-threat-model-review.md) — production-gate sign-off.

Backups must be encrypted and restoration rehearsed before production enablement. Restore into an isolated environment, run migrations, then verify health/readiness and an application smoke test. Do not treat a successful backup CronJob as recovery evidence. Documented targets: **logical RPO 24h** (daily `pg_dump`), **PITR RPO 5 minutes** when `flowforge-wal-archive` is sealing WAL, **RTO ≤ 30m** for CI-sized dumps (`scripts/backup/rpo-rto-rehearsal.sh`, `scripts/backup/manifest-pitr-rehearsal.sh`).

Hooks from `` / G.1.4 (AES-256-GCM AEAD + PBKDF2 via `BACKUP_ENCRYPTION_KEY` / `scripts/backup/aead.py`; wrap that key with KMS before production):

```bash
export POSTGRES_PASSWORD=...
export BACKUP_ENCRYPTION_KEY=...
# compose postgres + api already up
bash scripts/backup/encrypt-pg-dump.sh
bash scripts/backup/restore-rehearsal.sh

# DSN path (same cipher as the k8s CronJob)
export DATABASE_URL='postgres://…'
bash scripts/backup/run-encrypted-backup.sh
bash scripts/backup/rpo-rto-rehearsal.sh
bash scripts/backup/manifest-pitr-rehearsal.sh
```

`restore-rehearsal.sh` writes an encrypted dump, restores it into a throwaway Postgres container, checks `schema_migrations`, then boots the hardened API image against the restored database and asserts `/api/v1/health` and `/api/v1/readiness`. The isolated API is production-locked (no `APP_ENV`), so the script mounts the same local-only PKCS#8 PEM as compose (`deploy/local/embed-signing.pem`; override via `EMBED_SIGNING_KEY` / `EMBED_SIGNING_KEY_FILE`) and points at the compose MinIO bucket that the source API already created. It does not set `ARTIFACT_S3_CREATE_BUCKET`. CI runs the same script. Production still boot-fails without a unique Secret key and without bucket credentials.

Kubernetes: `deploy/k8s/backup-cronjob.yaml` (`flowforge-db-backup`) runs `/usr/local/bin/run-encrypted-backup` from `ghcr.io/bbengt1/flowforge-backup` (`scripts/backup/Dockerfile`). `wal-archive-deployment.yaml` runs `/usr/local/bin/receive-wal` (one replica). `pitr-base-cronjob.yaml` runs `/usr/local/bin/pitr-basebackup`. Apply `backup-secret.example.yaml` and open allowlisted object-store egress. The backup role needs `REPLICATION` for the WAL and base-backup paths.

E12.2 adds a fail-closed resilience suite (worker-loss, queue lag, migrate serialization, bounded load, ≥2× headroom) plus schema-level isolated restore and RPO/RTO rehearsal that do not need compose:

```bash
TEST_DATABASE_URL='postgres://flowforge:…@127.0.0.1:5432/flowforge?sslmode=disable' \
  bash scripts/e12-resilience-suite.sh
```

See [e12-resilience-capacity.md](reference/e12-resilience-capacity.md). CI job: `.github/workflows/e12-resilience.yml`. The E12.1 security suite is unchanged.

Operator/admin **UI** procedures (shell, vault, embed/Portal expectations,
session/CHIPS/CSRF) are [guides/operator-admin.md](guides/operator-admin.md).
Do not duplicate OpenAPI/deploy/incident/backup there.
