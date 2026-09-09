import { callIdentityProxy, type IdentityClientResult } from "./identity-client.ts";
import type { DevIdentity } from "./identity-headers.ts";
import { problemFieldErrors, type ProblemDetails } from "./problem.ts";
import {
  applyDraftResponse,
  applyNormalizeResponse,
  coreCatalog,
  executionStartBody,
  isCompareResult,
  isConflictProblem,
  isNormalizeResponse,
  isValidateResponse,
  isWorkflowDraft,
  isWorkflowExecution,
  isWorkflowExport,
  isWorkflowRecord,
  isWorkflowVersion,
  readExecutionPayload,
  workflowErrorsFromProblem,
  type AppliedDraft,
  type AppliedNormalize,
} from "./workflow.ts";
import type {
  CompareWorkflowBody,
  CompareWorkflowResult,
  CreateWorkflowBody,
  DefinitionYamlBody,
  NormalizeResponse,
  PublishWorkflowBody,
  PublishWorkflowResult,
  RestoreDraftBody,
  SaveDraftBody,
  ValidateResponse,
  WorkflowCatalog,
  WorkflowDetail,
  WorkflowDraft,
  WorkflowExecution,
  WorkflowExport,
  WorkflowFieldError,
  WorkflowList,
  WorkflowRecord,
  WorkflowVersion,
  WorkflowVersionList,
} from "./workflow-types.ts";
import { parseAuthorizedPins } from "./ops-config.ts";
import type { OpsConfigPin } from "./ops-config-types.ts";

export const WORKFLOW_CATALOG_PATH = "/workflows/catalog";
export const WORKFLOW_VALIDATE_PATH = "/workflows/validate";
export const WORKFLOW_NORMALIZE_PATH = "/workflows/normalize";
export const WORKFLOWS_PATH = "/workflows";
export const IF_MATCH_HEADER = "If-Match";

export function workflowPath(workflowId: string): string {
  return `${WORKFLOWS_PATH}/${workflowId}`;
}

export function workflowDraftPath(workflowId: string): string {
  return `${workflowPath(workflowId)}/draft`;
}

export function workflowPublishPath(workflowId: string): string {
  return `${workflowPath(workflowId)}/publish`;
}

export function workflowComparePath(workflowId: string): string {
  return `${workflowPath(workflowId)}/compare`;
}

export function workflowVersionsPath(workflowId: string): string {
  return `${workflowPath(workflowId)}/versions`;
}

export function workflowVersionPath(workflowId: string, versionId: string): string {
  return `${workflowVersionsPath(workflowId)}/${versionId}`;
}

export function workflowExportPath(workflowId: string, versionId: string): string {
  return `${workflowVersionPath(workflowId, versionId)}/export`;
}

export function workflowRestorePath(workflowId: string, versionId: string): string {
  return `${workflowVersionPath(workflowId, versionId)}/restore`;
}

export function workflowExecutionsPath(workflowId: string): string {
  return `${workflowPath(workflowId)}/executions`;
}

export function workflowExecutionPath(
  workflowId: string,
  executionId: string,
): string {
  return `${workflowExecutionsPath(workflowId)}/${executionId}`;
}

export type CatalogClientSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  catalog: WorkflowCatalog;
};

export type ValidateClientSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  valid: true;
  summary: ValidateResponse["summary"];
  warnings: WorkflowFieldError[];
};

export type NormalizeClientSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  applied: AppliedNormalize;
};

export type WorkflowClientFailure = {
  ok: false;
  statusCode: number;
  requestId: string;
  problem: ProblemDetails;
  errors: WorkflowFieldError[];
  conflict: boolean;
};

export type ListWorkflowsSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  items: WorkflowRecord[];
};

export type WorkflowRecordSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  workflow: WorkflowRecord;
};

export type DraftClientSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  workflow?: WorkflowRecord;
  draft: WorkflowDraft;
  applied: AppliedDraft;
};

