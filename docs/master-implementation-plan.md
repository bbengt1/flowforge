# FlowForge master implementation plan

## Purpose and planning rules

This is the issue-creation backlog for the documented MVP. It turns the product and security references into small, independently testable stories. Product scope comes from the [architecture](architecture.md), while the reference documents remain normative for the detailed contracts.

### Non-negotiable MVP rules

- PostgreSQL is the durable source of truth; the queue, leases, execution state, audit events, and artifact metadata survive pod loss.
- Every workspace-owned read, write, credential lookup, queue job, cache key, realtime subscription, and audit event is scoped by a server-derived workspace ID.
- YAML is the only persisted workflow definition. Canvas and YAML round-trip through normalized YAML; drafts never execute and published versions are immutable.
- Credentials are encrypted, never stored in YAML/browser state/logs, and are resolved only as scoped worker handles.
- Provider calls fail closed. Lost leases or uncertain side effects produce `indeterminate`, never an assumed safe retry.
- MVP excludes arbitrary shells, package installation, free-form Kubernetes proxying, shared tenant instances filtered only in the UI, and a connector marketplace.
- Catalog entries marked **Next** or **Provider** (including `workflow.call`) are registry-disabled for MVP. They require a separately approved epic with their own contract, migration, threat review, and release gate before the UI can expose or publish them.

## Agile issue hierarchy

Create one GitHub epic per row below. Create the listed stories in sequence within an epic, linking every story to its parent epic and its prerequisites. A story should be no larger than one vertical, reviewable capability; split UI/API/worker work only when they can be validated independently.

| Order | Epic | Outcome | Depends on |
| --- | --- | --- | --- |
| E1 | Platform foundation | Deployable Go/Next.js/PostgreSQL baseline with health and observability | — |
| E2 | Workspace identity and RBAC | Server-enforced workspace isolation and least privilege | E1 |
| E3 | Workflow domain and YAML contract | Versioned, validated, canonical workflow definitions | E1, E2 |
| E4 | Credentials, targets, and policy | Encrypted, workspace-scoped operational configuration | E2 |
| E5 | Durable execution control plane | Idempotent, leased workflow execution with auditability | E2, E3, E4 |
| E6 | Authoring and operations UI | Accessible workflow authoring and safe execution visibility | E2–E5 |
| E7 | Kubernetes engine | Policy-controlled Kubernetes reads, apply, and rollout observation | E5 |
| E8 | SSH engine | Allowlisted, profile-controlled remote operations | E5 |
| E9 | Script engine | Published, signed, isolated Python and Go execution | E5 |
| E10 | Triggers and approvals | Safe manual, webhook, schedule, and approval workflow starts | E5, E6 |
| E11 | Embedding and Portal adapter | Signed, tenant/workbench-local embedded FlowForge surface | E2, E6 |
| E12 | Production readiness | Proven security, recovery, capacity, and operator readiness | E1–E11 |

## Issue-ready stories

### E1 — Platform foundation

1. **Bootstrap the deployable application skeleton.** Create the Next.js UI, Go API, PostgreSQL connection/migration harness, configuration template, container builds, and versioned `/api/v1` health/readiness endpoints.
   - Accept when a clean environment starts UI, API, and PostgreSQL; migrations are repeatable; health distinguishes dependency failure; configuration has no hard-coded secrets.
2. **Establish API, error, and observability conventions.** Add request correlation, structured secret-free logging, RFC 9457 problem responses, OpenAPI generation/publishing, and baseline metrics.
   - Accept when invalid/authenticated requests return documented problem details and every API-to-worker flow can be traced by correlation ID.
3. **Ship deployment and supply-chain safety defaults.** Define non-root containers, resource limits, TLS/proxy configuration, network policies, secure headers, dependency/image provenance and vulnerability gates, backup encryption, and restore-test automation.
   - Accept when deployment manifests enforce the defaults, builds reject unapproved or vulnerable artifacts under the documented policy, and a restore rehearsal proves state recovery.

### E2 — Workspace identity and RBAC

