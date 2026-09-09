/**
 * Typed E7.1 client. Paths come from kubernetes-contract.ts so a
 * retarget only edits that adapter. Session cookies + CSRF on
 * mutations. credentials: include. Specs are secret-stripped.
 */

import { callIdentityProxy, type IdentityClientResult } from "./identity-client.ts";
import type { DevIdentity } from "./identity-headers.ts";
import {
  clusterTargetDraftPath,
  clusterTargetPath,
  clusterTargetPublishPath,
  clusterTargetSelectPath,
  clusterTargetsPath,
  clusterTargetVersionPath,
  clusterTargetVersionsPath,
  kubernetesBatchSelectPath,
  kubernetesPoliciesPath,
  kubernetesPolicyDraftPath,
  kubernetesPolicyPath,
  kubernetesPolicyPublishPath,
  kubernetesPolicySelectPath,
  kubernetesPolicyVersionPath,
  kubernetesPolicyVersionsPath,
} from "./kubernetes-contract.ts";
import { isKubernetesPolicySpec, sanitizeKubernetesSpec } from "./kubernetes.ts";
import { problemFieldErrors, type ProblemDetails } from "./problem.ts";
import {
  buildCreateBody,
  buildPublishBody,
  buildSaveDraftBody,
  buildSelectBody,
  buildBatchSelectBody,
} from "./ops-config-contract.ts";
import {
  parseAuthorizedPins,
  parseOpsConfigDraft,
  parseOpsConfigList,
  parseOpsConfigPin,
  parseOpsConfigRecord,
  parseOpsConfigVersion,
} from "./ops-config.ts";
import type {
  OpsConfigDraft,
  OpsConfigKind,
  OpsConfigPin,
  OpsConfigRecord,
  OpsConfigSpec,
  OpsConfigSummary,
  OpsConfigVersion,
  SelectRef,
} from "./ops-config-types.ts";

export type KubernetesClientFailure = {
  ok: false;
  statusCode: number;
  requestId: string;
  problem: ProblemDetails;
  conflict: boolean;
  strippedKeys: string[];
};

export type ClusterTargetListSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  items: OpsConfigSummary[];
  strippedKeys: string[];
};

export type KubernetesDraftSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  resource?: OpsConfigRecord;
  draft: OpsConfigDraft;
  strippedKeys: string[];
};

export type KubernetesRecordSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  resource: OpsConfigRecord;
  strippedKeys: string[];
};

export type KubernetesPublishSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  resource: OpsConfigRecord;
  version: OpsConfigVersion;
  strippedKeys: string[];
};

export type KubernetesSelectSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  pin: OpsConfigPin;
  strippedKeys: string[];
};

export type KubernetesPinsSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  items: OpsConfigPin[];
  strippedKeys: string[];
};

export type KubernetesVersionsSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  items: OpsConfigVersion[];
  strippedKeys: string[];
};

export type KubernetesVersionSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  version: OpsConfigVersion;
  strippedKeys: string[];
};

export async function listClusterTargets(
  identity: DevIdentity,
): Promise<ClusterTargetListSuccess | KubernetesClientFailure> {
  return listCollection(identity, clusterTargetsPath(), "cluster_target");
}

export async function createClusterTarget(
  identity: DevIdentity,
  name: string,
  spec: OpsConfigSpec,
  slug?: string,
): Promise<KubernetesDraftSuccess | KubernetesClientFailure> {
  const path = clusterTargetsPath();
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "POST",
    body: buildCreateBody(name, sanitizeKubernetesSpec(spec), slug, "cluster_target"),
  });
  return draftResult(result, path, "cluster_target");
}

export async function getClusterTarget(
  identity: DevIdentity,
  resourceId: string,
): Promise<KubernetesRecordSuccess | KubernetesClientFailure> {
  return getRecord(identity, clusterTargetPath(resourceId), "cluster_target");
}

export async function getClusterTargetDraft(
  identity: DevIdentity,
  resourceId: string,
): Promise<KubernetesDraftSuccess | KubernetesClientFailure> {
  return draftOnly(
    identity,
    clusterTargetDraftPath(resourceId),
    "cluster_target",
    resourceId,
  );
}

