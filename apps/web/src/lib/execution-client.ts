/**
 * Thin typed execution client (E5.1 list/detail + E5.2 cancel/retry
 * + E5.3 artifacts/download).
 *
 * Paths come only from execution-contract.ts. Session:
 * credentials:include. CSRF on POST cancel/retry/downloads. Host-supplied
 * workspace IDs are never sent. Unexpected secrets are stripped.
 * Never log request bodies, download tokens, or grant URLs. Status is
 * GET /executions/{id} only — never /jobs/*. Downloads mint
 * POST /artifacts/{id}/downloads then stream GET /artifact-downloads/{id}.
 */

import {
  callIdentityProxy,
  streamIdentityProxy,
  type IdentityClientResult,
} from "./identity-client.ts";
import type { DevIdentity } from "./identity-headers.ts";
import { type ProblemDetails } from "./problem.ts";
import {
  DOWNLOAD_APPLIED_MESSAGE,
  EXECUTION_LOG_LIMIT_DEFAULT,
  EXECUTION_LOG_MAX_BYTES_DEFAULT,
  RETRY_APPLIED_MESSAGE,
  buildCancelBody,
  buildDownloadGrantBody,
  buildRetryBody,
  artifactDownloadPath,
  artifactDownloadStreamPath,
  artifactPath,
  executionArtifactsPath,
  isSameOriginGrantHref,
  executionAuditEventsPath,
  executionCancelPath,
  executionJobsPath,
  executionPath,
  executionRetryPath,
  executionStepLogsPath,
  executionStepRetryPath,
  executionStepsPath,
  listExecutionsPath,
  listWorkflowExecutionsPath,
  listWorkspaceAuditEventsPath,
  workflowExecutionCancelPath,
  workflowExecutionPath,
  workflowExecutionRetryPath,
} from "./execution-contract.ts";
import {
  cancelOutcomeMessage,
  canDownloadArtifact,
  downloadGrantFailureMessage,
  downloadGrantView,
  forgetDownloadGrant,
  isDownloadGrantExpired,
  type EphemeralDownloadGrant,
  isExecutionForbidden,
  isIdempotentCancel,
  parseDownloadGrant,
  parseExecutionArtifact,
  parseExecutionDetail,
  parseExecutionEvent,
  parseExecutionJob,
  parseExecutionList,
  parseExecutionLogs,
  parseExecutionStep,
  parseItemList,
  stripSecretFields,
  wipeDownloadGrant,
} from "./execution.ts";
import type {
  AuditEventQuery,
  DownloadGrantView,
  ExecutionArtifact,
  ExecutionAuditEvent,
  ExecutionDetail,
  ExecutionJob,
  ExecutionListQuery,
  ExecutionLogSlice,
  ExecutionRecord,
  ExecutionStep,
} from "./execution-types.ts";

export type ExecutionClientFailure = {
  ok: false;
  statusCode: number;
  requestId: string;
  problem: ProblemDetails;
  forbidden: boolean;
  strippedKeys: string[];
};

export type ExecutionListSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  items: ExecutionRecord[];
  strippedKeys: string[];
};

export type ExecutionDetailSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  execution: ExecutionDetail;
  strippedKeys: string[];
};

export type ExecutionStepsSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  items: ExecutionStep[];
  strippedKeys: string[];
};

export type ExecutionJobsSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  items: ExecutionJob[];
  strippedKeys: string[];
};

export type ExecutionEventsSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  items: ExecutionAuditEvent[];
  strippedKeys: string[];
};

export type ExecutionCancelSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  execution: ExecutionDetail | null;
  idempotent: boolean;
  message: string;
  strippedKeys: string[];
};

export type ExecutionRetrySuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  execution: ExecutionDetail | null;
  message: string;
  strippedKeys: string[];
};

export type ExecutionArtifactsSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  items: ExecutionArtifact[];
  strippedKeys: string[];
};

export type ExecutionLogsSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  logs: ExecutionLogSlice;
  strippedKeys: string[];
};

export type ArtifactDownloadSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  grant: DownloadGrantView;
  message: string;
  strippedKeys: string[];
};

