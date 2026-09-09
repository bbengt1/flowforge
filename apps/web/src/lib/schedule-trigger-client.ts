/**
 * Typed schedule client. Paths and write bodies come from
 * schedule-trigger-contract.ts so a retarget only edits that adapter.
 * Cookie session + CSRF on admin mutations and dispatch.
 * Collection is #116 `/schedules`.
 */

import { callIdentityProxy } from "./identity-client.ts";
import type { DevIdentity } from "./identity-headers.ts";
import { isResourceId } from "./identity-proxy-ids.ts";
import type { ProblemDetails } from "./problem.ts";
import type { WorkflowCatalog } from "./workflow-types.ts";
import {
  SCHEDULE_DISPATCH_FORBIDDEN_MESSAGE,
  SCHEDULE_FORBIDDEN_MESSAGE,
  SCHEDULE_HOST_SUPPLIED_MESSAGE,
  SCHEDULE_TRIGGER_PROBLEM_CODES,
  SCHEDULE_VIEW_FORBIDDEN_MESSAGE,
  hostSuppliedScheduleIdentityKeys,
  isScheduleTriggerRef,
  parseScheduleDispatchItems,
  parseScheduleTypeCatalog,
  parseScheduleTriggerList,
  parseScheduleTriggerRecord,
  rejectHostSuppliedScheduleBody,
  scheduleCatalogPath,
  scheduleDispatchPath,
  scheduleMutationOutcomeMessage,
  scheduleTriggerCreatePath,
  scheduleTriggerDeletePath,
  scheduleTriggerDisablePath,
  scheduleTriggerEnablePath,
  scheduleTriggerListPath,
  scheduleTriggerPath,
  scheduleTriggerUpdatePath,
  scheduleTriggerWriteBody,
  type ScheduleDispatchItem,
  type ScheduleTypeCatalog,
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

export type ScheduleCatalogSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  catalog: ScheduleTypeCatalog;
};

export type ScheduleDispatchSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  items: ScheduleDispatchItem[];
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

function invalidScheduleProblem(path: string): ScheduleTriggerClientFailure {
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
      "scheduleId must be a workspace resource UUID.",
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

export async function getScheduleCatalog(
  identity: DevIdentity,
  catalog?: WorkflowCatalog | null,
  scheduleCatalog?: ScheduleTypeCatalog | null,
): Promise<ScheduleCatalogSuccess | ScheduleTriggerClientFailure> {
  const path = scheduleCatalogPath(catalog, scheduleCatalog);
  const result = await callIdentityProxy<unknown>(path, identity);
  if (!result.ok) {
    return failure(result);
  }
  const parsed = parseScheduleTypeCatalog(result.data);
  if (!parsed) {
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
        "Schedule catalog metadata was missing.",
      ),
    };
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    catalog: parsed,
  };
}

export async function listScheduleTriggers(
  identity: DevIdentity,
  workflowId: string,
  catalog?: WorkflowCatalog | null,
  scheduleCatalog?: ScheduleTypeCatalog | null,
): Promise<ScheduleTriggerListSuccess | ScheduleTriggerClientFailure> {
  if (!isResourceId(workflowId)) {
    return invalidWorkflowProblem("/schedules");
  }
  const path = scheduleTriggerListPath(workflowId, catalog, scheduleCatalog);
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
  scheduleCatalog?: ScheduleTypeCatalog | null,
): Promise<ScheduleTriggerMutationSuccess | ScheduleTriggerClientFailure> {
  if (!isResourceId(workflowId)) {
    return invalidWorkflowProblem("/schedules");
  }
  const validated = validateScheduleTriggerDraft(draft, catalog, scheduleCatalog);
  if (!validated.ok) {
    return {
      ok: false,
      statusCode: 400,
      requestId: "",
      forbidden: false,
      problem: localProblem(
        scheduleTriggerCreatePath(workflowId, catalog, scheduleCatalog),
        "",
        400,
        SCHEDULE_TRIGGER_PROBLEM_CODES.invalidRequest,
        "Invalid request",
        validated.errors[0] ?? "Schedule settings are invalid.",
      ),
    };
  }
  const body = rejectHostSuppliedScheduleBody(
    scheduleTriggerWriteBody(validated.settings, workflowId) as Record<string, unknown>,
  ) as ScheduleTriggerWriteBody;
  return mutateScheduleTrigger(
    identity,
    scheduleTriggerCreatePath(workflowId, catalog, scheduleCatalog),
    "POST",
    "create",
    body,
    workflowId,
  );
}

