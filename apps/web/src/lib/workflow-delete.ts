/**
 * Soft-delete a workflow (#540 web).
 *
 * DELETE /api/v1/workflows/{id} returns 204. The control plane
 * unpublishes, turns triggers off, and tombstones the row. YAML is
 * not sent or changed. Delete never cancels queued or running work.
 *
 * The action is shown only when capabilities.delete is true and the
 * surface is not /embed/v1. A missing flag is false.
 *
 * Workflow detail may include deleteImpact for a caller who can delete.
 * waitingRuns are parked runs delete will stop. blocked or inFlightRuns
 * means delete would return 409. A missing or malformed field keeps the
 * previous copy and never invents a count. Embed never shows it.
 */

import type { QueryClient } from "@tanstack/react-query";
import type { DestructiveImpactItem } from "./confirm-destructive.ts";
import type { ProblemDetails } from "./problem.ts";
import {
  sanitizeQueryCacheValue,
  workflowExplorerQueryKey,
  workflowListQueryKey,
  workflowRecordQueryKey,
  workflowSearchQueryKey,
} from "./query-cache.ts";
import type {
  WorkflowCapabilities,
  WorkflowDeleteImpact,
  WorkflowRecord,
} from "./workflow-types.ts";

export const WORKFLOW_HAS_ACTIVE_EXECUTIONS_CODE =
  "workflow_has_active_executions" as const;

export const WORKFLOW_SLUG_RESERVED_CODE = "workflow_slug_reserved" as const;

export const DELETE_WORKFLOW_LABEL = "Delete workflow";

export const WORKFLOW_DELETE_DESCRIPTION =
  "Deleting unpublishes the workflow and turns off its triggers. The definition YAML is not changed.";

export const WORKFLOW_DELETE_PUBLISHED_NOTE =
  "This workflow is published. Delete unpublishes it and turns its triggers off.";

export const WORKFLOW_DELETE_ACTIVE_EXECUTIONS_MESSAGE =
  "Queued or running executions must finish or be cancelled before this workflow can be deleted. Delete does not cancel them.";

export const WORKFLOW_DELETE_EXECUTIONS_DETAIL =
  "Queued or running executions block delete. Nothing is cancelled.";

const DELETE_IMPACT_FIELDS = new Set([
  "waitingRuns",
  "blocked",
  "inFlightRuns",
]);

export const WORKFLOW_DELETE_FORBIDDEN_MESSAGE =
  "You don't have permission to delete this workflow.";

export const WORKFLOW_DELETE_NOT_FOUND_MESSAGE =
  "This workflow no longer exists.";

export const WORKFLOW_DELETE_OTHER_MESSAGE =
  "The workflow could not be deleted.";

export const WORKFLOW_DELETE_CONFIRM_HINT = "Type the workflow name to confirm.";

export const WORKFLOW_SLUG_RESERVED_NAME_MESSAGE =
  "This name is reserved by a deleted workflow. Choose a different name.";

export const WORKFLOW_SLUG_RESERVED_SLUG_MESSAGE =
  "This slug is reserved by a deleted workflow. Choose a different slug.";

export const WORKFLOW_SLUG_CONFLICT_MESSAGE =
  "A workflow with this slug already exists.";

export const WORKFLOW_SLUG_EXHAUSTED_MESSAGE =
  "A unique slug could not be allocated.";

export const WORKFLOW_DELETED_TOAST_TITLE = "Workflow deleted";

export type WorkflowDeleteFailureKind =
  | "active-executions"
  | "forbidden"
  | "not-found"
  | "other";

export type WorkflowSlugField = "name" | "slug";

export function readWorkflowCapabilities(value: unknown): WorkflowCapabilities {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { delete: false };
  }
  const body = value as Record<string, unknown>;
  return { delete: body.delete === true };
}

function nonNegativeInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}

/**
 * A valid deleteImpact, or undefined when the field is missing or
 * malformed. Undefined keeps the existing confirm copy.
 */