export async function listExecutions(
  identity: DevIdentity,
  filter: ExecutionListQuery = {},
): Promise<ExecutionListSuccess | ExecutionClientFailure> {
  return listFromPath(identity, listExecutionsPath(filter));
}

export async function listWorkflowExecutions(
  identity: DevIdentity,
  workflowId: string,
  filter: Pick<ExecutionListQuery, "status" | "limit"> = {},
): Promise<ExecutionListSuccess | ExecutionClientFailure> {
  return listFromPath(
    identity,
    listWorkflowExecutionsPath(workflowId, filter),
  );
}

async function listFromPath(
  identity: DevIdentity,
  path: string,
): Promise<ExecutionListSuccess | ExecutionClientFailure> {
  const result = await callIdentityProxy<unknown>(path, identity);
  if (!result.ok) {
    return failure(result);
  }
  const strippedKeys: string[] = [];
  stripSecretFields(result.data, strippedKeys);
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    items: parseExecutionList(result.data),
    strippedKeys,
  };
}

export async function getExecution(
  identity: DevIdentity,
  executionId: string,
  workflowId?: string,
): Promise<ExecutionDetailSuccess | ExecutionClientFailure> {
  const path = executionPath(executionId);
  const result = await callIdentityProxy<unknown>(path, identity);
  if (result.ok) {
    return detailResult(result, path, executionId);
  }
  if (result.statusCode === 404 && workflowId?.trim()) {
    return getWorkflowExecutionDetail(
      identity,
      workflowId.trim(),
      executionId,
    );
  }
  return failure(result);
}

export async function getWorkflowExecutionDetail(
  identity: DevIdentity,
  workflowId: string,
  executionId: string,
): Promise<ExecutionDetailSuccess | ExecutionClientFailure> {
  const path = workflowExecutionPath(workflowId, executionId);
  const result = await callIdentityProxy<unknown>(path, identity);
  return detailResult(result, path, executionId);
}

export async function getExecutionSteps(
  identity: DevIdentity,
  executionId: string,
): Promise<ExecutionStepsSuccess | ExecutionClientFailure> {
  return itemsResult(
    await callIdentityProxy<unknown>(executionStepsPath(executionId), identity),
    (item) => parseExecutionStep(item, executionId),
  );
}

export async function getExecutionJobs(
  identity: DevIdentity,
  executionId: string,
): Promise<ExecutionJobsSuccess | ExecutionClientFailure> {
  return itemsResult(
    await callIdentityProxy<unknown>(executionJobsPath(executionId), identity),
    (item) => parseExecutionJob(item, executionId),
  );
}

export async function getExecutionEvents(
  identity: DevIdentity,
  executionId: string,
): Promise<ExecutionEventsSuccess | ExecutionClientFailure> {
  return getExecutionAuditEvents(identity, executionId);
}

export async function getExecutionAuditEvents(
  identity: DevIdentity,
  executionId: string,
): Promise<ExecutionEventsSuccess | ExecutionClientFailure> {
  return itemsResult(
    await callIdentityProxy<unknown>(
      executionAuditEventsPath(executionId),
      identity,
    ),
    parseExecutionEvent,
  );
}

/**
 * POST /executions/{id}/cancel with CSRF. Empty body — never send
 * host-supplied id / workspaceId. A second cancel is success
 * (idempotent). 403 is fail-closed. Falls back to the workflow-scoped
 * twin on 404 when workflowId is known.
 */
export async function cancelExecution(
  identity: DevIdentity,
  executionId: string,
  options: { workflowId?: string; previousStatus?: string } = {},
): Promise<ExecutionCancelSuccess | ExecutionClientFailure> {
  const path = executionCancelPath(executionId);
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "POST",
    body: buildCancelBody(),
  });
  if (
    !result.ok &&
    result.statusCode === 404 &&
    options.workflowId?.trim()
  ) {
    return cancelWorkflowExecution(
      identity,
      options.workflowId.trim(),
      executionId,
      options.previousStatus,
    );
  }
  return cancelResult(result, path, executionId, options.previousStatus);
}

