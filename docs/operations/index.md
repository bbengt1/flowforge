# Release and operations

Control-plane and operator/admin UI pages publish
what already exists on `main`. They do not add product features or
weaken E12.1 / E12.2 harnesses.

## Operator guides

| Guide | Audience | Contents |
| --- | --- | --- |
| [API / OpenAPI](../reference/openapi.md) | Platform admins, integrators | How the published spec is obtained, `/api/v1` versioning, auth/session at high level |
| [Deployment and configuration](../deployment.md) | Control-plane operators | Local startup, local default tenant seed (R7.3 — labeled Example context stays local-only; trusted-dev is never rewrite login), production env inventory, local-vs-prod pitfalls, deploy manifests |
| [Incident and recovery](incident-recovery.md) | On-call / ops | Health vs readiness, worker-loss/fencing, restore rehearsal, escalation signals |
| [Schema migrations](schema-migrations.md) | On-call / ops | Apply and verify forward-only migrations, checksum drift, refused boot, upgrade and rollback |
| [SLOs and alerts](slo-alerts.md) | On-call / ops | Control-plane SLOs, business metrics, example Prometheus alert rules |
| [Retention and backup](retention-backup.md) | Ops / compliance | Encrypted backups, restore cadence, retention purge, legal hold |
| [KEK rotation](kek-rotation.md) | Ops / security | KMS-wrapped data KEK, online re-encryption, dual-KEK window |
| [E12.3 threat-model review](../reference/e12-threat-model-review.md) | Production-gate reviewers | Trust boundaries, embed, credentials, SSRF, tenancy; sign-off checklist |
| [Operator / admin UI](../guides/operator-admin.md) | Operators, workspace admins | Product-shell walkthroughs after R2–R7: home/editor, grant-gated membership off product chrome, labeled Example context, vault, approvals, executions, alerts, embed chrome, admin screens |
| [Accessibility review](../reference/e12-accessibility-review.md) | Production-gate reviewers | Keyboard, contrast, assistive-tech findings and cheap `apps/web` fixes |

Related evidence (do not re-run as a substitute for these guides):

- [E12.1 security verification](../reference/e12-security-verification.md)
- [E12.2 operational resilience and capacity](../reference/e12-resilience-capacity.md)
- [Security model](../reference/security-model.md)
- [Backend API map](../reference/backend-api-map.md)
- [Database specification](../reference/database.md)

[frontend-ui.md](../reference/frontend-ui.md) is the API→UI **contract
map**. It is not the operator/admin guide.

## Where the guides live

| Slice | Landing |
| --- | --- |
| API / OpenAPI publishing and accuracy | [openapi.md](../reference/openapi.md), `apps/api/openapi/openapi.yaml` |
| Deploy, configuration, incident/recovery, retention, backup | this tree + [deployment.md](../deployment.md) |
| Threat-model review (document existing controls) | [e12-threat-model-review.md](../reference/e12-threat-model-review.md) |
| Operator / admin UI guides (E12.3) | [operator-admin.md](../guides/operator-admin.md) |
| Accessibility review (E12.3) | [e12-accessibility-review.md](../reference/e12-accessibility-review.md) |
