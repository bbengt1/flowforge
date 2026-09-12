/**
 * R6.3 test-run client — mint a published test version, then start it.
 *
 * Relates to #272 / Part of #232. Keep #272 open.
 * Follow-up #284 (Terry: editor + home): identical digest / 409
 * already-published starts the existing published version. Keep #284
 * open.
 *
 * Inherits the Gracie + jonny R6 confirmation (D5 publish flavor then
 * start; drafts never run) and the D5 hard line: mint a published
 * test version then start it — never the unsaved/draft buffer. No
 * draft execute path. No silent test of the open editor YAML.
 * Reuses `publishWorkflow` + `startWorkflowExecution`. When the
 * client already has matching draft/published digests, skip publish
 * and start that published `workflowVersionId`. A 409 “already
 * published” on the test-run path resolves the latest published
 * version and starts it — it is not a draft revision conflict.
 * CSRF stays on those existing clients. No invented resume, replay,
 * or idempotent test-run endpoint. jonny: kind: test is not on the
 * publish API; the equivalent is the existing note. Not a blocking
 * gap. Do not invent draft-run.
 */

import type { DevIdentity } from "./identity-headers.ts";
import { isResourceId } from "./identity-proxy-ids.ts";
import { generateManualStartIdempotencyKey } from "./manual-start-contract.ts";
import type { ProblemDetails } from "./problem.ts";
import {
  getWorkflow,
  getWorkflowVersion,
  listWorkflowVersions,
  publishWorkflow,
  startWorkflowExecution,
  type ExecutionClientSuccess,
  type PublishClientSuccess,
  type WorkflowClientFailure,
} from "./workflow-client.ts";
import type { WorkflowRecord, WorkflowVersion } from "./workflow-types.ts";
import {
  TEST_RUN_ALREADY_PUBLISHED_UNRESOLVED_HELP,
  TEST_RUN_FORBIDDEN_HELP,
  TEST_RUN_OPEN_EDITOR_YAML_HELP,
  TEST_RUN_REVISION_HELP,
  TEST_RUN_SAVE_FIRST_HELP,
  canOfferEditorTestRun,
  isAlreadyPublishedTestRunConflict,
  latestPublishedTestVersion,
  testRunCanReusePublishedVersion,
  testRunDigestUnchanged,
  testRunInputUsesOpenEditorYaml,
  testRunKnownDigestChanged,
  testRunPublishBody,
  testRunStartUsesPublishedVersion,
} from "./editor-test-run.ts";

export type TestRunClientInput = {
  workflowId: string;
  revision: number | null;
  dirty?: boolean;
  permissions?: readonly string[] | null;
  idempotencyKey?: string;
  draftDigest?: string | null;
  latestVersionDigest?: string | null;
  latestVersionId?: string | null;
};

export type TestRunClientSuccess = {
  ok: true;
  step: "started";
  statusCode: number;
  requestId: string;
  reusedExistingPublished: boolean;
  workflow: PublishClientSuccess["workflow"];
  version: PublishClientSuccess["version"];
  pins: PublishClientSuccess["pins"];
  scriptArtifacts: PublishClientSuccess["scriptArtifacts"];
  execution: ExecutionClientSuccess["execution"];
};