export async function cancelWorkflowExecution(
  identity: DevIdentity,
  workflowId: string,
  executionId: string,
  previousStatus?: string,
): Promise<ExecutionCancelSuccess | ExecutionClientFailure> {
  const path = workflowExecutionCancelPath(workflowId, executionId);
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "POST",
    body: buildCancelBody(),
  });
  return cancelResult(result, path, executionId, previousStatus);
}

/**
 * POST /executions/{id}/retry with CSRF. Body is `{stepId?}` —
 * never host-supplied id / workspaceId. Prefer retryExecutionStep
 * when the clicked step is known. 403 is fail-closed. 409 for
 * indeterminate / provider nodes.
 */
export async function retryExecution(
  identity: DevIdentity,
  executionId: string,
  options: { workflowId?: string; stepId?: string } = {},
): Promise<ExecutionRetrySuccess | ExecutionClientFailure> {
  const path = executionRetryPath(executionId);
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "POST",
    body: buildRetryBody({ stepId: options.stepId }),
  });
  if (
    !result.ok &&
    result.statusCode === 404 &&
    options.workflowId?.trim()
  ) {
    return retryWorkflowExecution(
      identity,
      options.workflowId.trim(),
      executionId,
      options.stepId,
    );
  }
  return retryResult(result, path, executionId);
}

export async function retryExecutionStep(
  identity: DevIdentity,
  executionId: string,
  stepId: string,
): Promise<ExecutionRetrySuccess | ExecutionClientFailure> {
  const path = executionStepRetryPath(executionId, stepId);
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "POST",
    body: buildRetryBody({ stepId }),
  });
  if (!result.ok && result.statusCode === 404) {
    return retryExecution(identity, executionId, { stepId });
  }
  return retryResult(result, path, executionId);
}

export async function retryWorkflowExecution(
  identity: DevIdentity,
  workflowId: string,
  executionId: string,
  stepId?: string,
): Promise<ExecutionRetrySuccess | ExecutionClientFailure> {
  const path = workflowExecutionRetryPath(workflowId, executionId);
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "POST",
    body: buildRetryBody({ stepId }),
  });
  return retryResult(result, path, executionId);
}

function retryResult(
  result: IdentityClientResult<unknown>,
  instance: string,
  executionId: string,
): ExecutionRetrySuccess | ExecutionClientFailure {
  if (!result.ok) {
    return failure(result);
  }
  const strippedKeys: string[] = [];
  stripSecretFields(result.data, strippedKeys);
  const raw =
    result.data && typeof result.data === "object"
      ? (result.data as Record<string, unknown>)
      : {};
  const parsed = parseExecutionDetail(raw.execution ?? result.data);
  if (parsed && executionId && parsed.id !== executionId) {
    return malformed(
      result.requestId,
      result.statusCode,
      instance,
      "Retry payload id did not match the requested execution.",
    );
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    execution: parsed,
    message: RETRY_APPLIED_MESSAGE,
    strippedKeys,
  };
}

/** Poll GET /executions/{id} for steps/jobs. Never hits /jobs/*. */
export async function pollExecutionStatus(
  identity: DevIdentity,
  executionId: string,
  workflowId?: string,
): Promise<ExecutionDetailSuccess | ExecutionClientFailure> {
  return getExecution(identity, executionId, workflowId);
}

export async function listExecutionArtifacts(
  identity: DevIdentity,
  executionId: string,
): Promise<ExecutionArtifactsSuccess | ExecutionClientFailure> {
  return itemsResult(
    await callIdentityProxy<unknown>(
      executionArtifactsPath(executionId),
      identity,
    ),
    (item) => parseExecutionArtifact(item, executionId),
  );
}

export async function getExecutionArtifact(
  identity: DevIdentity,
  executionId: string,
  artifactId: string,
): Promise<
  | {
      ok: true;
      statusCode: number;
      requestId: string;
      artifact: ExecutionArtifact;
      strippedKeys: string[];
    }
  | ExecutionClientFailure
