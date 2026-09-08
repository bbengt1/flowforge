/**
 * Thin typed vault client. Secrets travel only in the create/rotate
 * request body; responses are sanitized before they reach callers.
 *
 * Session: credentials:include + X-CSRF-Token on mutations (via
 * callIdentityProxy). Host-supplied workspace IDs are never sent.
 */

import { callIdentityProxy, type IdentityClientResult } from "./identity-client.ts";
import type { DevIdentity } from "./identity-headers.ts";
import { type ProblemDetails } from "./problem.ts";
import {
  buildCreateCredentialBody,
  buildRotateCredentialBody,
  buildUpdateCredentialBody,
  credentialAuditPath,
  credentialDeletionImpactPath,
  credentialDisablePath,
  credentialEnablePath,
  credentialListSearch,
  credentialPath,
  credentialRotatePath,
  credentialTestPath,
  credentialUsagePath,
  credentialsPath,
  forgetSecretDraft,
} from "./credential-contract.ts";
import {
  sanitizeAuditEvents,
  sanitizeCredentialList,
  sanitizeCredentialRecord,
  sanitizeDeletionImpact,
  sanitizeUsage,
  stripSecretFields,
} from "./credential.ts";
import type {
  CreateCredentialBody,
  CredentialAuditEvent,
  CredentialDeletionImpact,
  CredentialListQuery,
  CredentialRecord,
  CredentialSecretDraft,
  CredentialTestResult,
  CredentialType,
  CredentialUsage,
  RotateCredentialBody,
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

export type CredentialUsageSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  usage: CredentialUsage;
  strippedKeys: string[];
};

export type CredentialAuditSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  items: CredentialAuditEvent[];
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
  strippedKeys: string[];
};

export type CredentialEmptySuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  strippedKeys: string[];
};

export async function listCredentials(
  identity: DevIdentity,
  query: CredentialListQuery = {},
): Promise<CredentialListSuccess | CredentialClientFailure> {
  const path = credentialListSearch(query);
  const result = await callIdentityProxy<unknown>(path, identity);
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
): Promise<CredentialRecordSuccess | CredentialClientFailure> {
  const payload = buildCreateCredentialBody(body);
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
  testOnRotate = false,
): Promise<CredentialRecordSuccess | CredentialClientFailure> {
  const path = credentialRotatePath(credentialId);
  const payload: RotateCredentialBody = buildRotateCredentialBody(
    type,
    secret,
    testOnRotate,
  );
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
  const sanitized = stripSecretFields(result.data);
  const raw = isObject(sanitized.value) ? sanitized.value : {};
  const status =
    raw.status === "passed" || raw.status === "failed" || raw.status === "untested"
      ? raw.status
      : "untested";
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    test: {
      status,
      testedAt:
        typeof raw.testedAt === "string"
          ? raw.testedAt
          : typeof raw.tested_at === "string"
            ? raw.tested_at
            : undefined,
      message: typeof raw.message === "string" ? raw.message : undefined,
    },
    strippedKeys: sanitized.strippedKeys,
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
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    usage: sanitized.value,
    strippedKeys: sanitized.strippedKeys,
  };
}

export async function getCredentialAudit(
  identity: DevIdentity,
  credentialId: string,
): Promise<CredentialAuditSuccess | CredentialClientFailure> {
  const path = credentialAuditPath(credentialId);
  const result = await callIdentityProxy<unknown>(path, identity);
  if (!result.ok) {
    return failure(result);
  }
  const sanitized = sanitizeAuditEvents(result.data);
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

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
