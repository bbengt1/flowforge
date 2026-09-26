import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createFlowforgeQueryClient } from "./query-cache.ts";
import { toWorkflowHomeItem } from "./workflow-home.ts";
import type { WorkflowRecord } from "./workflow-types.ts";
import {
  WORKFLOW_DELETE_ACTIVE_EXECUTIONS_MESSAGE,
  WORKFLOW_DELETE_DESCRIPTION,
  WORKFLOW_DELETE_EXECUTIONS_DETAIL,
  WORKFLOW_DELETE_FORBIDDEN_MESSAGE,
  WORKFLOW_DELETE_NOT_FOUND_MESSAGE,
  WORKFLOW_DELETE_OTHER_MESSAGE,
  WORKFLOW_DELETE_PUBLISHED_NOTE,
  WORKFLOW_HAS_ACTIVE_EXECUTIONS_CODE,
  WORKFLOW_SLUG_CONFLICT_MESSAGE,
  WORKFLOW_SLUG_EXHAUSTED_MESSAGE,
  WORKFLOW_SLUG_RESERVED_CODE,
  WORKFLOW_SLUG_RESERVED_NAME_MESSAGE,
  WORKFLOW_SLUG_RESERVED_SLUG_MESSAGE,
  classifyWorkflowDeleteFailure,
  invalidateDeletedWorkflowCache,
  omitDeletedWorkflow,
  readWorkflowCapabilities,
  readWorkflowDeleteImpact,
  rememberWorkflowCollections,
  workflowCapabilitiesAllowDelete,
  workflowDeleteActionVisible,
  workflowDeleteConfirmState,
  workflowDeleteDescription,
  workflowDeleteDialogStaysOpen,
  workflowDeleteFailureMessage,
  workflowDeleteImpact,
  workflowDeleteNameMatches,
  workflowDeleteShownImpact,
  workflowRecordWithCapabilities,
  workflowSlugReservedFromProblem,
  workflowSlugReservedMessage,
} from "./workflow-delete.ts";

const SCOPE = "acme\nops\nhttps://flowforge.local\noperator-ada";
const KEEP_ID = "11111111-1111-4111-8111-111111111111";
const DROP_ID = "22222222-2222-4222-8222-222222222222";

