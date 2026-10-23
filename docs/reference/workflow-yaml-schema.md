# Workflow YAML schema

## Contract

YAML is the canonical, portable workflow definition. The API stores the validated, normalized YAML source alongside its parsed representation and content digest. The web UI renders the parsed graph, but save always produces this schema and sends it to the API.

The first document version is `flowforge/v1`. Unsupported versions fail validation; additive optional fields remain compatible within v1.

## Example

```yaml
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: restart-api-rollout
  labels:
    team: platform
spec:
  description: Restart an approved deployment and wait for it to become ready.
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: restart
      type: kubernetes.apply
      name: Restart API
      with:
        clusterTargetId: 11111111-1111-4111-8111-111111111111
        namespace: cp-ops-nprd
        dryRun: server
        fieldManager: flowforge
        wait: ready
        timeoutSeconds: 300
        manifests: |
          apiVersion: apps/v1
          kind: Deployment
          metadata:
            name: api
          spec:
            template:
              metadata:
                annotations:
                  kubectl.kubernetes.io/restartedAt: "2026-09-04T12:00:00Z"
  edges: []
  outputs:
    - name: rollout
      from: restart.result
```

## Required shape

```text
apiVersion: flowforge/v1                 # required
kind: Workflow                            # required
metadata:
  name: display title                     # required; not the stored workflow slug
  slug: DNS-label                         # optional; create writes the chosen slug
  labels: string-to-string map            # optional
  ui:                                     # optional; ignored by executor
    layout:                               # optional; non-authoritative canvas hints (D1)
      version: 1
      nodes:
        <node-id>: { x: number, y: number }  # keys are a subset of spec.nodes[].id
spec:
  description: string                     # optional
  triggers: Trigger[]                     # one or more; each selects a published version at execution time
  nodes: Node[]                           # one or more, unique IDs
  edges: Edge[]                           # optional; graph must be acyclic in MVP
  outputs: Output[]                       # optional
```

`metadata.name` is the display title. It is not the stored workflow slug. `metadata.slug` is optional. On create the API chooses a slug from the JSON `slug`, then this field, then a derivation of the display name, and writes the chosen value back here. The stored form is a lowercase DNS label of at most 63 characters (`^[a-z][a-z0-9-]{0,62}$`) and is not `catalog`, `validate`, or `normalize`. An empty `metadata.slug` is omitted. Unknown metadata keys still fail closed.

`metadata.ui.layout` is additive optional on `flowforge/v1` (D1 / issue). The API stores and returns it on validate, normalize, draft save/load, and published versions. **Executor, `POST /policy/evaluate`, port typing, and dispatch ignore it.** Node keys must match `spec.nodes[].id`; extra keys are stripped (never invent a node). Missing keys auto-place that node. Non-finite coordinates or a non-object layout are treated as absent (auto-layout). Layout never carries edges, types, `with`, credentials, or ports. Unknown keys under `metadata.ui` / `layout` besides `layout` / `version`+`nodes` still fail closed. Older documents without the field keep working. applies `summary.ui.layout` or the YAML field on canvas load and writes it back on draft save (R2.5). Embed and standalone share this API.

Each node requires `id`, `type`, and `name`; `with` contains type-specific configuration. An edge has `from` and `to` values in `nodeId.port` form. Node IDs use lower-case letters, numbers, and hyphens, begin with a letter, and remain stable when a node is renamed. Trigger, node, edge, and output IDs/references must be unique and resolvable. Resource references such as `clusterTargetId`, `sshTargetId`, `commandProfileId`, and `runtimeProfileId` are non-secret UUIDs and must resolve inside the workflow workspace; display names and hostnames are never used as authorization references.

