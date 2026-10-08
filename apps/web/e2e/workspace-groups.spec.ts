import { expect, test, type Page, type Route } from "@playwright/test";
import { expectNoBlockingAxeViolations } from "./axe";
import { expectNoSecretsInBrowserStorage, installOperatorApi } from "./operator-api";
import { ROUTE_NOT_FOUND_HEADING } from "../src/lib/route-boundary-chrome.ts";
import {
  GROUP_CANNOT_APPROVE_DESCRIPTION,
  GROUP_CANNOT_APPROVE_LABEL,
  GROUP_MEMBER_NOT_IN_WORKSPACE_MESSAGE,
  GROUP_NAME_TAKEN_MESSAGE,
  GROUP_SCIM_LOCKED_MESSAGE,
  GROUP_SCIM_MANAGED_DESCRIPTION,
  GROUP_SCIM_MANAGED_LABEL,
  GROUP_SCIM_MODE_UNKNOWN_DESCRIPTION,
  GROUP_SCIM_REFUSED_MESSAGE,
  GROUP_SCIM_SYNCED_BEFORE_LABEL,
  WORKSPACE_GROUPS_EMBED_UNAVAILABLE,
  WORKSPACE_GROUPS_EMPTY_HEADING,
  WORKSPACE_GROUPS_FORBIDDEN,
} from "../src/lib/workspace-groups.ts";

/**
 * Workspace groups admin against an in-memory stand-in for
 * /api/v1/workspace/groups. canApprove comes from the fixture (the
 * server); the page never derives it.
 */

const OPERATOR_PERMISSIONS = [
  "workflow.view",
  "workflow.edit",
  "workflow.publish",
  "workflow.execute",
  "credential.view",
  "execution.view",
  "approval.view",
] as const;
const ADMIN_PERMISSIONS = [...OPERATOR_PERMISSIONS, "workspace.administer"] as const;

const GROUP_ID = "c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0";
const NEW_GROUP_ID = "d0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d0d0";
const MISSING_GROUP_ID = "e0e0e0e0-e0e0-4e0e-8e0e-e0e0e0e0e0e0";
const ADA = "88888888-8888-4888-8888-888888888888";
const BEA = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";
const CAL = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
const DEE = "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1";
const EVE = "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1";

type Person = { id: string; name: string; status: string; canApprove: boolean };

const PEOPLE: Record<string, Person> = {
  [ADA]: { id: ADA, name: "Ada Operator", status: "active", canApprove: true },
  [BEA]: { id: BEA, name: "Bea Disabled", status: "disabled", canApprove: false },
  [CAL]: { id: CAL, name: "Cal Viewer", status: "active", canApprove: false },
  [DEE]: { id: DEE, name: "Dee Removed", status: "active", canApprove: false },
  [EVE]: { id: EVE, name: "Eve Inactive", status: "disabled", canApprove: false },
};

type StoredGroup = {
  id: string;
  displayName: string;
  members: string[];
  managedBy?: "scim" | null;
};

/**
 * What the group list (top level) and detail (group object) report as
 * `groupsMode`: a mode, or nothing at all (an older server).
 */
type ReportedMode = "workspaces" | "groups" | "omit";

type GroupsApi = {
  groups: Map<string, StoredGroup>;
  calls: string[];
  /** The instance mode the server enforces. Switchable mid-test. */
  enforce: "workspaces" | "groups";
  /** What the group list and detail report. Switchable mid-test. */
  report: ReportedMode;
};

const MANAGED_DETAIL = "This group is managed by SCIM. Change it in the identity provider.";

function problem(path: string, status: number, code: string, errorPath?: string) {
  return {
    type: `urn:flowforge:problem:${code}`,
    title: status === 409 ? "Conflict" : status === 404 ? "Not Found" : "Invalid Request",
    status,
    detail: "server sentence is not shown on the field",
    instance: `/api/v1${path}`,
    code,
    request_id: "e2e-groups",
    ...(errorPath ? { errors: [{ path: errorPath, code, message: "server message" }] } : {}),
  };
}