export type PublishClientSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  workflow: WorkflowRecord;
  version: WorkflowVersion;
  pins: OpsConfigPin[];
};

export type VersionsClientSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  items: WorkflowVersion[];
};

export type VersionClientSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  version: WorkflowVersion;
};

export type ExportClientSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  exported: WorkflowExport;
};

export type CompareClientSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  compare: CompareWorkflowResult;
};

export type ExecutionClientSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  execution: WorkflowExecution;
};

export async function fetchWorkflowCatalog(
  identity: DevIdentity,
): Promise<CatalogClientSuccess | WorkflowClientFailure> {
  const result = await callIdentityProxy<WorkflowCatalog>(
    WORKFLOW_CATALOG_PATH,
    identity,
  );
  if (!result.ok) {
    return failure(result);
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    catalog: coreCatalog(result.data),
  };
}

export async function validateWorkflowYaml(
  identity: DevIdentity,
  yaml: string,
): Promise<ValidateClientSuccess | WorkflowClientFailure> {
  const result = await callIdentityProxy<ValidateResponse>(
    WORKFLOW_VALIDATE_PATH,
    identity,
    { method: "POST", body: definitionBody(yaml) },
  );
  if (!result.ok) {
    return failure(result);
  }
  if (!isValidateResponse(result.data)) {
    return malformed(
      result.requestId,
      result.statusCode,
      WORKFLOW_VALIDATE_PATH,
      "Validate returned a payload that is not a valid summary.",
    );
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    valid: true,
    summary: result.data.summary,
    warnings: result.data.warnings ?? [],
  };
}

export async function normalizeWorkflowYaml(
  identity: DevIdentity,
  yaml: string,
): Promise<NormalizeClientSuccess | WorkflowClientFailure> {
  const result = await callIdentityProxy<NormalizeResponse>(
    WORKFLOW_NORMALIZE_PATH,
    identity,
    { method: "POST", body: definitionBody(yaml) },
  );
  if (!result.ok) {
    return failure(result);
  }
  if (!isNormalizeResponse(result.data)) {
    return malformed(
      result.requestId,
      result.statusCode,
      WORKFLOW_NORMALIZE_PATH,
      "Normalize returned a payload without definitionYaml and digest.",
    );
  }
  const applied = applyNormalizeResponse(result.data);
  if (!applied) {
    return malformed(
      result.requestId,
      result.statusCode,
      WORKFLOW_NORMALIZE_PATH,
      "Normalize response could not replace the editor buffer.",
    );
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    applied,
  };
}

function definitionBody(yaml: string): DefinitionYamlBody {
  return { definitionYaml: yaml };
}

function failure(
  result: Extract<IdentityClientResult<unknown>, { ok: false }>,
): WorkflowClientFailure {
  return {
    ok: false,
    statusCode: result.statusCode,
    requestId: result.requestId,
    problem: {
      ...result.problem,
      errors: problemFieldErrors(result.problem),
    },
    errors: workflowErrorsFromProblem(result.problem),
    conflict: isConflictProblem(result.problem),
  };
}

function malformed(
  requestId: string,
  statusCode: number,
  instance: string,
  detail: string,
): WorkflowClientFailure {
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
    errors: [],
    conflict: false,
  };
}

export async function listWorkflows(
  identity: DevIdentity,
): Promise<ListWorkflowsSuccess | WorkflowClientFailure> {
  const result = await callIdentityProxy<WorkflowList>(WORKFLOWS_PATH, identity);
  if (!result.ok) {
    return failure(result);
  }
  const items = Array.isArray(result.data.items)
    ? result.data.items.filter(isWorkflowRecord)
    : [];
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    items,
  };
}

export async function createWorkflow(
  identity: DevIdentity,
  body: CreateWorkflowBody,
): Promise<DraftClientSuccess | WorkflowClientFailure> {
  const result = await callIdentityProxy<WorkflowDetail>(WORKFLOWS_PATH, identity, {
    method: "POST",
    body,
  });
  return detailResult(result, WORKFLOWS_PATH);
}

