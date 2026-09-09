import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CLUSTER_TARGET_UI_COLLECTION,
  CLUSTER_TARGET_UPSTREAM_COLLECTION,
  KUBERNETES_API_PR,
  KUBERNETES_EPIC,
  KUBERNETES_LEAST_PRIVILEGE_NOTES,
  KUBERNETES_POLICY_UI_COLLECTION,
  KUBERNETES_POLICY_UPSTREAM_COLLECTION,
  KUBERNETES_PROXY_ROUTES,
  KUBERNETES_ROUTE_MAP_SOURCE,
  KUBERNETES_STORY,
  clusterTargetDraftPath,
  clusterTargetPublishPath,
  clusterTargetSelectPath,
  clusterTargetsHref,
  clusterTargetsPath,
  clusterTargetVersionPath,
  emptyKubernetesPolicy,
  isKubernetesProxySegments,
  kubernetesCatalogPath,
  kubernetesPoliciesHref,
  kubernetesPoliciesPath,
  kubernetesPolicyDraftPath,
  opsConfigCatalogPath,
  retargetCollectionPath,
  retargetKubernetesApiPath,
} from "./kubernetes-contract.ts";

const RESOURCE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";

describe("kubernetes contract (#70 retarget adapter)", () => {
  it("cites E7.1 / E7 and the #74 map on main", () => {
    assert.equal(KUBERNETES_STORY, 70);
    assert.equal(KUBERNETES_EPIC, 69);
    assert.equal(KUBERNETES_API_PR, 74);
    assert.equal(KUBERNETES_ROUTE_MAP_SOURCE, "e71-#74");
    assert.equal(CLUSTER_TARGET_UI_COLLECTION, "cluster-targets");
    assert.equal(CLUSTER_TARGET_UPSTREAM_COLLECTION, "cluster-targets");
    assert.equal(KUBERNETES_POLICY_UI_COLLECTION, "policies");
    assert.equal(KUBERNETES_POLICY_UPSTREAM_COLLECTION, "policies");
    assert.equal(kubernetesCatalogPath(), "/kubernetes/catalog");
    assert.equal(opsConfigCatalogPath(), "/ops-config/catalog");
  });

  it("builds REST paths consistent with ops-config draft/publish/versions", () => {
    assert.equal(clusterTargetsPath(), "/cluster-targets");
    assert.equal(
      clusterTargetDraftPath(RESOURCE_ID),
      `/cluster-targets/${RESOURCE_ID}/draft`,
    );
    assert.equal(
      clusterTargetPublishPath(RESOURCE_ID),
      `/cluster-targets/${RESOURCE_ID}/publish`,
    );
    assert.equal(
      clusterTargetSelectPath(RESOURCE_ID),
      `/cluster-targets/${RESOURCE_ID}/select`,
    );
    assert.equal(
      clusterTargetVersionPath(RESOURCE_ID, VERSION_ID),
      `/cluster-targets/${RESOURCE_ID}/versions/${VERSION_ID}`,
    );
    assert.equal(kubernetesPoliciesPath(), "/policies");
    assert.equal(
      kubernetesPolicyDraftPath(RESOURCE_ID),
      `/policies/${RESOURCE_ID}/draft`,
    );
    assert.equal(clusterTargetsHref(), "/config/cluster-targets");
    assert.equal(kubernetesPoliciesHref(), "/config/policies");
  });

  it("retargets UI /api/v1 collections onto upstream in one place", () => {
    assert.equal(
      retargetKubernetesApiPath("/api/v1/cluster-targets"),
      "/api/v1/cluster-targets",
    );
    assert.equal(
      retargetKubernetesApiPath(`/api/v1/cluster-targets/${RESOURCE_ID}/select`),
      `/api/v1/cluster-targets/${RESOURCE_ID}/select`,
    );
    assert.equal(
      retargetKubernetesApiPath(`/api/v1/policies/${RESOURCE_ID}/draft`),
      `/api/v1/policies/${RESOURCE_ID}/draft`,
    );
    assert.equal(
      retargetKubernetesApiPath("/api/v1/kubernetes/catalog"),
      "/api/v1/kubernetes/catalog",
    );
    assert.equal(
      retargetCollectionPath(
        "/api/v1/cluster-targets",
        "cluster-targets",
        "k8s-targets",
      ),
      "/api/v1/k8s-targets",
    );
    assert.equal(
      retargetCollectionPath(
        `/api/v1/cluster-targets/${RESOURCE_ID}/publish`,
        "cluster-targets",
        "k8s-targets",
      ),
      `/api/v1/k8s-targets/${RESOURCE_ID}/publish`,
    );
  });

  it("allowlists draft/publish/select/versions and rejects authorized", () => {
    assert.equal(isKubernetesProxySegments(["cluster-targets"]), true);
    assert.equal(isKubernetesProxySegments(["policies", RESOURCE_ID]), true);
    assert.equal(isKubernetesProxySegments(["kubernetes", "catalog"]), true);
    assert.equal(isKubernetesProxySegments(["ssh-targets"]), false);
    const catalog = KUBERNETES_PROXY_ROUTES.some(
      (route) =>
        route.methods.includes("GET") &&
        route.match(["kubernetes", "catalog"]),
    );
    assert.equal(catalog, true);
    const list = KUBERNETES_PROXY_ROUTES.some(
      (route) =>
        route.methods.includes("GET") && route.match(["cluster-targets"]),
    );
    const select = KUBERNETES_PROXY_ROUTES.some(
      (route) =>
        route.methods.includes("POST") &&
        route.match(["cluster-targets", RESOURCE_ID, "select"]),
    );
    const authorized = KUBERNETES_PROXY_ROUTES.some((route) =>
      route.match(["cluster-targets", "authorized"]),
    );
    assert.equal(list, true);
    assert.equal(select, true);
    assert.equal(authorized, false);
  });

  it("empty kubernetes policy is secret-free and least-privilege notes mention kubeconfig", () => {
    const empty = emptyKubernetesPolicy();
    assert.equal(empty.kind, "kubernetes");
    assert.deepEqual(empty.policy.allowedNamespaces, []);
    assert.deepEqual(empty.policy.allowedKinds, []);
    assert.deepEqual(empty.policy.allowedVerbs, []);
    assert.equal(empty.policy.requireApproval, false);
    assert.equal("kubeconfig" in empty, false);
    assert.equal("kubeconfig" in empty.policy, false);
    assert.ok(
      KUBERNETES_LEAST_PRIVILEGE_NOTES.some((note) =>
        /kubeconfig/i.test(note),
      ),
    );
  });
});
