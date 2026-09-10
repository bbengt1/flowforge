# Technical reference

The maintained technical reference starts with the [workflow model](workflow-model.md), [workflow YAML schema](workflow-yaml-schema.md), [standard action catalog](action-catalog.md), [core neutral node contracts](core-node-contracts.md), [security model](security-model.md), [frontend UI](frontend-ui.md), [database specification](database.md), [Kubernetes API engine](kubernetes-engine.md), [SSH engine](ssh-engine.md), and [script engine](script-engine.md).

Future implementation changes should add API, deployment, and runner references here, and update the security model when a trust boundary or control changes.

- [Backend API map](backend-api-map.md): implemented control-plane routes and contracts.
- [Embed SDK / contract](embed-sdk.md): E11.1 mint/exchange plus E11.2 validation, durable `jti`, key rotation, and tenancy propagation.
- [CP Ops Portal adapter](portal-adapter.md): E11.3 Portal host wiring, capability map, and fail-closed integration boundary.
- [E12.1 security verification suite](e12-security-verification.md): named harness, CI gate, last-run pointer, and Chloe map.
- [E12.2 operational resilience and capacity](e12-resilience-capacity.md): restore/worker/load harness, ≥2× headroom claims, and Chloe no-UI map.
- [API / OpenAPI publishing](openapi.md): published spec path, `/api/v1` versioning, and operator fetch/auth.
- [E12.3 threat-model review](e12-threat-model-review.md): production-gate sign-off against existing controls (no new features).
- [Release and operations](../operations/index.md): incident/recovery and retention/backup runbooks; Chloe UI/a11y landings.
- [Operator / admin UI guide](../guides/operator-admin.md): Chloe E12.3 product-shell walkthroughs (not this API→UI map).
- [E12.3 accessibility review](e12-accessibility-review.md): labels, focus, keyboard paths, and tracked gaps.
