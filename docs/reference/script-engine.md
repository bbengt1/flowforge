# Script engine

## Purpose

The script engine runs Python and Go automation as isolated workflow nodes. It supports authored code without granting host access, arbitrary package installation, or implicit credentials.

## Node contract

`script.python` and `script.go` YAML nodes contain source, `entrypoint`, resource limits, timeout, declared input/output schema, and an approved runtime/dependency profile. Source is visible and versioned with the workflow; secrets are always injected at runtime through scoped handles and are never serialized into YAML or logs.

On publish, FlowForge validates source and configuration, packages it into an immutable content-addressed artifact, scans/signs the package, and records the artifact digest on the workflow version. Execution uses that digest, not mutable draft source. A UI save writes the same YAML schema; publish is the artifact creation boundary.

## Execution boundary

`API validation and policy → publish signed artifact → pin workflow/artifact digests → durable queue → isolated short-lived runner → redacted result/audit event`.

Runners use a non-root UID, read-only root filesystem, ephemeral writable workspace, CPU/memory/process/time limits, dropped Linux capabilities, `no_new_privs`, and default-deny egress. They have no host Docker socket, cloud-instance metadata access, or Kubernetes service-account mount unless explicitly authorized by node policy. Any approved egress uses destination/port allowlists and DNS resolution is constrained to those destinations. Python runs from an approved digest-pinned image and locked dependency profile; Go runs a precompiled signed binary built from the published source in a controlled builder. The runner verifies the artifact digest, signature, and required clean scan status immediately before execution. Runtime package installation and arbitrary base images are MVP non-goals.

Inputs arrive as validated JSON against the declared `inputSchema` and a 16 KiB cap; secret keys and plaintext credentials are rejected before inject. Outputs must meet the declared `outputSchema` and the same size limit, then are redacted before persist/audit. Environment variables expose only an allowlisted runtime context (`FLOWFORGE_*`). Credential handles are short-lived, scoped, and never serialized as plaintext.

## Authorization and reliability

FlowForge requires `workflow.execute`, `script.run`, and runtime-profile access; elevated network, credential, or Kubernetes access needs explicit policy approval. Each run audits source/artifact digests, runtime profile, policy revision, actor, input/output schema validation, resource use, outcome, and correlation ID.

Retries are zero by default. A node may be retry-safe only when it declares `retrySafe`, an `idempotencyKey`, and `verification.behavior=declared-hook` plus a bounded `retryPolicy.maxAttempts` (1–5). Worker lease loss produces an indeterminate status until that hook resolves it; FlowForge does not rerun a potentially side-effecting script automatically. `onMatch` defaults to `already-applied`, `onMismatch` to `safe-to-retry`, and `onError` is `indeterminate`.

## Initial implementation layout

E9.1 packages, scans, signs, and pins. E9.2 runs isolated short-lived runners (`VerifyForDispatch` then `Execute`). E9.3 validates typed I/O, injects scoped handles, redacts outputs, and treats lease loss as indeterminate until a declared verification hook. E9.4 revokes artifacts (`POST /scripts/{id}/revoke`) and emergency-stops running scripts (`POST /executions/{id}/emergency-stop`). `VerifyForDispatch` rechecks signature, scan, and `revoked_at` at start, claim, heartbeat-before-dispatch, and Execute. Uncertain stop stays `indeterminate`.

```text
apps/api/internal/scripts/
  model.go source.go validator.go package.go signer.go scan.go
  policy.go runtime.go redaction.go catalog.go pipeline.go
  isolation.go egress.go execute.go harness.go builder.go
  io.go handle.go env.go retry.go
  revoke.go stop.go
  store.go memory.go postgres.go
apps/api/internal/workflow/script_contract.go
apps/api/internal/httpapi/script.go
apps/api/migrations/000013_script_artifacts.sql
apps/api/migrations/000014_script_revocation.sql
deploy/kubernetes/
  script-runner-deployment.yaml
  script-runner-networkpolicy.yaml
```

Runtime profiles stay ops-config `kind=runtime_profile` (E4.2): digest-pinned `imageDigest` + `dependencyLockDigest`, required `limits.{cpuMillis,memoryMib,timeoutSeconds,processes}`, optional `egress.destinations` (default-deny; DNS is constrained). Python uses that image+lock. Go is a precompiled signed binary from a controlled builder; CI uses a documented stub (`StubBuilder`) that still enforces isolation gates. Full containers are not started in `go test` — `HarnessRuntime` asserts UID / read-only root / dropped caps / `no_new_privs` / metadata / egress / limits / package-install. Production pods use `deploy/kubernetes/script-runner-*.yaml` (non-root 65532, no SA token, no docker.sock, default-deny NetworkPolicy + kube-system DNS).

## Required validation

- YAML/node, source, entrypoint, runtime-profile, input/output-schema, and size-limit tests.
- Package digest, signing, mutable-artifact rejection, and secret-redaction tests.
- Runner isolation tests for UID, filesystem, capabilities/`no_new_privs`, metadata-service denial, egress allowlists, resource limits, signature/scan verification, and disallowed package installation.
- Python execution and Go build/binary tests using approved fixtures only.
- Authorization, tenancy, audit, retry/indeterminate-state, and PostgreSQL persistence tests.
