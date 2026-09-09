/**
 * Single adapter for Chloe's E7.1 cluster-target + Kubernetes
 * policy UI. Retargeted to jonny's #74 map on `main`.
 *
 * Existing E4.2 ops-config paths plus one new catalog:
 *
 *   GET      /ops-config/catalog          {kinds, kubernetesEngine}
 *   GET      /kubernetes/catalog          engine allowlists + SA templates
 *   GET|POST /cluster-targets
 *   GET|PUT  /cluster-targets/{id}/draft
 *   POST     /cluster-targets/{id}/publish|select|disable|enable
 *   GET      /cluster-targets/{id}/versions[/{versionId}]
 *   GET|POST /policies  (kind=kubernetes)
 *   POST     /ops-config/select
 *
 * Cookie session + `X-CSRF-Token` on mutations. JSON camelCase.
 * RFC 9457 problems. Host-supplied `id` / `workspaceId` → 400 UX.
 * UI never receives kubeconfigs. Do not invent routes.
 * Relates to #70 (already closed by #74) / Part of #69.
 * Do not change `apps/api`. Do not re-close #70.
 *
 * E7.2 node `with` schema / catalog fallback lives in
 * `kubernetes-node-contract.ts` — wired to jonny's #78 map on
 * `main` (`GET /workflows/catalog` + `GET /kubernetes/catalog`
 * `nodes[]` / `errors[]` / `apply`). Relates to #71 / Part of #69.
 * E7.3 observation is `kubernetes-rollout-contract.ts` (`e73-#79`).
 */

import { isResourceId } from "./identity-proxy-ids.ts";
import {
  KUBERNETES_ALLOWED_KINDS,
  KUBERNETES_ALLOWED_VERBS,
  KUBERNETES_APPROVAL_OPERATIONS,
  KUBERNETES_POLICY_KIND,
} from "./kubernetes-types.ts";

export const KUBERNETES_STORY = 70;
export const KUBERNETES_EPIC = 69;
/** Jonny's E7.1 map on main. */
export const KUBERNETES_API_PR = 74;
export const KUBERNETES_ROUTE_MAP_SOURCE = "e71-#74" as const;

export const CLUSTER_TARGET_UI_COLLECTION = "cluster-targets";
export const CLUSTER_TARGET_UPSTREAM_COLLECTION = "cluster-targets";
export const KUBERNETES_POLICY_UI_COLLECTION = "policies";
export const KUBERNETES_POLICY_UPSTREAM_COLLECTION = "policies";
export const OPS_CONFIG_SELECT_UI_PATH = "/ops-config/select";
export const OPS_CONFIG_SELECT_UPSTREAM_PATH = "/ops-config/select";
export const KUBERNETES_CATALOG_UI_COLLECTION = "kubernetes";
export const KUBERNETES_CATALOG_UPSTREAM_COLLECTION = "kubernetes";
export const KUBERNETES_CATALOG_ACTION = "catalog";

export const KUBERNETES_DRAFT_ACTION = "draft";
export const KUBERNETES_PUBLISH_ACTION = "publish";
export const KUBERNETES_SELECT_ACTION = "select";
export const KUBERNETES_DISABLE_ACTION = "disable";
export const KUBERNETES_ENABLE_ACTION = "enable";
export const KUBERNETES_VERSIONS_ACTION = "versions";

export const KUBERNETES_PROBLEM_CODES = {
  invalidRequest: "invalid-request",
  unauthenticated: "unauthenticated",
  forbidden: "forbidden",
  notFound: "not-found",
  conflict: "conflict",
} as const;

export const KUBERNETES_SECRET_FREE_HELP =
  "Cluster targets bind a workspace vault credential by display name and id. The UI never lists, stores, or renders kubeconfig, tokens, or plaintext secrets.";

export const KUBERNETES_FAIL_CLOSED_HELP =
  "Selectors fail closed on HTTP 403. Cross-workspace or unauthorized cluster targets are not listed.";

export const HOST_SUPPLIED_IDENTITY_HELP =
  "Host-supplied id or workspaceId is not accepted. The API returns 400 invalid-request.";

export const HOST_SUPPLIED_IDENTITY_DETAIL =
  "Do not send id or workspaceId on writes. Workspace scope comes from the session and tenant + workbench headers.";

export const KUBERNETES_LEAST_PRIVILEGE_NOTES = [
  "Bind each cluster target to a workspace kubernetes credential — never paste a kubeconfig into this UI.",
  "Allowlist only the namespaces, kinds, and verbs the workflow needs. Empty allowlists fail closed.",
  "MVP kinds: ConfigMap, Service, Deployment, StatefulSet, DaemonSet, Job, CronJob, Ingress, NetworkPolicy. Secret manifests are denied.",
  "Kubernetes service accounts should use namespace-scoped Role and RoleBinding. ClusterRoles are not part of MVP.",
  "Workers receive ephemeral scoped material. The API and UI never receive kubeconfigs or plaintext credentials.",
  "Mark side-effecting actions (apply) as approval-required. Target or policy publish invalidates prior approvals.",
] as const;