function groupBody(group: StoredGroup) {
  return {
    id: group.id,
    displayName: group.displayName,
    memberCount: group.members.length,
    managedBy: group.managedBy ?? null,
    createdAt: "2026-10-01T12:00:00.000Z",
    updatedAt: "2026-10-01T12:00:00.000Z",
  };
}

function modeField(report: ReportedMode): { groupsMode?: "workspaces" | "groups" } {
  return report === "omit" ? {} : { groupsMode: report };
}

function detailBody(group: StoredGroup, report: ReportedMode) {
  return {
    ...groupBody(group),
    ...modeField(report),
    members: group.members.map((id) => ({
      userId: id,
      displayName: PEOPLE[id]?.name ?? "",
      canApprove: PEOPLE[id]?.canApprove === true,
    })),
  };
}

function apiPath(url: string): string {
  return new URL(url).pathname.replace(/^\/api\/(?:v1|control-plane)/, "");
}

function readBody(route: Route): Record<string, unknown> {
  const raw = route.request().postData();
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

async function send(route: Route, status: number, body?: unknown): Promise<void> {
  if (status === 204) {
    await route.fulfill({ status: 204, body: "" });
    return;
  }
  const isProblem = status >= 400;
  await route.fulfill({
    status,
    contentType: isProblem ? "application/problem+json" : "application/json",
    body: JSON.stringify(body),
  });
}

async function installGroupsApi(
  page: Page,
  options: {
    seed?: StoredGroup[];
    permissions?: readonly string[];
    embed?: boolean;
    enforce?: "workspaces" | "groups";
    report?: ReportedMode;
  } = {},
): Promise<GroupsApi> {
  await installOperatorApi(page, {
    permissions: options.permissions ?? ADMIN_PERMISSIONS,
    embed: options.embed,
  });
  const api: GroupsApi = {
    groups: new Map((options.seed ?? []).map((group) => [group.id, { ...group, members: [...group.members] }])),
    calls: [],
    enforce: options.enforce ?? "workspaces",
    report: options.report ?? options.enforce ?? "workspaces",
  };
  // The groups screens read the mode from their own responses. Any call
  // here is recorded (and refused like an un-stepped-up admin) so a test
  // can prove the screens never make it.
  await page.route(/\/api\/(?:v1|control-plane)\/workspace\/scim-tokens/, async (route) => {
    const path = apiPath(route.request().url());
    api.calls.push(`${route.request().method()} ${path}`);
    await send(route, 403, {
      ...problem(path, 403, "mfa-required"),
      title: "Forbidden",
      detail: "Verify MFA before using this permission.",
    });
  });
  await page.route(/\/api\/(?:v1|control-plane)\/workspace\/(?:groups|members)/, async (route) => {
    const method = route.request().method();
    const path = apiPath(route.request().url());
    api.calls.push(`${method} ${path}`);
    if (path === "/workspace/members" && method === "GET") {
      await send(route, 200, {
        items: Object.values(PEOPLE).map((person) => ({
          user: {
            id: person.id,
            issuer: "https://flowforge.local",
            external_subject: person.name.toLowerCase().replace(/\s+/g, "-"),
            display_name: person.name,
            status: person.status,
          },
          roles: ["viewer"],
          permissions: ["workflow.view"],
        })),
        limit: 100,
        cursor: "",
        next: "",
      });
      return;
    }
    if (path === "/workspace/groups") {
      if (method === "GET") {
        const items = [...api.groups.values()]
          .sort((a, b) => a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()))
          .map(groupBody);
        await send(route, 200, {
          items,
          limit: 50,
          cursor: "",
          next: "",
          ...modeField(api.report),
        });
        return;
      }
      if (method === "POST") {
        const name = String(readBody(route).displayName ?? "").trim();
        const clash = [...api.groups.values()].some(
          (group) => group.displayName.toLowerCase() === name.toLowerCase(),
        );
        if (clash) {
          await send(route, 409, problem(path, 409, "group_name_taken", "displayName"));
          return;
        }
        const created = { id: NEW_GROUP_ID, displayName: name, members: [] };
        api.groups.set(created.id, created);
        await send(route, 201, groupBody(created));
        return;
      }
    }
    const match = path.match(/^\/workspace\/groups\/([^/]+)(?:\/members(?:\/([^/]+))?)?$/);
    const group = match ? api.groups.get(match[1] ?? "") : undefined;
    if (!match || !group) {
      await send(route, 404, problem(path, 404, "not-found"));
      return;
    }
    const isMembers = path.includes("/members");
    const userId = match[2];
    if (!isMembers && method === "GET") {
      await send(route, 200, detailBody(group, api.report));
      return;
    }
    if (group.managedBy === "scim" && api.enforce === "groups") {
      await send(route, 409, {
        ...problem(path, 409, "group_managed_by_scim"),
        detail: MANAGED_DETAIL,
      });
      return;
    }
    if (!isMembers && method === "PATCH") {
      group.displayName = String(readBody(route).displayName ?? "").trim();
      await send(route, 200, groupBody(group));
      return;
    }
    if (!isMembers && method === "DELETE") {
      api.groups.delete(group.id);
      await send(route, 204);
      return;
    }
    if (isMembers && !userId && method === "POST") {
      const id = String(readBody(route).userId ?? "");
      // Dee lost their role binding after the picker loaded.
      if (id === DEE || PEOPLE[id]?.status !== "active") {
        await send(route, 400, problem(path, 400, "group_member_not_in_workspace", "userId"));
        return;
      }
      if (!group.members.includes(id)) {
        group.members.push(id);
      }
      await send(route, 204);
      return;
    }
    if (isMembers && userId && method === "DELETE") {
      group.members = group.members.filter((item) => item !== userId);
      await send(route, 204);
      return;
    }
    await send(route, 405, problem(path, 405, "invalid-request"));
  });
  return api;
}

