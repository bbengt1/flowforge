# FlowForge documentation

## Start here

- [Architecture](architecture.md): component boundaries, deployment model, and embedding contract.
- [Rewrite: n8n-class parity](architecture/flowforge-rewrite-n8n-class-parity.md): successor product charter after E1–E12 and epic #195 — parity of interaction and coverage, not an n8n clone. Chloe’s UI-surface fold-in is §11.1; jonny’s control-plane fold-in is §11.2. No issues from this doc until R1 is accepted.
- [FlowForge UX Laws](architecture/flowforge-ux-laws.md): post-R1–R7 chrome polish using [Laws of UX](https://lawsofux.com/) — selective Must / Should / already-covered / out-of-scope. Docs-only; Arie opens the epic. Not a security/product-model redesign.
- [Workflows home folder hierarchy](architecture/flowforge-workflow-folders.md): Nested, server-backed folders on `/workflows` (per workspace). F.1 API landed; chrome is F.2+. Not tags-first; not client-only persistence.
- [First-run bootstrap gate](architecture/flowforge-first-run-bootstrap.md): B.1 `GET /api/v1/bootstrap` + B.2–B.5 / B.7 wizard APIs (`persistence`, `admins`, `public-url`, `tls` create/upload/skip + `MarkComplete`). B.6 chrome landed; B.7 Skip for now chrome landed — **keep #347 open**. Standalone wizard only — never `/embed/v1`.
- [Rewrite UI surfaces](reference/rewrite-ui-surfaces.md): Chloe’s expanded surface map, operator migration notes, and keep/replace/retire (UI). Charter §11.1 is the fold-in authority.
- [Master implementation plan](master-implementation-plan.md): agile epic and story backlog for the shipped MVP (E1–E12).
- [MVP workflow model](reference/workflow-model.md): resources, node types, and acceptance criteria.
- [Workflow YAML schema](reference/workflow-yaml-schema.md): canonical saved workflow definition and UI round-trip rules.
- [Standard action catalog](reference/action-catalog.md): core workflow nodes and their safe contracts.
- [Core neutral node contracts](reference/core-node-contracts.md): E3.3 typed ports, `with` schemas, bounds, policy, and catalog deltas for the UI.
- [Frontend UI](reference/frontend-ui.md): canvas-first editor chrome, action wizard, credential vault, and UX requirements.
- [Operator / admin UI guide](guides/operator-admin.md): shell, authoring, vault, executions, approvals, embed/Portal, ADV-024, session/CHIPS/CSRF (Chloe, E12.3).
- [E12.3 accessibility review](reference/e12-accessibility-review.md): findings, fixes applied, and tracked gaps.
- [Database specification](reference/database.md): PostgreSQL entities, isolation, execution durability, and retention.
- [Security model](reference/security-model.md): trust boundaries, sessions, triggers, secret handling, and security verification.
- [E12.1 security verification suite](reference/e12-security-verification.md): named harness, CI gate, last-run pointer, and Chloe map.
- [E12.2 operational resilience and capacity](reference/e12-resilience-capacity.md): backup/restore, worker-loss, queue lag, migrate serialization, load peaks, and ≥2× headroom.
- [E12.3 release and operations](operations/index.md): API/OpenAPI, deploy/config, incident/recovery, retention/backup (jonny) plus Chloe UI/a11y landings.
- [API / OpenAPI publishing](reference/openapi.md): how to obtain the published spec, `/api/v1` versioning, and auth notes.
- [E12.3 threat-model review](reference/e12-threat-model-review.md): production-gate checklist against existing controls and E12 evidence.
- [Kubernetes API engine](reference/kubernetes-engine.md): first backend workflow-node capability.
- [SSH engine](reference/ssh-engine.md): controlled remote-server operations.
- [Script engine](reference/script-engine.md): isolated Python and Go automation.
- [Technical reference](reference/index.md): authoritative implementation map.
- [Embed SDK / contract](reference/embed-sdk.md): versioned host assertion, durable `jti`, key rotation, and `/embed/v1` deep links.
- [CP Ops Portal adapter](reference/portal-adapter.md): Portal host wiring, role → capability map, and integration boundary (no shared DB/executor).
- [Deployment and local development](deployment.md): startup, production config inventory, safety controls, and recovery rehearsal.

## Intended audiences

- Operators build and run approved automation.
- Workspace administrators manage membership, credentials, target allowlists, and execution policy.
- Host applications embed FlowForge with a signed, workspace-scoped session.
