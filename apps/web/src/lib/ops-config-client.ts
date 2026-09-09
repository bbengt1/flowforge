/**
 * Thin typed E4.2 client aligned to #41.
 * PUT draft with body revision. POST select for pins.
 * Session cookies + CSRF on mutations. credentials: include.
 */

import { callIdentityProxy, type IdentityClientResult } from "./identity-client.ts";
import type { DevIdentity } from "./identity-headers.ts";
import {
  hostSuppliedIdentityKeys,
  hostSuppliedIdentityProblem,
} from "./kubernetes.ts";
import { problemFieldErrors, type ProblemDetails } from "./problem.ts";
import {
  batchSelectPath,
  buildBatchSelectBody,
  buildCreateBody,
  buildPublishBody,
  buildSaveDraftBody,
  buildSelectBody,
  catalogPath,
  collectionPath,
  disablePath,
  draftPath,
  enablePath,
  publishPath,
  resourcePath,
  selectPath,
  versionPath,
  versionsPath,
  workflowVersionPinsPath,
} from "./ops-config-contract.ts";
import {
  parseAuthorizedPins,
  parseOpsConfigDraft,
  parseOpsConfigList,
  parseOpsConfigPin,
  parseOpsConfigRecord,
  parseOpsConfigVersion,
  stripSecrets,
} from "./ops-config.ts";
import type {
  OpsConfigCatalog,
  OpsConfigDraft,
  OpsConfigKind,
  OpsConfigPin,
  OpsConfigRecord,
  OpsConfigSpec,
  OpsConfigSummary,
  OpsConfigVersion,
  SelectRef,
} from "./ops-config-types.ts";

export type OpsConfigClientFailure = {
  ok: false;
  statusCode: number;
  requestId: string;
  problem: ProblemDetails;
  conflict: boolean;
};

export type ListConfigSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  items: OpsConfigSummary[];
};

export type RecordSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  resource: OpsConfigRecord;
};

export type DraftSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  resource?: OpsConfigRecord;
  draft: OpsConfigDraft;
};

export type PublishSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  resource: OpsConfigRecord;
  version: OpsConfigVersion;
};

export type VersionsSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  items: OpsConfigVersion[];
};

export type VersionSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  version: OpsConfigVersion;
};

export type SelectSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  pin: OpsConfigPin;
};

export type PinsSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  items: OpsConfigPin[];
};

export type CatalogSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  catalog: OpsConfigCatalog;
};

export async function getOpsConfigCatalog(
  identity: DevIdentity,
): Promise<CatalogSuccess | OpsConfigClientFailure> {
  const result = await callIdentityProxy<unknown>(catalogPath(), identity);
  if (!result.ok) {
    return failure(result);
  }
  const payload = asRecord(result.data);
  const kinds = Array.isArray(payload.kinds)
    ? (payload.kinds as OpsConfigCatalog["kinds"])
    : [];
  const engineRaw = payload.kubernetesEngine;
  const kubernetesEngine =
    engineRaw && typeof engineRaw === "object" && !Array.isArray(engineRaw)
      ? stripSecrets(engineRaw as Record<string, unknown>)
      : undefined;
  const sshEngineRaw = payload.sshEngine;
  const sshEngine =
    sshEngineRaw && typeof sshEngineRaw === "object" && !Array.isArray(sshEngineRaw)
      ? stripSecrets(sshEngineRaw as Record<string, unknown>)
      : undefined;
  const scriptEngineRaw = payload.scriptEngine;
  const scriptEngine =
    scriptEngineRaw &&
    typeof scriptEngineRaw === "object" &&
    !Array.isArray(scriptEngineRaw)
      ? stripSecrets(scriptEngineRaw as Record<string, unknown>)
      : undefined;
  const httpEngineRaw = payload.httpEngine;
  const httpEngine =
    httpEngineRaw && typeof httpEngineRaw === "object" && !Array.isArray(httpEngineRaw)
      ? stripSecrets(httpEngineRaw as Record<string, unknown>)
      : undefined;
  const notificationEngineRaw = payload.notificationEngine;
  const notificationEngine =
    notificationEngineRaw &&
    typeof notificationEngineRaw === "object" &&
    !Array.isArray(notificationEngineRaw)
      ? stripSecrets(notificationEngineRaw as Record<string, unknown>)
      : undefined;
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    catalog: {
      kinds,
      kubernetesEngine,
      sshEngine,
      scriptEngine,
      httpEngine,
      notificationEngine,
    },
  };
}

