import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  commandHref,
  filterPaletteCommands,
  isWorkflowHomePath,
  PALETTE_INPUT_LABEL,
  PALETTE_SHORTCUT_HELP,
  paletteCommands,
  paletteHighlightIndex,
} from "./command-palette.ts";
import {
  clearNotifications,
  pushNotification,
  sanitizeNotification,
} from "./workspace-notifications.ts";

const viewer = [
  "workflow.view",
  "execution.view",
  "approval.view",
  "opsconfig.view",
  "alert.view",
];

describe("paletteCommands", () => {
  it("omits create/publish/run and vault without those permissions", () => {
    const commands = paletteCommands(viewer);
    const ids = commands.map((item) => item.id);
    assert.ok(ids.includes("open-editor"));
    assert.equal(
      commands.find((item) => item.id === "nav-actions")?.hint,
      "Enabled action catalog",
    );
    assert.ok(ids.includes("webhook-triggers"));
    assert.ok(ids.includes("schedule-triggers"));
    assert.ok(ids.includes("nav-alerts"));
    assert.equal(ids.includes("new-workflow"), false);
    assert.equal(ids.includes("publish"), false);
    assert.equal(ids.includes("test-run"), false);
    assert.equal(ids.includes("run-published"), false);
    assert.equal(ids.includes("manual-start"), false);
    assert.equal(ids.includes("nav-vault"), false);
    assert.equal(ids.includes("nav-membership"), false);
    assert.equal(ids.includes("nav-isolation"), false);
  });

  it("omits membership/isolation commands without the ADV-024 grant", () => {
    const viewerIds = paletteCommands(viewer).map((item) => item.id);
    assert.equal(viewerIds.includes("nav-membership"), false);
    assert.equal(viewerIds.includes("nav-isolation"), false);
    const adminIds = paletteCommands([
      ...viewer,
      "workspace.administer",
    ]).map((item) => item.id);
    assert.ok(adminIds.includes("nav-membership"));
    assert.ok(adminIds.includes("nav-isolation"));
    assert.equal(
      paletteCommands([...viewer, "workspace.administer"]).find(
        (item) => item.id === "nav-isolation",
      )?.hint,
      "Success is a denial",
    );
  });

  it("includes authoring commands for an editor with execute", () => {
    const commands = paletteCommands(
      [
        ...viewer,
        "workflow.edit",
        "workflow.publish",
        "workflow.execute",
        "credential.view",
      ],
      { workflowId: "11111111-1111-4111-8111-111111111111" },
    );
    const ids = commands.map((item) => item.id);
    assert.ok(ids.includes("new-workflow"));
    assert.ok(ids.includes("publish"));
    assert.ok(ids.includes("test-run"));
    assert.ok(ids.includes("run-published"));
    assert.ok(ids.includes("validate"));
    assert.ok(ids.includes("normalize"));
    assert.ok(ids.includes("nav-vault"));
    assert.equal(commandHref({ type: "normalize" }), null);
    assert.equal(
      filterPaletteCommands(commands, "normalize")[0]?.id,
      "normalize",
    );
  });

  it("omits normalize without workflow.edit even when a workflow is open", () => {
    const commands = paletteCommands(viewer, {
      workflowId: "11111111-1111-4111-8111-111111111111",
    });
    const ids = commands.map((item) => item.id);
    assert.ok(ids.includes("validate"));
    assert.equal(ids.includes("normalize"), false);
  });

  it("omits editor-only commands without an open workflow", () => {
    const commands = paletteCommands([
      ...viewer,
      "workflow.edit",
      "workflow.publish",
      "workflow.execute",
    ]);
    const ids = commands.map((item) => item.id);
    assert.ok(ids.includes("new-workflow"));
    assert.equal(ids.includes("publish"), false);
    assert.equal(ids.includes("test-run"), false);
    assert.equal(ids.includes("run-published"), false);
    assert.equal(ids.includes("manual-start"), true);
    assert.equal(ids.includes("validate"), false);
    assert.equal(ids.includes("normalize"), false);
    assert.equal(isWorkflowHomePath("/workflows"), true);
    assert.equal(isWorkflowHomePath("/workflows/abc"), false);
    assert.equal(
      commandHref({
        type: "open-editor",
        workflowId: "11111111-1111-4111-8111-111111111111",
      }),
      "/workflows/11111111-1111-4111-8111-111111111111",
    );
    assert.equal(commandHref({ type: "new-workflow" }), "/workflows?create=1");
    assert.equal(commandHref({ type: "import-yaml" }), "/workflows?import=1");
  });

  it("filters commands by query", () => {
    const commands = paletteCommands([...viewer, "workflow.edit"]);
    assert.equal(filterPaletteCommands(commands, "new")[0]?.id, "new-workflow");
  });

  it("moves the highlight with arrows and wraps", () => {
    assert.equal(paletteHighlightIndex(0, "ArrowDown", 3), 1);
    assert.equal(paletteHighlightIndex(2, "ArrowDown", 3), 0);
    assert.equal(paletteHighlightIndex(0, "ArrowUp", 3), 2);
    assert.equal(paletteHighlightIndex(1, "Home", 3), 0);
    assert.equal(paletteHighlightIndex(0, "End", 3), 2);
    assert.equal(paletteHighlightIndex(1, "Enter", 3), 1);
    assert.match(PALETTE_SHORTCUT_HELP, /Ctrl\+Shift\+K/);
    assert.equal(PALETTE_INPUT_LABEL, "Filter commands");
  });
});

describe("sanitizeNotification", () => {
  it("drops secret fields and never stores plaintext", () => {
    clearNotifications();
    const note = sanitizeNotification({
      kind: "execution",
      title: "Run started",
      detail: "queued",
      secret: "hunter2",
      token: "abc",
    });
    assert.ok(note);
    assert.equal(JSON.stringify(note).includes("hunter2"), false);
    const pushed = pushNotification({
      kind: "validation",
      title: "Draft valid",
      kubeconfig: "apiVersion: v1",
    });
    assert.ok(pushed);
    assert.equal(JSON.stringify(pushed).includes("apiVersion: v1"), false);
  });
});