1. **Model workspaces, users, roles, and permissions.** Implement workspace membership, unique `(tenant_id, workbench_key)` workspace identity, and deny-by-default permission checks for every resource/action.
   - Accept when a permission matrix covers view, edit, publish, execute, credential, approval, and administration actions, and uniqueness/authorization tests reject ambiguous or host-supplied workspace identity.
2. **Enforce workspace isolation end to end.** Apply server-derived workspace scope to database queries/RLS, API routes, caches, jobs, artifacts, realtime channels, and audits. Use `FORCE ROW LEVEL SECURITY`, transaction-local scope set only after authorization, pool reset on checkout, and composite `(workspace_id, id)` foreign keys (or an equivalent partition-safe constraint).
   - Accept when negative tests prove cross-workspace reads, writes, subscriptions, credential use, and artifact access fail; unset/stale pooled session scope returns no rows; and a valid UUID from another workspace cannot be attached through a foreign key.
3. **Implement secure browser session controls.** Add secure cookie session handling, CSRF defense, CORS/CSP policy, session expiry, and audit logging.
   - Accept when CSRF, hostile origin, stale session, and privilege-escalation tests fail closed.

### E3 — Workflow domain and YAML contract

1. **Implement canonical workflow YAML parsing and normalization.** Define typed graph schema, node/port compatibility, safe parser limits, normalization, digesting, and actionable validation errors.
   - Accept when malformed YAML, unsupported tags/templates, cycles/disconnected nodes, invalid ports, and unsafe references are rejected; valid definitions normalize deterministically.
2. **Implement drafts, immutable publishing, and version history.** Support create, update, conflict-safe draft save, publish, immutable export, compare, and restore-as-new-draft.
   - Accept when drafts cannot run and an execution remains pinned to its selected version/digest after later edits.
3. **Implement core neutral nodes.** Deliver condition, delay, data set/map/validate, and flow stop/fail node contracts. Triggers remain workflow-level entries, not graph nodes.
   - Accept when each node has typed ports, bounded inputs/outputs and aggregation, policy metadata, redaction, data classification, and deterministic unit/integration coverage.

### E4 — Credentials, targets, and policy

1. **Build the encrypted credential vault.** Add typed credential metadata, encryption/key management integration, rotation, disablement, safe test status, usage visibility, and deletion impact reporting.
   - Accept when plaintext is absent from APIs, browser state, YAML, jobs, logs, metrics, and audit records.
2. **Implement versioned operational configuration.** Add workspace-scoped cluster targets, SSH targets, command profiles, runtime profiles, connections, recipient lists, message templates, response schemas, and policies with immutable published revisions.
   - Accept when a workflow/execution pins exact referenced versions; endpoint, recipient, template, and schema selection is server-authorized; and no cross-workspace resource can be used.
3. **Implement policy evaluation and approvals boundary.** Evaluate target/action policy before dispatch and produce approval requirements bound to workflow version, target, policy revision, operation, and expiry.
   - Accept when a changed policy/target/version invalidates a prior approval and authorization is rechecked server-side.

### E5 — Durable execution control plane

1. **Persist executions, steps, jobs, and audit events.** Implement the documented PostgreSQL model, indexes, retention, and workspace-scoped query APIs.
   - Accept when `(workspace, workflow version, idempotency key)` duplicates do not repeat work and sensitive outputs are redacted before persistence.
2. **Implement durable dispatch, authenticated jobs, leases, fencing, and recovery.** Add queued jobs with workspace/version/policy/expiry binding, single active claim, heartbeat, lease expiry, fencing tokens, cancellation, and retry policy.
   - Accept when workers reject altered, expired, or cross-workspace jobs; worker crash/lease-loss tests prevent duplicate provider calls; cancellation is idempotent and separately authorized; and unsafe outcomes become `indeterminate`.
3. **Implement execution status and artifact access.** Provide redacted step state, bounded logs/output, encrypted artifact metadata, short-lived authorized downloads, and retention deletion.
   - Accept when unsafe artifact content is rejected before upload, artifact authorization is re-evaluated per request, retention removes metadata and object payload, and authorized legal holds preserve evidence with an audit trail.
4. **Protect audit integrity and operational alerts.** Make audit records append-only to normal application roles and emit actionable signals for authorization, replay, policy, and redaction failures.
   - Accept when mutation/tamper attempts fail, alert routing is exercised with safe fixtures, and alerts contain correlation/resource identifiers but no secret material.

