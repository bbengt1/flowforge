# Script engine

## Purpose

The script engine runs Python and Go automation as isolated workflow nodes. It supports authored code without granting host access, arbitrary package installation, or implicit credentials.

## Node contract

`script.python` and `script.go` YAML nodes contain source, `entrypoint`, resource limits, timeout, declared input/output schema, and an approved runtime/dependency profile. Source is visible and versioned with the workflow; secrets are always injected at runtime through scoped handles and are never serialized into YAML or logs.

On publish, FlowForge validates source and configuration, packages it into an immutable content-addressed artifact, scans/signs the package, and records the artifact digest on the workflow version. Execution uses that digest, not mutable draft source. A UI save writes the same YAML schema; publish is the artifact creation boundary.

## Execution boundary

`API validation and policy → publish signed artifact → pin workflow/artifact digests → durable queue → isolated short-lived runner → redacted result/audit event`.

Runners use a non-root UID, read-only root filesystem, ephemeral writable workspace, CPU/memory/process/time limits, dropped Linux capabilities, `no_new_privs`, and default-deny egress. They have no host Docker socket, cloud-instance metadata access, or Kubernetes service-account mount unless explicitly authorized by node policy. Any approved egress uses destination/port allowlists and DNS resolution is constrained to those destinations. Python runs from an approved digest-pinned image and locked dependency profile; Go runs a precompiled signed binary built from the published source in a controlled builder. The runner verifies the artifact digest, signature, and required clean scan status immediately before execution. Runtime package installation and arbitrary base images are MVP non-goals.

Inputs arrive as validated JSON; outputs must meet the declared schema and size limit. Environment variables expose only an allowlisted runtime context. Credential handles are short-lived, scoped, and redacted before output persistence.

## Authorization and reliability

FlowForge requires `workflow.execute`, `script.run`, and runtime-profile access; elevated network, credential, or Kubernetes access needs explicit policy approval. Each run audits source/artifact digests, runtime profile, policy revision, actor, input/output schema validation, resource use, outcome, and correlation ID.

Retries are zero by default. A node may be retry-safe only when it declares an idempotency key and verification behavior. Worker lease loss produces an indeterminate status until a safe verification hook resolves it; FlowForge does not rerun a potentially side-effecting script automatically.

## Initial implementation layout

E9.1 (this story) implements the control-plane publish pipeline only. E9.2–E9.4 remain hooks (`VerifyForDispatch`, `RunnerNotImplemented`, `revoked_at`).

```text
apps/api/internal/scripts/
  model.go source.go validator.go package.go signer.go scan.go
  policy.go runtime.go redaction.go catalog.go pipeline.go
  store.go memory.go postgres.go
apps/api/internal/workflow/script_contract.go
apps/api/internal/httpapi/script.go
apps/api/migrations/000013_script_artifacts.sql
```

Runtime profiles stay ops-config `kind=runtime_profile` (E4.2): digest-pinned `imageDigest` + `dependencyLockDigest`. Isolated runner manifests (`deploy/kubernetes/script-runner-*.yaml`) are E9.2.

## Required validation

- YAML/node, source, entrypoint, runtime-profile, input/output-schema, and size-limit tests.
- Package digest, signing, mutable-artifact rejection, and secret-redaction tests.
- Runner isolation tests for UID, filesystem, capabilities/`no_new_privs`, metadata-service denial, egress allowlists, resource limits, signature/scan verification, and disallowed package installation.
- Python execution and Go build/binary tests using approved fixtures only.
- Authorization, tenancy, audit, retry/indeterminate-state, and PostgreSQL persistence tests.