export const KUBERNETES_KIND_HELP =
  "Allowlisted resource kinds. Secret, cluster-scoped objects, CRDs, RBAC, and admission webhooks are out of MVP.";

export const KUBERNETES_VERB_HELP =
  "Allowlisted verbs for this target. apply always performs server-side dry-run before persist.";

export const KUBERNETES_APPROVAL_HELP =
  "Approval-required operations bind workflow version + target revision + policy revision. Re-evaluate after publish.";

export function clusterTargetsPath(): string {
  return `/${CLUSTER_TARGET_UI_COLLECTION}`;
}

export function clusterTargetPath(resourceId: string): string {
  return `${clusterTargetsPath()}/${resourceId}`;
}

export function clusterTargetDraftPath(resourceId: string): string {
  return `${clusterTargetPath(resourceId)}/${KUBERNETES_DRAFT_ACTION}`;
}

export function clusterTargetPublishPath(resourceId: string): string {
  return `${clusterTargetPath(resourceId)}/${KUBERNETES_PUBLISH_ACTION}`;
}

export function clusterTargetSelectPath(resourceId: string): string {
  return `${clusterTargetPath(resourceId)}/${KUBERNETES_SELECT_ACTION}`;
}

export function clusterTargetDisablePath(resourceId: string): string {
  return `${clusterTargetPath(resourceId)}/${KUBERNETES_DISABLE_ACTION}`;
}

export function clusterTargetEnablePath(resourceId: string): string {
  return `${clusterTargetPath(resourceId)}/${KUBERNETES_ENABLE_ACTION}`;
}

export function clusterTargetVersionsPath(resourceId: string): string {
  return `${clusterTargetPath(resourceId)}/${KUBERNETES_VERSIONS_ACTION}`;
}

export function clusterTargetVersionPath(
  resourceId: string,
  versionId: string,
): string {
  return `${clusterTargetVersionsPath(resourceId)}/${versionId}`;
}

export function kubernetesPoliciesPath(): string {
  return `/${KUBERNETES_POLICY_UI_COLLECTION}`;
}

export function kubernetesPolicyPath(resourceId: string): string {
  return `${kubernetesPoliciesPath()}/${resourceId}`;
}

export function kubernetesPolicyDraftPath(resourceId: string): string {
  return `${kubernetesPolicyPath(resourceId)}/${KUBERNETES_DRAFT_ACTION}`;
}

export function kubernetesPolicyPublishPath(resourceId: string): string {
  return `${kubernetesPolicyPath(resourceId)}/${KUBERNETES_PUBLISH_ACTION}`;
}

export function kubernetesPolicySelectPath(resourceId: string): string {
  return `${kubernetesPolicyPath(resourceId)}/${KUBERNETES_SELECT_ACTION}`;
}

export function kubernetesPolicyVersionsPath(resourceId: string): string {
  return `${kubernetesPolicyPath(resourceId)}/${KUBERNETES_VERSIONS_ACTION}`;
}

export function kubernetesPolicyVersionPath(
  resourceId: string,
  versionId: string,
): string {
  return `${kubernetesPolicyVersionsPath(resourceId)}/${versionId}`;
}

export function kubernetesBatchSelectPath(): string {
  return OPS_CONFIG_SELECT_UI_PATH;
}

export function kubernetesCatalogPath(): string {
  return `/${KUBERNETES_CATALOG_UI_COLLECTION}/${KUBERNETES_CATALOG_ACTION}`;
}

export function opsConfigCatalogPath(): string {
  return "/ops-config/catalog";
}

export function clusterTargetsHref(): string {
  return `/config/${CLUSTER_TARGET_UI_COLLECTION}`;
}

export function kubernetesPoliciesHref(): string {
  return `/config/${KUBERNETES_POLICY_UI_COLLECTION}`;
}

export function retargetCollectionPath(
  uiApiPath: string,
  uiCollection: string,
  upstreamCollection: string,
): string {
  const prefix = `/api/v1/${uiCollection}`;
  const target = `/api/v1/${upstreamCollection}`;
  if (
    uiApiPath === prefix ||
    uiApiPath.startsWith(`${prefix}/`) ||
    uiApiPath.startsWith(`${prefix}?`)
  ) {
    return `${target}${uiApiPath.slice(prefix.length)}`;
  }
  return uiApiPath;
}

/**
 * Rewrite UI `/api/v1/{cluster-targets,policies,kubernetes}…` onto
 * the #74 upstream collections. Today this is identity.
 */