### E6 — Authoring and operations UI

1. **Build the RBAC-aware workspace shell and workflow home.** Deliver switcher, navigation, safe global search, workflow list/filtering, templates, status, and command palette.
   - Accept when inaccessible capabilities and secret content are never displayed or searchable.
2. **Build synchronized YAML and canvas editing.** Deliver action library, typed ports/edges, inspector, validation navigation, YAML editor, import/export, and save normalization loop.
   - Accept when opening/saving/importing/editing preserve canonical YAML semantics; invalid YAML never renders a guessed graph; and the action registry only exposes enabled implementations, rejecting unavailable actions at publish.
3. **Build guided action and credential authoring.** Deliver action wizard, credential vault screens, policy/approval previews, and optimistic pending/success/error feedback.
   - Accept when selectors show only authorized resources and sensitive values are masked and cleared after submission, never persist in browser state, URLs, logs, snapshots, or analytics, and create/rotate/test flows prove that boundary.
4. **Build execution history and replay.** Deliver published-version run flow, pre-run review, graph replay, approvals, safe retry/cancel actions, redacted logs, version/execution comparison, and accessible keyboard/screen-reader behavior.
   - Accept when `indeterminate` state is unmistakable; approval controls remain disabled until E10 is enabled; and UI tests cover keyboard-only authoring and error navigation.

### E7 — Kubernetes engine

1. **Implement cluster target and Kubernetes policy management.** Restrict targets to workspace credentials, namespace/kind/verb policy, and least-privilege service accounts.
2. **Implement Kubernetes read/apply nodes.** Validate manifests, policy, server-side dry-run, then server-side apply without automatic force ownership transfer.
3. **Implement rollout observation and audit.** Add bounded Deployment/StatefulSet/DaemonSet/Job observation, cancellation/timeout, redacted results, and audit snapshots.
   - Epic accepts when fake-client and `envtest` cases cover policy/RBAC denial, dry-run, fixed field manager/`Force=false`, conflict, rollout failure, tenancy, and worker network isolation; reject Secret data, cluster-scoped resources, namespaces, CRDs, RBAC, admission webhooks, privileged/host namespace/`hostPath` workloads, capability escalation, mutable or nonallowlisted images, and unsafe Ingress hosts/TLS/backends/annotations.

### E8 — SSH engine

1. **Implement SSH target and immutable command-profile management.** Enforce typed parameters, reviewed rendering with no raw shell interpolation, target/profile pinning, and workspace RBAC.
2. **Implement isolated `ssh.run`.** Use ephemeral keys, verified known hosts, DNS/address allowlists, key-only auth, time bounds, and no forwarding/proxy/interactive shell.
3. **Implement SSH indeterminate/retry semantics.** Default retries to zero; allow only profile-declared retry-safe operations with verification.
   - Epic accepts when fake-server tests cover host mismatch, DNS rebinding, adversarial parameter injection, denied auth/forwarding, timeout, redaction, tenancy, audit, and lease loss.

### E9 — Script engine

1. **Implement script source validation and publish pipeline.** Package approved Python/Go source, scan/sign it, pin immutable content-addressed artifacts, and reject mutable/unscanned artifacts.
2. **Implement isolated script runners.** Enforce non-root/read-only execution, resource limits, dropped capabilities, `no_new_privs`, no metadata service/socket, controlled egress, and approved runtime images/dependency locks.
3. **Implement typed script I/O and recovery.** Validate schemas/size limits, inject only scoped handles, redact outputs, and handle retries/lease loss safely.
4. **Implement artifact revocation and emergency stop.** Propagate artifact revocation before every dispatch and define the authorized emergency-stop behavior for a running script.
   - Accept when revoked artifacts cannot start, dispatch rechecks signature/scan/revocation state, and an emergency stop is policy-gated, audited, and leaves an uncertain provider outcome `indeterminate` until verified.
   - Epic accepts when isolation, signing, egress, package-install denial, Python/Go fixtures, authorization, tenancy, and indeterminate-state tests pass.

### E10 — Triggers and approvals