export function readWorkflowDeleteImpact(
  value: unknown,
): WorkflowDeleteImpact | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const body = value as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!DELETE_IMPACT_FIELDS.has(key)) {
      return undefined;
    }
  }
  if (
    !Object.prototype.hasOwnProperty.call(body, "waitingRuns") ||
    !Object.prototype.hasOwnProperty.call(body, "blocked") ||
    !Object.prototype.hasOwnProperty.call(body, "inFlightRuns")
  ) {
    return undefined;
  }
  const waitingRuns = nonNegativeInt(body.waitingRuns);
  const inFlightRuns = nonNegativeInt(body.inFlightRuns);
  if (
    waitingRuns === null ||
    inFlightRuns === null ||
    typeof body.blocked !== "boolean"
  ) {
    return undefined;
  }
  return { waitingRuns, blocked: body.blocked, inFlightRuns };
}

/** Embed never receives the counts, even when the payload includes them. */
export function workflowDeleteShownImpact(input: {
  embed: boolean;
  deleteImpact: unknown;
}): WorkflowDeleteImpact | undefined {
  if (input.embed) {
    return undefined;
  }
  return readWorkflowDeleteImpact(input.deleteImpact);
}

export function workflowDeleteWaitingRunsMessage(count: number): string {
  const noun = count === 1 ? "run" : "runs";
  return `${count} ${noun} waiting on an approval or a delay will be stopped and marked failed.`;
}

export function workflowDeleteBlockedRunsMessage(count: number): string {
  if (count === 1) {
    return "This workflow can't be deleted while 1 run is still running or queued.";
  }
  if (count > 1) {
    return `This workflow can't be deleted while ${count} runs are still running or queued.`;
  }
  return "This workflow can't be deleted while runs are still running or queued.";
}

export type WorkflowDeleteConfirmState = {
  description: string;
  executionsDetail: string;
  confirmDisabled: boolean;
};

export function workflowDeleteConfirmState(input: {
  status: string;
  deleteImpact?: WorkflowDeleteImpact | null;
}): WorkflowDeleteConfirmState {
  const description = workflowDeleteDescription(input.status);
  const impact = input.deleteImpact ?? undefined;
  if (!impact) {
    return {
      description,
      executionsDetail: WORKFLOW_DELETE_EXECUTIONS_DETAIL,
      confirmDisabled: false,
    };
  }
  if (impact.blocked || impact.inFlightRuns > 0) {
    const sentence = workflowDeleteBlockedRunsMessage(impact.inFlightRuns);
    return {
      description: `${description} ${sentence}`,
      executionsDetail: sentence,
      confirmDisabled: true,
    };
  }
  if (impact.waitingRuns > 0) {
    const sentence = workflowDeleteWaitingRunsMessage(impact.waitingRuns);
    return {
      description: `${description} ${sentence}`,
      executionsDetail: sentence,
      confirmDisabled: false,
    };
  }
  return {
    description,
    executionsDetail: WORKFLOW_DELETE_EXECUTIONS_DETAIL,
    confirmDisabled: false,
  };
}

export function workflowRecordWithCapabilities(
  record: WorkflowRecord,
): WorkflowRecord {
  const raw = record as WorkflowRecord & {
    capabilities?: unknown;
    deleteImpact?: unknown;
  };
  const deleteImpact = readWorkflowDeleteImpact(raw.deleteImpact);
  const next: WorkflowRecord = {
    ...record,
    capabilities: readWorkflowCapabilities(raw.capabilities),
  };
  if (deleteImpact) {
    next.deleteImpact = deleteImpact;
  } else {
    delete next.deleteImpact;
  }
  return next;
}

/** Missing, false, or any non-boolean true is denied. */
export function workflowCapabilitiesAllowDelete(
  capabilities: unknown,
): boolean {
  return readWorkflowCapabilities(capabilities).delete === true;
}

/**
 * Embed never offers delete, even when the flag is true.
 * Standalone shows it only for an explicit true flag.
 */
export function workflowDeleteActionVisible(input: {
  embed: boolean;
  canDelete: boolean;
}): boolean {
  if (input.embed) {
    return false;
  }
  return input.canDelete === true;
}

export function classifyWorkflowDeleteFailure(input: {
  statusCode: number;
  code: string;
}): WorkflowDeleteFailureKind {
  if (input.code === WORKFLOW_HAS_ACTIVE_EXECUTIONS_CODE) {
    return "active-executions";
  }
  if (input.statusCode === 403 || input.code === "forbidden") {
    return "forbidden";
  }
  if (input.statusCode === 404 || input.code === "not-found") {
    return "not-found";
  }
  return "other";
}