export type TestRunClientFailure = WorkflowClientFailure & {
  step: "gate" | "publish" | "resolve" | "start";
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

function notConflict(
  failure: WorkflowClientFailure,
  step: TestRunClientFailure["step"],
): TestRunClientFailure {
  return { ...failure, step, conflict: false };
}

async function lookupLatestPublishedTestVersion(
  identity: DevIdentity,
  workflowId: string,
  preferredVersionId?: string | null,
): Promise<
  | { ok: true; found: true; workflow: WorkflowRecord; version: WorkflowVersion }
  | { ok: true; found: false }
  | TestRunClientFailure
> {
  const record = await getWorkflow(identity, workflowId);
  if (!record.ok) {
    return notConflict(record, "resolve");
  }

  const preferred = preferredVersionId?.trim() || "";
  const versionId = testRunStartUsesPublishedVersion(preferred)
    ? preferred
    : record.workflow.latestVersionId;

  if (testRunStartUsesPublishedVersion(versionId)) {
    const version = await getWorkflowVersion(identity, workflowId, versionId!);
    if (version.ok) {
      return {
        ok: true,
        found: true,
        workflow: record.workflow,
        version: version.version,
      };
    }
  }

  const listed = await listWorkflowVersions(identity, workflowId);
  if (!listed.ok) {
    return notConflict(listed, "resolve");
  }
  const latest = latestPublishedTestVersion(listed.items);
  if (!latest) {
    return { ok: true, found: false };
  }
  return { ok: true, found: true, workflow: record.workflow, version: latest };
}

function publishedDigestMatchesDraft(
  workflow: WorkflowRecord,
  version: WorkflowVersion,
): boolean {
  return testRunDigestUnchanged(
    workflow.draftDigest,
    version.digest || workflow.latestVersionDigest,
  );
}

async function resolveLatestPublishedTestVersion(
  identity: DevIdentity,
  workflowId: string,
  preferredVersionId?: string | null,
): Promise<
  | { ok: true; workflow: WorkflowRecord; version: WorkflowVersion }
  | TestRunClientFailure
> {
  const path = `/workflows/${workflowId}`;
  const looked = await lookupLatestPublishedTestVersion(
    identity,
    workflowId,
    preferredVersionId,
  );
  if (!looked.ok) {
    return looked;
  }
  if (!looked.found) {
    return gateFailure(TEST_RUN_ALREADY_PUBLISHED_UNRESOLVED_HELP, path);
  }
  return { ok: true, workflow: looked.workflow, version: looked.version };
}

async function startPublishedTestVersion(
  identity: DevIdentity,
  input: TestRunClientInput,
  published: {
    workflow: PublishClientSuccess["workflow"];
    version: PublishClientSuccess["version"];
    pins?: PublishClientSuccess["pins"];
    scriptArtifacts?: PublishClientSuccess["scriptArtifacts"];
  },
  reusedExistingPublished: boolean,
): Promise<TestRunClientSuccess | TestRunClientFailure> {
  const path = `/workflows/${input.workflowId}`;
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
    reusedExistingPublished,
    workflow: published.workflow,
    version: published.version,
    pins: published.pins ?? [],
    scriptArtifacts: published.scriptArtifacts ?? [],
    execution: started.execution,
  };
}

export async function runPublishedTestVersion(
  identity: DevIdentity,
  input: TestRunClientInput,
): Promise<TestRunClientSuccess | TestRunClientFailure> {
  const path = `/workflows/${input.workflowId}`;
  if (testRunInputUsesOpenEditorYaml(input)) {
    return gateFailure(TEST_RUN_OPEN_EDITOR_YAML_HELP, path);
  }
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

  if (testRunCanReusePublishedVersion(input)) {
    const resolved = await resolveLatestPublishedTestVersion(
      identity,
      input.workflowId,
      input.latestVersionId,
    );
    if (!resolved.ok) {
      return resolved;
    }
    return startPublishedTestVersion(identity, input, resolved, true);
  }

  // Home list often omits latestVersionDigest (omitempty). Probe GET
  // /workflows/{id} before publish so identical digest still starts
  // the existing published version from either call site.
  if (!testRunKnownDigestChanged(input)) {
    const probed = await lookupLatestPublishedTestVersion(
      identity,
      input.workflowId,
      input.latestVersionId,
    );
    if (!probed.ok) {
      return probed;
    }
    if (
      probed.found &&
      publishedDigestMatchesDraft(probed.workflow, probed.version) &&
      testRunStartUsesPublishedVersion(probed.version.id)
    ) {
      return startPublishedTestVersion(identity, input, probed, true);
    }
  }

  const published = await publishWorkflow(
    identity,
    input.workflowId,
    testRunPublishBody(input.revision),
  );
  if (!published.ok) {
    if (!isAlreadyPublishedTestRunConflict(published.problem)) {
      return { ...published, step: "publish" };
    }
    const resolved = await resolveLatestPublishedTestVersion(
      identity,
      input.workflowId,
    );
    if (!resolved.ok) {
      return resolved;
    }
    return startPublishedTestVersion(identity, input, resolved, true);
  }
  if (!testRunStartUsesPublishedVersion(published.version.id)) {
    return gateFailure(
      "Publish did not return a published workflowVersionId. Drafts never run.",
      path,
    );
  }

  return startPublishedTestVersion(identity, input, published, false);
}

export function testRunProblem(
  result: TestRunClientFailure,
): ProblemDetails {
  return result.problem;
}