> {
  const path = artifactPath(artifactId);
  const result = await callIdentityProxy<unknown>(path, identity);
  if (!result.ok) {
    return failure(result);
  }
  const strippedKeys: string[] = [];
  stripSecretFields(result.data, strippedKeys);
  const artifact = parseExecutionArtifact(result.data, executionId);
  if (!artifact || artifact.id !== artifactId) {
    return malformed(
      result.requestId,
      result.statusCode,
      path,
      "Artifact payload was missing a matching id.",
    );
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    artifact,
    strippedKeys,
  };
}

export async function getExecutionStepLogs(
  identity: DevIdentity,
  executionId: string,
  stepId: string,
): Promise<ExecutionLogsSuccess | ExecutionClientFailure> {
  const path = executionStepLogsPath(executionId, stepId, {
    limit: EXECUTION_LOG_LIMIT_DEFAULT,
    maxBytes: EXECUTION_LOG_MAX_BYTES_DEFAULT,
  });
  const result = await callIdentityProxy<unknown>(path, identity);
  if (!result.ok) {
    return failure(result);
  }
  const strippedKeys: string[] = [];
  stripSecretFields(result.data, strippedKeys);
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    logs: parseExecutionLogs(result.data, stepId),
    strippedKeys,
  };
}

/**
 * POST /artifacts/{id}/downloads (CSRF, 60s TTL), then stream
 * GET /artifact-downloads/{grantId} with cookies. Re-mint once on
 * stream 404. Never persist href / storageRef. 403 fails closed.
 * Download tokens are never logged.
 */
export async function downloadExecutionArtifact(
  identity: DevIdentity,
  executionId: string,
  artifactId: string,
  options: {
    artifact?: ExecutionArtifact;
    save?: (blob: Blob, filename: string) => void;
    now?: number;
  } = {},
): Promise<ArtifactDownloadSuccess | ExecutionClientFailure> {
  const mintPath = artifactDownloadPath(artifactId);
  if (options.artifact && !canDownloadArtifact(options.artifact)) {
    return {
      ok: false,
      statusCode: 410,
      requestId: "",
      forbidden: false,
      strippedKeys: [],
      problem: {
        type: "urn:flowforge:problem:not-found",
        title: "Gone",
        status: 410,
        detail: downloadGrantFailureMessage({ expired: true, statusCode: 410 }),
        instance: mintPath,
        code: "not-found",
        request_id: "",
      },
    };
  }

  const minted = await mintArtifactDownloadGrant(identity, artifactId);
  if (!minted.ok) {
    return minted;
  }
  const now = options.now ?? Date.now();
  let grant = minted.grant;
  const strippedKeys = [...minted.strippedKeys];

  if (isDownloadGrantExpired(grant, now)) {
    forgetDownloadGrant(grant);
    return grantExpired(minted.requestId, mintPath, strippedKeys);
  }
  if (!isSameOriginGrantHref(grant.href, grant.id)) {
    forgetDownloadGrant(grant);
    return malformed(
      minted.requestId,
      minted.statusCode,
      mintPath,
      "Download grant href was not a same-origin /artifact-downloads/{grantId} path.",
    );
  }

  wipeDownloadGrant(grant);
  let stream = await streamIdentityProxy(
    artifactDownloadStreamPath(grant.id),
    identity,
  );
  if (!stream.ok && stream.statusCode === 404) {
    forgetDownloadGrant(grant);
    const reminted = await mintArtifactDownloadGrant(identity, artifactId);
    if (!reminted.ok) {
      return reminted;
    }
    strippedKeys.push(...reminted.strippedKeys);
    grant = reminted.grant;
    if (
      isDownloadGrantExpired(grant, options.now ?? Date.now()) ||
      !isSameOriginGrantHref(grant.href, grant.id)
    ) {
      forgetDownloadGrant(grant);
      return grantExpired(reminted.requestId, mintPath, strippedKeys);
    }
    wipeDownloadGrant(grant);
    stream = await streamIdentityProxy(
      artifactDownloadStreamPath(grant.id),
      identity,
    );
  }

  const view = downloadGrantView(grant, now);
  forgetDownloadGrant(grant);

  if (!stream.ok) {
    if (stream.statusCode === 403) {
      return failure(stream);
    }
    if (stream.statusCode === 404) {
      return grantExpired(stream.requestId, mintPath, strippedKeys);
    }
    return failure(stream);
  }

  const filename =
    filenameFromDisposition(stream.contentDisposition) ||
    options.artifact?.name ||
    "artifact";
  options.save?.(stream.blob, filename);

  return {
    ok: true,
    statusCode: stream.statusCode,
    requestId: stream.requestId,
    grant: view,
    message: DOWNLOAD_APPLIED_MESSAGE,
    strippedKeys,
  };
}

