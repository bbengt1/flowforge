import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { paletteCommands } from "./command-palette.ts";
import type { ProblemDetails } from "./problem.ts";
import {
  GROUP_CANNOT_APPROVE_DESCRIPTION,
  GROUP_CANNOT_APPROVE_LABEL,
  GROUP_MEMBER_INVALID_MESSAGE,
  GROUP_MEMBER_NOT_IN_WORKSPACE_MESSAGE,
  GROUP_NAME_INVALID_MESSAGE,
  GROUP_NAME_REQUIRED_MESSAGE,
  GROUP_NAME_TAKEN_MESSAGE,
  GROUP_NAME_TOO_LONG_MESSAGE,
  WORKSPACE_GROUPS_HREF,
  canManageWorkspaceGroups,
  groupDisplayNameClientError,
  groupDisplayNameLength,
  groupRenameIsNoOp,
  isWorkspaceGroupId,
  normalizeGroupDisplayName,
  readWorkspaceGroupDetail,
  readWorkspaceGroups,
  workspaceGroupApiPath,
  workspaceGroupApprovalNote,
  workspaceGroupCandidates,
  workspaceGroupDeleteImpact,
  workspaceGroupFieldError,
  workspaceGroupHref,
  workspaceGroupMemberApiPath,
  workspaceGroupMemberCountLabel,
  workspaceGroupMemberLabel,
  workspaceGroupMemberRemoveImpact,
  workspaceGroupMembersApiPath,
  workspaceGroupProblemTreatment,
} from "./workspace-groups.ts";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..", "..");

function source(relative: string): string {
  return readFileSync(join(webRoot, relative), "utf8");
}

const GROUP_ID = "3f1c2a4e-9d7b-4c1a-8e2f-0a1b2c3d4e5f";
const ADA = "88888888-8888-4888-8888-888888888888";
const BEA = "99999999-9999-4999-8999-999999999999";
const CAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function problem(
  status: number,
  code: string,
  errors?: { path: string; code: string; message: string }[],
): ProblemDetails {
  return {
    type: `urn:flowforge:problem:${code}`,
    title: "Problem",
    status,
    detail: "server sentence",
    instance: "/api/v1/workspace/groups",
    code,
    request_id: "req-1",
    ...(errors ? { errors } : {}),
  };
}

function member(id: string, status: string, displayName?: string) {
  return {
    user: {
      id,
      issuer: "https://flowforge.local",
      external_subject: `sub-${id.slice(0, 4)}`,
      status,
      ...(displayName === undefined ? {} : { display_name: displayName }),
    },
    roles: ["viewer"],
    permissions: ["workflow.view"],
  };
}

describe("workspace groups gating", () => {
  it("is admin-only, hidden while permissions are unknown, and never in embed", () => {
    assert.equal(canManageWorkspaceGroups(null), false);
    assert.equal(canManageWorkspaceGroups(undefined), false);
    assert.equal(canManageWorkspaceGroups([]), false);
    assert.equal(canManageWorkspaceGroups(["workflow.view", "approval.decide"]), false);
    // platform.administer alone is not the groups permission.
    assert.equal(canManageWorkspaceGroups(["platform.administer"]), false);
    assert.equal(canManageWorkspaceGroups(["workspace.administer"]), true);
    assert.equal(
      canManageWorkspaceGroups(["workspace.administer"], { embed: true }),
      false,
    );
  });

  it("adds a palette command for admins only, and never in embed", () => {
    const viewer = ["workflow.view"];
    const admin = [...viewer, "workspace.administer"];
    const ids = (perms: string[], embed = false) =>
      paletteCommands(perms, { embed }).map((item) => item.id);
    assert.equal(ids(viewer).includes("nav-groups"), false);
    assert.equal(ids(admin).includes("nav-groups"), true);
    assert.equal(ids(admin, true).includes("nav-groups"), false);
    const command = paletteCommands(admin).find((item) => item.id === "nav-groups");
    assert.deepEqual(command?.action, { type: "navigate", href: WORKSPACE_GROUPS_HREF });
  });

  it("links from Settings administration only when groups can be managed", () => {
    const links = source("src/components/settings/FoundationAdminLinks.tsx");
    assert.match(links, /canManageWorkspaceGroups\(permissions, \{ embed \}\)/);
    assert.match(links, /WORKSPACE_GROUPS_HREF/);
    const palette = source("src/components/shell/CommandPalette.tsx");
    assert.match(palette, /paletteCommands\(permissions, \{ workflowId, executionId, embed \}\)/);
  });

  it("builds web and API paths with encoded ids", () => {
    assert.equal(workspaceGroupHref(GROUP_ID), `/groups/${GROUP_ID}`);
    assert.equal(workspaceGroupApiPath(GROUP_ID), `/workspace/groups/${GROUP_ID}`);
    assert.equal(
      workspaceGroupMembersApiPath(GROUP_ID),
      `/workspace/groups/${GROUP_ID}/members`,
    );
    assert.equal(
      workspaceGroupMemberApiPath(GROUP_ID, ADA),
      `/workspace/groups/${GROUP_ID}/members/${ADA}`,
    );
    assert.equal(workspaceGroupHref("a/b"), "/groups/a%2Fb");
    assert.equal(isWorkspaceGroupId(GROUP_ID), true);
    assert.equal(isWorkspaceGroupId("not-a-uuid"), false);
    assert.equal(isWorkspaceGroupId(undefined), false);
  });
});

