# Release notes

## Unreleased

### Exact whole numbers in run and webhook input

- A whole number outside ±2^53 sent in run-start input or a webhook body is now stored and returned with its exact digits (in `executions.input_redacted`, the run-start response and `GET /api/v1/executions/{id}`). Webhook signatures are still verified on the raw body bytes first.
- Big numeric IDs sent before this fix were stored rounded. The original digits were not kept, so those rows cannot be repaired and there is no backfill. Sending IDs as strings avoids the problem with any version.
- A schedule trigger `catchUp` written as a whole number with a decimal point or exponent (`1.0`, `1e2`) is read as that integer. A fraction or a value too large for an integer is refused with a fixed error instead of being dropped.
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