export async function listOpsConfig(
  identity: DevIdentity,
  kind: OpsConfigKind,
): Promise<ListConfigSuccess | OpsConfigClientFailure> {
  const path = collectionPath(kind);
  const result = await callIdentityProxy<unknown>(path, identity);
  if (!result.ok) {
    return failure(result);
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    items: parseOpsConfigList(result.data).map((item) => ({ ...item, kind })),
  };
}

export async function createOpsConfig(
  identity: DevIdentity,
  kind: OpsConfigKind,
  name: string,
  spec: OpsConfigSpec,
  slug?: string,
): Promise<DraftSuccess | OpsConfigClientFailure> {
  const path = collectionPath(kind);
  const rejected = rejectHostIdentity(spec, path);
  if (rejected) {
    return rejected;
  }
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "POST",
    body: buildCreateBody(name, spec, slug, kind),
  });
  return draftResult(result, path, kind);
}

export async function getOpsConfig(
  identity: DevIdentity,
  kind: OpsConfigKind,
  resourceId: string,
): Promise<RecordSuccess | OpsConfigClientFailure> {
  const path = resourcePath(kind, resourceId);
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
      "Config resource was missing id, name, or status.",
    );
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    resource: { ...resource, kind },
  };
}

export async function getOpsConfigDraft(
  identity: DevIdentity,
  kind: OpsConfigKind,
  resourceId: string,
): Promise<DraftSuccess | OpsConfigClientFailure> {
  const path = draftPath(kind, resourceId);
  const result = await callIdentityProxy<unknown>(path, identity);
  return draftOnlyResult(result, path, kind, resourceId);
}

export async function saveOpsConfigDraft(
  identity: DevIdentity,
  kind: OpsConfigKind,
  resourceId: string,
  revision: number,
  spec: OpsConfigSpec,
  name?: string,
): Promise<DraftSuccess | OpsConfigClientFailure> {
  const path = draftPath(kind, resourceId);
  const rejected = rejectHostIdentity(spec, path);
  if (rejected) {
    return rejected;
  }
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "PUT",
    body: buildSaveDraftBody(revision, spec, name, kind),
  });
  return draftResult(result, path, kind);
}

export async function publishOpsConfig(
  identity: DevIdentity,
  kind: OpsConfigKind,
  resourceId: string,
  revision?: number,
  note?: string,
): Promise<PublishSuccess | OpsConfigClientFailure> {
  const path = publishPath(kind, resourceId);
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
    version: { ...version, kind },
  };
}

export async function listOpsConfigVersions(
  identity: DevIdentity,
  kind: OpsConfigKind,
  resourceId: string,
): Promise<VersionsSuccess | OpsConfigClientFailure> {
  const path = versionsPath(kind, resourceId);
  const result = await callIdentityProxy<unknown>(path, identity);
  if (!result.ok) {
    return failure(result);
  }
  const items = asItems(result.data)
    .map(parseOpsConfigVersion)
    .filter((item): item is OpsConfigVersion => item !== null)
    .map((item) => ({ ...item, kind }));
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    items,
  };
}

export async function getOpsConfigVersion(
  identity: DevIdentity,
  kind: OpsConfigKind,
  resourceId: string,
  versionId: string,
): Promise<VersionSuccess | OpsConfigClientFailure> {
  const path = versionPath(kind, resourceId, versionId);
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
    version: { ...version, kind },
  };
}

