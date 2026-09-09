/**
 * Typed webhook trigger client. Paths and write bodies come from
 * webhook-trigger-contract.ts so a retarget only edits that adapter.
 * Cookie session + CSRF on mutations. One-time secrets are extracted
 * then stripped — never persisted.
 */

import { callIdentityProxy } from "./identity-client.ts";
import type { DevIdentity } from "./identity-headers.ts";
import { isResourceId } from "./identity-proxy-ids.ts";
import type { ProblemDetails } from "./problem.ts";
import type { WorkflowCatalog } from "./workflow-types.ts";
import {
  WEBHOOK_FORBIDDEN_MESSAGE,
  WEBHOOK_HOST_SUPPLIED_MESSAGE,
  WEBHOOK_MAP_PENDING_MESSAGE,
  WEBHOOK_TRIGGER_PROBLEM_CODES,
  WEBHOOK_VIEW_FORBIDDEN_MESSAGE,
  hostSuppliedWebhookIdentityKeys,
  isWebhookMapPending,
  parseWebhookTriggerList,
  parseWebhookTriggerRecord,
  rejectHostSuppliedWebhookBody,
  takeOneTimeSecret,
  webhookMutationOutcomeMessage,
  webhookTriggerCreatePath,
  webhookTriggerDisablePath,
  webhookTriggerEnablePath,
  webhookTriggerListPath,
  webhookTriggerPath,
  webhookTriggerRotatePath,
  webhookTriggerUpdatePath,
  type WebhookOneTimeReveal,
  type WebhookTriggerDraft,
  type WebhookTriggerRecord,
  type WebhookTriggerWriteBody,
  validateWebhookTriggerDraft,
} from "./webhook-trigger-contract.ts";

export type WebhookTriggerClientFailure = {
  ok: false;
  statusCode: number;
  requestId: string;
  problem: ProblemDetails;
  forbidden: boolean;
  mapPending: boolean;
};

export type WebhookTriggerListSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  items: WebhookTriggerRecord[];
  strippedKeys: string[];
  usedFallback: boolean;
};

export type WebhookTriggerMutationSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  trigger: WebhookTriggerRecord | null;
  reveal: WebhookOneTimeReveal;
  strippedKeys: string[];
  message: string;
};

function failure(result: {
  statusCode: number;
  requestId: string;
  problem: ProblemDetails;
}): WebhookTriggerClientFailure {
  const code = String(result.problem.code ?? "").trim();
  const forbidden =
    result.statusCode === 403 ||
    code === WEBHOOK_TRIGGER_PROBLEM_CODES.forbidden ||
    code === "permission-denied";
  return {
    ok: false,
    statusCode: result.statusCode,
    requestId: result.requestId,
    problem: result.problem,
    forbidden,
    mapPending: isWebhookMapPending(result.statusCode, result.problem),
  };
}

function localProblem(
  path: string,
  requestId: string,
  status: number,
  code: string,
  title: string,
  detail: string,
): ProblemDetails {
  return {
    type: `urn:flowforge:problem:${code}`,
    title,
    status,
    detail,
    instance: path,
    code,
    request_id: requestId,
  };
}

function invalidWorkflowProblem(path: string): WebhookTriggerClientFailure {
  return {
    ok: false,
    statusCode: 400,
    requestId: "",
    forbidden: false,
    mapPending: false,
    problem: localProblem(
      path,
      "",
      400,
      WEBHOOK_TRIGGER_PROBLEM_CODES.invalidRequest,
      "Invalid request",
      "workflowId must be a workspace resource UUID.",
    ),
  };
}

