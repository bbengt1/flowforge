import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canCreateWorkflows,
  canSeeCredentialsNav,
  canSeeMembershipIsolationNav,
  canSeeWorkflowsNav,
  navItemIsActive,
  visibleWorkspaceNav,
} from "./workspace-nav.ts";

const viewer = [
  "workflow.view",
  "execution.view",
  "approval.view",
  "opsconfig.view",
  "alert.view",
];

const editor = [
  "workflow.view",
  "workflow.edit",
  "execution.view",
  "credential.view",
  "approval.view",
  "opsconfig.view",
  "opsconfig.edit",
  "alert.view",
];

describe("visibleWorkspaceNav", () => {
  it("hides gated items until permissions are known", () => {
    const items = visibleWorkspaceNav(null);
    assert.deepEqual(
      items.map((item) => item.id),
      ["settings", "portal"],
    );
  });

  it("hides membership/isolation without workspace.administer", () => {
    assert.equal(canSeeMembershipIsolationNav(null), false);
    assert.equal(canSeeMembershipIsolationNav(viewer), false);
    const ids = visibleWorkspaceNav(viewer).map((item) => item.id);
    assert.equal(ids.includes("membership"), false);
    assert.equal(ids.includes("isolation"), false);
    const admin = visibleWorkspaceNav([
      ...viewer,
      "workspace.administer",
    ]).map((item) => item.id);
    assert.ok(admin.includes("membership"));
    assert.ok(admin.includes("isolation"));
  });

  it("hides inaccessible capabilities for a viewer", () => {
    const ids = visibleWorkspaceNav(viewer).map((item) => item.id);
    assert.ok(ids.includes("workflows"));
    assert.ok(ids.includes("actions"));
    assert.ok(ids.includes("targets"));
    assert.ok(ids.includes("profiles"));
    assert.ok(ids.includes("config"));
    assert.ok(ids.includes("executions"));
    assert.ok(ids.includes("templates"));
    assert.ok(ids.includes("approvals"));
    assert.ok(ids.includes("alerts"));
    assert.equal(ids.includes("credentials"), false);
    assert.ok(ids.includes("settings"));
  });

  it("shows credentials only with credential.view", () => {
    assert.equal(canSeeCredentialsNav(viewer), false);
    assert.equal(canSeeCredentialsNav(editor), true);
    const ids = visibleWorkspaceNav(editor).map((item) => item.id);
    assert.ok(ids.includes("credentials"));
  });

  it("hides workflows without workflow.view", () => {
    assert.equal(canSeeWorkflowsNav(["execution.view"]), false);
    const ids = visibleWorkspaceNav(["execution.view", "alert.view"]).map(
      (item) => item.id,
    );
    assert.equal(ids.includes("workflows"), false);
    assert.equal(ids.includes("actions"), false);
    assert.equal(ids.includes("templates"), false);
    assert.ok(ids.includes("executions"));
    assert.ok(ids.includes("alerts"));
  });

  it("does not offer create without workflow.edit", () => {
    assert.equal(canCreateWorkflows(viewer), false);
    assert.equal(canCreateWorkflows(editor), true);
    assert.equal(canCreateWorkflows(null), false);
  });
});

describe("navItemIsActive", () => {
  it("treats workflow editor routes as Workflows", () => {
    assert.equal(navItemIsActive("/workflows", "/workflows/abc"), true);
    assert.equal(navItemIsActive("/executions", "/executions/abc"), true);
    assert.equal(navItemIsActive("/settings", "/membership"), false);
  });
});
