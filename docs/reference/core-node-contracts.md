# Core neutral node contracts (E3.3)

Handoff for the UI / catalog agent. The Go API on `GET /api/v1/workflows/catalog` is the live contract. This page lists the **schema deltas** from E3.1 so can place and configure these nodes without guessing.

`apps/web` was not rewritten in this story. Existing palette code that reads `type`, `phase`, `inputs`, `outputs`, and `requiredWith` keeps working. New fields are additive.

## Non-negotiable rules

- **Triggers stay workflow-level.** `manual`, `webhook`, and `schedule` appear only under `spec.triggers`. They are not `spec.nodes` types. Catalog `rules.triggersAreWorkflowLevel` and `rules.graphNodesExcludeTriggers` are `true`.
- **Next / provider types stay rejected.** `workflow.call`, `flow.switch`, `data.merge`, provider connectors, etc. remain `phase: next|provider` and fail publish/validate with `unsupported-node` / `unsupported-trigger`.
- **Unknown `with` keys fail closed** on these seven nodes (`unknown-field`).
- **Expressions only in declared `expr` fields.** Paths are dotted identifiers (`foo.bar`). `{{`, `${`, `{%`, `||`, `&&` in plain strings are `expression-forbidden` or `template-forbidden`. FFX expressions are allowed only in catalog fields of kind `expr`, written as `{expr: "..."}`: today `flow.condition.with.expr` and `data.map.with.expr` (see [FFX expressions](#ffx-expressions)).

## Catalog JSON deltas (additive)

Every catalog node may now include:

| Field | Purpose |
| --- | --- |
| `title`, `description` | Palette / inspector copy |
| `allowedWith[]` | Allowlisted `with` keys (`name`, `kind`, `required`, `enum`, `description`) |
| `policy` | `{permissions, retrySafe, sideEffects, idempotent, cancellation, verification, defaultMaxAttempts}` |
| `bounds` | `{maxInputBytes, maxOutputBytes, maxWithBytes, maxAggregationItems, maxDurationSeconds?}` |
| `redaction` | `{auditFields, redactInputs, redactOutputs, strategy}` |

Every port may now include:

| Field | Purpose |
| --- | --- |
| `classification` | `public` \| `internal` \| `confidential` \| `inherit` (`secret` is never a legal payload) |
| `maxBytes` | Encoded JSON size cap (16 KiB for these nodes) |
| `description` | Inspector help |

`inherit` means the outbound port copies the inbound classification. `data.set` / `flow.stop` / `flow.fail` results are `public` (literals and operator-safe summaries only).

Catalog root also has:

```json
{
  "apiVersion": "flowforge/v1",
  "rules": {
    "triggersAreWorkflowLevel": true,
    "graphNodesExcludeTriggers": true,
    "unsupportedPhasesRejected": true
  }
}
```

UI should keep filtering the palette to `phase: core`. Treat missing `policy` on other core nodes (Kubernetes, SSH, HTTP, approval, scripts) as “E3.1 stub — not a full E3.3 contract yet.”

## Node map

Default policy for all seven: `permissions: [workflow.execute]`, `retrySafe: true`, `sideEffects: false`, `idempotent: true`, `cancellation: path-local`, `defaultMaxAttempts: 1`.

Default bounds: 16 KiB input/output/`with`, 32 aggregation items. Delay also caps duration at **604800 seconds (P7D)**.

### `flow.condition`

| | |
| --- | --- |
| Ports | in `value` (any, required, inherit) → out `true`, `false` (any, inherit) |
| `requiredWith` | none in the catalog; exactly one of `op` or `expr` is required |
| `allowedWith` | `op` (eq, ne, gt, lt, gte, lte, exists, contains), `compare` (required unless `op=exists`), `path` (optional dotted path), **or** `expr` (FFX, boolean) |
| Behavior | Declarative compare, or an FFX boolean expression with `item` bound to the inbound value when it is an object. `expr` cannot be combined with `op`, `compare` or `path`. Matching branch receives the **inbound value** (not a boolean). `exists` rejects `compare`. |
| Audit | `op` (`expr` for an expression), `matched`, `classification` (inputs redacted; never the expression or values) |

### `flow.delay`

| | |
| --- | --- |
| Ports | in `input` (any) → out `result` (object, inherit; passthrough or `{}`) |
| `requiredWith` | `duration` |
| `allowedWith` | `duration` ISO-8601 using **weeks, days, and time units only** (`PT5M`, `P1DT2H`, `P1W`). Years/months rejected. Max `P7D`. |
| Behavior | Contract returns a durable `durationSeconds`. Workers must not sleep. Unknown keys such as `sleep` fail closed. |
| Audit | `durationSeconds` |

### `data.set`

| | |
| --- | --- |
| Ports | none → out `result` (object, public) |
| `requiredWith` | `value` |
| `allowedWith` | `value` (object), optional `schema` (JSON-schema subset), optional `classification` (`public`\|`internal`) |
| Behavior | Literal object only. Secret keys/values and `confidential`/`secret` classification are rejected. Optional schema: `type`, `properties`, `required`, `additionalProperties` (bool), `items`, `enum`, `maxLength`, `maxItems`, `maxProperties`, `minimum`, `maximum`, `classification`. |
| Limits | 32 fields, depth 8, 16 KiB |

### `data.map`

| | |
| --- | --- |
| Ports | in `input` (object, required, inherit) → out `result` (object, inherit) |
| `requiredWith` | none in the catalog; exactly one of `mapping` or `expr` is required |
| `allowedWith` | `mapping`: `dest.path: source.path` **or** `dest.path: {from, convert?}`; **or** `expr` (FFX, returns the mapped object; `item` is the input object) |
| `convert` | `string` \| `integer` \| `boolean` \| `object` |
| Behavior | Explicit paths only. Classification preserved per field. Missing source path is `unresolved-reference`. |
| Limits | 32 mapping entries, path depth 8 |

E3.1 fixtures `mapping: {a: b}` remain valid. With `expr`, the result must be an object of at most 16 KiB and 32 fields, may not use a reserved `__ff_` key, and takes the highest classification of the input.

### `data.validate`

| | |
| --- | --- |
| Ports | in `value` (any, required, inherit) → out `result` (object, inherit) = the validated value |
| `requiredWith` | `schema` |
| Behavior | Same schema subset as `data.set`. Failures name **field paths** only; messages do not echo secret content. |
| Audit | `valid`, `failedPaths` |

### `flow.stop`

| | |
| --- | --- |
| Ports | in `input` (any, not copied to output) → out `result` `{status, message?}` (public), emitted **only** for `status: success` |
| `allowedWith` | `status` (`success`\|`failure`\|`canceled`, default `success`), `message` (≤256 bytes, no secrets/stack traces) |
| Behavior | Ends **this path only**. Not a cancel-other-execution API. `success` finishes the step and emits `result`. `failure` and `canceled` fail the step: its `error.code` is the stable code `failure` or `canceled`, and `error.message` is the safe `message` (empty when unset). A failed step releases no downstream edges, so `result` is not delivered and the run rolls up as failed. |

### `flow.fail`

| | |
| --- | --- |
| Ports | in `input` (any, not copied) → out `result` `{status: failure, code, message?}` (public) |
| `requiredWith` | **`code`** (new vs E3.1 — DNS label or dotted token such as `precheck-failed`) |
| `allowedWith` | `code`, `message` |
| Behavior | Operator-facing failure. PEM/tokens and `panic:` / `Traceback` messages are rejected. |

## FFX expressions

FFX is a typed, CEL-based expression language. An expression is written as `{expr: "..."}` in a field the catalog declares with `kind: expr`.

- **Scope:** `item` (the node's primary input when it is an object), `input.<port>` for wired ports, `run.id`, `run.startedAt`, `run.clock`, `workflow.id`, `workflow.versionId`. `run.clock` is a deterministic per-attempt clock: it is set once when the attempt starts, so re-evaluating an attempt gives the same result, and a retry gets a new value. There is no `now()`.
- **`vars`:** workspace variables are credential references. They can only be passed through whole (`vars.name`) into a field that takes a credential reference; they can never be read, compared or output. Neither `flow.condition.expr` nor `data.map.expr` takes one.
- **Presence tests:** `has()` is not supported. Use `'k' in m`, for example `'total' in item && item.total > 10`.
- **Nested ternaries:** bracket them. A nested ternary without brackets, like `true ? true ? 1 : 0 : 0`, gives `expression-parse`; write `true ? (true ? 1 : 0) : 0`.
- **Limits:** source ≤ 1 KiB, ≤ 256 AST nodes, nesting depth ≤ 8, a static cost budget at publish, and at runtime a cost limit with interrupt checks, a 10 ms deadline per evaluation and 2 s per step. Results are ≤ 16 KiB.
- **Publish codes:** `expression-parse`, `expression-type`, `expression-ref-unknown`, `expression-ref-not-ancestor`, `expression-secret-use`, `expression-too-complex`. Publish validates every expression and refuses a draft that does not.
- **Runtime codes:** `expression-cost-exceeded`, `expression-timeout`, `expression-runtime`, and `expression-type` when a value only known at runtime has the wrong type. Errors name the node id and never echo the expression or values.

## Validation error codes (new)

| Code | When |
| --- | --- |
| `classification-denied` | Secret/confidential literal or key on a core data node |
| `output-too-large` | Port / `with` / message exceeds the documented byte cap |
| `aggregation-limit` | Too many object fields, array items, or mapping entries |
| `invalid-schema` | Illegal schema keyword, depth, or shape |
| `duration-limit` | `flow.delay` duration &gt; P7D or not &gt; 0 |
| `expression-forbidden` | Path/compare/message used `\|\|`, `&&`, or template syntax |

Existing codes still apply: `unknown-field`, `invalid-with`, `secret-forbidden`, `template-forbidden`, `unsupported-node`, `required-input`, `incompatible-ports`.

## Authoring examples

```yaml
- id: constants
  type: data.set
  name: Constants
  with:
    value:
      env: staging
    schema:
      type: object
      properties:
        env: {type: string, classification: public}
      additionalProperties: false

- id: gate
  type: flow.condition
  name: Gate
  with:
    op: eq
    compare: staging
    path: env

- id: pause
  type: flow.delay
  name: Pause
  with:
    duration: PT5M

- id: failed
  type: flow.fail
  name: Failed
  with:
    code: env-mismatch
    message: environment is not staging
```

## Out of scope (do not imply in the UI)

- Durable worker execution, leases, or real timers (E5). Delay is a **contract** (`durationSeconds`) only.
- Provider engines (Kubernetes / SSH / script). HTTP/notification dispatch is E10.4 (`GET /http/catalog`).
- Credentials (E4). These nodes never accept credential or connection IDs.
- `flow.approval` is a full E10.3 contract: required `approverRole` + `expiresIn` (max `P7D`), optional `policyId`, optional `approvers` `{users, groups}` (UUID lists, at least one entry and at most 25 combined, no duplicates; `approverRole` must then be a known workspace role), typed ports `request` → `approved`/`rejected`/`expired`, unknown `with` keys rejected. Durable wait/resume is decide; it is not a worker sleep.
- Canvas persistence / rewrite of `apps/web`.
