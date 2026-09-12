import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  dispatchWorkspaceCommand,
  subscribeWorkspaceCommands,
  type WorkspaceCommandName,
} from "./workspace-commands.ts";

describe("workspace commands", () => {
  it("delivers validate / publish / run-published with this workflow id", () => {
    const seen: { name: WorkspaceCommandName; workflowId?: string }[] = [];
    const stop = subscribeWorkspaceCommands((name, detail) => {
      seen.push({ name, workflowId: detail?.workflowId });
    });
    const id = "11111111-1111-4111-8111-111111111111";
    dispatchWorkspaceCommand("validate", { workflowId: id });
    dispatchWorkspaceCommand("publish", { workflowId: id });
    dispatchWorkspaceCommand("test-run", { workflowId: id });
    dispatchWorkspaceCommand("run-published", { workflowId: id });
    stop();
    dispatchWorkspaceCommand("publish", { workflowId: "ignored-after-unsubscribe" });
    assert.deepEqual(seen, [
      { name: "validate", workflowId: id },
      { name: "publish", workflowId: id },
      { name: "test-run", workflowId: id },
      { name: "run-published", workflowId: id },
    ]);
  });
});
