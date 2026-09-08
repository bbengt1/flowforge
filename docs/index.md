# FlowForge documentation

## Start here

- [Architecture](architecture.md): component boundaries, deployment model, and embedding contract.
- [Master implementation plan](master-implementation-plan.md): agile epic and story backlog for implementation planning.
- [MVP workflow model](reference/workflow-model.md): resources, node types, and acceptance criteria.
- [Workflow YAML schema](reference/workflow-yaml-schema.md): canonical saved workflow definition and UI round-trip rules.
- [Standard action catalog](reference/action-catalog.md): core workflow nodes and their safe contracts.
- [Frontend UI](reference/frontend-ui.md): workflow canvas, action wizard, credential vault, and UX requirements.
- [Database specification](reference/database.md): PostgreSQL entities, isolation, execution durability, and retention.
- [Security model](reference/security-model.md): trust boundaries, sessions, triggers, secret handling, and security verification.
- [Kubernetes API engine](reference/kubernetes-engine.md): first backend workflow-node capability.
- [SSH engine](reference/ssh-engine.md): controlled remote-server operations.
- [Script engine](reference/script-engine.md): isolated Python and Go automation.
- [Technical reference](reference/index.md): authoritative implementation map.
- [Deployment and local development](deployment.md): startup, safety controls, and recovery rehearsal.

## Intended audiences

- Operators build and run approved automation.
- Workspace administrators manage membership, credentials, target allowlists, and execution policy.
- Host applications embed FlowForge with a signed, workspace-scoped session.
