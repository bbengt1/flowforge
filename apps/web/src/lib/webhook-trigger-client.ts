/**
 * Typed webhook trigger client. Paths and write bodies come from
 * webhook-trigger-contract.ts so a retarget only edits that adapter.
 * Cookie session + CSRF on admin mutations. Secrets are never persisted
 * or shown — unexpected secret fields are a #113 contract leak.
 */

import { forgetSecretDraft } from "./credential-contract.ts";
import { callIdentityProxy } from "./identity-client.ts";
import type { DevIdentity } from "./identity-headers.ts";
import { isResourceId } from "./identity-proxy-ids.ts";
import type { ProblemDetails } from "./problem.ts";
import type { WorkflowCatalog } from "./workflow-types.ts";
import {
  WEBHOOK_FORBIDDEN_MESSAGE,
  WEBHOOK_HOST_SUPPLIED_MESSAGE,
  WEBHOOK_TRIGGER_PROBLEM_CODES,
  WEBHOOK_VIEW_FORBIDDEN_MESSAGE,
  hostSuppliedWebhookIdentityKeys,
  isWebhookTriggerRef,
  parseWebhookTriggerList,
  parseWebhookTriggerRecord,
  rejectHostSuppliedWebhookBody,
  stripUnexpectedWebhookSecret,
  webhookMutationOutcomeMessage,
  webhookTriggerCreatePath,
  webhookTriggerDeletePath,
  webhookTriggerDisablePath,
  webhookTriggerEnablePath,
  webhookTriggerListPath,
  webhookTriggerPath,
  webhookTriggerRotateBody,
  webhookTriggerRotatePath,
  webhookTriggerUpdatePath,
  type WebhookSecretLeak,
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
};

export type WebhookTriggerListSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  items: WebhookTriggerRecord[];
  strippedKeys: string[];
  secretLeak: boolean;
};

export type WebhookTriggerMutationSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  trigger: WebhookTriggerRecord | null;
  leak: WebhookSecretLeak;
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

function invalidTriggerProblem(path: string): WebhookTriggerClientFailure {
  return {
    ok: false,
    statusCode: 400,
    requestId: "",
    forbidden: false,
    problem: localProblem(
      path,
      "",
      400,
      WEBHOOK_TRIGGER_PROBLEM_CODES.invalidRequest,
      "Invalid request",
      "triggerId must be a UUID or opaque publicId (wh_…).",
    ),
  };
}

function hostIdentityFailure(path: string): WebhookTriggerClientFailure {
  return {
    ok: false,
    statusCode: 400,
    requestId: "",
    forbidden: false,
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
    if (failed.forbidden) {
      failed.problem = {
        ...failed.problem,
        detail: failed.problem.detail || WEBHOOK_VIEW_FORBIDDEN_MESSAGE,
      };
    }
    return failed;
  }
  const extracted = stripUnexpectedWebhookSecret(result.data);
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    items: parseWebhookTriggerList(result.data, workflowId, catalog),
    strippedKeys: extracted.strippedKeys,
    secretLeak: extracted.leaked,
  };
}

