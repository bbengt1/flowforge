# Standard action catalog

## Contract

Every action is a typed node in canonical `flowforge/v1` YAML. It declares typed input/output ports, a bounded `with` configuration, a permission/policy requirement, retry-safety behavior, and a redacted audit result. An action may form a single-action workflow or compose with other nodes through explicit edges; it never becomes a separate execution model. Triggers are workflow-level `spec.triggers` entries, not graph nodes; their canonical shape is defined in the [workflow YAML schema](workflow-yaml-schema.md).

This catalog distinguishes **core** nodes (first implementation target), **next** nodes (planned after execution safety is proven), and **provider** nodes (connector-specific work). A visible catalog entry does not imply access: the UI lists only actions enabled for the workspace and principal, and the API independently authorizes every request and dispatch.

## Triggers and workflow lifecycle

| Trigger type | Phase | Purpose | Key rules |
| --- | --- | --- | --- |
| `manual` | Core | User starts a published workflow. | Captures actor, optional input schema (`schema` / `inputSchema`), idempotency key, and version digest. Start is `POST /workflows/{id}/executions` with `workflow.execute`, CSRF, and a published `workflowVersionId`. |
| `webhook` | Core | Authenticated external event starts a workflow. | Opaque `publicId` (`wh_`+64 hex); rotatable vault `webhook_secret` (never returned); `POST /hooks/{publicId}` reads the raw body and verifies `v1` HMAC over `v1.{timestamp}.{raw}` before JSON parse; timestamp/replay, size/rate/concurrency limits; allowlisted field mapping into 16 KiB typed input; E10.1 idempotency/fingerprint start. Fail closed on bad sig, replay, skew, oversize, rate, unpublished/disabled. YAML may declare only `schema` / `inputSchema` / `contentType`. |
| `schedule` | Core | Cron/timezone schedule starts a workflow. | Admin CRUD `POST /schedules` pins a published version. Timezone is a required IANA name. Safe defaults: `overlapPolicy=skip`, `misfirePolicy=ignore`, `catchUp=0`. Dispatcher `POST /schedules/dispatch` starts with E10.1 idempotency/authz/policy and fails closed when disabled/unpublished. |
| `event` | Next | Provider/event bus event starts a workflow. | Explicit subscription, source verification, and dedupe. |

### Workflow lifecycle actions

| Node | Phase | Purpose | Key rules |
| --- | --- | --- | --- |
| `workflow.call` | Next | Start a pinned child workflow version. | Declared schemas, policy checks, no recursion, full lineage audit. |
| `flow.stop` | Core | End the current execution path with success, failure, or canceled status. | Optional `status` (`success` default) and safe `message`. Stops only the current path; it cannot silently stop another execution. |
| `flow.fail` | Core | End the current execution path with a safe operator-facing failure. | Required operator `code` (DNS label or dotted token) and optional safe `message`. Must not expose internals or secrets. |

There is no generic `start` action inside a workflow: a trigger starts it. A trigger emits only its validated `event` and `context` ports into the workflow entry point. `workflow.call` is the explicit, version-pinned way to start another workflow. There is no unrestricted `stop` action for remote systems; operational stop/restart behavior belongs to an approved Kubernetes, SSH, or provider action. Cancellation of another execution is a separately authorized API/UI command, never a YAML node or port value; it requires current `execution.cancel` permission, same-workspace authorization, an idempotent audit record, and cannot cancel an approval, parent, or ancestor run unless policy explicitly permits it. Retry is a bounded policy on the action being retried, not an independently runnable `flow.retry` node; a policy is valid only for an action explicitly marked retry-safe with verification behavior, bounded attempts/backoff/jitter, and an indeterminate terminal state when verification cannot establish the outcome.

## Control flow and timing

