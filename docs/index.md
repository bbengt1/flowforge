# FlowForge documentation

## Start here

- [Architecture](architecture.md): component boundaries, deployment model, and embedding contract.
- [Master implementation plan](master-implementation-plan.md): agile epic and story backlog for implementation planning.
- [MVP workflow model](reference/workflow-model.md): resources, node types, and acceptance criteria.
- [Workflow YAML schema](reference/workflow-yaml-schema.md): canonical saved workflow definition and UI round-trip rules.
- [Standard action catalog](reference/action-catalog.md): core workflow nodes and their safe contracts.
- [Core neutral node contracts](reference/core-node-contracts.md): E3.3 typed ports, `with` schemas, bounds, policy, and catalog deltas for the UI.
- [Frontend UI](reference/frontend-ui.md): workflow canvas, action wizard, credential vault, and UX requirements.
- [Database specification](reference/database.md): PostgreSQL entities, isolation, execution durability, and retention.
- [Security model](reference/security-model.md): trust boundaries, sessions, triggers, secret handling, and security verification.
- [E12.1 security verification suite](reference/e12-security-verification.md): named harness, CI gate, last-run pointer, and Chloe map.
- [Kubernetes API engine](reference/kubernetes-engine.md): first backend workflow-node capability.
- [SSH engine](reference/ssh-engine.md): controlled remote-server operations.
- [Script engine](reference/script-engine.md): isolated Python and Go automation.
- [Technical reference](reference/index.md): authoritative implementation map.
- [Embed SDK / contract](reference/embed-sdk.md): versioned host assertion, durable `jti`, key rotation, and `/embed/v1` deep links.
- [CP Ops Portal adapter](reference/portal-adapter.md): Portal host wiring, role → capability map, and integration boundary (no shared DB/executor).
- [Deployment and local development](deployment.md): startup, safety controls, and recovery rehearsal.

## Intended audiences

- Operators build and run approved automation.
- Workspace administrators manage membership, credentials, target allowlists, and execution policy.
- Host applications embed FlowForge with a signed, workspace-scoped session.