const RELEASE_GROUP: StoredGroup = {
  id: GROUP_ID,
  displayName: "Release managers",
  members: [ADA, BEA],
};

test.describe("workspace groups admin", () => {
  test("empty list teaches the model and is axe-clean", async ({ page }) => {
    await installGroupsApi(page);
    await page.goto("/groups");
    await expect(page.getByRole("heading", { level: 1, name: "Workspace groups" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: WORKSPACE_GROUPS_EMPTY_HEADING }),
    ).toBeVisible();
    await expect(page.locator("main")).toHaveCount(1);
    await expectNoBlockingAxeViolations(page);
    await expectNoSecretsInBrowserStorage(page);
  });

  test("create maps group_name_taken to the name field, then opens the new group", async ({
    page,
  }) => {
    const api = await installGroupsApi(page, { seed: [RELEASE_GROUP] });
    await page.goto("/groups");
    const row = page.locator(`[data-group-row='${GROUP_ID}']`);
    await expect(row).toContainText("Release managers");
    await expect(row).toContainText("2 members");
    await expectNoBlockingAxeViolations(page);

    await page.getByRole("button", { name: "Create group" }).click();
    const dialog = page.getByRole("dialog", { name: "Create group" });
    await expect(dialog).toBeVisible();
    const name = dialog.getByLabel("Group name");
    await expect(name).toBeFocused();
    await name.fill("  release MANAGERS ");
    await dialog.getByRole("button", { name: "Create group" }).click();
    await expect(page.locator("#group-display-name-error")).toHaveText(GROUP_NAME_TAKEN_MESSAGE);
    await expect(name).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByText("server sentence is not shown on the field")).toHaveCount(0);
    await expectNoBlockingAxeViolations(page);
    expect(api.calls).toContain("POST /workspace/groups");

    await name.fill("Deploy approvers");
    await expect(page.locator("#group-display-name-error")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Create group" }).click();
    await expect(page).toHaveURL(new RegExp(`/groups/${NEW_GROUP_ID}$`));
    await expect(
      page.getByRole("heading", { level: 1, name: "Deploy approvers" }),
    ).toBeVisible();
    await expect(page.locator("[data-group-members-empty]")).toBeVisible();
  });

  test("detail notes who can't approve and adds a member through the picker", async ({
    page,
  }) => {
    await installGroupsApi(page, { seed: [RELEASE_GROUP] });
    await page.goto(`/groups/${GROUP_ID}`);
    await expect(
      page.getByRole("heading", { level: 1, name: "Release managers" }),
    ).toBeVisible();
    const ada = page.locator(`[data-group-member='${ADA}']`);
    const bea = page.locator(`[data-group-member='${BEA}']`);
    await expect(ada).toContainText("Ada Operator");
    await expect(ada.locator("[data-group-member-cannot-approve]")).toHaveCount(0);
    await expect(bea.locator("[data-group-member-cannot-approve]")).toContainText(
      GROUP_CANNOT_APPROVE_LABEL,
    );
    await expect(bea).toContainText(GROUP_CANNOT_APPROVE_DESCRIPTION);
    const removeBea = page.getByRole("button", { name: "Remove Bea Disabled from this group" });
    await expect(removeBea).toHaveAccessibleDescription(GROUP_CANNOT_APPROVE_DESCRIPTION);
    await expectNoBlockingAxeViolations(page);

    await page.getByRole("button", { name: "Add member" }).click();
    const dialog = page.getByRole("dialog", { name: "Add member to Release managers" });
    await expect(dialog).toBeVisible();
    const picker = dialog.getByLabel("Member");
    await expect(picker.locator("option")).toHaveText([
      "Choose a member",
      "Cal Viewer",
      "Dee Removed",
    ]);
    await expectNoBlockingAxeViolations(page);

    await picker.selectOption(DEE);
    await dialog.getByRole("button", { name: "Add member" }).click();
    await expect(page.locator("#group-member-user-error")).toHaveText(
      GROUP_MEMBER_NOT_IN_WORKSPACE_MESSAGE,
    );
    await expect(picker).toHaveAttribute("aria-invalid", "true");

    await picker.selectOption(CAL);
    await expect(page.locator("#group-member-user-error")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Add member" }).click();
    await expect(dialog).toHaveCount(0);
    const cal = page.locator(`[data-group-member='${CAL}']`);
    await expect(cal).toContainText("Cal Viewer");
    await expect(cal.locator("[data-group-member-cannot-approve]")).toBeVisible();
    await expect(page.getByText("3 members", { exact: false })).toBeVisible();
  });

  test("remove member confirms, offers undo, then drops the row", async ({ page }) => {
    const api = await installGroupsApi(page, { seed: [RELEASE_GROUP] });
    await page.goto(`/groups/${GROUP_ID}`);
    await page.getByRole("button", { name: "Remove Bea Disabled from this group" }).click();
    const confirm = page.getByRole("dialog", { name: "Remove from this group?" });
    await expect(confirm).toBeVisible();
    await expectNoBlockingAxeViolations(page);
    await confirm.getByRole("button", { name: "Remove member" }).click();
    await expect(page.locator("[data-confirm-destructive='undo']")).toBeVisible();
    await expect(page.locator(`[data-group-member='${BEA}']`)).toHaveCount(0, {
      timeout: 20_000,
    });
    expect(api.calls).toContain(`DELETE /workspace/groups/${GROUP_ID}/members/${BEA}`);
  });

  test("rename and delete return to the list", async ({ page }) => {
    const api = await installGroupsApi(page, { seed: [RELEASE_GROUP] });
    await page.goto(`/groups/${GROUP_ID}`);
    await page.getByRole("button", { name: "Rename" }).click();
    const rename = page.getByRole("dialog", { name: "Rename group" });
    const name = rename.getByLabel("Group name");
    await expect(name).toHaveValue("Release managers");
    const save = rename.getByRole("button", { name: "Save name" });
    // Only an exact trimmed match is unchanged.
    await expect(save).toBeDisabled();
    await name.fill(" Release managers ");
    await expect(save).toBeDisabled();
    // A case-only rename is a real change and is sent.
    await name.fill("RELEASE MANAGERS");
    await expect(save).toBeEnabled();
    await save.click();
    await expect(
      page.getByRole("heading", { level: 1, name: "RELEASE MANAGERS" }),
    ).toBeVisible();
    expect(api.calls).toContain(`PATCH /workspace/groups/${GROUP_ID}`);

    await page.getByRole("button", { name: "Rename" }).click();
    await expect(name).toHaveValue("RELEASE MANAGERS");
    await name.fill("Release leads");
    await rename.getByRole("button", { name: "Save name" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Release leads" })).toBeVisible();

    await page.getByRole("button", { name: "Delete group" }).click();
    const confirm = page.getByRole("dialog", { name: "Delete this group?" });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("This cannot be undone.");
    await expectNoBlockingAxeViolations(page);
    await confirm.getByRole("button", { name: "Delete group" }).click();
    await expect(page).toHaveURL(/\/groups$/);
    await expect(
      page.getByRole("heading", { name: WORKSPACE_GROUPS_EMPTY_HEADING }),
    ).toBeVisible();
    expect(api.calls).toContain(`DELETE /workspace/groups/${GROUP_ID}`);
  });

  test("a missing or malformed group id uses the not-found boundary", async ({ page }) => {
    await installGroupsApi(page, { seed: [RELEASE_GROUP] });
    await page.goto(`/groups/${MISSING_GROUP_ID}`);
    await expect(
      page.getByRole("heading", { level: 1, name: ROUTE_NOT_FOUND_HEADING }),
    ).toBeVisible();
    await page.goto("/groups/not-a-uuid");
    await expect(
      page.getByRole("heading", { level: 1, name: ROUTE_NOT_FOUND_HEADING }),
    ).toBeVisible();
  });

  test("non-admins get the forbidden treatment and no groups calls", async ({ page }) => {
    const api = await installGroupsApi(page, {
      seed: [RELEASE_GROUP],
      permissions: OPERATOR_PERMISSIONS,
    });
    await page.goto("/groups");
    await expect(page.getByText(WORKSPACE_GROUPS_FORBIDDEN)).toBeVisible();
    await expect(page.getByRole("button", { name: "Create group" })).toHaveCount(0);
    await page.goto(`/groups/${GROUP_ID}`);
    await expect(page.getByText(WORKSPACE_GROUPS_FORBIDDEN)).toBeVisible();
    expect(api.calls.filter((call) => call.includes("/workspace/groups"))).toEqual([]);
    await page.goto("/settings");
    await expect(page.getByRole("link", { name: "Workspace groups" })).toHaveCount(0);
  });

  test("admins find groups from Settings", async ({ page }) => {
    await installGroupsApi(page, { seed: [RELEASE_GROUP] });
    await page.goto("/settings");
    const link = page.getByRole("link", { name: "Workspace groups" });
    await expect(link).toHaveAttribute("href", "/groups");
  });

  test("embed never shows or calls groups", async ({ page }) => {
    const api = await installGroupsApi(page, { seed: [RELEASE_GROUP], embed: true });
    await page.goto("/embed/v1/groups");
    await expect(page.getByRole("button", { name: "Create group" })).toHaveCount(0);
    await expect(page.locator(`[data-group-row='${GROUP_ID}']`)).toHaveCount(0);
    await expect(page.getByText(WORKSPACE_GROUPS_EMBED_UNAVAILABLE)).toBeVisible();
    await page.goto(`/embed/v1/groups/${GROUP_ID}`);
    await expect(page.getByText(WORKSPACE_GROUPS_EMBED_UNAVAILABLE)).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete group" })).toHaveCount(0);
    expect(api.calls.filter((call) => call.includes("/workspace/groups"))).toEqual([]);
  });

});

const SCIM_GROUP_ID = "f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0";

const SCIM_GROUP: StoredGroup = {
  id: SCIM_GROUP_ID,
  displayName: "Okta approvers",
  members: [ADA, CAL],
  managedBy: "scim",
};

test.describe("SCIM-managed groups", () => {
  test("in groups mode a managed group is read-only with one plain sentence", async ({ page }) => {
    const api = await installGroupsApi(page, {
      seed: [RELEASE_GROUP, SCIM_GROUP],
      enforce: "groups",
    });
    await page.goto(`/groups/${SCIM_GROUP_ID}`);
    await expect(page.getByRole("heading", { level: 1, name: "Okta approvers" })).toBeVisible();
    const note = page.locator("[data-group-scim-locked='locked']");
    await expect(note).toHaveText(GROUP_SCIM_LOCKED_MESSAGE);
    await expect(page.locator("[data-group-scim-badge='scim-locked']")).toContainText(
      GROUP_SCIM_MANAGED_LABEL,
    );
    for (const name of ["Rename", "Delete group", "Add member"]) {
      const button = page.getByRole("button", { name, exact: true });
      await expect(button).toBeDisabled();
      await expect(button).toHaveAccessibleDescription(GROUP_SCIM_LOCKED_MESSAGE);
    }
    // Members stay visible; Remove is off and says why (plus the approval note).
    await expect(page.locator(`[data-group-member='${ADA}']`)).toContainText("Ada Operator");
    await expect(page.locator(`[data-group-member='${CAL}']`)).toContainText("Cal Viewer");
    const removeAda = page.getByRole("button", { name: "Remove Ada Operator from this group" });
    await expect(removeAda).toBeDisabled();
    await expect(removeAda).toHaveAccessibleDescription(GROUP_SCIM_LOCKED_MESSAGE);
    const removeCal = page.getByRole("button", { name: "Remove Cal Viewer from this group" });
    await expect(removeCal).toBeDisabled();
    await expect(removeCal).toHaveAccessibleDescription(
      `${GROUP_SCIM_LOCKED_MESSAGE} ${GROUP_CANNOT_APPROVE_DESCRIPTION}`,
    );
    await expectNoBlockingAxeViolations(page);
    // Nothing was sent but reads, and the mode came from the detail itself.
    expect(api.calls.filter((call) => !call.startsWith("GET "))).toEqual([]);
    expect(api.calls.filter((call) => call.includes("scim-tokens"))).toEqual([]);
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // A local group on the same instance stays editable.
    await page.goto(`/groups/${GROUP_ID}`);
    await expect(page.getByRole("heading", { level: 1, name: "Release managers" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Rename", exact: true })).toBeEnabled();
    await expect(page.locator("[data-group-scim-badge]")).toHaveCount(0);
    await expect(page.locator("[data-group-scim-locked]")).toHaveCount(0);
  });

  test("in workspaces mode the same group is editable", async ({ page }) => {
    const api = await installGroupsApi(page, { seed: [SCIM_GROUP], enforce: "workspaces" });
    await page.goto(`/groups/${SCIM_GROUP_ID}`);
    await expect(page.getByRole("heading", { level: 1, name: "Okta approvers" })).toBeVisible();
    await expect(page.locator("[data-group-scim-badge='scim-unenforced']")).toContainText(
      GROUP_SCIM_SYNCED_BEFORE_LABEL,
    );
    await expect(page.locator("[data-group-scim-locked]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add member", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Delete group", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    const rename = page.getByRole("dialog", { name: "Rename group" });
    await rename.getByLabel("Group name").fill("Okta approvers (local)");
    await rename.getByRole("button", { name: "Save name" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Okta approvers (local)" }),
    ).toBeVisible();
    expect(api.calls).toContain(`PATCH /workspace/groups/${SCIM_GROUP_ID}`);
    expect(api.calls.filter((call) => call.includes("scim-tokens"))).toEqual([]);
    await expectNoBlockingAxeViolations(page);

    // The list reads the same mode from its one top-level field.
    await page.getByRole("link", { name: "Workspace groups" }).first().click();
    await expect(
      page.locator(`[data-group-row='${SCIM_GROUP_ID}'] [data-group-scim-badge]`),
    ).toHaveAttribute("data-group-scim-badge", "scim-unenforced");
    await expect(page.locator(`[data-group-row='${SCIM_GROUP_ID}']`)).toContainText(
      GROUP_SCIM_SYNCED_BEFORE_LABEL,
    );
    expect(api.calls.filter((call) => call.includes("scim-tokens"))).toEqual([]);
  });

  test("a stale edit gets the 409, shows the sentence, and switches to read-only", async ({
    page,
  }) => {
    // An older server sends no groupsMode, so the page can't tell the
    // mode. The server enforces groups mode anyway.
    const api = await installGroupsApi(page, {
      seed: [SCIM_GROUP],
      enforce: "groups",
      report: "omit",
    });
    await page.goto(`/groups/${SCIM_GROUP_ID}`);
    await expect(page.getByRole("heading", { level: 1, name: "Okta approvers" })).toBeVisible();
    const badge = page.locator("[data-group-scim-badge]");
    await expect(badge).toHaveAttribute("data-group-scim-badge", "scim-mode-unknown");
    await expect(badge.getByRole("status")).toHaveAccessibleDescription(
      GROUP_SCIM_MODE_UNKNOWN_DESCRIPTION,
    );
    // No side read of the SCIM token list, so no MFA step-up dialog either.
    expect(api.calls.filter((call) => call.includes("scim-tokens"))).toEqual([]);
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const renameButton = page.getByRole("button", { name: "Rename", exact: true });
    await expect(renameButton).toBeEnabled();
    await renameButton.click();
    const rename = page.getByRole("dialog", { name: "Rename group" });
    await rename.getByLabel("Group name").fill("Renamed here");
    await rename.getByRole("button", { name: "Save name" }).click();

    await expect(rename).toHaveCount(0);
    const refused = page.locator("[data-group-scim-locked='refused']");
    await expect(refused).toHaveText(GROUP_SCIM_REFUSED_MESSAGE);
    await expect(refused).toHaveAttribute("role", "alert");
    await expect(page.getByText(MANAGED_DETAIL)).toHaveCount(0);
    await expect(page.getByText("group_managed_by_scim")).toHaveCount(0);
    await expect(badge).toHaveAttribute("data-group-scim-badge", "scim-locked");
    await expect(renameButton).toBeDisabled();
    await expect(renameButton).toHaveAccessibleDescription(GROUP_SCIM_REFUSED_MESSAGE);
    await expect(page.getByRole("button", { name: "Add member", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Delete group", exact: true })).toBeDisabled();
    await expect(page.getByRole("heading", { level: 1, name: "Okta approvers" })).toBeVisible();
    // The group was read again after the refusal.
    expect(
      api.calls.filter((call) => call === `GET /workspace/groups/${SCIM_GROUP_ID}`).length,
    ).toBeGreaterThan(1);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(api.calls.filter((call) => call.includes("scim-tokens"))).toEqual([]);
    await expectNoBlockingAxeViolations(page);
  });

  test("a stale member removal gets the 409 and switches to read-only", async ({ page }) => {
    const api = await installGroupsApi(page, {
      seed: [SCIM_GROUP],
      enforce: "workspaces",
    });
    await page.goto(`/groups/${SCIM_GROUP_ID}`);
    await expect(page.locator("[data-group-scim-badge='scim-unenforced']")).toBeVisible();
    // The operator switches the instance to groups mode after the page loaded.
    api.enforce = "groups";
    api.report = "groups";
    await page.getByRole("button", { name: "Remove Cal Viewer from this group" }).click();
    await page
      .getByRole("dialog", { name: "Remove from this group?" })
      .getByRole("button", { name: "Remove member" })
      .click();
    const refused = page.locator("[data-group-scim-locked='refused']");
    await expect(refused).toHaveText(GROUP_SCIM_REFUSED_MESSAGE, { timeout: 20_000 });
    await expect(page.locator(`[data-group-member='${CAL}']`)).toContainText("Cal Viewer");
    await expect(
      page.getByRole("button", { name: "Remove Cal Viewer from this group" }),
    ).toBeDisabled();
    expect(api.groups.get(SCIM_GROUP_ID)?.members).toEqual([ADA, CAL]);
    // The detail read again after the refusal reports groups mode itself.
    await expect(page.locator("[data-group-scim-badge]")).toHaveAttribute(
      "data-group-scim-badge",
      "scim-locked",
    );
    await expect(page.getByRole("button", { name: "Rename", exact: true })).toBeDisabled();

    // The list now reports the new mode too.
    await page.getByRole("link", { name: "Workspace groups" }).first().click();
    await expect(
      page.locator(`[data-group-row='${SCIM_GROUP_ID}'] [data-group-scim-badge]`),
    ).toHaveAttribute("data-group-scim-badge", "scim-locked");
    expect(api.calls.filter((call) => call.includes("scim-tokens"))).toEqual([]);
  });

  test("the badge and its tooltip are reachable by keyboard on the list", async ({ page }) => {
    await installGroupsApi(page, { seed: [RELEASE_GROUP, SCIM_GROUP], enforce: "groups" });
    await page.goto("/groups");
    const row = page.locator(`[data-group-row='${SCIM_GROUP_ID}']`);
    await expect(row).toContainText("Okta approvers");
    await expect(row.locator("[data-group-scim-badge]")).toHaveAttribute(
      "data-group-scim-badge",
      "scim-locked",
    );
    await expect(
      page.locator(`[data-group-row='${GROUP_ID}'] [data-group-scim-badge]`),
    ).toHaveCount(0);
    const chip = row.getByRole("status");
    await expect(chip).toHaveAccessibleName(GROUP_SCIM_MANAGED_LABEL);
    await expect(chip).toHaveAccessibleDescription(GROUP_SCIM_MANAGED_DESCRIPTION);
    await expect(chip).toHaveAttribute("tabindex", "0");
    const tipId = await chip.getAttribute("aria-describedby");
    expect(tipId).toBeTruthy();
    const tip = page.locator(`[id="${tipId}"]`);
    await expect(tip).toHaveAttribute("role", "tooltip");
    await expect(tip).toHaveAttribute("data-ff-tooltip", "closed");

    // Tab from the group's link lands on the chip and opens the tooltip.
    await row.getByRole("link", { name: "Okta approvers" }).focus();
    await page.keyboard.press("Tab");
    await expect(chip).toBeFocused();
    await expect(tip).toHaveAttribute("data-ff-tooltip", "open");
    await expect(tip).toHaveText(GROUP_SCIM_MANAGED_DESCRIPTION);
    await expectNoBlockingAxeViolations(page);
    // Escape closes it and focus stays on the chip, like the other status tooltips.
    await page.keyboard.press("Escape");
    await expect(tip).toHaveAttribute("data-ff-tooltip", "closed");
    await expect(chip).toBeFocused();
    // The chip is one stop: the next Tab leaves it for the next control.
    await page.keyboard.press("Tab");
    await expect(chip).not.toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(chip).toBeFocused();
    await expect(tip).toHaveAttribute("data-ff-tooltip", "open");
    await page.keyboard.press("Escape");
    await expect(tip).toHaveAttribute("data-ff-tooltip", "closed");

    // The detail page badge works the same way.
    await row.getByRole("link", { name: "Okta approvers" }).click();
    const detailChip = page.locator("[data-group-scim-badge]").getByRole("status");
    await expect(detailChip).toHaveAccessibleDescription(GROUP_SCIM_MANAGED_DESCRIPTION);
    await page.keyboard.press("Shift");
    await detailChip.focus();
    const detailTip = page.locator(`[id="${await detailChip.getAttribute("aria-describedby")}"]`);
    await expect(detailTip).toHaveAttribute("data-ff-tooltip", "open");
    await page.keyboard.press("Escape");
    await expect(detailTip).toHaveAttribute("data-ff-tooltip", "closed");
    await expect(detailChip).toBeFocused();
  });

  test("the groups screens never read the SCIM token list", async ({ page }) => {
    const api = await installGroupsApi(page, {
      seed: [RELEASE_GROUP, SCIM_GROUP],
      enforce: "groups",
    });
    await page.goto("/groups");
    await expect(page.locator(`[data-group-row='${GROUP_ID}']`)).toContainText("Release managers");
    await expect(
      page.locator(`[data-group-row='${SCIM_GROUP_ID}'] [data-group-scim-badge]`),
    ).toHaveAttribute("data-group-scim-badge", "scim-locked");
    await page.goto(`/groups/${SCIM_GROUP_ID}`);
    await expect(page.locator("[data-group-scim-locked='locked']")).toHaveText(
      GROUP_SCIM_LOCKED_MESSAGE,
    );
    await page.goto(`/groups/${GROUP_ID}`);
    await expect(page.getByRole("heading", { level: 1, name: "Release managers" })).toBeVisible();
    expect(api.calls.filter((call) => call.includes("scim-tokens"))).toEqual([]);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});