Trigger configuration is type-specific and allowlisted. `manual` has no
user-editable security configuration. It may declare an optional JSON-schema
subset for authenticated start input (`schema`, `inputSchema`, or
`with.schema` / `with.inputSchema`). `webhook` stores an opaque generated
trigger ID (`publicId`) and rotatable vault `webhook_secret` reference outside
YAML; YAML may declare only the input schema (`schema` / `inputSchema` /
`with.schema` / `with.inputSchema`) and accepted `contentType`
(`application/json` in MVP). Field mapping, size/rate/concurrency limits, and
the HMAC secret are admin/API config, not YAML. `schedule` requires an IANA timezone, cron or
interval expression, explicit overlap policy, and bounded misfire/catch-up
behavior. Neither trigger configuration nor inputs can override workspace,
workflow version, target policy, credentials, approval, or node configuration.

`error` is a system trigger for a workspace error workflow. It takes
no fields (`with` or any other key is `unknown-field`) and must be the
workflow's only trigger (`error-trigger-not-alone`), checked at save,
`/validate` and publish. Only the engine starts it: a manual or API start of
a version with the `error` trigger is `400`, and the store refuses it from
every other start path (schedule, webhook) too.

A workspace admin names the error workflow with
`PUT /api/v1/workspace/error-workflow` `{workflowId}` (and clears it with
`DELETE`, reads it with `GET`); the workspace is the session's own workspace.
Set and clear need `workspace.administer` plus MFA step-up, and the target
must be a
published, not deleted workflow in the same workspace whose latest version's
only trigger is `error`; otherwise `400`. Each change writes
`workspace.error_workflow.set` / `.cleared` with the admin's display name and
UUID. The reference is never cleared automatically (no `ON DELETE SET NULL`).

When a run in that workspace ends, in the same transaction, the engine starts
one run of the error workflow (as a system run with no requester, trigger
type `error`) if:

- the run ended `failed` and the failure that ended it has a code onError
  could route (the allowlist and `flow.fail` literal dotted codes above), with
  reason `failed`; or the run ended `indeterminate`, with reason
  `indeterminate`;
- the run's trigger is automated (`api`, `schedule`, `webhook` or any other
  automated trigger), not `manual`, and no operator retried a step of it;
- the run is not itself an error-workflow run (no chains).

It never fires on `canceled` or `succeededWithErrors`, on a workflow delete,
or for system, security, authorization or policy codes. A run fires at most
once (unique `executions.error_parent_id`). When the configured target is
deleted, a draft, archived or no longer `error`-only at fire time, nothing
starts and `execution.error_workflow.skipped` records the reason
(`target_deleted`, `target_unpublished`, `target_disabled`,
`target_not_error_workflow`, `target_missing`); a failure code that is not
eligible is skipped with `code_not_eligible`. The error run counts against
the workspace open-run cap like any other start (`cap_reached` when full),
passes the same pre-start policy evaluation (`policy_denied`,
`approval_required`, `policy_unavailable`), and any other start error is
skipped as `start_failed`. The whole start runs in a savepoint, so a skip or
failure never changes or blocks the parent run's final status. A start writes
`execution.error_workflow.fired` on the parent (with the parent's actor id)
and `execution.start` on the error run.

The error run's input is exactly `{reason, triggerType, executionId,
workflowId, workflowName, workflowVersionId, workflowVersion, nodeId, code,
message}` describing the parent run; `code` is capped at 64 bytes and
`message` at 256 bytes. It never carries the parent's actor, input, trigger
metadata or secrets. The error run's `errorParentId` links back to the parent.

## SSH and script node examples

```yaml
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: rotate-cache
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: clear-cache
      type: ssh.run
      name: Clear cache
      with:
        sshTargetId: 22222222-2222-4222-8222-222222222222
        commandProfileId: 33333333-3333-4333-8333-333333333333
        parameters:
          service: api
        timeoutSeconds: 60
        retryPolicy:
          maxAttempts: 1
    - id: summarize
      type: script.python
      name: Summarize result
      with:
        source: |
          import json
          print(json.dumps({"status": "complete"}))
        entrypoint: main.py
        runtimeProfileId: 66666666-6666-4666-8666-666666666666
        timeoutSeconds: 30
        memoryMiB: 128
  edges:
    - from: clear-cache.result
      to: summarize.input