| Node | Phase | Inputs → outputs | Policy and behavior |
| --- | --- | --- | --- |
| `flow.condition` | Core | `value` → `true`, `false` | Declarative `op` (`eq`/`ne`/`gt`/`lt`/`gte`/`lte`/`exists`/`contains`) plus literal `compare` (except `exists`) and optional dotted `path`. No expression language. Matching branch receives the inbound value. |
| `flow.switch` | Next | `value` → named cases/default | Ordered declarative cases with exactly one selected route. |
| `flow.parallel` / `flow.join` | Next | `input` → branch/join result | Explicit concurrency limit, join mode, and failure handling. |
| `flow.forEach` | Next | `items` → item results | Maximum item count/concurrency and bounded aggregation. |
| `flow.delay` | Core | `input` → `result` | ISO-8601 `duration` (weeks/days/time only, max `P7D`). Durable wake-up time; no worker sleeps or in-memory timers. |
| `flow.waitForEvent` | Next | correlation input → event/timeout | Durable subscription, timeout, and source verification. |
| `flow.approval` | Core | `request` → `approved`, `rejected`, `expired` | Required `approverRole` + `expiresIn` (max `P7D`). Durable mid-run wait (no worker lease). Binding includes version/target/policy/operation/execution. Decide is resume; self-approval denied; changed state invalidates; expiry emits `expired`. |

## Data and artifacts

| Node | Phase | Purpose | Key rules |
| --- | --- | --- | --- |
| `data.set` | Core | Create a typed literal object. | Required `value` object; optional JSON-schema subset and `classification` (`public`/`internal` only). Secret keys/values rejected. |
| `data.map` | Core | Declaratively map selected fields between schemas. | `mapping` of `dest: source` or `dest: {from, convert}`. Explicit dotted paths; no general expression language. Classification preserved. |
| `data.validate` | Core | Validate a value against a declared schema. | Required `schema` (JSON-schema subset). Safe errors identify fields, not secret content. |
| `data.merge` | Next | Combine explicitly selected typed objects. | Deterministic precedence required. |
| `data.filter` / `data.sort` | Next | Bound collections for downstream work. | Max item/output size and stable ordering. |
| `artifact.write` | Next | Persist an allowed generated file/payload. | Redaction/scan before upload, content classification, size limit, digest, retention, and encryption; reject content that cannot be safely retained. |
| `artifact.read` | Next | Read a permitted referenced artifact. | Per-request workspace/retention/access check and declared output schema; never arbitrary object-store paths, bucket credentials, or durable download URLs. |

Outputs follow declared schemas and size limits. An oversized port output fails with a safe summary; it does not automatically become an artifact. Only an explicitly eligible `artifact.write` action may create an artifact after classification, redaction/scanning, encryption, retention, and authorization checks. Artifact IDs and digests are not automatically readable port payloads.

## HTTP and integration actions

| Node | Phase | Purpose | Key rules |
| --- | --- | --- | --- |
| `http.request` | Core | Call an approved HTTP API. | Named connection credential, host/method/path allowlist, TLS verification, redirect policy, timeout, request/response schema and size limits, redaction. |
| `notification.webhook` | Core | Deliver a safe event to an approved webhook. | Credential-backed endpoint, allowlisted host, redirect policy, idempotency header, bounded retries. |
| `notification.email` | Core | Send an email through an approved mail connection. | Recipient domain/policy allowlist, template/input schema, attachment limits, safe audit metadata. |
| `notification.chat` | Next | Send Slack/Teams-style message. | Approved connection/channel allowlist and redacted output. |
| `servicenow.ticket` | Provider | Create/update/query incident or change records. | Scoped connector credential, request schema, idempotency, provider error normalization. |
| `interlink.request` | Provider | Create/read approved Interlink work. | Same connection, policy, audit, and redaction model. |

`http.request` never accepts a user-provided unrestricted URL, credentials in YAML, disabled TLS verification, or unbounded response body. Connections resolve hostnames through an approved resolver, then check every destination address (including redirects). Loopback, RFC1918/ULA, and CGNAT are denied by default; link-local and metadata addresses are always denied. Private destinations require an explicit `allowPrivateDestinations` flag on the pinned connection `endpointPolicy` or a published `kind=http` / `kind=notification` policy — unset is fail-closed. DNS rebinding cannot turn a public hostname into an internal hop. Request headers, query fields, and bodies use explicit schemas; secret-bearing inputs may cross this boundary only when the connection policy authorizes that exact field. Email/message content can interpolate only explicit typed inputs; sensitive values are excluded by default and must pass policy before delivery.

E10.4 implements the three core nodes. The live contract is `GET /api/v1/workflows/catalog` (`allowedWith`, `policy`, `bounds`, `redaction`, `integrationGate`) and `GET /api/v1/http/catalog`. The integration gate enables the nodes because the negative SSRF/redirect/DNS-rebinding/TLS/secret-field/tenancy suite is present; `INTEGRATION_ACTIONS_ENABLED=false` disables them at validate/publish.

## Operational actions

