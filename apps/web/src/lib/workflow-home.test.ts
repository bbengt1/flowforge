import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ApprovalRequest } from "./approval-types.ts";
import type { ExecutionRecord } from "./execution-types.ts";
import type { WorkflowDraft, WorkflowRecord } from "./workflow-types.ts";
import { workflowHomeLastRunHref } from "./product-home.ts";
import {
  EMPTY_WORKFLOW_HOME_FILTERS,
  buildWorkflowHomeItems,
  filterWorkflowHomeItems,
  folderFromSlug,
  workflowFolder,
} from "./workflow-home.ts";
import { WORKFLOW_TEMPLATES, workflowTemplateById } from "./workflow-templates.ts";

const record = (overrides: Partial<WorkflowRecord> = {}): WorkflowRecord => ({
  id: "11111111-1111-4111-8111-111111111111",
  slug: "ops/deploy",
  name: "Deploy app",
  status: "published",
  draftRevision: 3,
  draftDigest: "sha256:aaaa",
  latestVersionNumber: 2,
  latestVersionId: "22222222-2222-4222-8222-222222222222",
  createdBy: "chloe",
  updatedBy: "chloe",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  ...overrides,
});

const draft: WorkflowDraft = {
  workflowId: "11111111-1111-4111-8111-111111111111",
  revision: 3,
  definitionYaml: "apiVersion: flowforge/v1\n",
  digest: "sha256:aaaa",
  summary: {
    apiVersion: "flowforge/v1",
    name: "Deploy app",
    triggers: [{ id: "manual", type: "manual" }],
    nodes: [],
    edges: [],
    outputs: [],
  },
  warnings: [],
  validationState: "valid",
  updatedAt: "2026-09-01T00:00:00Z",
};

const execution = {
  id: "44444444-4444-4444-8444-444444444444",
  workflowId: "11111111-1111-4111-8111-111111111111",
  workflowName: "Deploy app",
  workflowSlug: "ops/deploy",
  workflowVersionId: "22222222-2222-4222-8222-222222222222",
  workflowVersionNumber: 2,
  workflowDigest: "sha256:aaaa",
  status: "succeeded",
  startedAt: "2026-09-08T00:00:00Z",
  finishedAt: "2026-09-08T00:01:00Z",
  createdAt: "2026-09-08T00:00:00Z",
  updatedAt: "2026-09-08T00:01:00Z",
  retentionUntil: "",
  correlationId: "corr-1",
  idempotencyKey: "",
  replayed: false,
  requestedBy: "chloe",
  triggerId: "",
  input: { secret: "nope" },
  policySnapshot: null,
  permittedActions: [],
} as ExecutionRecord;

const approval = {
  id: "55555555-5555-4555-8555-555555555555",
  status: "pending",
  workflowId: "11111111-1111-4111-8111-111111111111",
  workflowName: "Deploy app",
  requestedBy: "jonny",
  requestedAt: "2026-09-08T00:00:00Z",
  decidedBy: "",
  decidedAt: "",
  note: "",
  executionId: "",
  executionStatus: "",
  approverRole: "approver",
  permittedActions: [],
  binding: {
    workflowVersionId: "22222222-2222-4222-8222-222222222222",
    workflowVersionDigest: "sha256:aaaa",
    targetId: "",
    targetKind: "",
    targetName: "",
    targetVersionId: "",
    targetDigest: "",
    policyResourceId: "",
    policyRevisionId: "",
    policyRevisionNumber: null,
    policyDigest: "",
    operation: "workflow.execute",
    nodeId: "",
    nodeName: "",
    expiresAt: "2099-01-01T00:00:00Z",
    bindingFingerprint: "fp",
  },
  validity: {
    current: true,
    reason: "pending",
    changedFields: [],
    currentBinding: null,
  },
} as ApprovalRequest;

