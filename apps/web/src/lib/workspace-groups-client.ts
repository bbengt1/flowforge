/**
 * Workspace groups client. Cookie session + X-CSRF-Token on writes via
 * the same-origin identity proxy. Bodies carry only `displayName` or
 * `userId`; the workspace is server-derived and never sent.
 */

import {
  openCollectionPath,
  readCollectionPageFields,
  scrubCollectionPageProblem,
  type CollectionPageQuery,
} from "./collection-page.ts";
import { callIdentityProxy } from "./identity-client.ts";
import type { DevIdentity } from "./identity-headers.ts";
import type { ItemList, Member } from "./identity-types.ts";
import type { ProblemDetails } from "./problem.ts";
import type { ScimGroupsMode } from "./scim-tokens.ts";
import {
  WORKSPACE_GROUPS_API_PATH,
  normalizeGroupDisplayName,
  readWorkspaceGroup,
  readWorkspaceGroupDetail,
  readWorkspaceGroups,
  readWorkspaceGroupsMode,
  workspaceGroupApiPath,
  workspaceGroupMemberApiPath,
  workspaceGroupMembersApiPath,
  type WorkspaceGroup,
  type WorkspaceGroupDetail,
} from "./workspace-groups.ts";

export const WORKSPACE_MEMBERS_API_PATH = "/workspace/members";

export type WorkspaceGroupsFailure = {
  ok: false;
  statusCode: number;
  requestId: string;
  problem: ProblemDetails;
};

export type WorkspaceGroupsPage = {
  ok: true;
  requestId: string;
  items: WorkspaceGroup[];
  next: string;
  /** The page's top-level SCIM Groups mode. Null when missing or unknown. */
  groupsMode: ScimGroupsMode | null;
};

export type WorkspaceGroupDetailResult = {
  ok: true;
  requestId: string;
  group: WorkspaceGroupDetail;
};

export type WorkspaceGroupWriteResult = {
  ok: true;
  requestId: string;
  group: WorkspaceGroup | null;
};

export type WorkspaceGroupNoContentResult = {
  ok: true;
  requestId: string;
};

export type WorkspaceMembersPage = {
  ok: true;
  requestId: string;
  items: Member[];
  next: string;
};

function failed(result: {
  statusCode: number;
  requestId: string;
  problem: ProblemDetails;
}): WorkspaceGroupsFailure {
  return {
    ok: false,
    statusCode: result.statusCode,
    requestId: result.requestId,
    problem: result.problem,
  };
}

function openFailure(problem: ProblemDetails): WorkspaceGroupsFailure {
  return {
    ok: false,
    statusCode: problem.status,
    requestId: problem.request_id,
    problem,
  };
}

export async function listWorkspaceGroups(
  identity: DevIdentity,
  query: CollectionPageQuery = {},
): Promise<WorkspaceGroupsPage | WorkspaceGroupsFailure> {
  const opened = openCollectionPath(WORKSPACE_GROUPS_API_PATH, query);
  if (!opened.ok) {
    return openFailure(opened.problem);
  }
  const result = await callIdentityProxy<unknown>(opened.path, identity);
  if (!result.ok) {
    const failure = failed(result);
    if (failure.statusCode === 400) {
      failure.problem = scrubCollectionPageProblem(failure.problem);
    }
    return failure;
  }
  return {
    ok: true,
    requestId: result.requestId,
    items: readWorkspaceGroups(result.data),
    next: readCollectionPageFields(result.data).next,
    groupsMode: readWorkspaceGroupsMode(result.data),
  };
}

