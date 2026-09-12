/**
 * R6.3 test-run client — mint a published test version, then start it.
 *
 * Relates to #272 / Part of #232. Keep #272 open.
 *
 * Inherits the Gracie + jonny R6 confirmation (D5 publish flavor then
 * start; drafts never run). Reuses `publishWorkflow` +
 * `startWorkflowExecution`. CSRF stays on those existing clients.
 * No invented resume or replay route. jonny: kind: test is not on the
 * publish API; the equivalent is the existing note. Not a blocking
 * gap. Do not invent draft-run.
 */

import type { DevIdentity } from "./identity-headers.ts";
import { isResourceId } from "./identity-proxy-ids.ts";
import { generateManualStartIdempotencyKey } from "./manual-start-contract.ts";
import type { ProblemDetails } from "./problem.ts";
import {
  publishWorkflow,
  startWorkflowExecution,
  type ExecutionClientSuccess,
  type PublishClientSuccess,
  type WorkflowClientFailure,
} from "./workflow-client.ts";
import {
  TEST_RUN_FORBIDDEN_HELP,
  TEST_RUN_REVISION_HELP,
  TEST_RUN_SAVE_FIRST_HELP,
  canOfferEditorTestRun,
  testRunPublishBody,
  testRunStartUsesPublishedVersion,
} from "./editor-test-run.ts";

export type TestRunClientSuccess = {
  ok: true;
  step: "started";
  statusCode: number;
  requestId: string;
  workflow: PublishClientSuccess["workflow"];
  version: PublishClientSuccess["version"];
  pins: PublishClientSuccess["pins"];
  scriptArtifacts: PublishClientSuccess["scriptArtifacts"];
  execution: ExecutionClientSuccess["execution"];
};

export type TestRunClientFailure = WorkflowClientFailure & {
  step: "gate" | "publish" | "start";
};

function gateFailure(
  detail: string,
  instance: string,
): TestRunClientFailure {
  return {
    ok: false,
    step: "gate",
    statusCode: 400,
    requestId: "local-test-run-16",
    problem: {
      type: "urn:flowforge:problem:invalid-request",
      title: "Cannot test-run",
      status: 400,
      detail,
      instance,
      code: "invalid-request",
      request_id: "local-test-run-16",
    },
    errors: [],
    conflict: false,
  };
}

export async function runPublishedTestVersion(
  identity: DevIdentity,
  input: {
    workflowId: string;
    revision: number | null;
    dirty?: boolean;
    permissions?: readonly string[] | null;
    idempotencyKey?: string;
  },
): Promise<TestRunClientSuccess | TestRunClientFailure> {
  const path = `/workflows/${input.workflowId}`;
  if (!isResourceId(input.workflowId)) {
    return gateFailure("workflowId must be a workspace resource UUID.", path);
  }
  const gate = canOfferEditorTestRun({
    dirty: input.dirty === true,
    hasWorkflow: true,
    revision: input.revision,
    permissions: input.permissions,
  });
  if (!gate.ok) {
    const detail =
      gate.reason === "forbidden"
        ? TEST_RUN_FORBIDDEN_HELP
        : gate.reason === "dirty"
          ? TEST_RUN_SAVE_FIRST_HELP
          : TEST_RUN_REVISION_HELP;
    return gateFailure(detail, path);
  }
  if (input.revision === null) {
    return gateFailure(TEST_RUN_REVISION_HELP, path);
  }

  const published = await publishWorkflow(
    identity,
    input.workflowId,
    testRunPublishBody(input.revision),
  );
  if (!published.ok) {
    return { ...published, step: "publish" };
  }
  if (!testRunStartUsesPublishedVersion(published.version.id)) {
    return gateFailure(
      "Publish did not return a published workflowVersionId. Drafts never run.",
      path,
    );
  }

  const key = input.idempotencyKey?.trim() || generateManualStartIdempotencyKey();
  const started = await startWorkflowExecution(
    identity,
    input.workflowId,
    published.version.id,
    {
      idempotencyKey: key,
      input: {},
    },
  );
  if (!started.ok) {
    return { ...started, step: "start" };
  }

  return {
    ok: true,
    step: "started",
    statusCode: started.statusCode,
    requestId: started.requestId,
    workflow: published.workflow,
    version: published.version,
    pins: published.pins,
    scriptArtifacts: published.scriptArtifacts,
    execution: started.execution,
  };
}

export function testRunProblem(
  result: TestRunClientFailure,
): ProblemDetails {
  return result.problem;
}