```

`ssh.run` requires `sshTargetId`, `commandProfileId`, and bounded parameters; it cannot contain a raw command or credential. `script.python` and `script.go` require source, entrypoint, resource limits, and `runtimeProfileId`; the referenced approved runtime/dependency profile is pinned when publishing. Publishing packages source into an immutable signed artifact and replaces no user-authored source; the resulting artifact digest is attached to the workflow version outside the user-editable YAML.

## Composable node objects

Every item in `spec.nodes` is a typed workflow object. Nodes expose named input and output ports, and `spec.edges` connects an output port to an input port. The engine validates the complete directed graph before publish: referenced nodes/ports must exist, data types must be compatible, required inputs must be satisfied, and the MVP graph must be acyclic.

An action is a node; a workflow is one or more nodes. A YAML document with one `kubernetes.apply`, `ssh.run`, or script node is therefore a single-action workflow, not a distinct action resource. The same schema and lifecycle apply whether the graph has one node or many.

All nodes share this envelope:

```yaml
id: unique-node-id
type: provider.action
name: Human-readable label
join: all                 # optional; all (default) or any
onError: stop             # optional; stop (default), continue or errorOutput
with: {}                  # node-specific, policy-validated configuration
inputs: {}                # optional defaults or literal typed inputs
```

`join` selects how a node's incoming edges combine. Omitted and `all` are AND: the step runs only when every incoming edge has resolved satisfied. If any incoming edge resolves unsatisfied, the step is skipped, and that skip resolves the step's outgoing edges as unsatisfied. `any` is OR: once every incoming edge has resolved, the step runs if at least one was satisfied and is skipped if none were. `any` is valid only on a node with at least two incoming edges. Any other value fails validation. `flow.join` stays registry-disabled; there is no separate merge node.

`onError` sets what happens when a step fails. Omitted and `stop` fail the run as before, and steps that never ran end `skipped` with `upstream_failed`. With `continue`, the step still ends `failed`, its primary output port (the node type's `primaryOutput` in the catalog, `result` today) fires with an empty object `{}`, and edges from `error` never fire. With `errorOutput`, the step ends `failed`, only the synthetic `error` port fires with `{code, message, nodeId, attempt}` (never step input or output), and every other output edge (on branching nodes, every branch) resolves as not taken, so those targets end `skipped` with `branch_not_taken`. The mode comes from the run's pinned workflow version; editing the draft later does not change a run. Lease loss (`indeterminate`), cancel, policy refusals and emergency stop are never routed. A run whose only failures were handled ends `succeededWithErrors`: it is finished, it is not retryable (a routed step refuses retry with `step_error_handled`), and it never starts an error workflow. Each routed failure writes one `step.error_routed` audit row next to the usual `job.fail`. A step's `errorHandling` field reports `continue` or `errorOutput` for a routed failure.

Per-item routing (pure core list nodes such as `data.sort`, `data.filter`, and `data.merge` evaluating in-process over `{items: [...]}`): the same S2 allowlist is checked **per item**. Only allowlisted codes route; any other code, and every indeterminate item, fails the step. With `continue`, failed routable items drop from the primary / items ports; if every item fails, an items port gets exactly `[{}]` and non-items ports keep `{}`. With `errorOutput`, routable failures go to `error` as `{code, message ≤256 B, idx, lineage}` only (no item contents). If any item routes, the **step** ends `succeededWithErrors` and the run rolls up as above. Provider nodes stay run-once; per-item idempotency is not built yet. `flow.switch` still refuses `onError: continue` (no primary output). `data.filter` allows only `errorOutput` or none until a clear `main` items port exists. Lease loss marks in-flight `unknown` items `indeterminate` and never auto-retries them. Audits stay one row per step/batch (`step.items_completed`, `step.error_routed` with counts), never item contents or expression values. Publish validation fails closed with these codes: `invalid-on-error` (any other value, including empty), `error-edge-missing` (`errorOutput` without an edge from `error`), `error-edge-without-error-output` (an edge from `error` on a step that does not set `errorOutput`), `on-error-continue-without-primary-output` (`continue` on a node type with no `primaryOutput`, such as `flow.condition` or `flow.approval`; `ssh.run` and `kubernetes.*` use `result`; the message names the node id), and `on-error-not-allowed` (on `flow.approval`, which already has `rejected`/`expired` ports, or on a trigger). Error edges are part of the graph, so the acyclic check covers them.

Only some failure codes are routed; every other failure fails the run as if `onError` were `stop` (no `step.error_routed`). Routing is an allowlist and fails closed:

- These 10 runtime codes route on any node type: `timeout`, `connect-failed`, `command-failed`, `delivery-failed`, `dry-run-failed`, `apply-failed`, `read-failed`, `rollout-failed`, `cluster-unreachable` and `script-failed`. A `flow.fail` whose `with.code` is one of them, such as `timeout`, is routed too.
- A `flow.fail` operator code routes only when it is a dotted token (for example `team.reason`) written as a literal `with.code` in the pinned version, and the failure carries exactly that code. A templated or expression `with.code` is never routed, so run input cannot choose which code routes.
- Anything else is never routed. That includes security, authorization, policy, isolation, egress, artifact and emergency-stop codes, unknown codes, codes longer than 64 bytes, and a plain (non-dotted) `flow.fail` code such as `my-error`, which no longer routes. Use a dotted code such as `team.my-error` for a `flow.fail` you want routed.

An edge expresses object composition, not an implementation-specific callback:

```yaml
from: source-node.result
to: destination-node.input
```

The engine passes only the selected, schema-validated port value across an edge. A node never implicitly receives every prior node's result. Credentials, raw logs, secret values, and host assertions are not valid output-port data.

### Standard ports

| Node family | Inputs | Outputs |
| --- | --- | --- |
| Trigger | none | `event`, `context` |
| `kubernetes.apply` | optional `manifests`, `parameters` | `result`, `resources`, `status` |
| `kubernetes.get/list` | `parameters` | `result`, `items` |
| `kubernetes.rolloutStatus` | `resource` | `result`, `status` |
| `ssh.run` | `parameters` | `result`, `stdout`, `exitCode` |
| `script.python` / `script.go` | `input` | `result`, declared outputs |
| Condition (`flow.condition`) | `value` | `true`, `false` (inbound value on the matching branch) |
| `flow.delay` | optional `input` | `result` (passthrough object) |
| `data.set` | none | `result` (literal object) |
| `data.map` | `input` | `result` |
| `data.validate` | `value` | `result` (validated value) |
| `flow.stop` / `flow.fail` | optional `input` | `result` (`{status, message?}` / `{status, code, message?}`) |
| Notification/webhook | `payload` | `result` |

`result` is a safe structured summary. Every declared output has a schema,
content-type allowlist, and size limit. Providers may produce a richer artifact,
but another node receives it only through an explicitly declared, redacted output
when its schema permits it. Raw stdout/stderr, unredacted provider responses,
credentials, host assertions, and artifact download URLs are never port data.

See the [standard action catalog](action-catalog.md) for node-specific `with` contracts and safety policies.

### Composed example

This larger workflow uses the result of each YAML object as the typed input to the next object:

```yaml
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: validate-restart-and-notify
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: precheck
      type: ssh.run
      name: Check API host
      with:
        sshTargetId: 22222222-2222-4222-8222-222222222222
        commandProfileId: 44444444-4444-4444-8444-444444444444
        timeoutSeconds: 30
    - id: restart
      type: kubernetes.apply
      name: Restart API deployment
      with:
        clusterTargetId: 11111111-1111-4111-8111-111111111111
        namespace: cp-ops-nprd
        dryRun: server
        manifests: |
          apiVersion: apps/v1
          kind: Deployment
          metadata:
            name: api
    - id: summarize
      type: script.python
      name: Build change summary
      with:
        source: |
          import json
          print(json.dumps({"summary": "restart complete"}))
        entrypoint: main.py
        runtimeProfileId: 66666666-6666-4666-8666-666666666666
        timeoutSeconds: 30
    - id: notify
      type: notification.webhook
      name: Notify operations
      with:
        connectionId: 55555555-5555-4555-8555-555555555555
  edges:
    - from: precheck.result
      to: restart.parameters
    - from: restart.result
      to: summarize.input
    - from: summarize.result
      to: notify.payload