export async function updateScheduleTrigger(
  identity: DevIdentity,
  workflowId: string,
  scheduleId: string,
  draft: ScheduleTriggerDraft,
  catalog?: WorkflowCatalog | null,
  scheduleCatalog?: ScheduleTypeCatalog | null,
): Promise<ScheduleTriggerMutationSuccess | ScheduleTriggerClientFailure> {
  if (!isResourceId(workflowId)) {
    return invalidWorkflowProblem("/schedules/{scheduleId}");
  }
  if (!isScheduleTriggerRef(scheduleId)) {
    return invalidScheduleProblem("/schedules/{scheduleId}");
  }
  const validated = validateScheduleTriggerDraft(draft, catalog, scheduleCatalog);
  if (!validated.ok) {
    return {
      ok: false,
      statusCode: 400,
      requestId: "",
      forbidden: false,
      problem: localProblem(
        scheduleTriggerUpdatePath(scheduleId, catalog, scheduleCatalog),
        "",
        400,
        SCHEDULE_TRIGGER_PROBLEM_CODES.invalidRequest,
        "Invalid request",
        validated.errors[0] ?? "Schedule settings are invalid.",
      ),
    };
  }
  const body = rejectHostSuppliedScheduleBody(
    validated.body as Record<string, unknown>,
  ) as ScheduleTriggerWriteBody;
  return mutateScheduleTrigger(
    identity,
    scheduleTriggerUpdatePath(scheduleId, catalog, scheduleCatalog),
    "PATCH",
    "update",
    body,
    workflowId,
  );
}

export async function disableScheduleTrigger(
  identity: DevIdentity,
  workflowId: string,
  scheduleId: string,
  catalog?: WorkflowCatalog | null,
  scheduleCatalog?: ScheduleTypeCatalog | null,
): Promise<ScheduleTriggerMutationSuccess | ScheduleTriggerClientFailure> {
  if (!isResourceId(workflowId) || !isScheduleTriggerRef(scheduleId)) {
    return invalidScheduleProblem("/schedules/{scheduleId}/disable");
  }
  return mutateScheduleTrigger(
    identity,
    scheduleTriggerDisablePath(scheduleId, catalog, scheduleCatalog),
    "POST",
    "disable",
    {},
    workflowId,
  );
}

export async function enableScheduleTrigger(
  identity: DevIdentity,
  workflowId: string,
  scheduleId: string,
  catalog?: WorkflowCatalog | null,
  scheduleCatalog?: ScheduleTypeCatalog | null,
): Promise<ScheduleTriggerMutationSuccess | ScheduleTriggerClientFailure> {
  if (!isResourceId(workflowId) || !isScheduleTriggerRef(scheduleId)) {
    return invalidScheduleProblem("/schedules/{scheduleId}/enable");
  }
  return mutateScheduleTrigger(
    identity,
    scheduleTriggerEnablePath(scheduleId, catalog, scheduleCatalog),
    "POST",
    "enable",
    {},
    workflowId,
  );
}

export async function deleteScheduleTrigger(
  identity: DevIdentity,
  workflowId: string,
  scheduleId: string,
  catalog?: WorkflowCatalog | null,
  scheduleCatalog?: ScheduleTypeCatalog | null,
): Promise<ScheduleTriggerMutationSuccess | ScheduleTriggerClientFailure> {
  if (!isResourceId(workflowId) || !isScheduleTriggerRef(scheduleId)) {
    return invalidScheduleProblem("/schedules/{scheduleId}");
  }
  return mutateScheduleTrigger(
    identity,
    scheduleTriggerDeletePath(scheduleId, catalog, scheduleCatalog),
    "DELETE",
    "delete",
    undefined,
    workflowId,
  );
}

export async function dispatchSchedule(
  identity: DevIdentity,
  scheduleId?: string,
  catalog?: WorkflowCatalog | null,
  scheduleCatalog?: ScheduleTypeCatalog | null,
): Promise<ScheduleDispatchSuccess | ScheduleTriggerClientFailure> {
  const path = scheduleDispatchPath(catalog, scheduleCatalog);
  if (scheduleId && !isScheduleTriggerRef(scheduleId)) {
    return invalidScheduleProblem(path);
  }
  const body: Record<string, unknown> = {};
  if (scheduleId) {
    body.scheduleId = scheduleId;
  }
  if (hostSuppliedScheduleIdentityKeys(body).length > 0) {
    return hostIdentityFailure(path);
  }
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "POST",
    body,
  });
  if (!result.ok) {
    const failed = failure(result);
    if (failed.forbidden) {
      failed.problem = {
        ...failed.problem,
        detail: failed.problem.detail || SCHEDULE_DISPATCH_FORBIDDEN_MESSAGE,
      };
    }
    return failed;
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    items: parseScheduleDispatchItems(result.data),
    message: scheduleMutationOutcomeMessage("dispatch"),
  };
}

export async function getScheduleTrigger(
  identity: DevIdentity,
  workflowId: string,
  scheduleId: string,
  catalog?: WorkflowCatalog | null,
  scheduleCatalog?: ScheduleTypeCatalog | null,
): Promise<
  | {
      ok: true;
      statusCode: number;
      requestId: string;
      trigger: ScheduleTriggerRecord;
    }
  | ScheduleTriggerClientFailure
> {
  if (!isResourceId(workflowId) || !isScheduleTriggerRef(scheduleId)) {
    return invalidScheduleProblem("/schedules/{scheduleId}");
  }
  const path = scheduleTriggerPath(scheduleId, catalog, scheduleCatalog);
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
        "Schedule metadata was missing timezone or a published version pin.",
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
