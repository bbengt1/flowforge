# Release and operations

Relates to #184 / Part of #181. **Keep #184 open.**

Control-plane / ops slice (**jonny**, #188) plus operator/admin **UI**
and accessibility landings (**Chloe**, this PR). These pages publish
what already exists on `main`. They do not add product features or
weaken E12.1 / E12.2 harnesses.

## Operator guides

| Guide | Audience | Contents |
| --- | --- | --- |
| [API / OpenAPI](../reference/openapi.md) | Platform admins, integrators | How the published spec is obtained, `/api/v1` versioning, auth/session at high level |
| [Deployment and configuration](../deployment.md) | Control-plane operators | Local startup, local default tenant seed (#191), production env inventory, local-vs-prod pitfalls, deploy manifests |
| [Incident and recovery](incident-recovery.md) | On-call / ops | Health vs readiness, worker-loss/fencing, restore rehearsal, escalation signals |
| [Retention and backup](retention-backup.md) | Ops / compliance | Encrypted backups, restore cadence, retention purge, legal hold |
| [E12.3 threat-model review](../reference/e12-threat-model-review.md) | Production-gate reviewers | Trust boundaries, embed, credentials, SSRF, tenancy; sign-off checklist |
| [Operator / admin UI](../guides/operator-admin.md) | Operators, workspace admins | Product-shell walkthroughs: membership, vault, approvals, executions, alerts, embed chrome, admin screens |
| [Accessibility review](../reference/e12-accessibility-review.md) | Production-gate reviewers | Keyboard, contrast, assistive-tech findings and cheap `apps/web` fixes |

Related evidence (do not re-run as a substitute for these guides):

- [E12.1 security verification](../reference/e12-security-verification.md)
- [E12.2 operational resilience and capacity](../reference/e12-resilience-capacity.md)
- [Security model](../reference/security-model.md)
- [Backend API map](../reference/backend-api-map.md)
- [Database specification](../reference/database.md)

[frontend-ui.md](../reference/frontend-ui.md) is the API→UI **contract
map**. It is not the operator/admin guide.

## Ownership map

| Slice | Owner | Landing |
| --- | --- | --- |
| API / OpenAPI publishing and accuracy | **jonny** | [openapi.md](../reference/openapi.md), `apps/api/openapi/openapi.yaml` |
| Deploy, configuration, incident/recovery, retention, backup | **jonny** | this tree + [deployment.md](../deployment.md) |
| Threat-model review (document existing controls) | **jonny** | [e12-threat-model-review.md](../reference/e12-threat-model-review.md) |
| Operator / admin **UI** guides | **Chloe / E12.3** | [operator-admin.md](../guides/operator-admin.md) |
| Accessibility review | **Chloe / E12.3** | [e12-accessibility-review.md](../reference/e12-accessibility-review.md) |

Keep #184 open until both halves are accepted on `main`.