```

## Larger workflows and reuse

Nodes are the composition unit. A larger workflow is a graph of typed node objects, not a monolithic script. Reusable workflows will be introduced as an explicit `workflow.call` node with pinned `workflowVersionId`, declared input/output schemas, and caller/callee policy checks. The first release does not allow recursive workflow calls; it expands a pinned child version into the execution plan and records the full version lineage in audit events.

## Validation and normalization

1. Parse YAML using a safe parser with depth, node-count, scalar-size, and total-document-size limits: reject custom tags, aliases, duplicate keys, and documents other than one workflow definition.
2. Validate `apiVersion`, `kind`, structural shape, field types, node types, references, graph acyclicity, and type-specific `with` values.
3. Validate node ports, edge references, input/output schemas, required inputs, and graph acyclicity. Enforce workspace policy before publish and again before execution. For example, a `kubernetes.apply` node must reference an allowed target/namespace and pass the Kubernetes manifest policy.
4. Normalize ordering for deterministic output: top-level fields, metadata labels, optional `metadata.ui.layout` node keys, triggers, nodes, edges, and outputs are emitted in stable ID/name order; retain literal block content such as manifests exactly except for trailing newline normalization.
5. Compute a SHA-256 digest of normalized YAML. The digest and immutable YAML are pinned to each published version and execution.

Formatting differences alone do not create a semantic version change: the API returns normalized YAML after validation. Unknown fields fail by default so a typo cannot silently change behavior.

## UI round-trip rules

- YAML editor and canvas are two views of one draft, not separate sources of truth.
- Opening a workflow parses the stored YAML into the canvas. If parse/validation fails, show a field-aware error and do not render a guessed graph. Missing or invalid `metadata.ui.layout` is auto-layout; layout never invents nodes or edges.
- Canvas edits update the typed in-memory model; Save serializes normalized YAML and sends it to `PUT /api/v1/workflows/{workflowId}/draft`.
- YAML edits validate continuously with debounced feedback. Save is disabled while invalid.
- The API responds with normalized YAML and digest. The UI replaces its local source with that response, then redraws the canvas.
- Import validates before creating a draft. Export returns the immutable YAML for the selected workflow version.
- The UI never injects credentials, opaque runtime IDs, execution logs, or host-embed assertions into YAML.
- The SSH editor selects a target and command profile; the script editor edits typed source and runtime settings. Both serialize only the documented `with` fields above.

## API behavior

`PUT /api/v1/workflows/{workflowId}/draft` accepts `application/yaml` or a JSON envelope containing `definitionYaml`. It returns the normalized YAML, parsed summary, validation warnings, and digest. Publishing creates an immutable version from that normalized document; execution references the version digest.

Validation errors use RFC 9457 Problem Details with an `errors` array containing YAML path, line/column when available, code, and safe message. Example paths include `spec.nodes[0].with.namespace` and `spec.edges[2].from`.

## Non-goals

- YAML templating, expressions, anchors, aliases, custom tags, includes, and code execution.
- Persisting a separate canvas graph or translating an unversioned UI format at runtime.
- Implicit secrets or credentials in workflow YAML.
