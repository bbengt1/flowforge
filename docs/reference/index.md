# Technical reference

The maintained technical reference starts with the [workflow model](workflow-model.md), [workflow YAML schema](workflow-yaml-schema.md), [standard action catalog](action-catalog.md), [core neutral node contracts](core-node-contracts.md), [security model](security-model.md), [frontend UI](frontend-ui.md), [database specification](database.md), [Kubernetes API engine](kubernetes-engine.md), [SSH engine](ssh-engine.md), and [script engine](script-engine.md).

Future implementation changes should add API, deployment, and runner references here, and update the security model when a trust boundary or control changes.

- [Backend API map](backend-api-map.md): implemented control-plane routes and contracts.
- [Embed SDK / contract](embed-sdk.md): E11.1 mint/exchange plus E11.2 validation, durable `jti`, key rotation, and tenancy propagation.
- [CP Ops Portal adapter](portal-adapter.md): E11.3 Portal host wiring, capability map, and fail-closed integration boundary.