export async function getWorkflow(
  identity: DevIdentity,
  workflowId: string,
): Promise<WorkflowRecordSuccess | WorkflowClientFailure> {
  const path = workflowPath(workflowId);
  const result = await callIdentityProxy<WorkflowRecord>(path, identity);
  if (!result.ok) {
    return failure(result);
  }
  if (!isWorkflowRecord(result.data)) {
    return malformed(
      result.requestId,
      result.statusCode,
      path,
      "Workflow summary was missing id or draftRevision.",
    );
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    workflow: result.data,
  };
}

export async function getWorkflowDraft(
  identity: DevIdentity,
  workflowId: string,
): Promise<DraftClientSuccess | WorkflowClientFailure> {
  const path = workflowDraftPath(workflowId);
  const result = await callIdentityProxy<WorkflowDraft>(path, identity);
  if (!result.ok) {
    return failure(result);
  }
  return draftOnlyResult(result, path);
}

export async function saveWorkflowDraft(
  identity: DevIdentity,
  workflowId: string,
  yaml: string,
  revision: number,
): Promise<DraftClientSuccess | WorkflowClientFailure> {
  const path = workflowDraftPath(workflowId);
  const body: SaveDraftBody = { revision, definitionYaml: yaml };
  const result = await callIdentityProxy<WorkflowDetail>(path, identity, {
    method: "PUT",
    body,
    headers: { [IF_MATCH_HEADER]: String(revision) },
  });
  return detailResult(result, path);
}

export async function publishWorkflow(
  identity: DevIdentity,
  workflowId: string,
  body: PublishWorkflowBody = {},
): Promise<PublishClientSuccess | WorkflowClientFailure> {
  const path = workflowPublishPath(workflowId);
  const result = await callIdentityProxy<PublishWorkflowResult>(path, identity, {
    method: "POST",
    body,
  });
  if (!result.ok) {
    return failure(result);
  }
  if (!isWorkflowRecord(result.data.workflow) || !isWorkflowVersion(result.data.version)) {
    return malformed(
      result.requestId,
      result.statusCode,
      path,
      "Publish returned a payload without workflow and version.",
    );
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    workflow: result.data.workflow,
    version: result.data.version,
    pins: parseAuthorizedPins(result.data.pins),
  };
}

export async function listWorkflowVersions(
  identity: DevIdentity,
  workflowId: string,
): Promise<VersionsClientSuccess | WorkflowClientFailure> {
  const path = workflowVersionsPath(workflowId);
  const result = await callIdentityProxy<WorkflowVersionList>(path, identity);
  if (!result.ok) {
    return failure(result);
  }
  const items = Array.isArray(result.data.items)
    ? result.data.items.filter(isWorkflowVersion)
    : [];
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    items,
  };
}

export async function getWorkflowVersion(
  identity: DevIdentity,
  workflowId: string,
  versionId: string,
): Promise<VersionClientSuccess | WorkflowClientFailure> {
  const path = workflowVersionPath(workflowId, versionId);
  const result = await callIdentityProxy<WorkflowVersion>(path, identity);
  if (!result.ok) {
    return failure(result);
  }
  if (!isWorkflowVersion(result.data)) {
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
    version: result.data,
  };
}

export async function exportWorkflowVersion(
  identity: DevIdentity,
  workflowId: string,
  versionId: string,
): Promise<ExportClientSuccess | WorkflowClientFailure> {
  const path = workflowExportPath(workflowId, versionId);
  const result = await callIdentityProxy<WorkflowExport>(path, identity);
  if (!result.ok) {
    return failure(result);
  }
  if (!isWorkflowExport(result.data)) {
    return malformed(
      result.requestId,
      result.statusCode,
      path,
      "Export payload was missing filename or definitionYaml.",
    );
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    exported: result.data,
  };
}