export async function saveClusterTargetDraft(
  identity: DevIdentity,
  resourceId: string,
  revision: number,
  spec: OpsConfigSpec,
  name?: string,
): Promise<KubernetesDraftSuccess | KubernetesClientFailure> {
  const path = clusterTargetDraftPath(resourceId);
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "PUT",
    body: buildSaveDraftBody(
      revision,
      sanitizeKubernetesSpec(spec),
      name,
      "cluster_target",
    ),
  });
  return draftResult(result, path, "cluster_target");
}

export async function publishClusterTarget(
  identity: DevIdentity,
  resourceId: string,
  revision?: number,
  note?: string,
): Promise<KubernetesPublishSuccess | KubernetesClientFailure> {
  return publishResource(
    identity,
    clusterTargetPublishPath(resourceId),
    "cluster_target",
    revision,
    note,
  );
}

export async function selectClusterTarget(
  identity: DevIdentity,
  resourceId: string,
  versionId?: string,
): Promise<KubernetesSelectSuccess | KubernetesClientFailure> {
  return selectResource(
    identity,
    clusterTargetSelectPath(resourceId),
    "cluster_target",
    versionId,
  );
}

export async function listClusterTargetVersions(
  identity: DevIdentity,
  resourceId: string,
): Promise<KubernetesVersionsSuccess | KubernetesClientFailure> {
  return listVersions(
    identity,
    clusterTargetVersionsPath(resourceId),
    "cluster_target",
  );
}

export async function getClusterTargetVersion(
  identity: DevIdentity,
  resourceId: string,
  versionId: string,
): Promise<KubernetesVersionSuccess | KubernetesClientFailure> {
  return getVersion(
    identity,
    clusterTargetVersionPath(resourceId, versionId),
    "cluster_target",
  );
}

export async function listKubernetesPolicies(
  identity: DevIdentity,
): Promise<ClusterTargetListSuccess | KubernetesClientFailure> {
  return listCollection(identity, kubernetesPoliciesPath(), "policy");
}

export async function createKubernetesPolicy(
  identity: DevIdentity,
  name: string,
  spec: OpsConfigSpec,
  slug?: string,
): Promise<KubernetesDraftSuccess | KubernetesClientFailure> {
  const path = kubernetesPoliciesPath();
  const safe = sanitizeKubernetesSpec({
    ...spec,
    kind: spec.kind ?? "kubernetes",
  });
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "POST",
    body: buildCreateBody(name, safe, slug, "policy"),
  });
  return draftResult(result, path, "policy");
}

export async function getKubernetesPolicy(
  identity: DevIdentity,
  resourceId: string,
): Promise<KubernetesRecordSuccess | KubernetesClientFailure> {
  return getRecord(identity, kubernetesPolicyPath(resourceId), "policy");
}

export async function getKubernetesPolicyDraft(
  identity: DevIdentity,
  resourceId: string,
): Promise<KubernetesDraftSuccess | KubernetesClientFailure> {
  return draftOnly(
    identity,
    kubernetesPolicyDraftPath(resourceId),
    "policy",
    resourceId,
  );
}

export async function saveKubernetesPolicyDraft(
  identity: DevIdentity,
  resourceId: string,
  revision: number,
  spec: OpsConfigSpec,
  name?: string,
): Promise<KubernetesDraftSuccess | KubernetesClientFailure> {
  const path = kubernetesPolicyDraftPath(resourceId);
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "PUT",
    body: buildSaveDraftBody(
      revision,
      sanitizeKubernetesSpec(spec),
      name,
      "policy",
    ),
  });
  return draftResult(result, path, "policy");
}

export async function publishKubernetesPolicy(
  identity: DevIdentity,
  resourceId: string,
  revision?: number,
  note?: string,
): Promise<KubernetesPublishSuccess | KubernetesClientFailure> {
  return publishResource(
    identity,
    kubernetesPolicyPublishPath(resourceId),
    "policy",
    revision,
    note,
  );
}