export async function listWebhookTriggers(
  identity: DevIdentity,
  workflowId: string,
  catalog?: WorkflowCatalog | null,
): Promise<WebhookTriggerListSuccess | WebhookTriggerClientFailure> {
  if (!isResourceId(workflowId)) {
    return invalidWorkflowProblem("/workflows/{workflowId}/triggers");
  }
  const path = webhookTriggerListPath(workflowId, catalog);
  const result = await callIdentityProxy<unknown>(path, identity);
  if (!result.ok) {
    const failed = failure(result);
    if (failed.mapPending) {
      return {
        ok: true,
        statusCode: result.statusCode,
        requestId: result.requestId,
        items: [],
        strippedKeys: [],
        usedFallback: true,
      };
    }
    if (failed.forbidden) {
      failed.problem = {
        ...failed.problem,
        detail: failed.problem.detail || WEBHOOK_VIEW_FORBIDDEN_MESSAGE,
      };
    }
    return failed;
  }
  const strippedKeys: string[] = [];
  takeOneTimeSecret(result.data);
  const items = parseWebhookTriggerList(result.data, workflowId);
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    items,
    strippedKeys,
    usedFallback: false,
  };
}

async function mutateWebhookTrigger(
  identity: DevIdentity,
  path: string,
  method: "POST" | "PATCH",
  action: "create" | "rotate" | "disable" | "enable" | "update",
  body?: WebhookTriggerWriteBody | Record<string, never>,
  workflowId = "",
): Promise<WebhookTriggerMutationSuccess | WebhookTriggerClientFailure> {
  if (body && hostSuppliedWebhookIdentityKeys(body as Record<string, unknown>).length > 0) {
    return {
      ok: false,
      statusCode: 400,
      requestId: "",
      forbidden: false,
      mapPending: false,
      problem: localProblem(
        path,
        "",
        400,
        WEBHOOK_TRIGGER_PROBLEM_CODES.invalidRequest,
        "Invalid request",
        WEBHOOK_HOST_SUPPLIED_MESSAGE,
      ),
    };
  }
  const result = await callIdentityProxy<unknown>(path, identity, {
    method,
    body: body ?? {},
  });
  if (!result.ok) {
    const failed = failure(result);
    if (failed.mapPending) {
      failed.problem = {
        ...failed.problem,
        detail: failed.problem.detail || WEBHOOK_MAP_PENDING_MESSAGE,
      };
    }
    if (failed.forbidden) {
      failed.problem = {
        ...failed.problem,
        detail: failed.problem.detail || WEBHOOK_FORBIDDEN_MESSAGE,
      };
    }
    return failed;
  }
  const extracted = takeOneTimeSecret(result.data);
  const trigger = parseWebhookTriggerRecord(result.data, workflowId);
  const reveal: WebhookOneTimeReveal = {
    secret: extracted.secret,
    revealed: Boolean(extracted.secret),
  };
  const outcomeAction =
    action === "update" ? "create" : action === "create" || action === "rotate" || action === "disable" || action === "enable"
      ? action
      : "create";
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    trigger,
    reveal,
    strippedKeys: extracted.strippedKeys,
    message: webhookMutationOutcomeMessage(
      outcomeAction,
      reveal,
    ),
  };
}

export async function createWebhookTrigger(
  identity: DevIdentity,
  workflowId: string,
  draft: WebhookTriggerDraft,
  catalog?: WorkflowCatalog | null,
): Promise<WebhookTriggerMutationSuccess | WebhookTriggerClientFailure> {
  if (!isResourceId(workflowId)) {
    return invalidWorkflowProblem("/workflows/{workflowId}/triggers");
  }
  const validated = validateWebhookTriggerDraft(draft, catalog);
  if (!validated.ok) {
    return {
      ok: false,
      statusCode: 400,
      requestId: "",
      forbidden: false,
      mapPending: false,
      problem: localProblem(
        webhookTriggerCreatePath(workflowId, catalog),
        "",
        400,
        WEBHOOK_TRIGGER_PROBLEM_CODES.invalidRequest,
        "Invalid request",
        validated.errors[0] ?? "Webhook trigger settings are invalid.",
      ),
    };
  }
  return mutateWebhookTrigger(
    identity,
    webhookTriggerCreatePath(workflowId, catalog),
    "POST",
    "create",
    rejectHostSuppliedWebhookBody(validated.body),
    workflowId,
  );
}