export function workflowDeleteFailureMessage(
  kind: WorkflowDeleteFailureKind,
): string {
  switch (kind) {
    case "active-executions":
      return WORKFLOW_DELETE_ACTIVE_EXECUTIONS_MESSAGE;
    case "forbidden":
      return WORKFLOW_DELETE_FORBIDDEN_MESSAGE;
    case "not-found":
      return WORKFLOW_DELETE_NOT_FOUND_MESSAGE;
    default:
      return WORKFLOW_DELETE_OTHER_MESSAGE;
  }
}

/** 409 active runs and 403 keep the confirm dialog open. 404 closes it. */
export function workflowDeleteDialogStaysOpen(
  kind: WorkflowDeleteFailureKind,
): boolean {
  return kind === "active-executions" || kind === "forbidden" || kind === "other";
}

export function workflowDeleteIsNotFound(input: {
  statusCode: number;
  code: string;
}): boolean {
  return classifyWorkflowDeleteFailure(input) === "not-found";
}

export function workflowDeleteDescription(status: string): string {
  if (status === "published") {
    return `${WORKFLOW_DELETE_DESCRIPTION} ${WORKFLOW_DELETE_PUBLISHED_NOTE}`;
  }
  return WORKFLOW_DELETE_DESCRIPTION;
}

export function workflowDeleteImpact(input: {
  name: string;
  status: string;
  deleteImpact?: WorkflowDeleteImpact | null;
}): DestructiveImpactItem[] {
  const state = workflowDeleteConfirmState(input);
  return [
    { id: "workflow", label: "Workflow", detail: input.name },
    { id: "status", label: "Status", detail: input.status || "unknown" },
    {
      id: "effect",
      label: "Effect",
      detail: "Unpublish the workflow and turn its triggers off. YAML stays unchanged.",
    },
    {
      id: "runs",
      label: "Executions",
      detail: state.executionsDetail,
    },
  ];
}

export function workflowDeleteNameMatches(
  expectedName: string,
  typedName: string,
): boolean {
  const expected = expectedName.trim();
  if (!expected) {
    return false;
  }
  return typedName.trim() === expected;
}

/**
 * Create-time slug clash. Match the code, not which fields were sent.
 * workflow_slug_reserved, a live slug conflict ("slug already exists"),
 * and an exhausted derived slug ("could not be allocated") land on the
 * slug field. Other 409s — execution_not_retryable,
 * step_attempt_superseded, approval_closed, and a generic unique
 * violation — do not, even when an error path is slug.
 */
export function workflowSlugReservedTarget(input: {
  statusCode: number;
  code: string;
  detail?: string;
  errors?: readonly { path?: string; message?: string }[];
}): WorkflowSlugField | null {
  if (input.statusCode !== 409) {
    return null;
  }
  if (input.code === WORKFLOW_SLUG_RESERVED_CODE) {
    return "slug";
  }
  if (input.code === "conflict" && slugConflictKind(input) !== null) {
    return "slug";
  }
  return null;
}

function slugConflictKind(input: {
  detail?: string;
  errors?: readonly { path?: string; message?: string }[];
}): "live" | "exhausted" | null {
  const fromDetail = slugConflictText(input.detail);
  if (fromDetail) {
    return fromDetail;
  }
  for (const error of input.errors ?? []) {
    if (error.path !== "slug") {
      continue;
    }
    const fromError = slugConflictText(error.message);
    if (fromError) {
      return fromError;
    }
  }
  return null;
}

function slugConflictText(value: string | undefined): "live" | "exhausted" | null {
  const text = value ?? "";
  if (/slug already exists/i.test(text)) {
    return "live";
  }
  if (/could not be allocated/i.test(text)) {
    return "exhausted";
  }
  return null;
}

export function workflowSlugReservedMessage(field: WorkflowSlugField): string {
  return field === "slug"
    ? WORKFLOW_SLUG_RESERVED_SLUG_MESSAGE
    : WORKFLOW_SLUG_RESERVED_NAME_MESSAGE;
}

