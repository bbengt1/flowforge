/**
 * Workspace groups admin (web side of the groups API).
 *
 * Groups collect workspace members so approvals can be targeted at
 * them. A group never grants a permission. `canApprove` on a member
 * row is computed by the server from the member's status and roles;
 * the web only reads it and never derives it from roles.
 *
 * All routes are under `/api/v1/workspace/groups` and need
 * `workspace.administer`. Embed sessions are refused by the API, so
 * the web hides the surface on `/embed/v1` and never calls it there.
 * Field errors are placed by `errors[].path` only, never by message
 * text; the code only picks the sentence.
 */

import { sanitizeDestructiveImpact, type DestructiveImpactItem } from "./confirm-destructive.ts";
import { isResourceId } from "./identity-proxy-ids.ts";
import type { Member } from "./identity-types.ts";
import type { ProblemDetails } from "./problem.ts";
import { WORKSPACE_ADMIN_PERMISSION } from "./workspace-nav.ts";

export const WORKSPACE_GROUPS_API_PATH = "/workspace/groups";
export const WORKSPACE_GROUPS_HREF = "/groups";

export const GROUP_NAME_MAX_CHARS = 128;

export const GROUP_NAME_TAKEN_CODE = "group_name_taken";
export const GROUP_MEMBER_NOT_IN_WORKSPACE_CODE = "group_member_not_in_workspace";

export type WorkspaceGroup = {
  id: string;
  displayName: string;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceGroupMember = {
  userId: string;
  displayName: string;
  canApprove: boolean;
};

export type WorkspaceGroupDetail = WorkspaceGroup & {
  members: WorkspaceGroupMember[];
};

export type WorkspaceGroupField = "displayName" | "userId";

/* ---------- copy ---------- */

export const WORKSPACE_GROUPS_TITLE = "Workspace groups";

export const WORKSPACE_GROUPS_HELP =
  "Groups collect workspace members so approvals can be sent to them. A group never grants a permission. Whether someone can decide an approval still comes from their roles.";

export const WORKSPACE_GROUPS_LINK_HELP =
  "Name sets of members that approvals can be sent to. Groups never grant permissions.";

export const WORKSPACE_GROUPS_EMPTY_HEADING = "No groups yet";

export const WORKSPACE_GROUPS_EMPTY_HELP =
  "Create a group, then add the members who should receive approvals.";

export const WORKSPACE_GROUP_MEMBERS_EMPTY =
  "No members yet. Add workspace members who should receive approvals sent to this group.";

export const WORKSPACE_GROUPS_FORBIDDEN =
  "Only workspace administrators can manage groups.";

export const WORKSPACE_GROUPS_EMBED_UNAVAILABLE =
  "Groups are managed in the full FlowForge app. They are not available in an embedded view.";

export const GROUP_NAME_LABEL = "Group name";

export const GROUP_NAME_HINT =
  "1 to 128 characters. Spaces at the start and end are removed. Names are unique in this workspace, ignoring case.";

export const GROUP_NAME_REQUIRED_MESSAGE = "Enter a group name.";

export const GROUP_NAME_TOO_LONG_MESSAGE = `Use ${GROUP_NAME_MAX_CHARS} characters or fewer.`;

export const GROUP_NAME_TAKEN_MESSAGE =
  "Another group already uses this name. Names are compared without regard to case.";

export const GROUP_NAME_INVALID_MESSAGE =
  "This name can't be used. Enter 1 to 128 characters without control characters.";

export const GROUP_MEMBER_LABEL = "Member";

export const GROUP_MEMBER_HINT =
  "Only active workspace members who are not already in this group are listed.";

export const GROUP_MEMBER_NOT_IN_WORKSPACE_MESSAGE =
  "This person isn't an active member of this workspace anymore. Refresh the list and pick someone else.";

export const GROUP_MEMBER_INVALID_MESSAGE = "Pick a member from the list.";

export const GROUP_MEMBER_PICKER_EMPTY =
  "Everyone active in this workspace is already in this group.";

export const GROUP_MEMBER_PICKER_MORE =
  "More workspace members may be on the next page.";

export const GROUP_CANNOT_APPROVE_LABEL = "Can't approve";

export const GROUP_CANNOT_APPROVE_DESCRIPTION =
  "This person won't be able to approve or reject requests sent to this group. Their roles don't allow deciding approvals, or their account isn't active. Being in a group doesn't change that.";

export const GROUP_DELETE_DESCRIPTION =
  "This deletes the group and its member list. People stay in the workspace with the same roles. Approvals that name this group will reach nobody through it.";

export const GROUP_MEMBER_REMOVE_DESCRIPTION =
  "This removes the person from this group only. They stay in the workspace with the same roles.";

/* ---------- gating ---------- */

/**
 * Admin-only and never in embed. Unknown permissions (null) hide the
 * surface so it never flashes for a non-admin.
 */
export function canManageWorkspaceGroups(
  permissions: readonly string[] | null | undefined,
  options: { embed?: boolean } = {},
): boolean {
  if (options.embed) {
    return false;
  }
  if (permissions == null) {
    return false;
  }
  return permissions.includes(WORKSPACE_ADMIN_PERMISSION);
}

export function workspaceGroupHref(groupId: string): string {
  return `${WORKSPACE_GROUPS_HREF}/${encodeURIComponent(groupId)}`;
}

export function workspaceGroupApiPath(groupId: string): string {
  return `${WORKSPACE_GROUPS_API_PATH}/${encodeURIComponent(groupId)}`;
}

export function workspaceGroupMembersApiPath(groupId: string): string {
  return `${workspaceGroupApiPath(groupId)}/members`;
}

export function workspaceGroupMemberApiPath(groupId: string, userId: string): string {
  return `${workspaceGroupMembersApiPath(groupId)}/${encodeURIComponent(userId)}`;
}

/** A path segment that is not a UUID can never name a group. */
export function isWorkspaceGroupId(value: string | undefined): boolean {
  return isResourceId(value);
}

/* ---------- reading responses ---------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function readWorkspaceGroup(value: unknown): WorkspaceGroup | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.id !== "string" || !isResourceId(value.id)) {
    return null;
  }
  if (typeof value.displayName !== "string") {
    return null;
  }
  const count =
    typeof value.memberCount === "number" &&
    Number.isSafeInteger(value.memberCount) &&
    value.memberCount >= 0
      ? value.memberCount
      : 0;
  return {
    id: value.id,
    displayName: value.displayName,
    memberCount: count,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
  };
}

/**
 * Only an explicit `canApprove: true` counts. A missing or malformed
 * flag reads as false, so the web never claims someone can approve.
 */
export function readWorkspaceGroupMember(value: unknown): WorkspaceGroupMember | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.userId !== "string" || !isResourceId(value.userId)) {
    return null;
  }
  return {
    userId: value.userId,
    displayName: typeof value.displayName === "string" ? value.displayName : "",
    canApprove: value.canApprove === true,
  };
}

