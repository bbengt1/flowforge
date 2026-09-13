/**
 * F.2 list + F.3 create / rename / delete folder client.
 * Cookie session + X-CSRF-Token on POST / PATCH / DELETE.
 * workspaceId is server-derived — never sent from the browser.
 * Rename is name-only. Workflow move lives in workflow-client.ts (F.4).
 * Folder re-parent is not this client.
 */

import { callIdentityProxy } from "./identity-client.ts";
import type { DevIdentity } from "./identity-headers.ts";
import type { ProblemDetails } from "./problem.ts";
import type { WorkflowFieldError } from "./workflow-types.ts";
import {
  WORKFLOW_FOLDERS_PATH,
  folderNotEmptyCounts,
  isWorkflowFolder,
  workflowFolderPath,
  type FolderNotEmptyCounts,
  type WorkflowFolder,
  type WorkflowFolderList,
} from "./workflow-folder.ts";

export type ListWorkflowFoldersSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  items: WorkflowFolder[];
};

export type WorkflowFolderWriteSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  folder: WorkflowFolder | null;
};

export type WorkflowFolderClientFailure = {
  ok: false;
  statusCode: number;
  requestId: string;
  problem: ProblemDetails;
  errors: WorkflowFieldError[];
  conflict: boolean;
  notEmpty: FolderNotEmptyCounts | null;
};

function failure(
  result: Extract<
    Awaited<ReturnType<typeof callIdentityProxy<unknown>>>,
    { ok: false }
  >,
): WorkflowFolderClientFailure {
  return {
    ok: false,
    statusCode: result.statusCode,
    requestId: result.requestId,
    problem: result.problem,
    errors: [],
    conflict: result.statusCode === 409,
    notEmpty: folderNotEmptyCounts(result.problem),
  };
}

export async function listWorkflowFolders(
  identity: DevIdentity,
): Promise<ListWorkflowFoldersSuccess | WorkflowFolderClientFailure> {
  const result = await callIdentityProxy<WorkflowFolderList>(
    WORKFLOW_FOLDERS_PATH,
    identity,
  );
  if (!result.ok) {
    return failure(result);
  }
  const items = Array.isArray(result.data.items)
    ? result.data.items.filter(isWorkflowFolder)
    : [];
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    items,
  };
}

export async function createWorkflowFolder(
  identity: DevIdentity,
  input: { name: string; parentId?: string | null },
): Promise<WorkflowFolderWriteSuccess | WorkflowFolderClientFailure> {
  const body: { name: string; parentId?: string } = { name: input.name };
  const parentId = input.parentId?.trim() ?? "";
  if (parentId) {
    body.parentId = parentId;
  }
  const result = await callIdentityProxy<unknown>(
    WORKFLOW_FOLDERS_PATH,
    identity,
    { method: "POST", body },
  );
  if (!result.ok) {
    return failure(result);
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    folder: isWorkflowFolder(result.data) ? result.data : null,
  };
}

export async function renameWorkflowFolder(
  identity: DevIdentity,
  folderId: string,
  name: string,
): Promise<WorkflowFolderWriteSuccess | WorkflowFolderClientFailure> {
  const result = await callIdentityProxy<unknown>(
    workflowFolderPath(folderId),
    identity,
    { method: "PATCH", body: { name } },
  );
  if (!result.ok) {
    return failure(result);
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    folder: isWorkflowFolder(result.data) ? result.data : null,
  };
}

export async function deleteWorkflowFolder(
  identity: DevIdentity,
  folderId: string,
): Promise<WorkflowFolderWriteSuccess | WorkflowFolderClientFailure> {
  const result = await callIdentityProxy<unknown>(
    workflowFolderPath(folderId),
    identity,
    { method: "DELETE" },
  );
  if (!result.ok) {
    return failure(result);
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    folder: null,
  };
}
