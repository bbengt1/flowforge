/**
 * Typed schedule trigger client. Paths and write bodies come from
 * schedule-trigger-contract.ts so a retarget only edits that adapter.
 * Cookie session + CSRF on admin mutations.
 */

import { callIdentityProxy } from "./identity-client.ts";
import type { DevIdentity } from "./identity-headers.ts";
import { isResourceId } from "./identity-proxy-ids.ts";
import type { ProblemDetails } from "./problem.ts";
import type { WorkflowCatalog } from "./workflow-types.ts";
import {
  SCHEDULE_FORBIDDEN_MESSAGE,
  SCHEDULE_HOST_SUPPLIED_MESSAGE,
  SCHEDULE_TRIGGER_PROBLEM_CODES,
  SCHEDULE_VIEW_FORBIDDEN_MESSAGE,
  hostSuppliedScheduleIdentityKeys,
  isScheduleTriggerRef,
  parseScheduleTriggerList,
  parseScheduleTriggerRecord,
  rejectHostSuppliedScheduleBody,
  scheduleMutationOutcomeMessage,
  scheduleTriggerCreatePath,
  scheduleTriggerDeletePath,
  scheduleTriggerDisablePath,
  scheduleTriggerEnablePath,
  scheduleTriggerListPath,
  scheduleTriggerPath,
  scheduleTriggerUpdatePath,
  type ScheduleTriggerDraft,
  type ScheduleTriggerRecord,
  type ScheduleTriggerWriteBody,
  validateScheduleTriggerDraft,
} from "./schedule-trigger-contract.ts";

export type ScheduleTriggerClientFailure = {
  ok: false;
  statusCode: number;
  requestId: string;
  problem: ProblemDetails;
  forbidden: boolean;
};

export type ScheduleTriggerListSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  items: ScheduleTriggerRecord[];
};

export type ScheduleTriggerMutationSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  trigger: ScheduleTriggerRecord | null;
  message: string;
};

