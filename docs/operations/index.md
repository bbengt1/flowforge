# Release and operations

Relates to #184 / Part of #181. **Keep #184 open** — Chloe still owns
operator/admin **UI** guides and the accessibility review. This tree is
the control-plane / ops slice (jonny).

These pages publish what already exists on `main`. They do not add
product features, weaken E12.1 / E12.2 harnesses, or invent UI screens.

## Operator guides (this PR)

| Guide | Audience | Contents |
| --- | --- | --- |
| [API / OpenAPI](../reference/openapi.md) | Platform admins, integrators | How the published spec is obtained, `/api/v1` versioning, auth/session at high level |
| [Deployment and configuration](../deployment.md) | Control-plane operators | Local startup, production env inventory, local-vs-prod pitfalls, deploy manifests |
| [Incident and recovery](incident-recovery.md) | On-call / ops | Health vs readiness, worker-loss/fencing, restore rehearsal, escalation signals |
| [Retention and backup](retention-backup.md) | Ops / compliance | Encrypted backups, restore cadence, retention purge, legal hold |
| [E12.3 threat-model review](../reference/e12-threat-model-review.md) | Production-gate reviewers | Trust boundaries, embed, credentials, SSRF, tenancy; sign-off checklist |

Related evidence (do not re-run as a substitute for these guides):

- [E12.1 security verification](../reference/e12-security-verification.md)
- [E12.2 operational resilience and capacity](../reference/e12-resilience-capacity.md)
- [Security model](../reference/security-model.md)
- [Backend API map](../reference/backend-api-map.md)
- [Database specification](../reference/database.md)

## Ownership map

| Slice | Owner | Landing |
| --- | --- | --- |
| API / OpenAPI publishing and accuracy | **jonny** | [openapi.md](../reference/openapi.md), `apps/api/openapi/openapi.yaml` |
| Deploy, configuration, incident/recovery, retention, backup | **jonny** | this tree + [deployment.md](../deployment.md) |
| Threat-model review (document existing controls) | **jonny** | [e12-threat-model-review.md](../reference/e12-threat-model-review.md) |
| Operator / admin **UI** guides | **Chloe / E12.3** | stub below — not in this PR |
| Accessibility review | **Chloe / E12.3** | stub below — not in this PR |

## Chloe / E12.3 placeholders

**Operator UI guide — Chloe / E12.3.** Product-shell walkthroughs for
membership, vault, approvals, executions, alerts, embed chrome, and
admin screens land in Chloe's separate PR. Do not treat
[frontend-ui.md](../reference/frontend-ui.md) API→UI maps as the
operator/admin guide.

**Accessibility review — Chloe / E12.3.** Keyboard, contrast, and
assistive-tech review before production approval is Chloe's. This PR
makes no accessibility claims and includes no UI screenshots.

Until those land, operators use the API/OpenAPI and control-plane
runbooks above. Keep #184 open after this PR.
