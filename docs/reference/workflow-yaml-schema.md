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
  name: DNS-label                         # required, workflow-local identifier
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

`metadata.ui.layout` is additive optional on `flowforge/v1` (D1 / issue #238). The API stores and returns it on validate, normalize, draft save/load, and published versions. **Executor, `POST /policy/evaluate`, port typing, and dispatch ignore it.** Node keys must match `spec.nodes[].id`; extra keys are stripped (never invent a node). Missing keys auto-place that node. Non-finite coordinates or a non-object layout are treated as absent (auto-layout). Layout never carries edges, types, `with`, credentials, or ports. Unknown keys under `metadata.ui` / `layout` besides `layout` / `version`+`nodes` still fail closed. Older documents without the field keep working. Chloe applies `summary.ui.layout` or the YAML field on canvas load and writes it back on draft save (R2.5 / #238 — keep #238 open). Embed and standalone share this API.

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
with: {}                  # node-specific, policy-validated configuration
inputs: {}                # optional defaults or literal typed inputs
```

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
