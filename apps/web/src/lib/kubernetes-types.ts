/**
 * E7.1 cluster-target + Kubernetes policy types (Chloe UI).
 * Secret-free. Credentials stay in the E4.1 vault by display name/id.
 * Aligned to jonny's #74 map on main (`docs/reference/backend-api-map.md`).
 */

export const KUBERNETES_POLICY_KIND = "kubernetes" as const;
export const KUBERNETES_CREDENTIAL_TYPE = "kubernetes" as const;
export const KUBERNETES_CREDENTIAL_SECRET_FIELD = "kubeconfig" as const;
export const KUBERNETES_ROLE_TEMPLATE = "namespace-scoped-runner" as const;

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

export type KubernetesServiceAccount = {
  name: string;
  namespace?: string;
  roleTemplate?: string;
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
  serviceAccount?: KubernetesServiceAccount;
};

export type KubernetesEvaluationKey = {
  canonical: string;
  aliases: string[];
  failClosedWhenPresent: boolean;
  requiredForPublish?: boolean;
};

/** E7.2 node contract from GET /kubernetes/catalog `nodes[]` (#78). */
export type KubernetesEngineNodeContract = {
  type: string;
  verb: string;
  title: string;
  description: string;
  permissions: string[];
  requiredWith: string[];
  allowedWith: {
    name: string;
    kind: string;
    required?: boolean;
    enum?: string[];
    description?: string;
  }[];
  outputs: string[];
  sideEffects: boolean;
  retrySafe: boolean;
  idempotent: boolean;
  fieldManager?: string;
  force?: boolean;
  serverDryRunAlways?: boolean;
  waitReady?: string;
};

/** E7.2 engine error map from GET /kubernetes/catalog `errors[]` (#78). */
export type KubernetesEngineErrorShape = {
  code: string;
  status: number;
  meaning: string;
};

/** Fixed SSA rules from GET /kubernetes/catalog `apply` (#78). */
export type KubernetesEngineApplyRules = {
  fieldManager: string;
  force: boolean;
  serverDryRunAlways: boolean;
  clientDryRunAddsLocalValidationOnly: boolean;
  waitReady: string;
};

export type KubernetesEngineCatalog = {
  credentialType: string;
  credentialSecretField: string;
  allowedKinds: string[];
  allowedVerbs: string[];
  evaluationKeys: KubernetesEvaluationKey[];
  serviceAccount: {
    defaultName: string;
    roleTemplate: string;
    roleTemplatePath?: string;
    roleBindingTemplatePath?: string;
    serviceAccountPath?: string;
    clusterRoles: boolean;
    notes?: string;
  };
  publishRules: {
    clusterTargetRequired: string[];
    kubernetesPolicyRequired: string[];
    emptyAllowlistsRejected: boolean;
    credentialType: string;
    denyAllowsMissingAllowlist: boolean;
  };
  clusterRoles: boolean;
  nodes: KubernetesEngineNodeContract[];
  errors: KubernetesEngineErrorShape[];
  apply: KubernetesEngineApplyRules;
};