function failure(result: {
  statusCode: number;
  requestId: string;
  problem: ProblemDetails;
}): ScheduleTriggerClientFailure {
  const code = String(result.problem.code ?? "").trim();
  const forbidden =
    result.statusCode === 403 ||
    code === SCHEDULE_TRIGGER_PROBLEM_CODES.forbidden ||
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

function invalidWorkflowProblem(path: string): ScheduleTriggerClientFailure {
  return {
    ok: false,
    statusCode: 400,
    requestId: "",
    forbidden: false,
    problem: localProblem(
      path,
      "",
      400,
      SCHEDULE_TRIGGER_PROBLEM_CODES.invalidRequest,
      "Invalid request",
      "workflowId must be a workspace resource UUID.",
    ),
  };
}

function invalidTriggerProblem(path: string): ScheduleTriggerClientFailure {
  return {
    ok: false,
    statusCode: 400,
    requestId: "",
    forbidden: false,
    problem: localProblem(
      path,
      "",
      400,
      SCHEDULE_TRIGGER_PROBLEM_CODES.invalidRequest,
      "Invalid request",
      "triggerId must be a workspace resource UUID.",
    ),
  };
}

function hostIdentityFailure(path: string): ScheduleTriggerClientFailure {
  return {
    ok: false,
    statusCode: 400,
    requestId: "",
    forbidden: false,
    problem: localProblem(
      path,
      "",
      400,
      SCHEDULE_TRIGGER_PROBLEM_CODES.invalidRequest,
      "Invalid request",
      SCHEDULE_HOST_SUPPLIED_MESSAGE,
    ),
  };
}

export async function listScheduleTriggers(
  identity: DevIdentity,
  workflowId: string,
  catalog?: WorkflowCatalog | null,
): Promise<ScheduleTriggerListSuccess | ScheduleTriggerClientFailure> {
  if (!isResourceId(workflowId)) {
    return invalidWorkflowProblem("/workflows/{workflowId}/triggers");
  }
  const path = scheduleTriggerListPath(workflowId, catalog);
  const result = await callIdentityProxy<unknown>(path, identity);
  if (!result.ok) {
    const failed = failure(result);
    if (failed.forbidden) {
      failed.problem = {
        ...failed.problem,
        detail: failed.problem.detail || SCHEDULE_VIEW_FORBIDDEN_MESSAGE,
      };
    }
    return failed;
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    items: parseScheduleTriggerList(result.data, workflowId),
  };
}

async function mutateScheduleTrigger(
  identity: DevIdentity,
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  action: "create" | "update" | "disable" | "enable" | "delete",
  body?: ScheduleTriggerWriteBody | Record<string, never>,
  workflowId = "",
): Promise<ScheduleTriggerMutationSuccess | ScheduleTriggerClientFailure> {
  if (body && hostSuppliedScheduleIdentityKeys(body as Record<string, unknown>).length > 0) {
    return hostIdentityFailure(path);
  }
  const result = await callIdentityProxy<unknown>(path, identity, {
    method,
    ...(body !== undefined ? { body } : {}),
  });
  if (!result.ok) {
    const failed = failure(result);
    if (failed.forbidden) {
      failed.problem = {
        ...failed.problem,
        detail: failed.problem.detail || SCHEDULE_FORBIDDEN_MESSAGE,
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
      message: scheduleMutationOutcomeMessage("delete"),
    };
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    trigger: parseScheduleTriggerRecord(result.data, workflowId),
    message: scheduleMutationOutcomeMessage(action),
  };
}

export async function createScheduleTrigger(
  identity: DevIdentity,
  workflowId: string,
  draft: ScheduleTriggerDraft,
  catalog?: WorkflowCatalog | null,
): Promise<ScheduleTriggerMutationSuccess | ScheduleTriggerClientFailure> {
  if (!isResourceId(workflowId)) {
    return invalidWorkflowProblem("/workflows/{workflowId}/triggers");
  }
  const validated = validateScheduleTriggerDraft(draft, catalog);
  if (!validated.ok) {
    return {
      ok: false,
      statusCode: 400,
      requestId: "",
      forbidden: false,
      problem: localProblem(
        scheduleTriggerCreatePath(workflowId, catalog),
        "",
        400,
        SCHEDULE_TRIGGER_PROBLEM_CODES.invalidRequest,
        "Invalid request",
        validated.errors[0] ?? "Schedule trigger settings are invalid.",
      ),
    };
  }
  const body = rejectHostSuppliedScheduleBody(
    validated.body as Record<string, unknown>,
  ) as ScheduleTriggerWriteBody;
  return mutateScheduleTrigger(
    identity,
    scheduleTriggerCreatePath(workflowId, catalog),
    "POST",
    "create",
    body,
    workflowId,
  );
}

export async function updateScheduleTrigger(
  identity: DevIdentity,
  workflowId: string,
  triggerId: string,
  draft: ScheduleTriggerDraft,
  catalog?: WorkflowCatalog | null,
): Promise<ScheduleTriggerMutationSuccess | ScheduleTriggerClientFailure> {
  if (!isResourceId(workflowId)) {
    return invalidWorkflowProblem("/triggers/{triggerId}");
  }
  if (!isScheduleTriggerRef(triggerId)) {
    return invalidTriggerProblem("/triggers/{triggerId}");
  }
  const validated = validateScheduleTriggerDraft(draft, catalog);
  if (!validated.ok) {
    return {
      ok: false,
      statusCode: 400,
      requestId: "",
      forbidden: false,
      problem: localProblem(
        scheduleTriggerUpdatePath(triggerId, catalog),
        "",
        400,
        SCHEDULE_TRIGGER_PROBLEM_CODES.invalidRequest,
        "Invalid request",
        validated.errors[0] ?? "Schedule trigger settings are invalid.",
      ),
    };
  }
  const body = rejectHostSuppliedScheduleBody(
    validated.body as Record<string, unknown>,
  ) as ScheduleTriggerWriteBody;
  return mutateScheduleTrigger(
    identity,
    scheduleTriggerUpdatePath(triggerId, catalog),
    "PATCH",
    "update",
    body,
    workflowId,
  );
}

export async function disableScheduleTrigger(
  identity: DevIdentity,
  workflowId: string,
  triggerId: string,
  catalog?: WorkflowCatalog | null,
): Promise<ScheduleTriggerMutationSuccess | ScheduleTriggerClientFailure> {
  if (!isResourceId(workflowId) || !isScheduleTriggerRef(triggerId)) {
    return invalidTriggerProblem("/triggers/{triggerId}/disable");
  }
  return mutateScheduleTrigger(
    identity,
    scheduleTriggerDisablePath(triggerId, catalog),
    "POST",
    "disable",
    {},
    workflowId,
  );
}

export async function enableScheduleTrigger(
  identity: DevIdentity,
  workflowId: string,
  triggerId: string,
  catalog?: WorkflowCatalog | null,
): Promise<ScheduleTriggerMutationSuccess | ScheduleTriggerClientFailure> {
  if (!isResourceId(workflowId) || !isScheduleTriggerRef(triggerId)) {
    return invalidTriggerProblem("/triggers/{triggerId}/enable");
  }
  return mutateScheduleTrigger(
    identity,
    scheduleTriggerEnablePath(triggerId, catalog),
    "POST",
    "enable",
    {},
    workflowId,
  );
}

export async function deleteScheduleTrigger(
  identity: DevIdentity,
  workflowId: string,
  triggerId: string,
  catalog?: WorkflowCatalog | null,
): Promise<ScheduleTriggerMutationSuccess | ScheduleTriggerClientFailure> {
  if (!isResourceId(workflowId) || !isScheduleTriggerRef(triggerId)) {
    return invalidTriggerProblem("/triggers/{triggerId}");
  }
  return mutateScheduleTrigger(
    identity,
    scheduleTriggerDeletePath(triggerId, catalog),
    "DELETE",
    "delete",
    undefined,
    workflowId,
  );
}

export async function getScheduleTrigger(
  identity: DevIdentity,
  workflowId: string,
  triggerId: string,
  catalog?: WorkflowCatalog | null,
): Promise<
  | {
      ok: true;
      statusCode: number;
      requestId: string;
      trigger: ScheduleTriggerRecord;
    }
  | ScheduleTriggerClientFailure
> {
  if (!isResourceId(workflowId) || !isScheduleTriggerRef(triggerId)) {
    return invalidTriggerProblem("/triggers/{triggerId}");
  }
  const path = scheduleTriggerPath(triggerId, catalog);
  const result = await callIdentityProxy<unknown>(path, identity);
  if (!result.ok) {
    return failure(result);
  }
  const trigger = parseScheduleTriggerRecord(result.data, workflowId);
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
        "Schedule trigger metadata was missing timezone or a published version pin.",
      ),
    };
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    trigger,
  };
}