function record(overrides: Partial<WorkflowRecord> = {}): WorkflowRecord {
  return {
    id: KEEP_ID,
    slug: "deploy",
    name: "Deploy",
    status: "draft",
    draftRevision: 1,
    draftDigest: "sha256:aaaa",
    latestVersionNumber: 0,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

describe("workflow delete capability gating", () => {
  it("fails closed unless delete is boolean true", () => {
    assert.deepEqual(readWorkflowCapabilities(undefined), { delete: false });
    assert.deepEqual(readWorkflowCapabilities(null), { delete: false });
    assert.deepEqual(readWorkflowCapabilities("true"), { delete: false });
    assert.deepEqual(readWorkflowCapabilities({ delete: "true" }), { delete: false });
    assert.deepEqual(readWorkflowCapabilities({ delete: 1 }), { delete: false });
    assert.deepEqual(readWorkflowCapabilities({ delete: false }), { delete: false });
    assert.equal(workflowCapabilitiesAllowDelete({ delete: true }), true);
    assert.equal(workflowCapabilitiesAllowDelete({}), false);

    const kept = workflowRecordWithCapabilities(record());
    assert.equal(kept.capabilities?.delete, false);
    const allowed = workflowRecordWithCapabilities(
      record({ capabilities: { delete: true } }),
    );
    assert.equal(allowed.capabilities?.delete, true);
  });

  it("hides the action on embed and when the flag is missing", () => {
    assert.equal(
      workflowDeleteActionVisible({ embed: false, canDelete: true }),
      true,
    );
    assert.equal(
      workflowDeleteActionVisible({ embed: false, canDelete: false }),
      false,
    );
    assert.equal(
      workflowDeleteActionVisible({ embed: true, canDelete: true }),
      false,
    );
    assert.equal(toWorkflowHomeItem(record()).canDelete, false);
    assert.equal(
      toWorkflowHomeItem(record({ capabilities: { delete: true } })).canDelete,
      true,
    );
    assert.equal(
      toWorkflowHomeItem(record({ capabilities: { delete: false } })).canDelete,
      false,
    );
  });
});

describe("workflow delete impact copy", () => {
  const parked = { waitingRuns: 2, blocked: false, inFlightRuns: 0 };

  it("names plural and singular parked runs and leaves a clear run unchanged", () => {
    const plural = workflowDeleteConfirmState({
      status: "published",
      deleteImpact: parked,
    });
    assert.equal(plural.confirmDisabled, false);
    assert.match(
      plural.description,
      /2 runs waiting on an approval or a delay will be stopped and marked failed\./,
    );
    assert.equal(
      plural.executionsDetail,
      "2 runs waiting on an approval or a delay will be stopped and marked failed.",
    );
    assert.doesNotMatch(plural.executionsDetail, /Nothing is cancelled/);

    const singular = workflowDeleteConfirmState({
      status: "draft",
      deleteImpact: { waitingRuns: 1, blocked: false, inFlightRuns: 0 },
    });
    assert.equal(singular.confirmDisabled, false);
    assert.equal(
      singular.executionsDetail,
      "1 run waiting on an approval or a delay will be stopped and marked failed.",
    );

    const clear = workflowDeleteConfirmState({
      status: "draft",
      deleteImpact: { waitingRuns: 0, blocked: false, inFlightRuns: 0 },
    });
    assert.equal(clear.confirmDisabled, false);
    assert.equal(clear.description, workflowDeleteDescription("draft"));
    assert.equal(clear.executionsDetail, WORKFLOW_DELETE_EXECUTIONS_DETAIL);
    assert.match(workflowDeleteImpact({ name: "Deploy", status: "draft" })[3]?.detail ?? "", /Nothing is cancelled/);
  });

  it("disables confirm when delete is blocked or runs are in flight", () => {
    const blocked = workflowDeleteConfirmState({
      status: "published",
      deleteImpact: { waitingRuns: 4, blocked: true, inFlightRuns: 2 },
    });
    assert.equal(blocked.confirmDisabled, true);
    assert.equal(
      blocked.executionsDetail,
      "This workflow can't be deleted while 2 runs are still running or queued.",
    );
    assert.doesNotMatch(blocked.description, /will be stopped/);

    const one = workflowDeleteConfirmState({
      status: "draft",
      deleteImpact: { waitingRuns: 0, blocked: false, inFlightRuns: 1 },
    });
    assert.equal(one.confirmDisabled, true);
    assert.equal(
      one.executionsDetail,
      "This workflow can't be deleted while 1 run is still running or queued.",
    );

    const blockedWithoutCount = workflowDeleteConfirmState({
      status: "draft",
      deleteImpact: { waitingRuns: 0, blocked: true, inFlightRuns: 0 },
    });
    assert.equal(blockedWithoutCount.confirmDisabled, true);
    assert.equal(
      blockedWithoutCount.executionsDetail,
      "This workflow can't be deleted while runs are still running or queued.",
    );
    assert.doesNotMatch(blockedWithoutCount.executionsDetail, /0/);
  });

  it("falls back when deleteImpact is missing or malformed and never guesses a count", () => {
    const fallback = workflowDeleteConfirmState({ status: "draft" });
    assert.equal(fallback.confirmDisabled, false);
    assert.equal(fallback.executionsDetail, WORKFLOW_DELETE_EXECUTIONS_DETAIL);
    assert.equal(
      workflowDeleteConfirmState({ status: "draft", deleteImpact: null }).executionsDetail,
      WORKFLOW_DELETE_EXECUTIONS_DETAIL,
    );

    const malformed = [
      undefined,
      null,
      "2",
      [],
      { waitingRuns: "2", blocked: false, inFlightRuns: 0 },
      { waitingRuns: -1, blocked: false, inFlightRuns: 0 },
      { waitingRuns: 1.5, blocked: false, inFlightRuns: 0 },
      { waitingRuns: 1, blocked: "true", inFlightRuns: 0 },
      { waitingRuns: 2, blocked: false, inFlightRuns: 0, extra: true },
      { waitingRuns: 2, blocked: false },
      { waitingRuns: Number.NaN, blocked: false, inFlightRuns: 0 },
    ];
    for (const value of malformed) {
      assert.equal(readWorkflowDeleteImpact(value), undefined);
      const state = workflowDeleteConfirmState({
        status: "draft",
        deleteImpact: readWorkflowDeleteImpact(value),
      });
      assert.equal(state.confirmDisabled, false);
      assert.equal(state.executionsDetail, WORKFLOW_DELETE_EXECUTIONS_DETAIL);
      assert.doesNotMatch(state.description, /will be stopped/);
      assert.doesNotMatch(state.description, /\d+ runs?/);
    }

    assert.deepEqual(readWorkflowDeleteImpact(parked), parked);
    const kept = workflowRecordWithCapabilities(
      record({
        capabilities: { delete: true },
        deleteImpact: parked,
      }),
    );
    assert.deepEqual(kept.deleteImpact, parked);
    assert.equal(kept.capabilities?.delete, true);
    const stripped = workflowRecordWithCapabilities(
      record({
        capabilities: { delete: false },
        deleteImpact: { waitingRuns: "9", blocked: false, inFlightRuns: 0 } as never,
      }),
    );
    assert.equal(stripped.deleteImpact, undefined);
    assert.equal(stripped.capabilities?.delete, false);
    assert.equal(
      toWorkflowHomeItem(stripped).canDelete,
      false,
    );
  });

  it("drops delete impact on embed so the counts never appear", () => {
    const hidden = workflowDeleteShownImpact({
      embed: true,
      deleteImpact: { waitingRuns: 3, blocked: true, inFlightRuns: 2 },
    });
    assert.equal(hidden, undefined);
    const state = workflowDeleteConfirmState({
      status: "published",
      deleteImpact: hidden,
    });
    assert.equal(state.confirmDisabled, false);
    assert.equal(state.executionsDetail, WORKFLOW_DELETE_EXECUTIONS_DETAIL);
    assert.doesNotMatch(state.description, /will be stopped/);
    assert.doesNotMatch(state.description, /still running or queued/);
    assert.equal(
      workflowDeleteActionVisible({ embed: true, canDelete: true }),
      false,
    );

    const here = fileURLToPath(new URL(".", import.meta.url));
    const home = readFileSync(`${here}../components/home/WorkflowHome.tsx`, "utf8");
    const operator = readFileSync(
      `${here}../components/workflows/WorkflowOperator.tsx`,
      "utf8",
    );
    const dialog = readFileSync(
      `${here}../components/workflows/DeleteWorkflowDialog.tsx`,
      "utf8",
    );
    assert.match(home, /!embed && workflowDelete/);
    assert.match(operator, /!embed && workflow && workflowDeleteOpen/);
    assert.match(dialog, /workflowDeleteShownImpact/);
    assert.match(dialog, /getWorkflow/);
  });
});

describe("workflow delete error codes", () => {
  it("classifies by status and code, never by message text", () => {
    assert.equal(
      classifyWorkflowDeleteFailure({
        statusCode: 409,
        code: WORKFLOW_HAS_ACTIVE_EXECUTIONS_CODE,
      }),
      "active-executions",
    );
    assert.equal(
      classifyWorkflowDeleteFailure({
        statusCode: 409,
        code: "conflict",
      }),
      "other",
    );
    assert.equal(
      classifyWorkflowDeleteFailure({
        statusCode: 403,
        code: "forbidden",
      }),
      "forbidden",
    );
    assert.equal(
      classifyWorkflowDeleteFailure({
        statusCode: 403,
        code: "workflow_has_active_executions must finish",
      }),
      "forbidden",
    );
    assert.equal(
      classifyWorkflowDeleteFailure({
        statusCode: 404,
        code: "not-found",
      }),
      "not-found",
    );
    assert.equal(
      classifyWorkflowDeleteFailure({
        statusCode: 404,
        code: "permission denied in the detail",
      }),
      "not-found",
    );
    assert.equal(
      classifyWorkflowDeleteFailure({
        statusCode: 500,
        code: "upstream-error",
      }),
      "other",
    );
  });

  it("keeps the dialog open for active runs and permission, and closes it on 404", () => {
    assert.equal(workflowDeleteDialogStaysOpen("active-executions"), true);
    assert.equal(workflowDeleteDialogStaysOpen("forbidden"), true);
    assert.equal(workflowDeleteDialogStaysOpen("other"), true);
    assert.equal(workflowDeleteDialogStaysOpen("not-found"), false);
    assert.equal(
      workflowDeleteFailureMessage("active-executions"),
      WORKFLOW_DELETE_ACTIVE_EXECUTIONS_MESSAGE,
    );
    assert.match(
      WORKFLOW_DELETE_ACTIVE_EXECUTIONS_MESSAGE,
      /must finish or be cancelled/,
    );
    assert.match(WORKFLOW_DELETE_ACTIVE_EXECUTIONS_MESSAGE, /does not cancel/);
    assert.equal(
      workflowDeleteFailureMessage("forbidden"),
      WORKFLOW_DELETE_FORBIDDEN_MESSAGE,
    );
    assert.equal(
      workflowDeleteFailureMessage("not-found"),
      WORKFLOW_DELETE_NOT_FOUND_MESSAGE,
    );
    assert.equal(
      workflowDeleteFailureMessage("other"),
      WORKFLOW_DELETE_OTHER_MESSAGE,
    );
  });

  it("puts reserved and slug-conflict errors on the slug field even when no slug was sent", () => {
    const reservedSent = workflowSlugReservedFromProblem(
      { status: 409, code: WORKFLOW_SLUG_RESERVED_CODE, detail: "ignored" },
      { slug: "deploy", name: "Deploy" },
    );
    assert.deepEqual(reservedSent, {
      field: "slug",
      message: WORKFLOW_SLUG_RESERVED_SLUG_MESSAGE,
    });
    const reservedNameOnly = workflowSlugReservedFromProblem(
      {
        status: 409,
        code: WORKFLOW_SLUG_RESERVED_CODE,
        detail: "please parse this sentence instead of the code",
      },
      { name: "Deploy" },
    );
    assert.deepEqual(reservedNameOnly, {
      field: "slug",
      message: WORKFLOW_SLUG_RESERVED_SLUG_MESSAGE,
    });
    assert.notEqual(reservedNameOnly?.message, WORKFLOW_SLUG_RESERVED_NAME_MESSAGE);

    const conflict = workflowSlugReservedFromProblem(
      {
        status: 409,
        code: "conflict",
        detail: "A workflow with this slug already exists.",
      },
      { name: "Deploy" },
    );
    assert.deepEqual(conflict, {
      field: "slug",
      message: WORKFLOW_SLUG_CONFLICT_MESSAGE,
    });
    const conflictOnPath = workflowSlugReservedFromProblem(
      {
        status: 409,
        code: "conflict",
        detail: "please parse this sentence instead of the code",
        errors: [
          {
            path: "slug",
            code: "conflict",
            message: "A workflow with this slug already exists.",
          },
        ],
      },
      {},
    );
    assert.deepEqual(conflictOnPath, {
      field: "slug",
      message: WORKFLOW_SLUG_CONFLICT_MESSAGE,
    });
    const exhausted = workflowSlugReservedFromProblem(
      {
        status: 409,
        code: "conflict",
        detail: "A unique slug could not be allocated.",
        errors: [
          {
            path: "slug",
            code: "conflict",
            message: "A unique slug could not be allocated.",
          },
        ],
      },
      { name: "Quota" },
    );
    assert.deepEqual(exhausted, {
      field: "slug",
      message: WORKFLOW_SLUG_EXHAUSTED_MESSAGE,
    });
    assert.equal(
      workflowSlugReservedFromProblem(
        { status: 409, code: "conflict", detail: "Draft revision mismatch." },
        { name: "Deploy" },
      ),
      null,
    );
    assert.equal(
      workflowSlugReservedFromProblem(
        { status: 400, code: WORKFLOW_SLUG_RESERVED_CODE },
        { slug: "deploy" },
      ),
      null,
    );
    assert.equal(
      workflowSlugReservedFromProblem(
        {
          status: 409,
          code: "conflict",
          detail: "The request conflicts with an existing record.",
          errors: [
            {
              path: "slug",
              code: "conflict",
              message: "The request conflicts with an existing record.",
            },
          ],
        },
        { name: "Deploy" },
      ),
      null,
    );
    assert.equal(
      workflowSlugReservedFromProblem(
        {
          status: 409,
          code: "conflict",
          detail: "A unique identity already exists.",
        },
        {},
      ),
      null,
    );
    for (const code of [
      "execution_not_retryable",
      "step_attempt_superseded",
      "approval_closed",
    ]) {
      assert.equal(
        workflowSlugReservedFromProblem(
          {
            status: 409,
            code,
            detail: "A workflow with this slug already exists.",
            errors: [
              {
                path: "slug",
                code,
                message: "A workflow with this slug already exists.",
              },
            ],
          },
          { name: "Deploy" },
        ),
        null,
      );
    }
    assert.equal(workflowSlugReservedMessage("slug"), WORKFLOW_SLUG_RESERVED_SLUG_MESSAGE);
    assert.equal(workflowSlugReservedMessage("name"), WORKFLOW_SLUG_RESERVED_NAME_MESSAGE);
  });

  it("warns that delete unpublishes and turns triggers off", () => {
    assert.match(workflowDeleteDescription("draft"), /unpublishes the workflow/);
    assert.match(workflowDeleteDescription("draft"), /turns off its triggers/);
    assert.match(WORKFLOW_DELETE_DESCRIPTION, /YAML is not changed/);
    assert.match(
      workflowDeleteDescription("published"),
      new RegExp(WORKFLOW_DELETE_PUBLISHED_NOTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.equal(workflowDeleteNameMatches("Deploy", " Deploy "), true);
    assert.equal(workflowDeleteNameMatches("Deploy", "deploy"), false);
    assert.equal(workflowDeleteNameMatches("  ", "Deploy"), false);
  });
});

describe("workflow delete cache invalidation", () => {
  it("drops the workflow from list, explorer, search, and the record", async () => {
    const client = createFlowforgeQueryClient();
    const keep = { id: KEEP_ID, name: "Keep" };
    const drop = { id: DROP_ID, name: "Drop", password: "hunter2" };
    rememberWorkflowCollections(client, SCOPE, {
      list: [keep, drop],
      explorer: { folders: [{ id: "folder" }], workflows: [keep, drop] },
      search: [drop, keep],
      workflow: drop,
    });

    const listKey = ["flowforge", SCOPE, "workflows", "list"] as const;
    const explorerKey = ["flowforge", SCOPE, "workflows", "explorer"] as const;
    const searchKey = ["flowforge", SCOPE, "workflows", "search"] as const;
    const recordKey = ["flowforge", SCOPE, "workflows", "record", DROP_ID] as const;

    assert.equal(JSON.stringify(client.getQueryData(listKey)).includes("hunter2"), false);
    assert.equal(JSON.stringify(client.getQueryData(recordKey)).includes("hunter2"), false);

    await invalidateDeletedWorkflowCache(client, SCOPE, DROP_ID);

    assert.deepEqual(
      (client.getQueryData(listKey) as { id: string }[]).map((item) => item.id),
      [KEEP_ID],
    );
    const explorer = client.getQueryData(explorerKey) as {
      folders: { id: string }[];
      workflows: { id: string }[];
    };
    assert.deepEqual(
      explorer.workflows.map((item) => item.id),
      [KEEP_ID],
    );
    assert.deepEqual(explorer.folders, [{ id: "folder" }]);
    assert.deepEqual(
      (client.getQueryData(searchKey) as { id: string }[]).map((item) => item.id),
      [KEEP_ID],
    );
    assert.equal(client.getQueryData(recordKey), undefined);
    assert.deepEqual(omitDeletedWorkflow([keep, drop], DROP_ID), [keep]);
    assert.equal(omitDeletedWorkflow(null, DROP_ID), null);
  });

  it("does nothing without a scope or workflow id", async () => {
    const client = createFlowforgeQueryClient();
    rememberWorkflowCollections(client, null, {
      list: [{ id: KEEP_ID }],
    });
    await invalidateDeletedWorkflowCache(client, null, DROP_ID);
    await invalidateDeletedWorkflowCache(client, SCOPE, "  ");
    assert.equal(client.getQueryData(["flowforge", SCOPE, "workflows", "list"]), undefined);
  });
});
