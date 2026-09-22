# Supply-chain policy (MVP foundation)

Implemented by `.github/workflows/supply-chain.yml`, `.github/workflows/codeql.yml`, `.github/dependabot.yml`, and the scripts under `scripts/`. Builds **reject** artifacts that fail these gates. This is not a full SLSA Level 3 program.

## Approved bases

Dockerfiles may `FROM` only names listed in `approved-bases.txt`. Tag **and** a multi-arch index digest are required (`name:tag@sha256:…`). Unlisted or unpinned bases fail CI (`scripts/check-approved-bases.sh`). How to refresh pins: [docs/deployment.md](../../docs/deployment.md#refreshing-dockerfile-base-digests).

Production **deployed** images must additionally be digest-pinned at deploy time. `:latest` is rejected in `deploy/k8s`.

Shared runtime UID for FlowForge app images: **65532**.

## Vulnerability gates

| Check | Scope | Fail when |
| --- | --- | --- |
| `govulncheck` | Reachable **third-party** Go modules in `apps/api` | Any known vulnerability in the call graph (`scripts/govulncheck-gate.py`) |
| `govulncheck` stdlib | Go toolchain | Recorded, not rejected in this MVP. Production enablement requires a currently patched Go release (1.26.x+ as of this story). |
| Trivy filesystem (`library`) | Go modules in `apps/api` (`image-scan`) | HIGH or CRITICAL (`--severity HIGH,CRITICAL --exit-code 1 --ignore-unfixed`) |
| Trivy filesystem (`library`) | `apps/web` npm dependencies via the workspace `pnpm-lock.yaml` (`web-image-scan`) | HIGH or CRITICAL, same flags as the API filesystem scan. `apps/web` has no lockfile of its own; the job scans the repo root and skips `apps/api`. |
| Trivy image | OS + app packages in `flowforge-api` | CRITICAL **with a vendor fix**. Unfixed OS CVEs are recorded, not rejected (MVP). Digest-pin and patch before production enablement |
| Trivy image | OS + app packages in `flowforge-web` | Same CRITICAL gate as the API image (`--severity CRITICAL --exit-code 1 --ignore-unfixed`). The runner stage removes npm and corepack so the base image's bundled `tar` 7.5.11 (CVE-2026-59873) is not in the runtime filesystem. |
| SPDX SBOM | `api-sbom.spdx.json` (`api-supply-chain`), `web-sbom.spdx.json` (`web-supply-chain`) | The SBOM step is part of the job. A failed image scan or SBOM generation fails the workflow. |

Unapproved or vulnerable artifacts do not pass the workflow.

Dependabot (`.github/dependabot.yml`) opens weekly update PRs. It is not a vulnerability merge gate. Ecosystems: `npm` at the repo root (pnpm workspace; `apps/web` has no separate lockfile), `gomod` for `apps/api`, `github-actions` at the repo root, and `docker` for `apps/web`, `apps/api` (API and script-runner Dockerfiles), and `scripts/backup`. Each ecosystem entry sets `open-pull-requests-limit: 5`. Minor and patch npm/gomod updates are grouped; GitHub Actions updates are grouped.

CodeQL (`.github/workflows/codeql.yml`) analyzes `apps/web` (JavaScript/TypeScript, `build-mode: none`) and `apps/api` (Go, `autobuild`) with `github/codeql-action` init/analyze and the default query suite. Database or query failures fail the job. The action has no severity input: high and critical alert checks fail the pull request when code scanning is enabled and the repository's default alert rules are left on (Settings → Code security → Code scanning). This repository is public, so CodeQL does not need GitHub Advanced Security. Do not set `upload: false`.

## Provenance

CI builds the API image from `apps/api/Dockerfile` and the script-runner image from `apps/api/Dockerfile.script-runner` (`flowforge-script-runner:ci`) in this repository. The API build records the git SHA and publishes:

- an SPDX SBOM artifact (`api-sbom.spdx.json`, artifact `api-supply-chain`)
- a SLSA-style provenance statement (source repo, revision, Dockerfile)

CI builds the web image from the repository root with `-f apps/web/Dockerfile` (`flowforge-web:ci`). That build publishes:

- an SPDX SBOM artifact (`web-sbom.spdx.json`, artifact `web-supply-chain`)
- a SLSA-style provenance statement (`web-provenance.json`) whose `dockerfile` is `apps/web/Dockerfile` (`scripts/write-provenance.sh` optional third argument; the API call is unchanged)

A successful backup job is not provenance. Registry push + `actions/attest-build-provenance` should be added when a registry is configured.