export function readWorkspaceGroupDetail(value: unknown): WorkspaceGroupDetail | null {
  const group = readWorkspaceGroup(value);
  if (!group || !isRecord(value)) {
    return null;
  }
  const rawMembers = Array.isArray(value.members) ? value.members : [];
  const members: WorkspaceGroupMember[] = [];
  for (const raw of rawMembers) {
    const member = readWorkspaceGroupMember(raw);
    if (member) {
      members.push(member);
    }
  }
  return { ...group, members };
}

export function readWorkspaceGroups(value: unknown): WorkspaceGroup[] {
  const raw = isRecord(value) && Array.isArray(value.items) ? value.items : [];
  const out: WorkspaceGroup[] = [];
  for (const item of raw) {
    const group = readWorkspaceGroup(item);
    if (group) {
      out.push(group);
    }
  }
  return out;
}

/* ---------- names ---------- */

export function normalizeGroupDisplayName(raw: string): string {
  return raw.trim();
}

/** Code points, the same count the API uses for the 128 limit. */
export function groupDisplayNameLength(name: string): number {
  return [...name].length;
}

/** Client-side hint only. The server stays the authority. */
export function groupDisplayNameClientError(raw: string): string | null {
  const name = normalizeGroupDisplayName(raw);
  if (!name) {
    return GROUP_NAME_REQUIRED_MESSAGE;
  }
  if (groupDisplayNameLength(name) > GROUP_NAME_MAX_CHARS) {
    return GROUP_NAME_TOO_LONG_MESSAGE;
  }
  return null;
}

/**
 * A rename is skipped only when the trimmed new name is exactly the
 * current name. A case-only change ("Ops" to "OPS") is a real rename:
 * the API saves and audits it, so the web must send it.
 */
export function groupRenameIsNoOp(currentName: string, nextRaw: string): boolean {
  return normalizeGroupDisplayName(nextRaw) === currentName;
}

/* ---------- problems ---------- */

function problemHasPath(
  problem: Pick<ProblemDetails, "errors">,
  field: WorkspaceGroupField,
): { code?: string } | null {
  for (const error of problem.errors ?? []) {
    if (error && error.path === field) {
      return error;
    }
  }
  return null;
}

