# FlowForge

Deployable application skeleton (E1.1). Product design, contracts, and the backlog live in [docs/](docs/index.md) — start with [architecture](docs/architecture.md), the [Implemented vs Specified](docs/architecture/implemented-vs-specified.md) matrix, and the [master implementation plan](docs/master-implementation-plan.md). Gap-program SoT: [docs/internal/claude-code-gap-analysis.md](docs/internal/claude-code-gap-analysis.md) (epic [G](https://github.com/bbengt1/flowforge/issues/401) / [G.0](https://github.com/bbengt1/flowforge/issues/402)).

This README covers how to start the local stack. It does not define product scope. It **does** state what that stack actually executes.

## What runs today

This is a **security-hardened prototype**, not an enterprise-ready platform. Compose does not call providers. A production-locked runner does.

| Surface | Today |
| --- | --- |
| Compose `worker` | Local/dev only (`/usr/local/bin/worker`). Evaluates `flow.condition` / `flow.stop` / `flow.fail` / `data.set` / `data.map` / `data.validate`. **Fails** Kubernetes, SSH, scripts, HTTP, and `flow.delay`. Refuses production-locked env. Do not copy into Kubernetes. |
| Production runner | `apps/api/cmd/runner` (`/usr/local/bin/runner`). Production-locked. Claims in-process and calls the kubernetes / ssh / script / http engines. Refuses local/dev. `deploy/k8s` ships a runner Deployment. Script steps create an isolated Job from `deploy/kubernetes/script-runner-deployment.yaml` (`apps/api/Dockerfile.script-runner`) only when `CONTROL_PLANE_API_CIDR` (or a same-namespace Service) is set and the script NetworkPolicy allows DNS plus that destination. Missing config refuses the Job. Provider egress otherwise stays default-deny. `notification.email` fails closed without a mailer. |
| Schedules / recover / purge | API leader scheduler (`SCHEDULER_ENABLED`, advisory lock `881726402`). Encrypted DB backups: `flowforge-db-backup` CronJob (RPO 24h). |
| Identity | Standalone **Login** (`POST /api/v1/login`). Embed is `POST /embed/exchange` (ADV-021). OIDC Authorization Code + PKCE is `POST /api/v1/oidc/start` and `POST /api/v1/oidc/callback` (opt-in; unset fails closed). TOTP MFA gates `platform.administer` and `credential.*` on local-login and OIDC sessions. SCIM 2.0 is `/scim/v2` with `SCIM_BEARER_TOKEN` (opt-in; unset fails closed). Durable lockout is `auth_lockouts` (`LOCKOUT_MAX_FAILURES`, default 5). |
| Bootstrap / TLS | First-run wizard including **Skip for now**. Standalone only. |
| Explorer | `/workflows` folder chrome (F/X). Not provider execution. |

Hard lines stay: YAML SoT; drafts never run; vault display-name + UUID only; ADV-021 / ADV-024. Full matrix: [Implemented vs Specified](docs/architecture/implemented-vs-specified.md).

## Local startup

1. Copy `env-template.txt` to `.env` and replace the local PostgreSQL password placeholder.
2. Run `docker compose up --build` (starts `postgres`, `api`, `worker`, and `web`). The compose worker claims jobs so **Start published** can leave `queued` for the six core nodes above. Provider nodes still fail closed (`local-worker-unsupported`). Opt out with `--scale worker=0` or `LOCAL_WORKER=0`. Do not copy the worker into Kubernetes. Production provider dispatch is `/usr/local/bin/runner` (`deploy/k8s`); it refuses this compose path.
3. Open the UI at [http://localhost:3000](http://localhost:3000).
4. With the Go module from [PR #2](https://github.com/bbengt1/flowforge/pull/2) present, verify [http://localhost:8080/api/v1/health](http://localhost:8080/api/v1/health) then [http://localhost:8080/api/v1/readiness](http://localhost:8080/api/v1/readiness).

The UI proxies `GET /api/v1/health` and `GET /api/v1/readiness` (compose network `http://api:8080`). Proxies forward or generate `X-Request-ID` and preserve `application/problem+json` on failure. Until the API is running, the home page shows those problem details instead of a private error string.

Operator OpenAPI links on the home/shell point at the control plane (`NEXT_PUBLIC_API_URL` + `/api/v1/swagger`, `/openapi.json`, `/openapi.yaml`). Those routes require `platform.administer` (`PLATFORM_ADMINS`). The UI does not re-host the specification.

`/membership` (Chloe, E2.1) exercises workspace identity and RBAC against jonny's API contract in [PR #17](https://github.com/bbengt1/flowforge/pull/17). Next.js `/api/control-plane/*` proxies attach `X-FlowForge-*` identity headers and `X-Request-ID`. The operator never treats a host-supplied workspace UUID as the lookup key.

## UI only (optional)

```bash
pnpm install
pnpm dev
```

Serves [http://localhost:3000](http://localhost:3000) and checks `http://localhost:8080/api/v1/health`.

## Layout

| Path | Role |
| --- | --- |
| `apps/web` | Next.js App Router UI (Compose `web` dockerfile; repo-root context) |
| `apps/api` | Go control plane (PR #2). Compose `api` build context, `HTTP_ADDR=:8080` |
| `docs/` | Normative architecture, implementation plan, and [Implemented vs Specified](docs/architecture/implemented-vs-specified.md) |
| `docs/internal/` | Internal SoT, including [claude-code-gap-analysis.md](docs/internal/claude-code-gap-analysis.md) (G / G.0) |

Compose builds `web` from the repository root (`dockerfile: apps/web/Dockerfile`, so `pnpm-lock.yaml` is in the context) and `api` from `./apps/api`. pnpm workspace root is ready for more packages later.

## E1 / E2 ownership

| Slice | Owner |
| --- | --- |
| Next.js UI, health/readiness/identity proxies, membership operator, secure headers, web image/compose hardening, `env-template.txt` web vars, this README | Chloe |
| Go API, PostgreSQL, workspace model/RBAC, API image/K8s/TLS/provenance/vuln gates, backup encryption + restore rehearsal | jonny |

## License and security

Apache License 2.0. Copyright 2026 Brent Bengtson. See [LICENSE](LICENSE).

Report vulnerabilities privately via GitHub Security Advisories — [SECURITY.md](SECURITY.md). How to contribute: [CONTRIBUTING.md](CONTRIBUTING.md).