export function retargetKubernetesApiPath(uiApiPath: string): string {
  let collected = retargetCollectionPath(
    uiApiPath,
    CLUSTER_TARGET_UI_COLLECTION,
    CLUSTER_TARGET_UPSTREAM_COLLECTION,
  );
  collected = retargetCollectionPath(
    collected,
    KUBERNETES_POLICY_UI_COLLECTION,
    KUBERNETES_POLICY_UPSTREAM_COLLECTION,
  );
  collected = retargetCollectionPath(
    collected,
    KUBERNETES_CATALOG_UI_COLLECTION,
    KUBERNETES_CATALOG_UPSTREAM_COLLECTION,
  );
  if (OPS_CONFIG_SELECT_UI_PATH === OPS_CONFIG_SELECT_UPSTREAM_PATH) {
    return collected;
  }
  const from = `/api/v1${OPS_CONFIG_SELECT_UI_PATH}`;
  const to = `/api/v1${OPS_CONFIG_SELECT_UPSTREAM_PATH}`;
  if (collected === from || collected.startsWith(`${from}?`)) {
    return `${to}${collected.slice(from.length)}`;
  }
  return collected;
}

export function isKubernetesProxySegments(segments: string[]): boolean {
  return (
    segments[0] === CLUSTER_TARGET_UI_COLLECTION ||
    segments[0] === KUBERNETES_POLICY_UI_COLLECTION ||
    (segments[0] === KUBERNETES_CATALOG_UI_COLLECTION &&
      segments[1] === KUBERNETES_CATALOG_ACTION)
  );
}

export type KubernetesProxyRoute = {
  methods: readonly string[];
  match: (segments: string[]) => boolean;
};

function isE71Collection(value: string | undefined): boolean {
  return (
    value === CLUSTER_TARGET_UI_COLLECTION ||
    value === KUBERNETES_POLICY_UI_COLLECTION
  );
}

/**
 * Allowlisted Next proxy routes. identity-proxy spreads this array so a
 * retarget only edits this file. Draft/publish/versions/select match
 * the #74 map on main (ops-config collections + GET /kubernetes/catalog).
 * No GET …/authorized.
 */
export const KUBERNETES_PROXY_ROUTES: readonly KubernetesProxyRoute[] = [
  {
    methods: ["GET"],
    match: (s) =>
      s.length === 2 &&
      s[0] === KUBERNETES_CATALOG_UI_COLLECTION &&
      s[1] === KUBERNETES_CATALOG_ACTION,
  },
  {
    methods: ["GET", "POST"],
    match: (s) => s.length === 1 && isE71Collection(s[0]),
  },
  {
    methods: ["GET"],
    match: (s) =>
      s.length === 2 && isE71Collection(s[0]) && isResourceId(s[1]),
  },
  {
    methods: ["GET", "PUT"],
    match: (s) =>
      s.length === 3 &&
      isE71Collection(s[0]) &&
      isResourceId(s[1]) &&
      s[2] === KUBERNETES_DRAFT_ACTION,
  },
  {
    methods: ["POST"],
    match: (s) =>
      s.length === 3 &&
      isE71Collection(s[0]) &&
      isResourceId(s[1]) &&
      (s[2] === KUBERNETES_PUBLISH_ACTION ||
        s[2] === KUBERNETES_SELECT_ACTION ||
        s[2] === KUBERNETES_DISABLE_ACTION ||
        s[2] === KUBERNETES_ENABLE_ACTION),
  },
  {
    methods: ["GET"],
    match: (s) =>
      s.length === 3 &&
      isE71Collection(s[0]) &&
      isResourceId(s[1]) &&
      s[2] === KUBERNETES_VERSIONS_ACTION,
  },
  {
    methods: ["GET"],
    match: (s) =>
      s.length === 4 &&
      isE71Collection(s[0]) &&
      isResourceId(s[1]) &&
      s[2] === KUBERNETES_VERSIONS_ACTION &&
      isResourceId(s[3]),
  },
];

export function emptyKubernetesPolicy(): {
  kind: typeof KUBERNETES_POLICY_KIND;
  policy: {
    allowedNamespaces: string[];
    allowedKinds: string[];
    allowedVerbs: string[];
    requireApproval: boolean;
    operations: string[];
  };
} {
  return {
    kind: KUBERNETES_POLICY_KIND,
    policy: {
      allowedNamespaces: [],
      allowedKinds: [],
      allowedVerbs: [],
      requireApproval: false,
      operations: [],
    },
  };
}

export const KUBERNETES_CATALOG_KINDS = KUBERNETES_ALLOWED_KINDS;
export const KUBERNETES_CATALOG_VERBS = KUBERNETES_ALLOWED_VERBS;
export const KUBERNETES_CATALOG_OPERATIONS = KUBERNETES_APPROVAL_OPERATIONS;

export {
  KUBERNETES_NODE_API_PR,
  KUBERNETES_NODE_EPIC,
  KUBERNETES_NODE_ROUTE_MAP_SOURCE,
  KUBERNETES_NODE_STORY,
} from "./kubernetes-node-contract.ts";
