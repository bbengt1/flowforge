# Contributing to FlowForge

Apache License 2.0. Contributions are under that license (see [LICENSE](LICENSE)). Vulnerability reports go to [SECURITY.md](SECURITY.md) — not a public issue.

This is a **security-hardened prototype**, not an enterprise-ready platform. Read these before changing behavior or docs:

- [Implemented vs Specified](docs/architecture/implemented-vs-specified.md) — what actually runs on `main`
- [Enterprise architecture gap analysis](docs/internal/claude-code-gap-analysis.md) — G / G.0 SoT (findings A–I)

Do not document Kubernetes, SSH, script, or HTTP provider execution as live. Compose’s local worker evaluates six core nodes only and fails closed on provider nodes.

## Local stack

See the root [README](README.md): copy `env-template.txt` to `.env`, then `docker compose up --build`. UI is `http://localhost:3000`; API is `:8080`.

| Area | Path | Role (docs) | GitHub owner |
| --- | --- | --- | --- |
| Go control plane | `apps/api` | jonny / API | [@bbengt1](https://github.com/bbengt1) |
| Next.js UI | `apps/web` | UI (Chloe) | [@bbengt1](https://github.com/bbengt1) |
| Docs | `docs/` | — | [@bbengt1](https://github.com/bbengt1) |
| Deploy | `deploy/` | — | [@bbengt1](https://github.com/bbengt1) |

Review requests follow [`.github/CODEOWNERS`](.github/CODEOWNERS). There are no other GitHub team handles.

## API tests (`apps/api`)

Go **1.26**. From `apps/api`:

```bash
go test ./...
gofmt -l .
go vet ./...
```

CI also runs `golangci-lint` (`.github/workflows/api-quality.yml`). The required `API unit tests` job sets `TEST_DATABASE_URL` against a PostgreSQL 16 service and publishes a coverage artifact plus a job-log / step summary (no coverage threshold). Locally, live-database integration tests stay skipped unless `TEST_DATABASE_URL` or `DATABASE_URL` is set. `config.Load` / `cmd/*` require `JOB_BINDING_SECRET` and `SCRIPT_SIGNING_KEY` (32-byte base64 or 64 hex). Use the documented compose local-only values or `openssl rand -base64 32`. Do not copy those defaults to Kubernetes. Logs and test failure text must never echo the secret.

## Web tests (`apps/web`)

Node **22**, `pnpm@10.33.3`. From the repo root:

```bash
pnpm install
pnpm test
pnpm lint --max-warnings=0
pnpm build
```

`pnpm test` is `node --experimental-strip-types --test src/lib/*.test.ts` in `@flowforge/web` (same as CI `Web unit tests`). `pnpm build` is the type-check (`next build`). Do not use bare `tsc`.

## Pull requests

Target `main`. Use [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md).

- Keep hard lines: fail closed; no secrets in logs; drafts never run; ADV-021; ADV-024; YAML is the only persisted workflow definition.
- Name the issue (`Closes #NNN` only when this PR fully satisfies it).
- Run the tests for the surface you touched. CI must stay green for that surface (`API unit tests`, `api-quality`, `gitleaks` / `secret-scan`, `Web unit tests`, `Web lint`, `Web production build`, plus smoke/supply-chain when deploy or compose changes).
- If the PR changes what actually runs on `main`, update [Implemented vs Specified](docs/architecture/implemented-vs-specified.md) in the same PR.
- Do not invent inboxes, team handles, or GitHub users. Do not put secrets in the PR body.