async function mintArtifactDownloadGrant(
  identity: DevIdentity,
  artifactId: string,
): Promise<
  | {
      ok: true;
      statusCode: number;
      requestId: string;
      grant: EphemeralDownloadGrant;
      strippedKeys: string[];
    }
  | ExecutionClientFailure
> {
  const path = artifactDownloadPath(artifactId);
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "POST",
    body: buildDownloadGrantBody(),
  });
  if (!result.ok) {
    return failure(result);
  }
  const strippedKeys: string[] = [];
  stripSecretFields(result.data, strippedKeys);
  const grant = parseDownloadGrant(result.data, artifactId);
  if (!grant) {
    return malformed(
      result.requestId,
      result.statusCode,
      path,
      "Download grant was missing id or artifactId.",
    );
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    grant,
    strippedKeys,
  };
}

function grantExpired(
  requestId: string,
  instance: string,
  strippedKeys: string[],
): ExecutionClientFailure {
  return {
    ok: false,
    statusCode: 410,
    requestId,
    forbidden: false,
    strippedKeys,
    problem: {
      type: "urn:flowforge:problem:not-found",
      title: "Gone",
      status: 410,
      detail: downloadGrantFailureMessage({ expired: true, statusCode: 410 }),
      instance,
      code: "not-found",
      request_id: requestId,
    },
  };
}

function filenameFromDisposition(value: string | null): string {
  if (!value) {
    return "";
  }
  const match = /filename\*?=(?:UTF-8''|"?)([^";]+)"?/i.exec(value);
  const raw = match?.[1]?.trim() ?? "";
  if (!raw || /[\\/]/.test(raw) || /https?:|s3:|gs:/i.test(raw)) {
    return "";
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function cancelResult(
  result: IdentityClientResult<unknown>,
  instance: string,
  executionId: string,
  previousStatus?: string,
): ExecutionCancelSuccess | ExecutionClientFailure {
  if (!result.ok) {
    return failure(result);
  }
  const strippedKeys: string[] = [];
  stripSecretFields(result.data, strippedKeys);
  if (result.statusCode === 204 || result.data == null) {
    const idempotent = isIdempotentCancel({
      previousStatus,
      status: "canceled",
    });
    return {
      ok: true,
      statusCode: result.statusCode,
      requestId: result.requestId,
      execution: null,
      idempotent,
      message: cancelOutcomeMessage({
        previousStatus,
        status: "canceled",
      }),
      strippedKeys,
    };
  }
  const parsed = parseExecutionDetail(result.data);
  if (parsed && executionId && parsed.id !== executionId) {
    return malformed(
      result.requestId,
      result.statusCode,
      instance,
      "Cancel payload id did not match the requested execution.",
    );
  }
  const raw =
    result.data && typeof result.data === "object"
      ? (result.data as Record<string, unknown>)
      : {};
  const idempotent = isIdempotentCancel({
    previousStatus,
    status: parsed?.status,
    canceled: raw.canceled === true,
    replayed: raw.replayed === true || parsed?.replayed === true,
  });
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    execution: parsed,
    idempotent,
    message: cancelOutcomeMessage({
      previousStatus,
      status: parsed?.status ?? "canceled",
      canceled: raw.canceled === true,
      replayed: raw.replayed === true || parsed?.replayed === true,
    }),
    strippedKeys,
  };
}

