/**
 * E7.1 cluster-target + Kubernetes policy types (Chloe UI, #70).
 * Secret-free. Credentials stay in the E4.1 vault by display name/id.
 * Jonny's route map is still in flight — shapes follow E4.2 ops-config
 * (`docs/reference/backend-api-map.md`) and kubernetes-engine.md.
 */

export const KUBERNETES_POLICY_KIND = "kubernetes" as const;

export const KUBERNETES_ALLOWED_KINDS = [
  "ConfigMap",
  "Service",
  "Deployment",
  "StatefulSet",
  "DaemonSet",
  "Job",
  "CronJob",
  "Ingress",
  "NetworkPolicy",
] as const;

export type KubernetesAllowedKind = (typeof KUBERNETES_ALLOWED_KINDS)[number];

export const KUBERNETES_ALLOWED_VERBS = [
  "get",
  "list",
  "apply",
  "watch",
] as const;

export type KubernetesAllowedVerb = (typeof KUBERNETES_ALLOWED_VERBS)[number];

export const KUBERNETES_APPROVAL_OPERATIONS = [
  "kubernetes.apply",
  "kubernetes.rolloutStatus",
  "apply",
] as const;

export type KubernetesApprovalOperation =
  (typeof KUBERNETES_APPROVAL_OPERATIONS)[number];

export const KUBERNETES_ACTION_TYPES = [
  "kubernetes.apply",
  "kubernetes.get",
  "kubernetes.list",
  "kubernetes.rolloutStatus",
] as const;

export type KubernetesActionType = (typeof KUBERNETES_ACTION_TYPES)[number];

/** Allowlisted namespace / kind / verb policy. No kubeconfig. */
export type KubernetesPolicyBody = {
  allowedNamespaces: string[];
  allowedKinds: string[];
  allowedVerbs: string[];
  requireApproval: boolean;
  operations: string[];
  approverRole?: string;
  expiresIn?: string;
  deny?: boolean;
};

export type KubernetesClusterTargetSpec = {
  credentialId: string;
  endpoint: {
    apiServer?: string;
    tlsServerName?: string;
    skipTLSVerify?: boolean;
  };
  allowedNamespaces?: string[];
  policyId?: string;
};