export function workflowSlugReservedFromProblem(
  problem: Pick<ProblemDetails, "status" | "code"> &
    Partial<Pick<ProblemDetails, "detail" | "errors">>,
  sent: { slug?: string; name?: string },
): { field: WorkflowSlugField; message: string } | null {
  const field = workflowSlugReservedTarget({
    statusCode: problem.status,
    code: problem.code,
    detail: problem.detail,
    errors: problem.errors,
  });
  if (!field) {
    return null;
  }
  // Callers pass `sent` so tests can show a name-only body and an
  // explicit slug land on the same field.
  void sent;
  return { field, message: workflowSlugFieldMessage(problem) };
}

function workflowSlugFieldMessage(
  problem: Pick<ProblemDetails, "code"> &
    Partial<Pick<ProblemDetails, "detail" | "errors">>,
): string {
  if (problem.code === WORKFLOW_SLUG_RESERVED_CODE) {
    return WORKFLOW_SLUG_RESERVED_SLUG_MESSAGE;
  }
  if (slugConflictKind(problem) === "exhausted") {
    return WORKFLOW_SLUG_EXHAUSTED_MESSAGE;
  }
  return WORKFLOW_SLUG_CONFLICT_MESSAGE;
}

export function omitDeletedWorkflow<T extends { id: string }>(
  items: readonly T[] | null,
  workflowId: string,
): T[] | null {
  if (items == null) {
    return null;
  }
  return items.filter((item) => item.id !== workflowId);
}

type WorkflowExplorerCache = {
  folders: unknown;
  workflows: readonly { id: string }[];
};

function dropWorkflowId(value: unknown, workflowId: string): unknown {
  if (Array.isArray(value)) {
    return value.filter((item) => {
      if (!item || typeof item !== "object") {
        return true;
      }
      return (item as { id?: unknown }).id !== workflowId;
    });
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const body = value as { workflows?: unknown };
  if (!Array.isArray(body.workflows)) {
    return value;
  }
  return {
    ...(value as Record<string, unknown>),
    workflows: dropWorkflowId(body.workflows, workflowId),
  };
}

export function rememberWorkflowCollections(
  client: QueryClient,
  scope: string | null,
  data: {
    list?: readonly { id: string }[];
    explorer?: WorkflowExplorerCache;
    search?: readonly { id: string }[] | null;
    workflow?: { id: string } | null;
  },
): void {
  if (!scope) {
    return;
  }
  const listKey = workflowListQueryKey(scope);
  if (listKey && data.list) {
    client.setQueryData(listKey, sanitizeQueryCacheValue([...data.list]).value);
  }
  const explorerKey = workflowExplorerQueryKey(scope);
  if (explorerKey && data.explorer) {
    client.setQueryData(
      explorerKey,
      sanitizeQueryCacheValue({
        folders: data.explorer.folders,
        workflows: [...data.explorer.workflows],
      }).value,
    );
  }
  const searchKey = workflowSearchQueryKey(scope);
  if (searchKey && data.search) {
    client.setQueryData(
      searchKey,
      sanitizeQueryCacheValue([...data.search]).value,
    );
  }
  const workflow = data.workflow;
  if (workflow) {
    const recordKey = workflowRecordQueryKey(scope, workflow.id);
    if (recordKey) {
      client.setQueryData(
        recordKey,
        sanitizeQueryCacheValue({ ...workflow }).value,
      );
    }
  }
}

export async function invalidateDeletedWorkflowCache(
  client: QueryClient,
  scope: string | null,
  workflowId: string,
): Promise<void> {
  if (!scope || !workflowId.trim()) {
    return;
  }
  const keys = [
    workflowListQueryKey(scope),
    workflowExplorerQueryKey(scope),
    workflowSearchQueryKey(scope),
  ];
  for (const key of keys) {
    if (!key) {
      continue;
    }
    client.setQueryData(key, (current) => dropWorkflowId(current, workflowId));
    await client.invalidateQueries({ queryKey: key });
  }
  const recordKey = workflowRecordQueryKey(scope, workflowId);
  if (recordKey) {
    client.removeQueries({ queryKey: recordKey });
  }
}