async function mutateWebhookTrigger(
  identity: DevIdentity,
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  action: "create" | "update" | "rotate" | "disable" | "enable" | "delete",
  body?: WebhookTriggerWriteBody | ReturnType<typeof webhookTriggerRotateBody>,
  workflowId = "",
  catalog?: WorkflowCatalog | null,
): Promise<WebhookTriggerMutationSuccess | WebhookTriggerClientFailure> {
  if (body && hostSuppliedWebhookIdentityKeys(body as Record<string, unknown>).length > 0) {
    return hostIdentityFailure(path);
  }
  const result = await callIdentityProxy<unknown>(path, identity, {
    method,
    ...(body !== undefined ? { body } : {}),
  });
  if (action === "rotate" && body && "secret" in body && body.secret) {
    forgetSecretDraft({ secret: body.secret.secret });
  }
  if (!result.ok) {
    const failed = failure(result);
    if (failed.forbidden) {
      failed.problem = {
        ...failed.problem,
        detail: failed.problem.detail || WEBHOOK_FORBIDDEN_MESSAGE,
      };
    }
    return failed;
  }
  if (action === "delete" || result.statusCode === 204) {
    return {
      ok: true,
      statusCode: result.statusCode,
      requestId: result.requestId,
      trigger: null,
      leak: { leaked: false, strippedKeys: [] },
      message: webhookMutationOutcomeMessage("delete"),
    };
  }
  const leak = stripUnexpectedWebhookSecret(result.data);
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    trigger: parseWebhookTriggerRecord(result.data, workflowId, catalog),
    leak,
    message: webhookMutationOutcomeMessage(action, leak),
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
  const validated = validateWebhookTriggerDraft(draft, catalog, "create");
  if (!validated.ok) {
    return {
      ok: false,
      statusCode: 400,
      requestId: "",
      forbidden: false,
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
  const body = rejectHostSuppliedWebhookBody(
    validated.body as Record<string, unknown>,
  ) as WebhookTriggerWriteBody;
  const inline = body.secret?.secret;
  const result = await mutateWebhookTrigger(
    identity,
    webhookTriggerCreatePath(workflowId, catalog),
    "POST",
    "create",
    body,
    workflowId,
    catalog,
  );
  if (inline) {
    forgetSecretDraft({ secret: inline });
  }
  draft.inlineSecret = "";
  return result;
}

export async function updateWebhookTrigger(
  identity: DevIdentity,
  workflowId: string,
  triggerId: string,
  draft: WebhookTriggerDraft,
  catalog?: WorkflowCatalog | null,
): Promise<WebhookTriggerMutationSuccess | WebhookTriggerClientFailure> {
  if (!isResourceId(workflowId)) {
    return invalidWorkflowProblem("/triggers/{triggerId}");
  }
  if (!isWebhookTriggerRef(triggerId)) {
    return invalidTriggerProblem("/triggers/{triggerId}");
  }
  const validated = validateWebhookTriggerDraft(draft, catalog, "update");
  if (!validated.ok) {
    return {
      ok: false,
      statusCode: 400,
      requestId: "",
      forbidden: false,
      problem: localProblem(
        webhookTriggerUpdatePath(triggerId, catalog),
        "",
        400,
        WEBHOOK_TRIGGER_PROBLEM_CODES.invalidRequest,
        "Invalid request",
        validated.errors[0] ?? "Webhook trigger settings are invalid.",
      ),
    };
  }
  const body = rejectHostSuppliedWebhookBody(
    validated.body as Record<string, unknown>,
  ) as WebhookTriggerWriteBody;
  if (body.secret) {
    return {
      ok: false,
      statusCode: 400,
      requestId: "",
      forbidden: false,
      problem: localProblem(
        webhookTriggerUpdatePath(triggerId, catalog),
        "",
        400,
        WEBHOOK_TRIGGER_PROBLEM_CODES.invalidRequest,
        "Invalid request",
        "Secret material can only be sent to create or rotate.",
      ),
    };
  }
  return mutateWebhookTrigger(
    identity,
    webhookTriggerUpdatePath(triggerId, catalog),
    "PATCH",
    "update",
    body,
    workflowId,
    catalog,
  );
}

export async function rotateWebhookTrigger(
  identity: DevIdentity,
  workflowId: string,
  triggerId: string,
  secret: string,
  catalog?: WorkflowCatalog | null,
): Promise<WebhookTriggerMutationSuccess | WebhookTriggerClientFailure> {
  if (!isResourceId(workflowId)) {
    return invalidWorkflowProblem("/triggers/{triggerId}/rotate");
  }
  if (!isWebhookTriggerRef(triggerId)) {
    return invalidTriggerProblem("/triggers/{triggerId}/rotate");
  }
  if (!secret.trim()) {
    return {
      ok: false,
      statusCode: 400,
      requestId: "",
      forbidden: false,
      problem: localProblem(
        webhookTriggerRotatePath(triggerId, catalog),
        "",
        400,
        WEBHOOK_TRIGGER_PROBLEM_CODES.invalidRequest,
        "Invalid request",
        "Rotate requires a new webhook secret.",
      ),
    };
  }
  const body = rejectHostSuppliedWebhookBody(
    webhookTriggerRotateBody(secret) as unknown as Record<string, unknown>,
  ) as ReturnType<typeof webhookTriggerRotateBody>;
  return mutateWebhookTrigger(
    identity,
    webhookTriggerRotatePath(triggerId, catalog),
    "POST",
    "rotate",
    body,
    workflowId,
    catalog,
  );
}

export async function disableWebhookTrigger(
  identity: DevIdentity,
  workflowId: string,
  triggerId: string,
  catalog?: WorkflowCatalog | null,
): Promise<WebhookTriggerMutationSuccess | WebhookTriggerClientFailure> {
  if (!isResourceId(workflowId) || !isWebhookTriggerRef(triggerId)) {
    return invalidTriggerProblem("/triggers/{triggerId}/disable");
  }
  return mutateWebhookTrigger(
    identity,
    webhookTriggerDisablePath(triggerId, catalog),
    "POST",
    "disable",
    {},
    workflowId,
    catalog,
  );
}

export async function enableWebhookTrigger(
  identity: DevIdentity,
  workflowId: string,
  triggerId: string,
  catalog?: WorkflowCatalog | null,
): Promise<WebhookTriggerMutationSuccess | WebhookTriggerClientFailure> {
  if (!isResourceId(workflowId) || !isWebhookTriggerRef(triggerId)) {
    return invalidTriggerProblem("/triggers/{triggerId}/enable");
  }
  return mutateWebhookTrigger(
    identity,
    webhookTriggerEnablePath(triggerId, catalog),
    "POST",
    "enable",
    {},
    workflowId,
    catalog,
  );
}

export async function deleteWebhookTrigger(
  identity: DevIdentity,
  workflowId: string,
  triggerId: string,
  catalog?: WorkflowCatalog | null,
): Promise<WebhookTriggerMutationSuccess | WebhookTriggerClientFailure> {
  if (!isResourceId(workflowId) || !isWebhookTriggerRef(triggerId)) {
    return invalidTriggerProblem("/triggers/{triggerId}");
  }
  return mutateWebhookTrigger(
    identity,
    webhookTriggerDeletePath(triggerId, catalog),
    "DELETE",
    "delete",
    undefined,
    workflowId,
    catalog,
  );
}

export async function getWebhookTrigger(
  identity: DevIdentity,
  workflowId: string,
  triggerId: string,
  catalog?: WorkflowCatalog | null,
): Promise<
  | {
      ok: true;
      statusCode: number;
      requestId: string;
      trigger: WebhookTriggerRecord;
      strippedKeys: string[];
      secretLeak: boolean;
    }
  | WebhookTriggerClientFailure
> {
  if (!isResourceId(workflowId) || !isWebhookTriggerRef(triggerId)) {
    return invalidTriggerProblem("/triggers/{triggerId}");
  }
  const path = webhookTriggerPath(triggerId, catalog);
  const result = await callIdentityProxy<unknown>(path, identity);
  if (!result.ok) {
    return failure(result);
  }
  const extracted = stripUnexpectedWebhookSecret(result.data);
  const trigger = parseWebhookTriggerRecord(result.data, workflowId, catalog);
  if (!trigger) {
    return {
      ok: false,
      statusCode: 502,
      requestId: result.requestId,
      forbidden: false,
      problem: localProblem(
        path,
        result.requestId,
        502,
        "invalid-request",
        "Invalid response",
        "Webhook trigger metadata was missing publicId. Secret fields were stripped.",
      ),
    };
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    trigger,
    strippedKeys: extracted.strippedKeys,
    secretLeak: extracted.leaked,
  };
}