describe("workspace group names", () => {
  it("trims and checks 1-128 code points as a client hint", () => {
    assert.equal(normalizeGroupDisplayName("  Release managers  "), "Release managers");
    assert.equal(groupDisplayNameClientError(""), GROUP_NAME_REQUIRED_MESSAGE);
    assert.equal(groupDisplayNameClientError("   "), GROUP_NAME_REQUIRED_MESSAGE);
    assert.equal(groupDisplayNameClientError("a".repeat(128)), null);
    assert.equal(groupDisplayNameClientError(` ${"a".repeat(128)} `), null);
    assert.equal(groupDisplayNameClientError("a".repeat(129)), GROUP_NAME_TOO_LONG_MESSAGE);
    // Astral characters count once each, like the API's rune count.
    const emoji = "😀".repeat(128);
    assert.equal(groupDisplayNameLength(emoji), 128);
    assert.equal(groupDisplayNameClientError(emoji), null);
  });
});

describe("workspace group rename comparison", () => {
  it("treats only an exact trimmed match as unchanged; case-only is a real rename", () => {
    assert.equal(groupRenameIsNoOp("Ops", "Ops"), true);
    assert.equal(groupRenameIsNoOp("Ops", "  Ops "), true);
    assert.equal(groupRenameIsNoOp("Ops", "OPS"), false);
    assert.equal(groupRenameIsNoOp("Ops", "ops"), false);
    assert.equal(groupRenameIsNoOp("Ops", " oPs "), false);
    assert.equal(groupRenameIsNoOp("Ops", "Ops team"), false);
    assert.equal(groupRenameIsNoOp("Ops", ""), false);
  });

  it("wires the dialog to the exact comparison, not a case-folded one", () => {
    const dialog = source("src/components/groups/GroupNameDialog.tsx");
    assert.match(dialog, /groupRenameIsNoOp\(initialName, name\)/);
    assert.doesNotMatch(dialog, /toLowerCase|toUpperCase|localeCompare/);
  });
});

describe("workspace group field errors", () => {
  it("places group_name_taken on displayName by path", () => {
    const taken = problem(409, "group_name_taken", [
      { path: "displayName", code: "group_name_taken", message: "dup" },
    ]);
    assert.equal(workspaceGroupFieldError(taken, "displayName"), GROUP_NAME_TAKEN_MESSAGE);
    assert.equal(workspaceGroupFieldError(taken, "userId"), null);
  });

  it("places an invalid name on displayName", () => {
    const invalid = problem(400, "invalid-request", [
      { path: "displayName", code: "invalid-request", message: "too long" },
    ]);
    assert.equal(
      workspaceGroupFieldError(invalid, "displayName"),
      GROUP_NAME_INVALID_MESSAGE,
    );
  });

  it("places member errors on userId and picks the sentence by code", () => {
    const notMember = problem(400, "group_member_not_in_workspace", [
      { path: "userId", code: "group_member_not_in_workspace", message: "x" },
    ]);
    assert.equal(
      workspaceGroupFieldError(notMember, "userId"),
      GROUP_MEMBER_NOT_IN_WORKSPACE_MESSAGE,
    );
    const notUuid = problem(400, "invalid-request", [
      { path: "userId", code: "invalid-request", message: "userId must be a UUID." },
    ]);
    assert.equal(workspaceGroupFieldError(notUuid, "userId"), GROUP_MEMBER_INVALID_MESSAGE);
    assert.equal(workspaceGroupFieldError(notUuid, "displayName"), null);
  });

  it("keeps pathless and non-field problems in the banner", () => {
    // A code without its path is not a field error.
    assert.equal(
      workspaceGroupFieldError(problem(409, "group_name_taken"), "displayName"),
      null,
    );
    assert.equal(
      workspaceGroupFieldError(problem(400, "invalid-request"), "userId"),
      null,
    );
    // 403 and 404 never land on a field, even with a path.
    assert.equal(
      workspaceGroupFieldError(
        problem(403, "forbidden", [{ path: "displayName", code: "forbidden", message: "x" }]),
        "displayName",
      ),
      null,
    );
    assert.equal(workspaceGroupFieldError(null, "displayName"), null);
  });

  it("never matches message text", () => {
    const misleading = problem(400, "invalid-request", [
      { path: "other", code: "invalid-request", message: "displayName userId" },
    ]);
    assert.equal(workspaceGroupFieldError(misleading, "displayName"), null);
    assert.equal(workspaceGroupFieldError(misleading, "userId"), null);
  });

  it("maps 404 to not-found and 401/403 to forbidden", () => {
    assert.equal(workspaceGroupProblemTreatment(problem(404, "not-found")), "not-found");
    assert.equal(workspaceGroupProblemTreatment(problem(403, "forbidden")), "forbidden");
    assert.equal(workspaceGroupProblemTreatment(problem(401, "unauthenticated")), "forbidden");
    assert.equal(workspaceGroupProblemTreatment(problem(500, "internal")), "banner");
    assert.equal(workspaceGroupProblemTreatment(null), null);
  });
});

