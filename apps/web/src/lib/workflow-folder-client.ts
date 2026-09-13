/**
 * F.2 folder list client. GET only — create / rename / delete / move
 * stay F.3 / F.4. Cookie session; no host-supplied workspaceId.
 */

import { callIdentityProxy } from "./identity-client.ts";
import type { DevIdentity } from "./identity-headers.ts";
import type { ProblemDetails } from "./problem.ts";
import type { WorkflowFieldError } from "./workflow-types.ts";
import {
  WORKFLOW_FOLDERS_PATH,
  isWorkflowFolder,
  type WorkflowFolder,
  type WorkflowFolderList,
} from "./workflow-folder.ts";

export type ListWorkflowFoldersSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  items: WorkflowFolder[];
};

export type WorkflowFolderClientFailure = {
  ok: false;
  statusCode: number;
  requestId: string;
  problem: ProblemDetails;
  errors: WorkflowFieldError[];
  conflict: boolean;
};

function failure(
  result: Extract<
    Awaited<ReturnType<typeof callIdentityProxy<WorkflowFolderList>>>,
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