/**
 * Sentence for the field named by `errors[].path`, or null when the
 * problem stays in the banner. Only 400 and 409 land on a field.
 */
export function workspaceGroupFieldError(
  problem: Pick<ProblemDetails, "status" | "code" | "errors"> | null | undefined,
  field: WorkspaceGroupField,
): string | null {
  if (!problem) {
    return null;
  }
  if (problem.status !== 400 && problem.status !== 409) {
    return null;
  }
  const hit = problemHasPath(problem, field);
  if (!hit) {
    return null;
  }
  const code = hit.code || problem.code;
  if (field === "displayName") {
    if (problem.status === 409 || code === GROUP_NAME_TAKEN_CODE) {
      return GROUP_NAME_TAKEN_MESSAGE;
    }
    return GROUP_NAME_INVALID_MESSAGE;
  }
  if (code === GROUP_MEMBER_NOT_IN_WORKSPACE_CODE) {
    return GROUP_MEMBER_NOT_IN_WORKSPACE_MESSAGE;
  }
  return GROUP_MEMBER_INVALID_MESSAGE;
}

export type WorkspaceGroupProblemTreatment = "not-found" | "forbidden" | "banner";

/**
 * 404 (missing, another workspace's, or a malformed id) uses the
 * not-found boundary. 401/403 use the forbidden treatment.
 */
export function workspaceGroupProblemTreatment(
  problem: Pick<ProblemDetails, "status" | "code"> | null | undefined,
): WorkspaceGroupProblemTreatment | null {
  if (!problem) {
    return null;
  }
  if (problem.status === 404) {
    return "not-found";
  }
  if (problem.status === 401 || problem.status === 403 || problem.code === "forbidden") {
    return "forbidden";
  }
  return "banner";
}

/* ---------- members ---------- */

/** Member row label. Never an email; display name, then the user id. */
export function workspaceGroupMemberLabel(member: {
  displayName?: string;
  userId: string;
}): string {
  const name = member.displayName?.trim() ?? "";
  return name || member.userId;
}

export type WorkspaceGroupApprovalNote = {
  label: string;
  description: string;
};

/** Plain note for a member who can't decide approvals. Null when they can. */
export function workspaceGroupApprovalNote(
  member: Pick<WorkspaceGroupMember, "canApprove">,
): WorkspaceGroupApprovalNote | null {
  if (member.canApprove === true) {
    return null;
  }
  return {
    label: GROUP_CANNOT_APPROVE_LABEL,
    description: GROUP_CANNOT_APPROVE_DESCRIPTION,
  };
}

export type WorkspaceGroupCandidate = {
  userId: string;
  label: string;
};

/**
 * Picker rows from `GET /workspace/members` pages: active users who are
 * not already in the group, once each, in server order. Roles are not
 * read. The server still refuses anyone it does not consider eligible.
 */
export function workspaceGroupCandidates(
  members: readonly Pick<Member, "user">[],
  existingUserIds: Iterable<string>,
): WorkspaceGroupCandidate[] {
  const skip = new Set(existingUserIds);
  const out: WorkspaceGroupCandidate[] = [];
  for (const member of members) {
    const user = member?.user;
    if (!user || typeof user.id !== "string" || !isResourceId(user.id)) {
      continue;
    }
    if (user.status !== "active") {
      continue;
    }
    if (skip.has(user.id)) {
      continue;
    }
    skip.add(user.id);
    out.push({
      userId: user.id,
      label: workspaceGroupMemberLabel({
        displayName: user.display_name,
        userId: user.id,
      }),
    });
  }
  return out;
}

export function workspaceGroupMemberCountLabel(count: number): string {
  return count === 1 ? "1 member" : `${count} members`;
}

/* ---------- destructive impact ---------- */

export function workspaceGroupDeleteImpact(group: {
  displayName: string;
  memberCount: number;
}): DestructiveImpactItem[] {
  return sanitizeDestructiveImpact([
    { id: "group", label: "Group", detail: group.displayName },
    {
      id: "members",
      label: "Member list",
      detail: workspaceGroupMemberCountLabel(group.memberCount),
    },
  ]);
}

export function workspaceGroupMemberRemoveImpact(input: {
  groupName: string;
  member: Pick<WorkspaceGroupMember, "displayName" | "userId">;
}): DestructiveImpactItem[] {
  return sanitizeDestructiveImpact([
    { id: "member", label: "Member", detail: workspaceGroupMemberLabel(input.member) },
    { id: "group", label: "Group", detail: input.groupName },
  ]);
}
