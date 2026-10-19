# Release notes

## Unreleased

### Expressions in `data.map` and `flow.condition`

- `data.map` accepts `with.expr: {expr: "..."}`, an FFX expression that returns the mapped object, as an alternative to `with.mapping`.
- `flow.condition` accepts `with.expr: {expr: "..."}`, an FFX boolean expression, as an alternative to `op`/`compare`/`path`.
- Publish validates every expression (parse, types, references, cost) and refuses a draft whose expressions do not validate. Errors name the node id. The editor can show the same errors first through `POST /api/v1/workflows/{workflowId}/draft/typecheck`.
- Published versions are not affected: they are immutable, pinned by digest and never re-checked when they run.
- Expressions read a deterministic per-attempt clock as `run.clock` (new column `execution_steps.eval_clock`, migration 000053). A retry gets a new value.
- `trigger` and `items` are not available yet in these expressions. Publish refuses them with `expression-ref-unknown`.
- Presence tests use `'k' in m`; `has()` is not supported. Bracket nested ternaries.

See [core node contracts: FFX expressions](../reference/core-node-contracts.md#ffx-expressions).
