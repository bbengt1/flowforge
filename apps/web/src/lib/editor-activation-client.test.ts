import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyEditorActivationToggle } from "./editor-activation-client.ts";
import { emptyStoredIdentity } from "./dev-identity.ts";
import type { EditorActivationPin } from "./editor-activation.ts";

const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";

const pin: EditorActivationPin = {
  kind: "webhook",
  id: "44444444-4444-4444-8444-444444444444",
  workflowVersionId: VERSION_ID,
  status: "enabled",
  label: "wh_example",
};

describe("R6.1 editor activation client", () => {
  it("refuses invented workflow ids and draft version pins", async () => {
    const identity = emptyStoredIdentity();
    const badWorkflow = await applyEditorActivationToggle(
      identity,
      "draft",
      [pin],
      VERSION_ID,
      "disable",
    );
    assert.equal(badWorkflow.ok, false);
    if (!badWorkflow.ok) {
      assert.match(badWorkflow.problem.detail ?? "", /workflowId/);
    }

    const draftVersion = await applyEditorActivationToggle(
      identity,
      WORKFLOW_ID,
      [pin],
      "draft",
      "disable",
    );
    assert.equal(draftVersion.ok, false);
    if (!draftVersion.ok) {
      assert.match(draftVersion.problem.detail ?? "", /published/);
    }

    const emptyPlan = await applyEditorActivationToggle(
      identity,
      WORKFLOW_ID,
      [pin],
      VERSION_ID,
      "enable",
    );
    assert.equal(emptyPlan.ok, false);
    if (!emptyPlan.ok) {
      assert.match(emptyPlan.problem.detail ?? "", /No disabled/);
    }
  });
});
