/**
 * Thin typed vault client against jonny's #38 routes. Secrets travel
 * only in the create/rotate request body; responses are sanitized
 * before they reach callers.
 *
 * Session: credentials:include + X-CSRF-Token on mutations (via
 * callIdentityProxy). Host-supplied workspace IDs are never sent.
 * CREDENTIAL_KEK is never read or sent.
 */

import { callIdentityProxy, type IdentityClientResult } from "./identity-client.ts";
import type { DevIdentity } from "./identity-headers.ts";
import { type ProblemDetails } from "./problem.ts";
import {
  FALLBACK_CREDENTIAL_CATALOG,
  buildCreateCredentialBody,
  buildDeleteCredentialBody,
  buildRotateCredentialBody,
  buildUpdateCredentialBody,
  credentialDeletionImpactPath,
  credentialDisablePath,
  credentialEnablePath,
  credentialEventsPath,
  credentialListPath,
  credentialPath,
  credentialRotatePath,
  credentialTestPath,
  credentialUsagePath,
  credentialUsePath,
  credentialsCatalogPath,
  credentialsPath,
  forgetSecretDraft,
} from "./credential-contract.ts";
import {
  sanitizeCatalog,
  sanitizeCredentialList,
  sanitizeCredentialRecord,
  sanitizeDeletionImpact,
  sanitizeEvents,
  sanitizeTestResponse,
  sanitizeUsage,
} from "./credential.ts";
import type {
  CreateCredentialBody,
  CredentialCatalog,
  CredentialDeletionImpact,
  CredentialEvent,
  CredentialRecord,
  CredentialSecretDraft,
  CredentialTestResult,
  CredentialType,
  CredentialUsage,
  UpdateCredentialBody,
} from "./credential-types.ts";

export type CredentialClientFailure = {
  ok: false;
  statusCode: number;
  requestId: string;
  problem: ProblemDetails;
  strippedKeys: string[];
};

export type CredentialRecordSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  credential: CredentialRecord;
  strippedKeys: string[];
};

export type CredentialListSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  items: CredentialRecord[];
  strippedKeys: string[];
};

export type CredentialCatalogSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  catalog: CredentialCatalog;
  usedFallback: boolean;
  strippedKeys: string[];
};

export type CredentialUsageSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  usage: CredentialUsage;
  strippedKeys: string[];
};

export type CredentialEventsSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  items: CredentialEvent[];
  strippedKeys: string[];
};

export type CredentialImpactSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  impact: CredentialDeletionImpact;
  strippedKeys: string[];
};

export type CredentialTestSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  test: CredentialTestResult;
  credential?: CredentialRecord;
  strippedKeys: string[];
};

export type CredentialEmptySuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  strippedKeys: string[];
};

export async function getCredentialCatalog(
  identity: DevIdentity,
): Promise<CredentialCatalogSuccess | CredentialClientFailure> {
  const result = await callIdentityProxy<unknown>(
    credentialsCatalogPath(),
    identity,
  );
  if (!result.ok) {
    return failure(result);
  }
  const sanitized = sanitizeCatalog(result.data);
  if (sanitized.value.types.length === 0) {
    return {
      ok: true,
      statusCode: result.statusCode,
      requestId: result.requestId,
      catalog: FALLBACK_CREDENTIAL_CATALOG,
      usedFallback: true,
      strippedKeys: sanitized.strippedKeys,
    };
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    catalog: sanitized.value,
    usedFallback: false,
    strippedKeys: sanitized.strippedKeys,
  };
}

export async function listCredentials(
  identity: DevIdentity,
): Promise<CredentialListSuccess | CredentialClientFailure> {
  const result = await callIdentityProxy<unknown>(credentialListPath(), identity);
  if (!result.ok) {
    return failure(result);
  }
  const sanitized = sanitizeCredentialList(result.data);
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    items: sanitized.value,
    strippedKeys: sanitized.strippedKeys,
  };
}

export async function createCredential(
  identity: DevIdentity,
  body: CreateCredentialBody,
  catalog: CredentialCatalog = FALLBACK_CREDENTIAL_CATALOG,
): Promise<CredentialRecordSuccess | CredentialClientFailure> {
  const payload = buildCreateCredentialBody(body, catalog);
  const result = await callIdentityProxy<unknown>(credentialsPath(), identity, {
    method: "POST",
    body: payload,
  });
  forgetSecretDraft(body.secret);
  forgetSecretDraft(payload.secret);
  return recordResult(result, credentialsPath());
}

export async function getCredential(
  identity: DevIdentity,
  credentialId: string,
): Promise<CredentialRecordSuccess | CredentialClientFailure> {
  const path = credentialPath(credentialId);
  const result = await callIdentityProxy<unknown>(path, identity);
  return recordResult(result, path);
}

export async function updateCredential(
  identity: DevIdentity,
  credentialId: string,
  body: UpdateCredentialBody,
): Promise<CredentialRecordSuccess | CredentialClientFailure> {
  const path = credentialPath(credentialId);
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "PATCH",
    body: buildUpdateCredentialBody(body),
  });
  return recordResult(result, path);
}