export async function compareWorkflow(
  identity: DevIdentity,
  workflowId: string,
  body: CompareWorkflowBody,
): Promise<CompareClientSuccess | WorkflowClientFailure> {
  const path = workflowComparePath(workflowId);
  const result = await callIdentityProxy<CompareWorkflowResult>(path, identity, {
    method: "POST",
    body,
  });
  if (!result.ok) {
    return failure(result);
  }
  if (!isCompareResult(result.data)) {
    return malformed(
      result.requestId,
      result.statusCode,
      path,
      "Compare returned a payload without equal/digestMatch/changes.",
    );
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    compare: result.data,
  };
}

export async function restoreWorkflowVersion(
  identity: DevIdentity,
  workflowId: string,
  versionId: string,
  body: RestoreDraftBody = {},
): Promise<DraftClientSuccess | WorkflowClientFailure> {
  const path = workflowRestorePath(workflowId, versionId);
  const result = await callIdentityProxy<WorkflowDetail>(path, identity, {
    method: "POST",
    body,
  });
  return detailResult(result, path);
}

export async function startWorkflowExecution(
  identity: DevIdentity,
  workflowId: string,
  workflowVersionId: string,
): Promise<ExecutionClientSuccess | WorkflowClientFailure> {
  const path = workflowExecutionsPath(workflowId);
  const body = executionStartBody(workflowVersionId);
  if (!body) {
    return malformed(
      "local-execution-16",
      400,
      path,
      "A published workflowVersionId is required. Drafts cannot be executed.",
    );
  }
  const result = await callIdentityProxy<WorkflowExecution>(path, identity, {
    method: "POST",
    body,
  });
  return executionResult(result, path);
}

export async function getWorkflowExecution(
  identity: DevIdentity,
  workflowId: string,
  executionId: string,
): Promise<ExecutionClientSuccess | WorkflowClientFailure> {
  const path = workflowExecutionPath(workflowId, executionId);
  const result = await callIdentityProxy<WorkflowExecution>(path, identity);
  return executionResult(result, path);
}

function detailResult(
  result: IdentityClientResult<WorkflowDetail>,
  instance: string,
): DraftClientSuccess | WorkflowClientFailure {
  if (!result.ok) {
    return failure(result);
  }
  if (!isWorkflowDraft(result.data.draft)) {
    return malformed(
      result.requestId,
      result.statusCode,
      instance,
      "Response was missing a draft with revision and definitionYaml.",
    );
  }
  const applied = applyDraftResponse(result.data.draft);
  if (!applied) {
    return malformed(
      result.requestId,
      result.statusCode,
      instance,
      "Draft response could not replace the editor buffer.",
    );
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    workflow: isWorkflowRecord(result.data.workflow)
      ? result.data.workflow
      : undefined,
    draft: result.data.draft,
    applied,
  };
}

function draftOnlyResult(
  result: IdentityClientResult<WorkflowDraft>,
  instance: string,
): DraftClientSuccess | WorkflowClientFailure {
  if (!result.ok) {
    return failure(result);
  }
  if (!isWorkflowDraft(result.data)) {
    return malformed(
      result.requestId,
      result.statusCode,
      instance,
      "Draft payload was missing revision or definitionYaml.",
    );
  }
  const applied = applyDraftResponse(result.data);
  if (!applied) {
    return malformed(
      result.requestId,
      result.statusCode,
      instance,
      "Draft response could not replace the editor buffer.",
    );
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    draft: result.data,
    applied,
  };
}

function executionResult(
  result: IdentityClientResult<WorkflowExecution>,
  instance: string,
): ExecutionClientSuccess | WorkflowClientFailure {
  if (!result.ok) {
    return failure(result);
  }
  const payload = readExecutionPayload(result.data);
  if (!isWorkflowExecution(payload)) {
    return malformed(
      result.requestId,
      result.statusCode,
      instance,
      "Execution payload was missing workflowVersionId or workflowDigest.",
    );
  }
  const pins = parseAuthorizedPins((payload as { pins?: unknown }).pins);
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    execution: { ...payload, pins },
  };
}