export async function getWorkspaceGroup(
  identity: DevIdentity,
  groupId: string,
): Promise<WorkspaceGroupDetailResult | WorkspaceGroupsFailure> {
  const result = await callIdentityProxy<unknown>(workspaceGroupApiPath(groupId), identity);
  if (!result.ok) {
    return failed(result);
  }
  const group = readWorkspaceGroupDetail(result.data);
  if (!group) {
    return failed({
      statusCode: 502,
      requestId: result.requestId,
      problem: {
        type: "urn:flowforge:problem:upstream-error",
        title: "Upstream Error",
        status: 502,
        detail: "The control plane returned a group the web could not read.",
        instance: workspaceGroupApiPath(groupId),
        code: "upstream-error",
        request_id: result.requestId,
      },
    });
  }
  return { ok: true, requestId: result.requestId, group };
}

export async function createWorkspaceGroup(
  identity: DevIdentity,
  displayName: string,
): Promise<WorkspaceGroupWriteResult | WorkspaceGroupsFailure> {
  const result = await callIdentityProxy<unknown>(WORKSPACE_GROUPS_API_PATH, identity, {
    method: "POST",
    body: { displayName: normalizeGroupDisplayName(displayName) },
  });
  if (!result.ok) {
    return failed(result);
  }
  return { ok: true, requestId: result.requestId, group: readWorkspaceGroup(result.data) };
}

export async function renameWorkspaceGroup(
  identity: DevIdentity,
  groupId: string,
  displayName: string,
): Promise<WorkspaceGroupWriteResult | WorkspaceGroupsFailure> {
  const result = await callIdentityProxy<unknown>(workspaceGroupApiPath(groupId), identity, {
    method: "PATCH",
    body: { displayName: normalizeGroupDisplayName(displayName) },
  });
  if (!result.ok) {
    return failed(result);
  }
  return { ok: true, requestId: result.requestId, group: readWorkspaceGroup(result.data) };
}

export async function deleteWorkspaceGroup(
  identity: DevIdentity,
  groupId: string,
): Promise<WorkspaceGroupNoContentResult | WorkspaceGroupsFailure> {
  const result = await callIdentityProxy<unknown>(workspaceGroupApiPath(groupId), identity, {
    method: "DELETE",
  });
  if (!result.ok) {
    return failed(result);
  }
  return { ok: true, requestId: result.requestId };
}

/** Idempotent: adding someone already in the group is also 204. */
export async function addWorkspaceGroupMember(
  identity: DevIdentity,
  groupId: string,
  userId: string,
): Promise<WorkspaceGroupNoContentResult | WorkspaceGroupsFailure> {
  const result = await callIdentityProxy<unknown>(
    workspaceGroupMembersApiPath(groupId),
    identity,
    { method: "POST", body: { userId } },
  );
  if (!result.ok) {
    return failed(result);
  }
  return { ok: true, requestId: result.requestId };
}

/** Idempotent: removing someone not in the group is also 204. */
export async function removeWorkspaceGroupMember(
  identity: DevIdentity,
  groupId: string,
  userId: string,
): Promise<WorkspaceGroupNoContentResult | WorkspaceGroupsFailure> {
  const result = await callIdentityProxy<unknown>(
    workspaceGroupMemberApiPath(groupId, userId),
    identity,
    { method: "DELETE" },
  );
  if (!result.ok) {
    return failed(result);
  }
  return { ok: true, requestId: result.requestId };
}

/** One page of the admin-only members list, for the add-member picker. */
export async function listWorkspaceMembersPage(
  identity: DevIdentity,
  cursor = "",
): Promise<WorkspaceMembersPage | WorkspaceGroupsFailure> {
  const opened = openCollectionPath(WORKSPACE_MEMBERS_API_PATH, {
    limit: 100,
    cursor,
  });
  if (!opened.ok) {
    return openFailure(opened.problem);
  }
  const result = await callIdentityProxy<ItemList<Member>>(opened.path, identity);
  if (!result.ok) {
    return failed(result);
  }
  const items = Array.isArray(result.data?.items) ? result.data.items : [];
  return {
    ok: true,
    requestId: result.requestId,
    items,
    next: readCollectionPageFields(result.data).next,
  };
}