export async function selectKubernetesPolicy(
  identity: DevIdentity,
  resourceId: string,
  versionId?: string,
): Promise<KubernetesSelectSuccess | KubernetesClientFailure> {
  const selected = await selectResource(
    identity,
    kubernetesPolicySelectPath(resourceId),
    "policy",
    versionId,
  );
  if (!selected.ok) {
    return selected;
  }
  if (selected.pin.spec && !isKubernetesPolicySpec(selected.pin.spec)) {
    return {
      ok: false,
      statusCode: 400,
      requestId: selected.requestId,
      problem: {
        type: "urn:flowforge:problem:invalid-request",
        title: "Invalid Request",
        status: 400,
        detail: "Selected policy is not a kubernetes policy.",
        instance: kubernetesPolicySelectPath(resourceId),
        code: "invalid-request",
        request_id: selected.requestId,
      },
      conflict: false,
      strippedKeys: selected.strippedKeys,
    };
  }
  return selected;
}

export async function listKubernetesPolicyVersions(
  identity: DevIdentity,
  resourceId: string,
): Promise<KubernetesVersionsSuccess | KubernetesClientFailure> {
  return listVersions(
    identity,
    kubernetesPolicyVersionsPath(resourceId),
    "policy",
  );
}

export async function getKubernetesPolicyVersion(
  identity: DevIdentity,
  resourceId: string,
  versionId: string,
): Promise<KubernetesVersionSuccess | KubernetesClientFailure> {
  return getVersion(
    identity,
    kubernetesPolicyVersionPath(resourceId, versionId),
    "policy",
  );
}

export async function selectKubernetesBatch(
  identity: DevIdentity,
  refs: SelectRef[],
): Promise<KubernetesPinsSuccess | KubernetesClientFailure> {
  const path = kubernetesBatchSelectPath();
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "POST",
    body: buildBatchSelectBody(refs),
  });
  if (!result.ok) {
    return failure(result);
  }
  const items = parseAuthorizedPins(result.data).map((pin) =>
    pin.spec ? { ...pin, spec: sanitizeKubernetesSpec(pin.spec) } : pin,
  );
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    items,
    strippedKeys: [],
  };
}

async function listCollection(
  identity: DevIdentity,
  path: string,
  kind: OpsConfigKind,
): Promise<ClusterTargetListSuccess | KubernetesClientFailure> {
  const result = await callIdentityProxy<unknown>(path, identity);
  if (!result.ok) {
    return failure(result);
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    items: parseOpsConfigList(result.data).map((item) => ({ ...item, kind })),
    strippedKeys: [],
  };
}

async function getRecord(
  identity: DevIdentity,
  path: string,
  kind: OpsConfigKind,
): Promise<KubernetesRecordSuccess | KubernetesClientFailure> {
  const result = await callIdentityProxy<unknown>(path, identity);
  if (!result.ok) {
    return failure(result);
  }
  const resource = parseOpsConfigRecord(result.data);
  if (!resource) {
    return malformed(
      result.requestId,
      result.statusCode,
      path,
      "Resource was missing id, name, or status.",
    );
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    resource: { ...resource, kind },
    strippedKeys: [],
  };
}

async function draftOnly(
  identity: DevIdentity,
  path: string,
  kind: OpsConfigKind,
  resourceId: string,
): Promise<KubernetesDraftSuccess | KubernetesClientFailure> {
  const result = await callIdentityProxy<unknown>(path, identity);
  if (!result.ok) {
    return failure(result);
  }
  const draft = parseOpsConfigDraft(result.data);
  if (!draft) {
    return malformed(
      result.requestId,
      result.statusCode,
      path,
      "Draft payload was missing revision.",
    );
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    draft: {
      ...draft,
      kind,
      resourceId: draft.resourceId || resourceId,
      spec: sanitizeKubernetesSpec(draft.spec),
    },
    strippedKeys: [],
  };
}

async function publishResource(
  identity: DevIdentity,
  path: string,
  kind: OpsConfigKind,
  revision?: number,
  note?: string,
): Promise<KubernetesPublishSuccess | KubernetesClientFailure> {
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "POST",
    body: buildPublishBody(revision, note),
  });
  if (!result.ok) {
    return failure(result);
  }
  const payload = asRecord(result.data);
  const resource = parseOpsConfigRecord(payload.resource ?? payload);
  const version = parseOpsConfigVersion(payload.version);
  if (!resource || !version) {
    return malformed(
      result.requestId,
      result.statusCode,
      path,
      "Publish returned a payload without resource and immutable version.",
    );
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    resource: { ...resource, kind },
    version: {
      ...version,
      kind,
      spec: sanitizeKubernetesSpec(version.spec),
    },
    strippedKeys: [],
  };
}

