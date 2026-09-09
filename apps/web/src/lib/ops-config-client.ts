/**
 * Thin typed E4.2 client. Session cookies + CSRF on mutations.
 * Paths come from ops-config-contract.ts so a route-map retarget is one file.
 */

import { callIdentityProxy, type IdentityClientResult } from "./identity-client.ts";
import type { DevIdentity } from "./identity-headers.ts";
import { problemFieldErrors, type ProblemDetails } from "./problem.ts";
import {
  authorizedPath,
  buildCompareBody,
  buildCreateBody,
  buildPublishBody,
  buildRestoreBody,
  buildSaveDraftBody,
  collectionPath,
  comparePath,
  draftPath,
  IF_MATCH_HEADER,
  publishPath,
  resourcePath,
  restorePath,
  versionPath,
  versionsPath,
} from "./ops-config-contract.ts";
import {
  parseAuthorizedPins,
  parseCompareResult,
  parseOpsConfigDraft,
  parseOpsConfigList,
  parseOpsConfigRecord,
  parseOpsConfigVersion,
} from "./ops-config.ts";
import type {
  CompareConfigRef,
  CompareConfigResult,
  OpsConfigDraft,
  OpsConfigKind,
  OpsConfigPin,
  OpsConfigRecord,
  OpsConfigSpec,
  OpsConfigSummary,
  OpsConfigVersion,
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

export type CompareSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  compare: CompareConfigResult;
};

export type AuthorizedSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  items: OpsConfigPin[];
};

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

export async function listAuthorizedPins(
  identity: DevIdentity,
  kind: OpsConfigKind,
): Promise<AuthorizedSuccess | OpsConfigClientFailure> {
  const path = authorizedPath(kind);
  const result = await callIdentityProxy<unknown>(path, identity);
  if (!result.ok) {
    return failure(result);
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    items: parseAuthorizedPins(result.data, kind),
  };
}

export async function createOpsConfig(
  identity: DevIdentity,
  kind: OpsConfigKind,
  name: string,
  spec: OpsConfigSpec,
): Promise<DraftSuccess | OpsConfigClientFailure> {
  const path = collectionPath(kind);
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "POST",
    body: buildCreateBody(name, spec),
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
  name: string,
  spec: OpsConfigSpec,
): Promise<DraftSuccess | OpsConfigClientFailure> {
  const path = draftPath(kind, resourceId);
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "PATCH",
    body: buildSaveDraftBody(revision, name, spec),
    headers: { [IF_MATCH_HEADER]: String(revision) },
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
  const items = (asItems(result.data))
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

export async function compareOpsConfig(
  identity: DevIdentity,
  kind: OpsConfigKind,
  resourceId: string,
  left: CompareConfigRef,
  right: CompareConfigRef,
): Promise<CompareSuccess | OpsConfigClientFailure> {
  const path = comparePath(kind, resourceId);
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "POST",
    body: buildCompareBody(left, right),
  });
  if (!result.ok) {
    return failure(result);
  }
  const compare = parseCompareResult(result.data);
  if (!compare) {
    return malformed(
      result.requestId,
      result.statusCode,
      path,
      "Compare returned a payload without equal/digestMatch.",
    );
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    compare,
  };
}

export async function restoreOpsConfigVersion(
  identity: DevIdentity,
  kind: OpsConfigKind,
  resourceId: string,
  versionId: string,
  expectedRevision?: number,
): Promise<DraftSuccess | OpsConfigClientFailure> {
  const path = restorePath(kind, resourceId, versionId);
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "POST",
    body: buildRestoreBody(expectedRevision),
  });
  return draftResult(result, path, kind);
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
      "Response was missing a draft with revision and name.",
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
      "Draft payload was missing revision or name.",
    );
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    draft: { ...draft, kind, resourceId: draft.resourceId || resourceId },
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
