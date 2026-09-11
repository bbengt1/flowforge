import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EXECUTION_INBOX,
  EXECUTION_INBOX_COLUMNS,
  EXECUTION_INBOX_DEFAULT_LIMIT,
  EXECUTION_INBOX_DEFERRED_QUERY_KEYS,
  EXECUTION_INBOX_HELP,
  EXECUTION_INBOX_HREF,
  EXECUTION_INBOX_KEYBOARD_HELP,
  EXECUTION_INBOX_LIMITS,
  EXECUTION_INBOX_OPEN_LABEL,
  EXECUTION_INBOX_QUERY_KEYS,
  EXECUTION_INBOX_SOURCES,
  INVENTED_REPLAY_ROUTE,
  R41_EPIC,
  R41_KEEP_STORY_OPEN,
  R41_STORY,
  executionInboxColumnIds,
  executionInboxColumnText,
  executionInboxDisplay,
  executionInboxDoesNotInventReplayRoute,
  executionInboxDraftsNeverRun,
  executionInboxDurationLabel,
  executionInboxEmbedUnchanged,
  executionInboxHasActiveFilters,
  executionInboxHref,
  executionInboxListPath,
  executionInboxOpenHref,
  executionInboxPreservesRedaction,
  executionInboxQueryOmitsDeferred,
  executionInboxStatuses,
  executionInboxTimeLabel,
  executionInboxUsesExistingListParams,
  parseExecutionInboxQuery,
  serializeExecutionInboxQuery,
} from "./execution-inbox.ts";
import { listExecutionsPath } from "./execution-contract.ts";
import { REDACTED_MARKER, type ExecutionRecord } from "./execution-types.ts";

const EXECUTION_ID = "33333333-3333-4333-8333-333333333333";
const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";

function sampleRecord(
  overrides: Partial<ExecutionRecord> = {},
): ExecutionRecord {
  return {
    id: EXECUTION_ID,
    workflowId: WORKFLOW_ID,
    workflowName: "rollout",
    workflowSlug: "rollout",
    workflowVersionId: "22222222-2222-4222-8222-222222222222",
    workflowVersionNumber: 3,
    workflowDigest: "sha256:abcdef0123456789",
    status: "succeeded",
    startedAt: "2026-09-09T01:00:00.000Z",
    finishedAt: "2026-09-09T01:02:00.000Z",
    createdAt: "2026-09-09T01:00:00.000Z",
    updatedAt: "2026-09-09T01:02:00.000Z",
    retentionUntil: "2026-12-08T01:00:00.000Z",
    correlationId: "corr-16-characters",
    idempotencyKey: "deploy-prod-1",
    replayed: false,
    requestedBy: "operator-chloe",
    triggerId: "",
    input: { token: REDACTED_MARKER },
    policySnapshot: null,
    permittedActions: [],
    ...overrides,
  };
}