describe("workflow home list/filter", () => {
  it("derives folder, validation, last run, and pending approvals", () => {
    assert.equal(folderFromSlug("ops/deploy"), "ops");
    assert.equal(workflowFolder("ops--deploy", "Deploy app"), "ops");
    assert.equal(workflowFolder("deploy", "ops/Deploy app"), "ops");
    assert.equal(workflowFolder("deploy", "ops: nightly"), "ops");
    const [item] = buildWorkflowHomeItems(
      [record({ slug: "ops--deploy", name: "Deploy app" })],
      {
        environment: "ops",
        drafts: new Map([[record().id, draft]]),
        executions: [execution],
        approvals: [approval],
        lastRunKnownIds: new Set([record().id]),
      },
    );
    assert.equal(item?.folder, "ops");
    assert.equal(item?.validationHealth, "valid");
    assert.equal(item?.triggers[0], "manual");
    assert.equal(item?.pendingApprovals, 1);
    assert.equal(item?.lastRunStatus, "succeeded");
    assert.equal(item?.lastRunKnown, true);
    assert.equal(
      workflowHomeLastRunHref({
        workflowId: item.id,
        lastRunId: item.lastRunId,
      }),
      `/executions/${item.lastRunId}`,
    );
    assert.equal(
      workflowHomeLastRunHref({ workflowId: item.id }),
      `/executions?workflowId=${item.id}`,
    );
    assert.equal(item?.environment, "ops");
    assert.equal(item?.latestVersionNumber, 2);
    assert.equal(item?.draftDigest, "sha256:aaaa");
    const [fromDraft] = buildWorkflowHomeItems(
      [record({ draftDigest: "" })],
      { drafts: new Map([[record().id, draft]]) },
    );
    assert.equal(fromDraft?.draftDigest, "sha256:aaaa");
  });

  it("filters by search, owner, trigger, status, and last run", () => {
    const other = record({
      id: "66666666-6666-4666-8666-666666666666",
      slug: "other",
      name: "Other",
      status: "draft",
      latestVersionNumber: 0,
      createdBy: "jonny",
      updatedBy: "jonny",
    });
    const items = buildWorkflowHomeItems([record(), other], {
      environment: "ops",
      drafts: new Map([[record().id, draft]]),
      executions: [execution],
      lastRunKnownIds: new Set([record().id, other.id]),
    });
    const found = filterWorkflowHomeItems(items, {
      ...EMPTY_WORKFLOW_HOME_FILTERS,
      query: "deploy",
      owner: "chloe",
      trigger: "manual",
      status: "published",
      lastRun: "succeeded",
    });
    assert.equal(found.length, 1);
    assert.equal(found[0]?.name, "Deploy app");

    const none = filterWorkflowHomeItems(items, {
      ...EMPTY_WORKFLOW_HOME_FILTERS,
      environment: "prod",
    });
    assert.equal(none.length, 0);

    const unknownRun = filterWorkflowHomeItems(
      buildWorkflowHomeItems([other], { environment: "ops" }),
      { ...EMPTY_WORKFLOW_HOME_FILTERS, lastRun: "never" },
    );
    assert.equal(unknownRun.length, 0);

    const neverRun = filterWorkflowHomeItems(
      buildWorkflowHomeItems([other], {
        environment: "ops",
        lastRunKnownIds: new Set([other.id]),
      }),
      { ...EMPTY_WORKFLOW_HOME_FILTERS, lastRun: "never" },
    );
    assert.equal(neverRun.length, 1);
  });
});

describe("workflow templates", () => {
  it("ships core-phase starters that create drafts", () => {
    assert.ok(WORKFLOW_TEMPLATES.length >= 4);
    assert.ok(workflowTemplateById("k8s-rollout")?.definitionYaml.includes("flowforge/v1"));
    assert.ok(workflowTemplateById("ssh-maintenance")?.definitionYaml.includes("data.set"));
    assert.ok(workflowTemplateById("python-automation")?.definitionYaml.includes("flow.stop"));
  });
});
