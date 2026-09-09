# SSH engine

## Purpose

The SSH engine runs approved remote operating-system operations as a workflow node. It is not an interactive terminal and does not accept arbitrary user-provided shell commands.

## Node contract

`ssh.run` requires a workspace-scoped `sshTargetId`, `commandProfileId`, optional typed `parameters`, bounded `timeoutSeconds`, and an explicit retry policy. The saved YAML contains references and values only; SSH keys, passwords, host fingerprints, connection settings, and raw logs remain outside the workflow definition.

Command profiles are administrator-owned, versioned templates with typed parameter constraints. Parameter values are passed without shell interpolation where the transport permits it; otherwise a reviewed profile renderer owns fixed quoting and rejects values outside its schema. A profile cannot be edited in place after a workflow version references it; publication pins the exact target and profile revisions used at execution.

## Execution flow

`API authorization and policy → pin target/profile revision → queue durable step → isolated worker retrieves ephemeral credential → known-host verified SSH connection → bounded command → redacted result and audit event`.

The worker never exposes an interactive shell. It uses key authentication, verified known-host fingerprints, connection/command timeouts, explicit host and port allowlists, and a non-root remote account where supported. A target's hostname is resolved through an approved resolver; every resolved address must be allowlisted and the connection is made only to that verified address, preventing DNS rebinding or target-hostname SSRF. Password authentication, agent forwarding, port forwarding, proxy commands, and host-key auto-acceptance are disabled in MVP.

## Authorization and reliability

FlowForge requires `workflow.execute`, `ssh.run`, `sshTarget.use`, and `commandProfile.use`; target policy can further restrict profiles, users, environments, and approvals. Each run records workspace, target, profile revision, parameter names (redacted values where sensitive), actor, host-embed context, correlation ID, exit outcome, and artifact references.

Automatic retries default to zero because remote side effects may not be idempotent. A profile may explicitly mark itself retry-safe (`retrySafe=true`) **and** declare an idempotent `verification` probe plus a bounded `retryPolicy.maxAttempts` (1–5). If the worker loses its lease after dispatch, or the provider outcome is unknown, FlowForge reports `indeterminate` until that probe confirms remote state; it never blindly repeats the mutating command.

Verification contract: `verification.template` is a reviewed `{name}` probe using the same `parameterSchema`. `onMatch` defaults to `already-applied` (resolve success, do not re-run). `onMismatch` defaults to `safe-to-retry` (allow one more mutating attempt). `onError` is `indeterminate`. Step/execution retry APIs use the same rules and return `retry-denied` when they are not met.

## Initial implementation layout

E8.1 (control-plane) lives on the E4.2 ops-config store. Isolated execution is E8.2.

```text
internal/ssh/
  model.go target.go schema.go render.go policy.go catalog.go
  errors.go handle.go resolve.go client.go execute.go redaction.go audit.go
  retry.go verify.go
internal/workflow/ssh_contract.go
internal/opsconfig/          # ssh_target + command_profile kinds, pins
internal/httpapi/opsconfig.go
GET /api/v1/ssh/catalog
```

E8.2 worker isolation: ephemeral credential handle (privateKey never exported), known-host fingerprint verification (mismatch fails closed), approved resolver + allowlist of every resolved address, connect only to the verified IP, key-only auth, bounded timeouts, non-root remote account (default `flowforge`). Password auth, agent/port forwarding, proxy commands, host-key auto-accept, and interactive shells are hard-denied.

E8.3 retry/indeterminate: `retryPolicy.maxAttempts` defaults to 0 everywhere (node, catalog, evaluate, retry APIs). Retries require pinned `retrySafe` + `verification` + remaining attempts. Lease loss / unknown outcome → `indeterminate` (never a silent re-run). A later attempt runs the probe first; `already-applied` succeeds without re-running.

## Required validation

- YAML/node shape and parameter-schema tests.
- Target/profile/RBAC/workspace isolation tests.
- Known-host mismatch, DNS-rebinding/address-allowlist, timeout, credential-redaction, and indeterminate-result tests.
- Fake SSH server tests for approved execution and denied forwarding/auth methods.
- PostgreSQL tenancy, audit, idempotency, and retry-safety tests.