| Node | Phase | Purpose | Key rules |
| --- | --- | --- | --- |
| `kubernetes.get` / `kubernetes.list` | Core | Read approved resources. | Target, namespace, kind, and verb policy. |
| `kubernetes.apply` | Core | Server-side dry-run/apply approved manifests. | See [Kubernetes engine](kubernetes-engine.md); no force/cluster-scope in MVP. |
| `kubernetes.rolloutStatus` | Core | Observe rollout completion/failure. | Bounded watch/timeout, no implicit rollback. |
| `ssh.run` | Core | Run an approved remote command profile. | See [SSH engine](ssh-engine.md); no free-form terminal. |
| `script.python` / `script.go` | Core | Run published signed script artifact. | See [script engine](script-engine.md); isolated runtime, no arbitrary package install. |
| `service.restart` | Next | Restart a named approved service. | Provider-backed action that resolves to approved SSH/Kubernetes profile; never a raw command. |
| `health.check` | Next | Check HTTP/TCP/Kubernetes service health. | Target allowlist, bounded timeout, redacted diagnostics. |

## Credential and configuration actions

Credentials are admin-managed backend resources, not workflow output data. The Action Wizard can select a permitted credential/target/profile by display name; it cannot create or reveal plaintext in the graph.

Connections, recipient lists, templates, and response schemas are also
workspace-scoped configuration resources. The UI may display their names, but
YAML uses only their UUIDs. Publication pins the approved resource revision and
execution resolves it server-side through workspace authorization; a workflow
cannot select an arbitrary endpoint, recipient, template, or schema at runtime.

| Node | Phase | Purpose | Key rules |
| --- | --- | --- | --- |
| `credential.test` | Next | Test a credential/target connection. | Requires credential-test permission; results are redacted and auditable. |
| `configuration.read` | Next | Read a permitted non-secret runtime setting. | Workspace scope and field allowlist. |
| `configuration.write` | Next | Update an approved idempotent runtime setting. | Explicit permission, validation, approval when policy requires, and audit. |

## Common YAML examples

```yaml
- id: pause-before-change
  type: flow.delay
  name: Wait for change window
  with:
    duration: PT5M

- id: call-status-api
  type: http.request
  name: Check service status
  with:
    connectionId: 77777777-7777-4777-8777-777777777777
    method: GET
    path: /v1/status
    timeoutSeconds: 15
    responseSchemaRef: 88888888-8888-4888-8888-888888888888

- id: request-approval
  type: flow.approval
  name: Approve production rollout
  with:
    approverRole: production-approver
    expiresIn: PT30M

- id: notify-operations
  type: notification.email
  name: Email operations
  with:
    connectionId: 99999999-9999-4999-8999-999999999999
    recipientListId: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
    templateId: bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb
```

## Shared execution rules

- This catalog is an inventory, not a replacement for a node's normative contract. A core action cannot ship until its contract defines required permissions, exact `with` schema and UUID references, input/output schemas and data classifications, byte/time/rate/concurrency limits, idempotency/retry/verification/cancellation behavior, policy snapshot, and redacted audit fields. The E3.3 [core neutral node contracts](core-node-contracts.md) are that normative `with`/port/policy map for `flow.condition`, `flow.delay`, `data.set`, `data.map`, `data.validate`, `flow.stop`, and `flow.fail`; the live catalog is `GET /api/v1/workflows/catalog`.
- Every provider action uses a workspace-scoped connection/target/profile reference and resolves credentials only inside the worker.
- References to workspace-owned resources are UUIDs; labels, hostnames, recipient addresses, and provider URLs are display or policy data, never authorization keys.
- `data.set` accepts only fields classified non-sensitive by schema; secret handles/references and policy-denied literal keys or values are rejected. Classification is preserved through maps, merges, filters, and sorts and blocks unauthorized HTTP or notification delivery.
- Node configuration and incoming/outgoing port data are validated before dispatch; unknown fields fail closed.
- Side-effecting nodes require an idempotency strategy and default to zero automatic retries unless explicitly marked retry-safe.
- Each action has connection, execution, and output-size limits; cancellation stops waiting/dispatch but never assumes a remote side effect was rolled back.
- Result, log, error, artifact, and audit data are redacted before persistence. Secrets, raw credentials, internal stack traces, and unrestricted provider payloads never become port outputs.
- The UI labels planned/provider actions clearly and does not allow wiring an unavailable action into a publishable workflow.