export async function rotateCredential(
  identity: DevIdentity,
  credentialId: string,
  type: CredentialType,
  secret: CredentialSecretDraft,
  catalog: CredentialCatalog = FALLBACK_CREDENTIAL_CATALOG,
): Promise<CredentialRecordSuccess | CredentialClientFailure> {
  const path = credentialRotatePath(credentialId);
  const payload = buildRotateCredentialBody(type, secret, catalog);
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "POST",
    body: payload,
  });
  forgetSecretDraft(secret);
  forgetSecretDraft(payload.secret);
  return recordResult(result, path);
}

export async function disableCredential(
  identity: DevIdentity,
  credentialId: string,
): Promise<CredentialRecordSuccess | CredentialClientFailure> {
  const path = credentialDisablePath(credentialId);
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "POST",
    body: {},
  });
  return recordResult(result, path);
}

export async function enableCredential(
  identity: DevIdentity,
  credentialId: string,
): Promise<CredentialRecordSuccess | CredentialClientFailure> {
  const path = credentialEnablePath(credentialId);
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "POST",
    body: {},
  });
  return recordResult(result, path);
}

export async function testCredential(
  identity: DevIdentity,
  credentialId: string,
): Promise<CredentialTestSuccess | CredentialClientFailure> {
  const path = credentialTestPath(credentialId);
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "POST",
    body: {},
  });
  if (!result.ok) {
    return failure(result);
  }
  const sanitized = sanitizeTestResponse(result.data);
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    test: sanitized.value.result,
    credential: sanitized.value.credential ?? undefined,
    strippedKeys: sanitized.strippedKeys,
  };
}

export async function recordCredentialUse(
  identity: DevIdentity,
  credentialId: string,
): Promise<CredentialEmptySuccess | CredentialClientFailure> {
  const path = credentialUsePath(credentialId);
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "POST",
    body: {},
  });
  if (!result.ok) {
    return failure(result);
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    strippedKeys: [],
  };
}

export async function getCredentialUsage(
  identity: DevIdentity,
  credentialId: string,
): Promise<CredentialUsageSuccess | CredentialClientFailure> {
  const path = credentialUsagePath(credentialId);
  const result = await callIdentityProxy<unknown>(path, identity);
  if (!result.ok) {
    return failure(result);
  }
  const sanitized = sanitizeUsage(result.data);
  if (!sanitized.value) {
    return malformed(
      result.requestId,
      result.statusCode,
      path,
      "Usage payload was missing credentialId.",
    );
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    usage: sanitized.value,
    strippedKeys: sanitized.strippedKeys,
  };
}

export async function getCredentialEvents(
  identity: DevIdentity,
  credentialId: string,
): Promise<CredentialEventsSuccess | CredentialClientFailure> {
  const path = credentialEventsPath(credentialId);
  const result = await callIdentityProxy<unknown>(path, identity);
  if (!result.ok) {
    return failure(result);
  }
  const sanitized = sanitizeEvents(result.data);
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    items: sanitized.value,
    strippedKeys: sanitized.strippedKeys,
  };
}

export async function getCredentialDeletionImpact(
  identity: DevIdentity,
  credentialId: string,
): Promise<CredentialImpactSuccess | CredentialClientFailure> {
  const path = credentialDeletionImpactPath(credentialId);
  const result = await callIdentityProxy<unknown>(path, identity);
  if (!result.ok) {
    return failure(result);
  }
  const sanitized = sanitizeDeletionImpact(result.data);
  if (!sanitized.value) {
    return malformed(
      result.requestId,
      result.statusCode,
      path,
      "Deletion impact was missing credentialId or displayName.",
    );
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    impact: sanitized.value,
    strippedKeys: sanitized.strippedKeys,
  };
}

export async function deleteCredential(
  identity: DevIdentity,
  credentialId: string,
): Promise<CredentialEmptySuccess | CredentialClientFailure> {
  const path = credentialPath(credentialId);
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "DELETE",
    body: buildDeleteCredentialBody(),
  });
  if (!result.ok) {
    return failure(result);
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    strippedKeys: [],
  };
}

function recordResult(
  result: IdentityClientResult<unknown>,
  instance: string,
): CredentialRecordSuccess | CredentialClientFailure {
  if (!result.ok) {
    return failure(result);
  }
  const sanitized = sanitizeCredentialRecord(result.data);
  if (!sanitized.value) {
    return malformed(
      result.requestId,
      result.statusCode,
      instance,
      "Credential payload was missing id, displayName, or type.",
    );
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    credential: sanitized.value,
    strippedKeys: sanitized.strippedKeys,
  };
}

function failure(
  result: Extract<IdentityClientResult<unknown>, { ok: false }>,
): CredentialClientFailure {
  return {
    ok: false,
    statusCode: result.statusCode,
    requestId: result.requestId,
    problem: result.problem,
    strippedKeys: [],
  };
}

function malformed(
  requestId: string,
  statusCode: number,
  instance: string,
  detail: string,
): CredentialClientFailure {
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
    strippedKeys: [],
  };
}
