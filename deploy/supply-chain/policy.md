# Supply-chain policy (MVP foundation)

Implemented by `.github/workflows/supply-chain.yml` and the scripts under `scripts/`. Builds **reject** artifacts that fail these gates. This is not a full SLSA Level 3 program.

## Approved bases

Dockerfiles may `FROM` only names listed in `approved-bases.txt` (tag required; digest pin is allowed as `name:tag@sha256:…`). Unlisted bases fail CI.

Production images must additionally be digest-pinned at deploy time. `:latest` is rejected in `deploy/k8s`.

Shared runtime UID for FlowForge app images: **65532**.

## Vulnerability gates

| Check | Scope | Fail when |
| --- | --- | --- |
| `govulncheck` | Reachable **third-party** Go modules in `apps/api` | Any known vulnerability in the call graph (`scripts/govulncheck-gate.py`) |
| `govulncheck` stdlib | Go toolchain | Recorded, not rejected in this MVP. Production enablement requires a currently patched Go release (1.26.x+ as of this story). |
| Trivy filesystem (`library`) | Application dependencies | HIGH or CRITICAL |
| Trivy image | OS + app packages in `flowforge-api` | CRITICAL **with a vendor fix**. Unfixed OS CVEs are recorded, not rejected (MVP). Digest-pin and patch before production enablement |

Unapproved or vulnerable artifacts do not pass the workflow.

## Provenance

CI builds the API image from `apps/api/Dockerfile` in this repository, records the git SHA, and publishes:

- an SPDX SBOM artifact
- a SLSA-style provenance statement (source repo, revision, Dockerfile)

A successful backup job is not provenance. Registry push + `actions/attest-build-provenance` should be added when a registry is configured.