export async function listWorkspaceAuditEvents(
  identity: DevIdentity,
  filter: AuditEventQuery = {},
): Promise<ExecutionEventsSuccess | ExecutionClientFailure> {
  return itemsResult(
    await callIdentityProxy<unknown>(
      listWorkspaceAuditEventsPath(filter),
      identity,
    ),
    parseExecutionEvent,
  );
}

/**
 * Load detail from GET /executions/{id} (steps/jobs/pins come from that
 * payload — #53). Audit may be filled from nested GET …/audit-events
 * or workspace GET /audit-events. Never fetches /jobs/* or nested
 * GET …/jobs for status.
 */
export async function loadExecutionHistory(
  identity: DevIdentity,
  executionId: string,
  workflowId?: string,
): Promise<ExecutionDetailSuccess | ExecutionClientFailure> {
  const header = await getExecution(identity, executionId, workflowId);
  if (!header.ok) {
    return header;
  }
  const strippedKeys = [...header.strippedKeys];
  let execution = header.execution;

  if (execution.auditEvents.length === 0) {
    const events = await getExecutionAuditEvents(identity, executionId);
    if (!events.ok && events.forbidden) {
      return events;
    }
    if (events.ok) {
      execution = { ...execution, auditEvents: events.items };
      strippedKeys.push(...events.strippedKeys);
    } else {
      const workspace = await listWorkspaceAuditEvents(identity, {
        resourceType: "execution",
        resourceId: executionId,
      });
      if (workspace.ok) {
        execution = { ...execution, auditEvents: workspace.items };
        strippedKeys.push(...workspace.strippedKeys);
      } else if (workspace.forbidden) {
        return workspace;
      }
    }
  }

  if (execution.artifacts.length === 0) {
    const artifacts = await listExecutionArtifacts(identity, executionId);
    if (!artifacts.ok && artifacts.forbidden) {
      return artifacts;
    }
    if (artifacts.ok) {
      execution = { ...execution, artifacts: artifacts.items };
      strippedKeys.push(...artifacts.strippedKeys);
    }
  }

  return {
    ok: true,
    statusCode: header.statusCode,
    requestId: header.requestId,
    execution,
    strippedKeys,
  };
}

function itemsResult<T>(
  result: IdentityClientResult<unknown>,
  parse: (item: unknown) => T | null,
):
  | {
      ok: true;
      statusCode: number;
      requestId: string;
      items: T[];
      strippedKeys: string[];
    }
  | ExecutionClientFailure {
  if (!result.ok) {
    return failure(result);
  }
  const strippedKeys: string[] = [];
  stripSecretFields(result.data, strippedKeys);
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    items: parseItemList(result.data, parse),
    strippedKeys,
  };
}

function detailResult(
  result: IdentityClientResult<unknown>,
  instance: string,
  executionId: string,
): ExecutionDetailSuccess | ExecutionClientFailure {
  if (!result.ok) {
    return failure(result);
  }
  const strippedKeys: string[] = [];
  stripSecretFields(result.data, strippedKeys);
  const execution = parseExecutionDetail(result.data);
  if (!execution) {
    return malformed(
      result.requestId,
      result.statusCode,
      instance,
      "Execution payload was missing id, workflowId, or workflowVersionId.",
    );
  }
  if (execution.id !== executionId && executionId) {
    return malformed(
      result.requestId,
      result.statusCode,
      instance,
      "Execution payload id did not match the requested execution.",
    );
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    execution,
    strippedKeys,
  };
}

function failure(
  result: Extract<IdentityClientResult<unknown>, { ok: false }>,
): ExecutionClientFailure {
  return {
    ok: false,
    statusCode: result.statusCode,
    requestId: result.requestId,
    problem: result.problem,
    forbidden: isExecutionForbidden(result.problem),
    strippedKeys: [],
  };
}

function malformed(
  requestId: string,
  statusCode: number,
  instance: string,
  detail: string,
): ExecutionClientFailure {
  return {
    ok: false,
    statusCode,
    requestId,
    forbidden: false,
    strippedKeys: [],
    problem: {
      type: "urn:flowforge:problem:upstream-error",
      title: "Upstream Error",
      status: statusCode,
      detail,
      instance,
      code: "upstream-error",
      request_id: requestId,
    },
  };
}