export async function updateWebhookTrigger(
  identity: DevIdentity,
  workflowId: string,
  triggerId: string,
  draft: WebhookTriggerDraft,
  catalog?: WorkflowCatalog | null,
): Promise<WebhookTriggerMutationSuccess | WebhookTriggerClientFailure> {
  if (!isResourceId(workflowId) || !isResourceId(triggerId)) {
    return invalidWorkflowProblem("/workflows/{workflowId}/triggers/{triggerId}");
  }
  const validated = validateWebhookTriggerDraft(draft, catalog);
  if (!validated.ok) {
    return {
      ok: false,
      statusCode: 400,
      requestId: "",
      forbidden: false,
      mapPending: false,
      problem: localProblem(
        webhookTriggerUpdatePath(workflowId, triggerId, catalog),
        "",
        400,
        WEBHOOK_TRIGGER_PROBLEM_CODES.invalidRequest,
        "Invalid request",
        validated.errors[0] ?? "Webhook trigger settings are invalid.",
      ),
    };
  }
  return mutateWebhookTrigger(
    identity,
    webhookTriggerUpdatePath(workflowId, triggerId, catalog),
    "PATCH",
    "update",
    rejectHostSuppliedWebhookBody(validated.body),
    workflowId,
  );
}

export async function rotateWebhookTrigger(
  identity: DevIdentity,
  workflowId: string,
  triggerId: string,
  catalog?: WorkflowCatalog | null,
): Promise<WebhookTriggerMutationSuccess | WebhookTriggerClientFailure> {
  if (!isResourceId(workflowId) || !isResourceId(triggerId)) {
    return invalidWorkflowProblem("/workflows/{workflowId}/triggers/{triggerId}/rotate");
  }
  return mutateWebhookTrigger(
    identity,
    webhookTriggerRotatePath(workflowId, triggerId, catalog),
    "POST",
    "rotate",
    {},
    workflowId,
  );
}

export async function disableWebhookTrigger(
  identity: DevIdentity,
  workflowId: string,
  triggerId: string,
  catalog?: WorkflowCatalog | null,
): Promise<WebhookTriggerMutationSuccess | WebhookTriggerClientFailure> {
  if (!isResourceId(workflowId) || !isResourceId(triggerId)) {
    return invalidWorkflowProblem("/workflows/{workflowId}/triggers/{triggerId}/disable");
  }
  return mutateWebhookTrigger(
    identity,
    webhookTriggerDisablePath(workflowId, triggerId, catalog),
    "POST",
    "disable",
    {},
    workflowId,
  );
}

export async function enableWebhookTrigger(
  identity: DevIdentity,
  workflowId: string,
  triggerId: string,
  catalog?: WorkflowCatalog | null,
): Promise<WebhookTriggerMutationSuccess | WebhookTriggerClientFailure> {
  if (!isResourceId(workflowId) || !isResourceId(triggerId)) {
    return invalidWorkflowProblem("/workflows/{workflowId}/triggers/{triggerId}/enable");
  }
  return mutateWebhookTrigger(
    identity,
    webhookTriggerEnablePath(workflowId, triggerId, catalog),
    "POST",
    "enable",
    {},
    workflowId,
  );
}

export async function getWebhookTrigger(
  identity: DevIdentity,
  workflowId: string,
  triggerId: string,
  catalog?: WorkflowCatalog | null,
): Promise<
  | { ok: true; statusCode: number; requestId: string; trigger: WebhookTriggerRecord; strippedKeys: string[] }
  | WebhookTriggerClientFailure
> {
  if (!isResourceId(workflowId) || !isResourceId(triggerId)) {
    return invalidWorkflowProblem("/workflows/{workflowId}/triggers/{triggerId}");
  }
  const path = webhookTriggerPath(workflowId, triggerId, catalog);
  const result = await callIdentityProxy<unknown>(path, identity);
  if (!result.ok) {
    return failure(result);
  }
  const extracted = takeOneTimeSecret(result.data);
  const trigger = parseWebhookTriggerRecord(result.data, workflowId);
  if (!trigger) {
    return {
      ok: false,
      statusCode: 502,
      requestId: result.requestId,
      forbidden: false,
      mapPending: false,
      problem: localProblem(
        path,
        result.requestId,
        502,
        "invalid-request",
        "Invalid response",
        "Webhook trigger metadata was missing an opaque id. Secret fields were stripped.",
      ),
    };
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    trigger,
    strippedKeys: extracted.strippedKeys,
  };
}