export async function selectOpsConfig(
  identity: DevIdentity,
  kind: OpsConfigKind,
  resourceId: string,
  versionId?: string,
): Promise<SelectSuccess | OpsConfigClientFailure> {
  const path = selectPath(kind, resourceId);
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
    pin: { ...pin, kind },
  };
}

export async function selectOpsConfigBatch(
  identity: DevIdentity,
  refs: SelectRef[],
): Promise<PinsSuccess | OpsConfigClientFailure> {
  const path = batchSelectPath();
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "POST",
    body: buildBatchSelectBody(refs),
  });
  if (!result.ok) {
    return failure(result);
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    items: parseAuthorizedPins(result.data),
  };
}

export async function disableOpsConfig(
  identity: DevIdentity,
  kind: OpsConfigKind,
  resourceId: string,
): Promise<RecordSuccess | OpsConfigClientFailure> {
  return mutateHead(identity, disablePath(kind, resourceId), kind);
}

export async function enableOpsConfig(
  identity: DevIdentity,
  kind: OpsConfigKind,
  resourceId: string,
): Promise<RecordSuccess | OpsConfigClientFailure> {
  return mutateHead(identity, enablePath(kind, resourceId), kind);
}

export async function listWorkflowVersionPins(
  identity: DevIdentity,
  workflowId: string,
  versionId: string,
): Promise<PinsSuccess | OpsConfigClientFailure> {
  const path = workflowVersionPinsPath(workflowId, versionId);
  const result = await callIdentityProxy<unknown>(path, identity);
  if (!result.ok) {
    return failure(result);
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    items: parseAuthorizedPins(result.data),
  };
}

async function mutateHead(
  identity: DevIdentity,
  path: string,
  kind: OpsConfigKind,
): Promise<RecordSuccess | OpsConfigClientFailure> {
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "POST",
    body: {},
  });
  if (!result.ok) {
    return failure(result);
  }
  const resource = parseOpsConfigRecord(result.data);
  if (!resource) {
    return malformed(
      result.requestId,
      result.statusCode,
      path,
      "Response was missing a resource head.",
    );
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    resource: { ...resource, kind },
  };
}

function draftResult(
  result: IdentityClientResult<unknown>,
  instance: string,
  kind: OpsConfigKind,
): DraftSuccess | OpsConfigClientFailure {
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
    draft: { ...draft, kind },
  };
}

function draftOnlyResult(
  result: IdentityClientResult<unknown>,
  instance: string,
  kind: OpsConfigKind,
  resourceId: string,
): DraftSuccess | OpsConfigClientFailure {
  if (!result.ok) {
    return failure(result);
  }
  const draft = parseOpsConfigDraft(result.data);
  if (!draft) {
    return malformed(
      result.requestId,
      result.statusCode,
      instance,
      "Draft payload was missing revision.",
    );
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    draft: { ...draft, kind, resourceId: draft.resourceId || resourceId },
  };
}

function rejectHostIdentity(
  spec: OpsConfigSpec,
  instance: string,
): OpsConfigClientFailure | null {
  const keys = hostSuppliedIdentityKeys(spec);
  if (keys.length === 0) {
    return null;
  }
  return {
    ok: false,
    statusCode: 400,
    requestId: "client",
    problem: hostSuppliedIdentityProblem(keys, instance),
    conflict: false,
  };
}

function failure(
  result: Extract<IdentityClientResult<unknown>, { ok: false }>,
): OpsConfigClientFailure {
  return {
    ok: false,
    statusCode: result.statusCode,
    requestId: result.requestId,
    problem: {
      ...result.problem,
      errors: problemFieldErrors(result.problem),
    },
    conflict: result.problem.code === "conflict" || result.statusCode === 409,
  };
}

function malformed(
  requestId: string,
  statusCode: number,
  instance: string,
  detail: string,
): OpsConfigClientFailure {
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
  if (value && typeof value === "object" && Array.isArray((value as { items?: unknown }).items)) {
    return (value as { items: unknown[] }).items;
  }
  return [];
}