1. **Implement authenticated manual starts.** Require published version selection, bounded typed input, idempotency key, authorization, and audit.
2. **Implement replay-safe webhooks.** Add opaque trigger IDs, rotatable secret references, raw-body signature validation before parsing, timestamp/replay protection, limits, rate/concurrency controls, and field mapping.
3. **Implement schedules and approvals.** Add timezone-explicit schedules with safe catch-up/overlap defaults plus durable `flow.approval` wait/resume/expiry, typed ports, publish-time validation, and separation-of-duties checks.
   - Accept when approvals bind the exact workflow version, target, operation, and policy snapshot; requester self-approval is denied; changed state invalidates approval; fresh authorization is required to decide; and wait state survives worker/pod loss.
4. **Implement core HTTP and notification actions.** Add `http.request`, `notification.webhook`, and `notification.email` using pinned, authorized connection/template/recipient/schema resources.
   - Accept when HTTP and webhook delivery use normalized endpoint, destination-IP, redirect, method/path, TLS, request/response-size, and secret-field policies; emails use approved recipient/template revisions; and all delivery results are redacted/audited.
   - Epic accepts when all trigger and integration paths are version-pinned, bounded, auditable, and cannot bypass policy or authorization.

### E11 — Embedding and Portal adapter

1. **Define and implement the versioned embed SDK/contract.** Mount the canonical UI through stable routes/deep links and exchange a short-lived, asymmetric signed, audience-bound, single-use assertion.
2. **Implement independent embed validation and tenancy propagation.** Validate issuer/audience/time bounds including `nbf`, token ID/capabilities/workspace, atomic one-time token-ID consumption with TTL, and active/overlap key rotation in FlowForge; propagate `(tenant_id, workbench_key)` through UI, API, configuration, jobs, workers, caches, realtime, history, and audit.
3. **Implement the CP Ops Portal adapter.** Replace/adapt its protected workflow surface without sharing FlowForge database or executor; keep Portal entry RBAC separate from FlowForge authorization.
   - Epic accepts when hostile host context, replayed assertions, cross-tenant/workbench access, and raw-log/credential exposure tests fail.

### E12 — Production readiness

1. **Run the security verification suite.** Cover identity/session/embed replay and key rotation, webhook safety, cross-workspace isolation, approval expiry, credential and artifact revocation, artifact/output authorization/redaction/legal holds, stale-worker fencing, provider failure behavior, SSRF/redirect/DNS-rebinding denial, and dependency/image provenance gates.
2. **Prove operational resilience and capacity.** Run backup/restore, worker-loss/recovery, queue lag, migration serialization, and load tests; document at least 2× observed peak headroom for database connections/writes, queue lag, and storage growth.
3. **Prepare release and operations documentation.** Publish API/OpenAPI, deployment, configuration, incident/recovery, retention, backup, and operator/admin guides; perform an accessibility and threat-model review before production approval.

## Story definition of ready

Before creating an issue, include: user/operator outcome; in/out of scope; parent epic and dependencies; API/YAML/data/UI impact; authorization and abuse-case analysis; acceptance criteria; test approach/fixtures; documentation changes; migration/rollout/rollback plan; and measurable observability/operational signals.

## Story definition of done

A story is done only when its acceptance criteria pass, negative tenancy/security cases are covered, API/OpenAPI and YAML contracts agree, migrations are tested, UI is accessible where applicable, logs/audits are secret-free, impacted docs (including this plan when scope changes) are updated, and validation evidence is attached to the issue/PR.

## Release gates

1. **Foundation gate:** E1–E5 pass before any provider action is enabled.
2. **Provider gate:** enable Kubernetes, SSH, and scripts independently only after their dedicated negative/security/isolation suites pass.
3. **Integration gate:** feature-flag `http.request`, webhook delivery, and email until their endpoint/recipient policy, SSRF/redirect/DNS-rebinding, TLS, secret-field, retry, and redaction suites pass.
4. **Embed gate:** enable Portal embedding only after signed assertion, one-time replay, key-rotation, and tenant/workbench propagation tests pass.
5. **Production gate:** E12 evidence, threat review, restore rehearsal, and capacity headroom are approved; otherwise affected features remain disabled.