async function selectResource(
  identity: DevIdentity,
  path: string,
  kind: OpsConfigKind,
  versionId?: string,
): Promise<KubernetesSelectSuccess | KubernetesClientFailure> {
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "POST",
    body: buildSelectBody(versionId),
  });
  if (!result.ok) {
    return failure(result);
  }
  const pin = parseOpsConfigPin(result.data);
  if (!pin) {
    return malformed(
      result.requestId,
      result.statusCode,
      path,
      "Select returned a payload without resourceId and versionId.",
    );
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    pin: {
      ...pin,
      kind,
      spec: pin.spec ? sanitizeKubernetesSpec(pin.spec) : undefined,
    },
    strippedKeys: [],
  };
}

async function listVersions(
  identity: DevIdentity,
  path: string,
  kind: OpsConfigKind,
): Promise<KubernetesVersionsSuccess | KubernetesClientFailure> {
  const result = await callIdentityProxy<unknown>(path, identity);
  if (!result.ok) {
    return failure(result);
  }
  const items = asItems(result.data)
    .map(parseOpsConfigVersion)
    .filter((item): item is OpsConfigVersion => item !== null)
    .map((item) => ({
      ...item,
      kind,
      spec: sanitizeKubernetesSpec(item.spec),
    }));
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    items,
    strippedKeys: [],
  };
}

async function getVersion(
  identity: DevIdentity,
  path: string,
  kind: OpsConfigKind,
): Promise<KubernetesVersionSuccess | KubernetesClientFailure> {
  const result = await callIdentityProxy<unknown>(path, identity);
  if (!result.ok) {
    return failure(result);
  }
  const version = parseOpsConfigVersion(result.data);
  if (!version) {
    return malformed(
      result.requestId,
      result.statusCode,
      path,
      "Version payload was missing id or digest.",
    );
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    version: { ...version, kind, spec: sanitizeKubernetesSpec(version.spec) },
    strippedKeys: [],
  };
}

function draftResult(
  result: IdentityClientResult<unknown>,
  instance: string,
  kind: OpsConfigKind,
): KubernetesDraftSuccess | KubernetesClientFailure {
  if (!result.ok) {
    return failure(result);
  }
  const payload = asRecord(result.data);
  const draft = parseOpsConfigDraft(payload.draft ?? payload);
  if (!draft) {
    return malformed(
      result.requestId,
      result.statusCode,
      instance,
      "Response was missing a draft with revision.",
    );
  }
  const resource = parseOpsConfigRecord(payload.resource);
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    resource: resource ? { ...resource, kind } : undefined,
    draft: { ...draft, kind, spec: sanitizeKubernetesSpec(draft.spec) },
    strippedKeys: [],
  };
}

function failure(
  result: Extract<IdentityClientResult<unknown>, { ok: false }>,
): KubernetesClientFailure {
  return {
    ok: false,
    statusCode: result.statusCode,
    requestId: result.requestId,
    problem: {
      ...result.problem,
      errors: problemFieldErrors(result.problem),
    },
    conflict: result.problem.code === "conflict" || result.statusCode === 409,
    strippedKeys: [],
  };
}

function malformed(
  requestId: string,
  statusCode: number,
  instance: string,
  detail: string,
): KubernetesClientFailure {
  return {
    ok: false,
    statusCode,
    requestId,
    problem: {
      type: "urn:flowforge:problem:upstream-error",
      title: "Upstream Error",
      status: statusCode,
      detail,
      instance,
      code: "upstream-error",
      request_id: requestId,
    },
    conflict: false,
    strippedKeys: [],
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function asItems(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (
    value &&
    typeof value === "object" &&
    Array.isArray((value as { items?: unknown }).items)
  ) {
    return (value as { items: unknown[] }).items;
  }
  return [];
}
