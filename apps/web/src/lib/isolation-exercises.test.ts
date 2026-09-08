import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyIsolationResult,
  emptyIsolationTargets,
  EXAMPLE_FOREIGN_UUID,
  EXAMPLE_MISMATCH_WORKSPACE_ID,
  isolationExercises,
} from "./isolation-exercises.ts";

describe("isolationExercises", () => {
  it("mirrors jonny's E2.2 isolation hook routes without inventing shapes", () => {
    const exercises = isolationExercises(emptyIsolationTargets());
    const byId = Object.fromEntries(exercises.map((item) => [item.id, item]));

    assert.equal(
      byId["use-foreign-credential"]?.path,
      `/workspace/credentials/${EXAMPLE_FOREIGN_UUID}/use`,
    );
    assert.equal(byId["use-foreign-credential"]?.method, "POST");
    assert.equal(
      byId["get-foreign-artifact"]?.path,
      `/workspace/artifacts/${EXAMPLE_FOREIGN_UUID}`,
    );
    assert.equal(byId["get-foreign-cache"]?.path, "/workspace/cache/job-1");
    assert.equal(
      byId["subscribe-foreign-channel"]?.path,
      `/workspace/realtime/channels/${EXAMPLE_FOREIGN_UUID}/subscribe`,
    );
    assert.equal(
      byId["get-foreign-record"]?.path,
      `/workspace/records/${EXAMPLE_FOREIGN_UUID}`,
    );
    assert.equal(
      byId["list-foreign-credentials"]?.path,
      "/workspace/records?kind=credential",
    );
    assert.equal(byId["list-jobs"]?.path, "/workspace/jobs");
    assert.equal(byId["list-audit-events"]?.path, "/workspace/audit-events");
    assert.equal(byId["reject-host-workspace-id-body"]?.method, "POST");
    assert.deepEqual(byId["reject-host-workspace-id-body"]?.body, {
      kind: "credential",
      name: "isolation-reject",
      workspace_id: EXAMPLE_MISMATCH_WORKSPACE_ID,
    });

    const failClosed = exercises.filter(
      (item) => item.expectedOutcome === "fail-closed",
    );
    const scoped = exercises.filter(
      (item) => item.expectedOutcome === "scoped-list",
    );
    assert.equal(failClosed.length >= 5, true);
    assert.equal(scoped.length, 3);
    for (const exercise of exercises) {
      assert.equal(exercise.path.includes("workspace-id"), false);
    }
  });

  it("never treats a host workspace UUID as the request path", () => {
    const exercises = isolationExercises({
      credentialId: EXAMPLE_MISMATCH_WORKSPACE_ID,
      artifactId: EXAMPLE_MISMATCH_WORKSPACE_ID,
      cacheKey: "other-key",
      channelId: EXAMPLE_MISMATCH_WORKSPACE_ID,
      recordId: EXAMPLE_MISMATCH_WORKSPACE_ID,
    });
    for (const exercise of exercises) {
      assert.equal(exercise.path.startsWith("/workspace/"), true);
      assert.equal(exercise.path.startsWith("/workspaces/"), false);
    }
  });
});

describe("classifyIsolationResult", () => {
  it("treats 400/403/404 as fail-closed and 2xx as a leak", () => {
    assert.equal(classifyIsolationResult(403).held, true);
    assert.equal(classifyIsolationResult(404).held, true);
    assert.equal(classifyIsolationResult(400).held, true);
    assert.equal(classifyIsolationResult(204).held, false);
    assert.equal(classifyIsolationResult(200).held, false);
    assert.equal(classifyIsolationResult(201).held, false);
    assert.equal(classifyIsolationResult(401).held, false);
    assert.equal(classifyIsolationResult(503).held, false);
    assert.equal(classifyIsolationResult(200, "scoped-list").held, true);
    assert.equal(classifyIsolationResult(403, "scoped-list").held, true);
  });
});
