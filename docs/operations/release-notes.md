# Release notes

## Unreleased

### Per-item onError for list nodes

- Pure core list nodes (`data.sort`, `data.filter`) can route allowlisted per-item failures with `onError: continue` or `errorOutput`. The step ends `succeededWithErrors` when any item routes; the run rollup is unchanged. `data.merge` is not wired for per-item onError yet.
- `continue` drops failed items from items ports (`[{}]` when every item fails). `errorOutput` writes `{code, message, idx, lineage}` on `error` with no item contents.
- Lease loss marks in-flight unknown items `indeterminate` (never auto-retried). Provider nodes stay run-once; per-item idempotency is not enabled yet.

### Switch, filter, sort and merge nodes

- `flow.switch`, `data.filter`, `data.sort` and `data.merge` are now core nodes: they publish and run on both workers. The catalog revision is 3, so versions published before this keep their pinned semantics.
- `flow.switch` takes ordered `cases` (`{name, op, compare}`, up to 16) and an optional `path`. The first matching case routes the inbound value to the output port named by that case, otherwise to the `default` port. Exactly one port fires. Publish requires `default`; at run time a switch with no match and no default fails closed with `switch-no-match`. A case whose comparison cannot apply to the value fails the step, as in `flow.condition`.
- Item lists travel inside the port value as `{items: [...]}`, under the 16 KiB port limit. An object reads as one item.
- `data.filter` splits items into `kept` and `dropped` by `path`/`op`/`compare` or by a per-item FFX boolean `with.expr`. Both ports fire and input order is kept.
- `data.sort` sorts by one `key` (`type` `string`, `number` or `timestamp`; `order` `asc` or `desc`). The sort is stable in both directions. A missing key fails with `sort-key-missing`; mixed or wrong key types fail with `sort-mixed-types`. Numbers compare exactly.
- `data.merge` combines `left` and `right` items with `mode` `append`, `zip` (same length, else `merge-length-mismatch`) or `byKey` (left order, then unmatched right items; keys must be unique strings or numbers, else `merge-duplicate-key` or `merge-key-missing`). On a field conflict the right value wins.

### Exact whole numbers in run and webhook input

- A whole number outside ±2^53 sent in run-start input or a webhook body is now stored and returned with its exact digits (in `executions.input_redacted`, the run-start response and `GET /api/v1/executions/{id}`). Webhook signatures are still verified on the raw body bytes first.
- Big numeric IDs sent before this fix were stored rounded. The original digits were not kept, so those rows cannot be repaired and there is no backfill. Sending IDs as strings avoids the problem with any version.
- A retry that reuses an idempotency key from before this release, with a whole number outside ±2^53 in its input, now gets `409 Conflict` (idempotency key reused with a different request fingerprint), because the stored fingerprint was taken over the rounded value. Retry with a new idempotency key.
- An integer literal beyond the 64-bit range in workflow YAML (for example a `data.set` value of `99999999999999999999`) keeps its exact digits through save, publish and export instead of being rounded. In a run, `flow.condition` `op: gt`/`op: eq` compares it exactly, and a `with.expr` that reads it fails closed with `expression-runtime`.
- Schedule `catchUp` must be an integer everywhere. `1.0`, `1e2`, a fraction or an out-of-range value is refused with an `invalid-type` field error naming `catchUp`, both in `POST /api/v1/schedules` and for a stored trigger value, instead of a generic invalid-JSON error or a silent drop.
- A JSON request field of the wrong type now returns an `invalid-type` field error naming the field and its expected type, without echoing the value. When the field sits inside an object keyed by the client, the error names the object, never the key.
- Schema type errors read "Value is not an integer." (fixed article).
- Script and HTTP notification schemas with `minimum`/`maximum` refuse non-finite numbers (NaN, ±Infinity) even when no `type` is declared.

### Expressions in `data.map` and `flow.condition`

- `data.map` accepts `with.expr: {expr: "..."}`, an FFX expression that returns the mapped object, as an alternative to `with.mapping`.
- `flow.condition` accepts `with.expr: {expr: "..."}`, an FFX boolean expression, as an alternative to `op`/`compare`/`path`.
- Publish validates every expression (parse, types, references, cost) and refuses a draft whose expressions do not validate. Errors name the node id. The editor can show the same errors first through `POST /api/v1/workflows/{workflowId}/draft/typecheck`.
- Published versions are not affected: they are immutable, pinned by digest and never re-checked when they run.
- Expressions read a deterministic per-attempt clock as `run.clock` (new column `execution_steps.eval_clock`, migration 000053). A retry gets a new value.
- `trigger` and `items` are not available yet in these expressions. Publish refuses them with `expression-ref-unknown`.
- Presence tests use `'k' in m`; `has()` is not supported. Bracket nested ternaries.
- A step fails, naming only the node id, if an expression result holds a whole number outside ±2^53, which cannot be stored exactly (use `string()` to keep the digits). Larger whole numbers in step data are kept exact, and template markers such as `}}` are allowed inside expression source only. Doubles are not range-checked (a whole double such as `1e20` stays a double).

See [core node contracts: FFX expressions](../reference/core-node-contracts.md#ffx-expressions).
