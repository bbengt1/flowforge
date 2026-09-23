# Supply-chain policy (MVP foundation)

Implemented by `.github/workflows/supply-chain.yml`, `.github/workflows/codeql.yml`, `.github/dependabot.yml`, `deploy/kyverno/`, `deploy/admission/`, and the scripts under `scripts/`. Builds **reject** artifacts that fail these gates. This is not a certified SLSA level.

## Approved bases

Dockerfiles may `FROM` only names listed in `approved-bases.txt`. Tag **and** a multi-arch index digest are required (`name:tag@sha256:…`). Unlisted or unpinned bases fail CI (`scripts/check-approved-bases.sh`). How to refresh pins: [docs/deployment.md](../../docs/deployment.md#refreshing-dockerfile-base-digests).

Production **deployed** images must be digest-pinned (`name:tag@sha256:<64 hex>` or `name@sha256:<64 hex>`). `:latest` and any other FlowForge tag without `@sha256:` are rejected by `scripts/check-deploy-defaults.sh` and `scripts/check-image-signing.sh`. The committed manifests use an all-zero digest. That value is not an image. Replace it with the `publish-images` digest before apply. `deploy/admission/` (Kubernetes 1.30+) denies a pod that still uses a mutable FlowForge tag. It is a separate kustomization with no namespace: `deploy/k8s` sets `namespace: flowforge`, and kustomize would stamp that onto a cluster-scoped policy.

Shared runtime UID for FlowForge app images: **65532**.

## Vulnerability gates

| Check | Scope | Fail when |
| --- | --- | --- |
| `govulncheck` | Reachable **third-party** Go modules in `apps/api` | Any known vulnerability in the call graph (`scripts/govulncheck-gate.py`) |
| `govulncheck` stdlib | Go toolchain | Recorded, not rejected in this MVP. Production enablement requires a currently patched Go release (1.26.x+ as of this story). |
| Trivy filesystem (`library`) | Go modules in `apps/api` (`image-scan`) | HIGH or CRITICAL (`--severity HIGH,CRITICAL --exit-code 1 --ignore-unfixed`) |
| Trivy filesystem (`library`) | `apps/web` npm dependencies via the workspace `pnpm-lock.yaml` (`web-image-scan`) | HIGH or CRITICAL, same flags as the API filesystem scan. `apps/web` has no lockfile of its own; the job scans the repo root and skips `apps/api`. |
| Trivy image | OS + app packages in `flowforge-api`, `flowforge-script-runner`, and `flowforge-backup` (`image-scan`) | HIGH or CRITICAL **with a vendor fix** (`--severity HIGH,CRITICAL --exit-code 1 --ignore-unfixed`) |
| Trivy image | OS + app packages in `flowforge-web` (`web-image-scan`) | Same HIGH/CRITICAL gate. Node 25 does not ship corepack; the build stage installs `pnpm@10.33.3` with npm. The runner stage removes npm (and corepack, if present) so the base image's bundled `tar` 7.5.11 (CVE-2026-59873) is not in the runtime filesystem. It also installs `libcrypto3` and `libssl3` `3.5.8-r0` (CVE-2026-14456). The pinned `node:25-alpine` index (Alpine 3.23) still contains `3.5.6-r0`. |
| SPDX SBOM | `api-sbom.spdx.json` (`api-supply-chain`), `web-sbom.spdx.json` (`web-supply-chain`) | The SBOM step is part of the job. A failed image scan or SBOM generation fails the workflow. |

Unfixed image CVEs (no patched package in the scanned image) stay in the Trivy log and do not fail the job. That is the whole ignore policy: `--ignore-unfixed` on the image scans above. There is no `.trivyignore`. Do not add one that drops a severity. A CVE exception has to name the CVE, the image, and why no fixed package is acceptable, in this file, in the same change as a Trivy ignore entry.

Unapproved or vulnerable artifacts do not pass the workflow.

Dependabot (`.github/dependabot.yml`) opens weekly update PRs. It is not a vulnerability merge gate. Ecosystems: `npm` at the repo root (pnpm workspace; `apps/web` has no separate lockfile), `gomod` for `apps/api`, `github-actions` at the repo root, and `docker` for `apps/web`, `apps/api` (API and script-runner Dockerfiles), and `scripts/backup`. Each ecosystem entry sets `open-pull-requests-limit: 5`. Minor and patch npm/gomod updates are grouped; GitHub Actions updates are grouped.

CodeQL (`.github/workflows/codeql.yml`) analyzes `apps/web` (JavaScript/TypeScript, `build-mode: none`) and `apps/api` (Go, `autobuild`) with `github/codeql-action` init/analyze and the default query suite. Database or query failures fail the job. The action has no severity input: high and critical alert checks fail the pull request when code scanning is enabled and the repository's default alert rules are left on (Settings → Code security → Code scanning). This repository is public, so CodeQL does not need GitHub Advanced Security. Do not set `upload: false`.

## Provenance and signatures

`scripts/write-provenance.sh` is retired. It exits non-zero and writes nothing. The old JSON file was unsigned, unattached, and often the local image id. It is not provenance.

Pull requests build `flowforge-api:ci`, `flowforge-script-runner:ci`, `flowforge-backup:ci`, and `flowforge-web:ci` and run the Trivy gates. They do not push or sign. A pull-request token must not be able to produce a signature admission will accept.

On a push to `main` (and `workflow_dispatch` on `main`), job `publish-images` pushes these images to GHCR by git SHA, then fails the job if any step is missing:

| Image | Dockerfile | Context |
| --- | --- | --- |
| `ghcr.io/<owner>/flowforge-api` | `apps/api/Dockerfile` | `apps/api` |
| `ghcr.io/<owner>/flowforge-web` | `apps/web/Dockerfile` | repository root |
| `ghcr.io/<owner>/flowforge-script-runner` | `apps/api/Dockerfile.script-runner` | `apps/api` |
| `ghcr.io/<owner>/flowforge-backup` | `scripts/backup/Dockerfile` | repository root |

`<owner>` is the GitHub repository owner (`bbengt1` for this repo). The job does not push the mutable `:foundation` tag. The digest in the job summary is what deploy manifests must pin. BuildKit provenance and SBOM attestations are turned off (`provenance: false`, `sbom: false`) so they are not confused with the signed statement.

Signing is keyless. `sigstore/cosign-installer@v4.1.2` installs cosign **v2.5.3** (pinned; the major-only `@v4` ref is not a git tag, and cosign v3 bundle layout is not what the Kyverno policy below is written against). `cosign sign --yes` uses the GitHub Actions OIDC token. The certificate subject is:

`https://github.com/bbengt1/flowforge/.github/workflows/supply-chain.yml@refs/heads/main`

Issuer: `https://token.actions.githubusercontent.com`.

Provenance is `actions/attest-build-provenance@v4` with `push-to-registry: true`. That is the GitHub SLSA provenance generator. The predicate type is `https://slsa.dev/provenance/v1`, stored on the image and in GitHub's attestation API. The job's permissions are `id-token: write`, `attestations: write`, and `packages: write`. A missing digest prints `refusing to sign` and exits non-zero. `continue-on-error` is not set.

The web image build arg `NEXT_PUBLIC_API_URL` comes from the repository variable `WEB_NEXT_PUBLIC_API_URL` when that variable is set. Unset keeps the Dockerfile default `http://localhost:8080`, which is not a production origin. Set the variable before relying on the signed web image. Do not rebuild and sign that image on a laptop: admission only accepts the `main` workflow identity.

SPDX SBOMs are still CI artifacts: `api-sbom.spdx.json` (`api-supply-chain`) and `web-sbom.spdx.json` (`web-supply-chain`). A successful backup job is not provenance.

### Verify a published digest

Replace `DIGEST` with the `sha256:…` value from the job summary. No registry password is required to verify a public image.

```bash
cosign verify \
  --certificate-identity "https://github.com/bbengt1/flowforge/.github/workflows/supply-chain.yml@refs/heads/main" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  ghcr.io/bbengt1/flowforge-api@sha256:DIGEST

cosign verify-attestation \
  --type slsaprovenance1 \
  --certificate-identity "https://github.com/bbengt1/flowforge/.github/workflows/supply-chain.yml@refs/heads/main" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  ghcr.io/bbengt1/flowforge-api@sha256:DIGEST

gh attestation verify "oci://ghcr.io/bbengt1/flowforge-api@sha256:DIGEST" \
  --owner bbengt1 \
  --signer-workflow bbengt1/flowforge/.github/workflows/supply-chain.yml
```

Repeat for `flowforge-web`, `flowforge-script-runner`, and `flowforge-backup`.

### Key-based signing (air gap only)

The reference path is keyless. For a cluster that cannot reach Fulcio or Rekor, generate a cosign key pair **outside the repo**. Do not commit the private key and do not print it. `COSIGN_PASSWORD` and the private key belong in the secret store.

```bash
cosign generate-key-pair
cosign sign --key cosign.key ghcr.io/bbengt1/flowforge-api@sha256:DIGEST
cosign verify --key cosign.pub ghcr.io/bbengt1/flowforge-api@sha256:DIGEST
```

`deploy/kyverno/flowforge-verify-images-key.example.yaml` is the admission shape for that public key. It is not applied. Substitute `REPLACE_WITH_COSIGN_PUBLIC_KEY` and keep `validationFailureAction: Enforce`. Do not apply it beside the keyless policy.

### Admission

1. `kubectl apply -k deploy/admission` installs an in-tree `ValidatingAdmissionPolicy` (Kubernetes 1.30+) that denies mutable FlowForge tags. It does not check signatures and does not need Kyverno.
2. Install Kyverno 1.11 or newer. This repo does not install it. Then `kubectl apply -k deploy/kyverno`. The policy is `Enforce` with `failurePolicy: Fail`. It requires a keyless signature, a SLSA provenance v1 attestation, and a digest (`verifyDigest: true`, `mutateDigest: false`). The cluster needs egress to `rekor.sigstore.dev`. If Kyverno cannot evaluate the webhook, the API server denies the pod.
3. Replace the all-zero digest in `deploy/k8s` with the signed digest, then `kubectl apply -k deploy/k8s`. `background: false` means already-running pods are not evicted; a rollout is what admission sees. Workloads applied without steps 1 and 2 are not admission-closed.

The script-runner Job template (`deploy/kubernetes/script-runner-deployment.yaml`, copied into the API binary) keeps `ghcr.io/bbengt1/flowforge-script-runner:foundation` as an identity check. The runner rewrites each created Job to `ghcr.io/bbengt1/flowforge-script-runner@<runtime profile imageDigest>` before submit. Put the signed script-runner digest in the runtime profile. Do not apply the template, and do not change its tag unless `ScriptRunnerImageRef` changes with both template copies.

GHCR may expose attestations only on the fallback tag `sha256-<digest>`, not the Referrers API. If Kyverno denies an image that `cosign verify-attestation` accepts, that is a verifier gap to fix in the cluster build. Do not flip the policy to `Audit`.

Repository Actions permissions must allow this workflow to write packages and attestations. A token that cannot push fails the `publish-images` job. That failure is the closed path.