describe("workspace group responses", () => {
  it("reads list items and drops rows without a UUID id", () => {
    const groups = readWorkspaceGroups({
      items: [
        {
          id: GROUP_ID,
          displayName: "Release managers",
          memberCount: 2,
          createdAt: "2026-10-01T00:00:00Z",
          updatedAt: "2026-10-01T00:00:00Z",
        },
        { id: "nope", displayName: "Bad" },
        { id: CAL, displayName: "No count" },
      ],
      limit: 50,
      cursor: "",
      next: "",
    });
    assert.equal(groups.length, 2);
    assert.equal(groups[0]?.memberCount, 2);
    assert.equal(groups[1]?.memberCount, 0);
  });

  it("only an explicit canApprove true counts", () => {
    const detail = readWorkspaceGroupDetail({
      id: GROUP_ID,
      displayName: "Release managers",
      memberCount: 4,
      createdAt: "",
      updatedAt: "",
      members: [
        { userId: ADA, displayName: "Ada", canApprove: true },
        { userId: BEA, displayName: "Bea", canApprove: false },
        { userId: CAL, displayName: "Cal" },
        { userId: DEE, displayName: "Dee", canApprove: "true" },
        { userId: "not-a-user", displayName: "Bad", canApprove: true },
      ],
    });
    assert.ok(detail);
    assert.deepEqual(
      detail.members.map((item) => [item.userId, item.canApprove]),
      [
        [ADA, true],
        [BEA, false],
        [CAL, false],
        [DEE, false],
      ],
    );
    assert.equal(readWorkspaceGroupDetail({ id: "x" }), null);
  });
});

describe("workspace group approval note", () => {
  it("shows a plain note only when the server says the member can't approve", () => {
    assert.equal(workspaceGroupApprovalNote({ canApprove: true }), null);
    const note = workspaceGroupApprovalNote({ canApprove: false });
    assert.deepEqual(note, {
      label: GROUP_CANNOT_APPROVE_LABEL,
      description: GROUP_CANNOT_APPROVE_DESCRIPTION,
    });
    assert.equal(GROUP_CANNOT_APPROVE_LABEL, "Can't approve");
  });

  it("uses plain wording with no permission keys, issue numbers, or roles math", () => {
    for (const text of [GROUP_CANNOT_APPROVE_LABEL, GROUP_CANNOT_APPROVE_DESCRIPTION]) {
      assert.doesNotMatch(text, /#\d|approval\.decide|workspace\.administer|canApprove/);
    }
    const detail = source("src/components/groups/WorkspaceGroupDetail.tsx");
    // The web reads canApprove; it never derives it from roles or permissions.
    assert.doesNotMatch(detail, /approval\.decide/);
    assert.doesNotMatch(detail, /\.roles\b/);
  });
});

describe("workspace group member picker", () => {
  it("keeps active members not already in the group, once each, in server order", () => {
    const candidates = workspaceGroupCandidates(
      [
        member(ADA, "active", "Ada"),
        member(BEA, "disabled", "Bea"),
        member(CAL, "active", ""),
        member(DEE, "active", "Dee"),
        member(DEE, "active", "Dee again"),
        member("not-a-uuid", "active", "Bad"),
      ],
      [ADA],
    );
    assert.deepEqual(candidates, [
      { userId: CAL, label: CAL },
      { userId: DEE, label: "Dee" },
    ]);
  });

  it("returns nothing when everyone active is already a member", () => {
    assert.deepEqual(
      workspaceGroupCandidates([member(ADA, "active", "Ada"), member(BEA, "invited")], [ADA]),
      [],
    );
  });

  it("labels by display name, then user id, never email", () => {
    assert.equal(workspaceGroupMemberLabel({ displayName: " Ada ", userId: ADA }), "Ada");
    assert.equal(workspaceGroupMemberLabel({ displayName: "", userId: ADA }), ADA);
  });
});

describe("workspace group destructive impact", () => {
  it("names the group and member count on delete", () => {
    assert.deepEqual(workspaceGroupDeleteImpact({ displayName: "Ops", memberCount: 1 }), [
      { id: "group", label: "Group", detail: "Ops" },
      { id: "members", label: "Member list", detail: "1 member" },
    ]);
    assert.equal(workspaceGroupMemberCountLabel(0), "0 members");
    assert.equal(workspaceGroupMemberCountLabel(3), "3 members");
  });

  it("names the member and group on remove", () => {
    assert.deepEqual(
      workspaceGroupMemberRemoveImpact({
        groupName: "Ops",
        member: { displayName: "", userId: ADA },
      }),
      [
        { id: "member", label: "Member", detail: ADA },
        { id: "group", label: "Group", detail: "Ops" },
      ],
    );
  });
});
