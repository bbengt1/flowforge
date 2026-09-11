# MVP workflow model

## Resources

| Resource | Purpose |
| --- | --- |
| Workspace | Tenant/project isolation boundary. |
| User and role binding | Workspace-scoped authorization. |
| Credential | Typed encrypted reference; plaintext is never returned. |
| Workflow and version | Draft graph plus immutable published/executed definitions. |
| Trigger | Manual, webhook, or schedule entry point. |
| Execution and step run | Version-pinned run, state, attempts, and redacted output. |
| Artifact | Retained output/log payload governed by retention policy. |
| Audit event | Append-only actor, action, resource, outcome, and correlation record. |

## Initial nodes

1. Manual, webhook, and schedule triggers.
2. Kubernetes get/list, apply, and rollout-status actions.
3. SSH execution against allowlisted targets and approved command profiles.
4. Python and Go source that is packaged into an immutable approved script artifact when published.
5. Condition, transform, delay, notification, and outbound webhook controls.

The [standard action catalog](action-catalog.md) is the maintained inventory of action types, ports, policies, and delivery phases.

## Trigger and execution safety

Triggers select an immutable published workflow version; drafts are never runnable.
Webhook triggers use a separate rotatable secret and replay-resistant signature
verification before payload parsing. Schedules are timezone-explicit and declare
misfire, overlap, and maximum catch-up behavior; the safe default is no catch-up
and one active execution. Trigger payloads map only allowlisted fields into typed
inputs and cannot supply credentials, policy overrides, target IDs, raw YAML, or
node configuration.

An idempotency key is required for manual and external starts. It is unique within
`(workspace, workflow version)` for a documented retention window and bound to a
fingerprint of the authenticated caller/trigger and normalized input. Reusing a
key with different input or caller context fails; it never attaches work from one
caller to another.

## Canonical workflow definition

Every draft and version stores its workflow graph as the versioned YAML document defined in the [workflow YAML schema](workflow-yaml-schema.md). The web editor projects that document into a canvas and serializes edits back into the same schema; it must not maintain an incompatible UI-only graph format. Optional `metadata.ui.layout` (D1) is a non-authoritative position hint on that same document — never a second canvas file — and is ignored by the executor.

The graph is composable: Kubernetes, SSH, script, condition, and notification nodes all expose typed ports. Edges explicitly pass a validated output from one YAML object into a compatible input of another, producing larger workflows without implicit shared state.

## Actions and workflows

FlowForge has one automation model:

- An **action** is one atomic typed node, such as `kubernetes.apply`, `ssh.run`, or `script.python`.
- A **workflow** is a versioned YAML graph containing one or more actions connected by explicit edges.

A single-action workflow is valid and uses the same authoring, policy, versioning, execution, audit, and API contracts as a multi-action workflow. It is not a separate persisted resource or execution engine. This keeps UI, RBAC, scheduling, retry, and observability behavior consistent as a simple action grows into a larger automation.

## Acceptance criteria

- A workflow executes the immutable version selected at start time.
- Exporting YAML, importing YAML, opening the visual editor, saving without edits, and saving a visual edit preserve the same valid schema and semantics.
- Every execution and credential lookup is scoped to one workspace.
- External/manual starts use an idempotency key; duplicate `(workspace, workflow version, key)` starts do not repeat work.
- Webhooks reject invalid, expired, or replayed signatures before parsing; all trigger types enforce bounded input, rate/concurrency limits, and version pinning.
- Step logs, inputs, outputs, errors, and audit records redact secrets.
- Kubernetes actions use workspace service accounts, namespace allowlists, and least-privilege RBAC.
- Kubernetes apply validates multi-document YAML against the Kubernetes API server with a server-side dry run before it persists any change; force ownership transfer is never automatic.
- SSH and script nodes resolve only workspace-scoped target/credential/artifact references. Their YAML may contain non-secret, workspace-scoped resource UUID references, but never keys, tokens, execution IDs, opaque runtime handles, or execution logs.
- SSH uses key authentication, known-host validation, host/command allowlists, and time limits.
- Script runners use approved/signed artifacts only; no host Docker socket, root user, writable system filesystem, arbitrary package install, or unrestricted egress.
- Workers persist a lease/heartbeat before work; retry behavior is bounded and defaults to disabled for arbitrary SSH/script side effects.
- Failures of authorization, signature verification, policy, artifact verification, or redaction fail closed before a provider call; uncertain side effects become `indeterminate`, never assumed absent.
