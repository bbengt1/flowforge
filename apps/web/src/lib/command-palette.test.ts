import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  commandHref,
  filterPaletteCommands,
  isWorkflowHomePath,
  paletteCommands,
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
    assert.ok(ids.includes("nav-alerts"));
    assert.equal(ids.includes("new-workflow"), false);
    assert.equal(ids.includes("publish"), false);
    assert.equal(ids.includes("run-published"), false);
    assert.equal(ids.includes("manual-start"), false);
    assert.equal(ids.includes("nav-vault"), false);
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
    assert.ok(ids.includes("run-published"));
    assert.ok(ids.includes("validate"));
    assert.ok(ids.includes("nav-vault"));
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
    assert.equal(ids.includes("run-published"), false);
    assert.equal(ids.includes("manual-start"), true);
    assert.equal(ids.includes("validate"), false);
    assert.equal(isWorkflowHomePath("/workflows"), true);
    assert.equal(isWorkflowHomePath("/workflows/abc"), false);
    assert.equal(commandHref({ type: "new-workflow" }), "/workflows?create=1");
    assert.equal(commandHref({ type: "import-yaml" }), "/workflows?import=1");
  });

  it("filters commands by query", () => {
    const commands = paletteCommands([...viewer, "workflow.edit"]);
    assert.equal(filterPaletteCommands(commands, "new")[0]?.id, "new-workflow");
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
