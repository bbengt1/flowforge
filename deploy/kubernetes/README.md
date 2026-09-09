# Workspace Kubernetes least-privilege templates (E7.1)

These manifests are **operator-applied, namespace-scoped** defaults for a FlowForge cluster target. They are metadata that E7.2 workers consume — FlowForge does not apply them itself in E7.1.

ClusterRoles, ClusterRoleBindings, and cluster-scoped resources are **not MVP**.

## Apply per allowed namespace

Replace `${NAMESPACE}` (and optionally `${SERVICE_ACCOUNT}`) then apply in each namespace listed on the cluster target and bound Kubernetes policy:

```bash
export NAMESPACE=cp-ops-nprd
export SERVICE_ACCOUNT=flowforge-runner
envsubst < deploy/kubernetes/workspace-serviceaccount.yaml | kubectl apply -n "$NAMESPACE" -f -
envsubst < deploy/kubernetes/workspace-role-template.yaml | kubectl apply -n "$NAMESPACE" -f -
envsubst < deploy/kubernetes/workspace-rolebinding-template.yaml | kubectl apply -n "$NAMESPACE" -f -
```

## What the role can do

The Role grants only the MVP engine verbs (`get`, `list`, `watch`, `create`, `update`, `patch`) on the documented allowlist: ConfigMap, Service, Deployment, StatefulSet, DaemonSet, Job, CronJob, Ingress, NetworkPolicy.

It does **not** grant:

- `Secret` read or write
- delete / rollback
- RBAC, CRDs, namespaces, admission webhooks
- cluster-scoped resources

## Cluster target metadata

Publish a cluster target with a workspace `kubernetes` credential (`secret.kubeconfig`) and optional `serviceAccount`:

```json
{
  "credentialId": "<vault-uuid>",
  "endpoint": { "apiServer": "https://kube.example" },
  "allowedNamespaces": ["cp-ops-nprd"],
  "serviceAccount": {
    "name": "flowforge-runner",
    "namespace": "cp-ops-nprd",
    "roleTemplate": "namespace-scoped-runner"
  }
}
```

Workers resolve the vault handle at execution time. The API never returns kubeconfig plaintext.