describe("R4.1 execution inbox", () => {
  it("keeps #254 open and cites epic #230", () => {
    assert.equal(R41_STORY, 254);
    assert.equal(R41_EPIC, 230);
    assert.equal(R41_KEEP_STORY_OPEN, true);
    assert.equal(EXECUTION_INBOX.migrateInPlace, true);
    assert.equal(EXECUTION_INBOX.operateDensity, true);
    assert.match(EXECUTION_INBOX_HELP, /status, workflowId, and limit/);
    assert.match(EXECUTION_INBOX_KEYBOARD_HELP, /opens the focused run/);
    assert.ok(
      EXECUTION_INBOX_SOURCES.includes(
        "src/components/executions/ExecutionHistory.tsx",
      ),
    );
  });

  it("parses only documented GET /executions query params from the URL", () => {
    const query = parseExecutionInboxQuery(
      `workflowId=${WORKFLOW_ID}&status=failed&limit=25&cursor=abc&startedAfter=2026-01-01&startedBefore=2026-02-01&triggerType=manual&requestedBy=chloe&correlationId=corr-1`,
    );
    assert.deepEqual(query, {
      workflowId: WORKFLOW_ID,
      status: "failed",
      limit: 25,
    });
    assert.deepEqual(EXECUTION_INBOX_QUERY_KEYS, [
      "status",
      "workflowId",
      "limit",
    ]);
    assert.ok(EXECUTION_INBOX_DEFERRED_QUERY_KEYS.includes("cursor"));
    assert.ok(EXECUTION_INBOX_DEFERRED_QUERY_KEYS.includes("triggerType"));
    assert.ok(EXECUTION_INBOX_DEFERRED_QUERY_KEYS.includes("requestedBy"));
    assert.ok(EXECUTION_INBOX_DEFERRED_QUERY_KEYS.includes("correlationId"));
    assert.equal(
      executionInboxQueryOmitsDeferred(
        `workflowId=${WORKFLOW_ID}&cursor=abc&triggerType=webhook`,
      ),
      true,
    );
    assert.equal(
      parseExecutionInboxQuery("status=not-a-status").status,
      "",
    );
    assert.equal(
      parseExecutionInboxQuery({ limit: ["7"] }).limit,
      7,
    );
    assert.equal(parseExecutionInboxQuery("").limit, EXECUTION_INBOX_DEFAULT_LIMIT);
    assert.deepEqual([...EXECUTION_INBOX_LIMITS], [10, 25, 50, 100]);
  });

  it("writes inbox hrefs and list paths without deferred filters", () => {
    assert.equal(executionInboxHref(), EXECUTION_INBOX_HREF);
    assert.equal(
      executionInboxHref({
        workflowId: WORKFLOW_ID,
        status: "indeterminate",
        limit: 25,
      }),
      `/executions?workflowId=${WORKFLOW_ID}&status=indeterminate&limit=25`,
    );
    assert.equal(
      executionInboxHref({
        workflowId: WORKFLOW_ID,
        status: "failed",
        limit: EXECUTION_INBOX_DEFAULT_LIMIT,
      }),
      `/executions?workflowId=${WORKFLOW_ID}&status=failed`,
    );
    assert.equal(
      executionInboxHref({ status: "queued" }, true),
      "/embed/v1/executions?status=queued",
    );
    assert.equal(
      executionInboxListPath({
        workflowId: WORKFLOW_ID,
        status: "queued",
        limit: 10,
      }),
      `/workflows/${WORKFLOW_ID}/executions?status=queued&limit=10`,
    );
    assert.equal(
      executionInboxListPath({ status: "failed", limit: 25 }),
      listExecutionsPath({ status: "failed", limit: 25 }),
    );
    assert.equal(
      executionInboxUsesExistingListParams({
        workflowId: WORKFLOW_ID,
        status: "running",
        limit: 25,
      }),
      true,
    );
    assert.equal(
      executionInboxUsesExistingListParams({ status: "succeeded", limit: 50 }),
      true,
    );
    assert.equal(serializeExecutionInboxQuery({}).toString(), "");
    assert.equal(
      executionInboxHasActiveFilters({
        workflowId: WORKFLOW_ID,
        status: "",
        limit: 50,
      }),
      true,
    );
    assert.equal(
      executionInboxHasActiveFilters({
        workflowId: "",
        status: "",
        limit: 50,
      }),
      false,
    );
  });

  it("exposes operate columns and opens detail without hunting", () => {
    const rows = executionInboxDisplay([
      sampleRecord(),
      sampleRecord({
        id: "44444444-4444-4444-8444-444444444444",
        status: "running",
        finishedAt: "",
      }),
    ]);
    assert.deepEqual(executionInboxColumnIds(), [
      "status",
      "workflow",
      "version",
      "started",
      "duration",
      "correlation",
      "open",
    ]);
    assert.equal(EXECUTION_INBOX_COLUMNS.length, 7);
    assert.equal(rows[0]?.workflowLabel, "rollout");
    assert.equal(rows[0]?.status, "succeeded");
    assert.equal(rows[0]?.durationLabel, "2m");
    assert.equal(rows[0]?.startedLabel, "2026-09-09 01:00:00Z");
    assert.equal(rows[0]?.openLabel, EXECUTION_INBOX_OPEN_LABEL);
    assert.equal(
      rows[0]?.href,
      `/executions/${EXECUTION_ID}?workflowId=${WORKFLOW_ID}`,
    );
    assert.equal(rows[1]?.durationLabel, "—");
    assert.match(executionInboxColumnText(rows[0]!), /Open/);
    assert.equal(
      executionInboxOpenHref(EXECUTION_ID, WORKFLOW_ID),
      `/executions/${EXECUTION_ID}?workflowId=${WORKFLOW_ID}`,
    );
    assert.equal(
      executionInboxOpenHref(EXECUTION_ID, WORKFLOW_ID, true),
      `/embed/v1/executions/${EXECUTION_ID}?workflowId=${WORKFLOW_ID}`,
    );
    assert.equal(executionInboxTimeLabel("—"), "—");
    assert.equal(
      executionInboxDurationLabel(
        "2026-09-09T01:00:00.000Z",
        "2026-09-09T01:00:00.400Z",
      ),
      "400ms",
    );
    assert.equal(
      executionInboxDurationLabel(
        "2026-09-09T01:00:00.000Z",
        "2026-09-09T02:05:00.000Z",
      ),
      "1h 5m",
    );
    assert.ok(executionInboxStatuses().includes("indeterminate"));
    assert.equal(EXECUTION_INBOX.openToDetailWithoutHunting, true);
    assert.equal(EXECUTION_INBOX.usefulColumns, true);
    assert.equal(EXECUTION_INBOX.statusAndWorkflowFilters, true);
  });

  it("preserves redaction, drafts-never-run, and existing ADV/embed contracts", () => {
    const leaked = sampleRecord({
      input: { password: REDACTED_MARKER, note: "safe" },
    });
    assert.equal(executionInboxPreservesRedaction([leaked]), true);
    assert.equal(executionInboxDraftsNeverRun(), true);
    assert.equal(executionInboxDoesNotInventReplayRoute(), true);
    assert.equal(executionInboxEmbedUnchanged(), true);
    assert.equal(INVENTED_REPLAY_ROUTE, "/replay");
    assert.equal(EXECUTION_INBOX.noInventedCursorFilter, true);
    assert.equal(EXECUTION_INBOX.noInventedTimeRangeFilter, true);
    assert.equal(EXECUTION_INBOX.noInventedTriggerTypeFilter, true);
    assert.equal(EXECUTION_INBOX.noInventedRequestedByFilter, true);
    assert.equal(EXECUTION_INBOX.noInventedCorrelationIdFilter, true);
    assert.equal(EXECUTION_INBOX.noSse, true);
    assert.equal(EXECUTION_INBOX.noCompareRoute, true);
    assert.equal(EXECUTION_INBOX.rbacFailClosed, true);
    assert.equal(EXECUTION_INBOX.redactionPreserved, true);
    assert.equal(EXECUTION_INBOX.usesExistingListParamsOnly, true);
  });
});
