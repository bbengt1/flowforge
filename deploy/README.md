# Deployment foundation (E1.3)

Thin control-plane defaults. This is not a full production platform.

| Path | Role |
| --- | --- |
| [`k8s/`](k8s/) | Namespace, API Deployment/Service, default-deny NetworkPolicy, TLS Ingress |
| [`kubernetes/`](kubernetes/) | Workspace least-privilege ServiceAccount / Role / RoleBinding templates for cluster targets (E7.1; ClusterRoles are not MVP) |
| [`tls/`](tls/) | Local reverse-proxy TLS terminator (Caddy) |
| [`supply-chain/`](supply-chain/) | Approved bases and vulnerability/provenance policy implemented in CI |

Backup encryption and restore rehearsal live in [`scripts/backup/`](../scripts/backup/). Operator narrative: [`docs/deployment.md`](../docs/deployment.md). Incident/recovery and retention cadence: [`docs/operations/`](../docs/operations/index.md).

Shared identity: containers run as UID/GID **65532**. The web image should use the same UID.
