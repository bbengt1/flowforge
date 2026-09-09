import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorkflowCatalog } from "./workflow-types.ts";
import {
  COMMON_IANA_TIMEZONES,
  SCHEDULE_CATALOG_FALLBACK_MESSAGE,
  SCHEDULE_DEFAULT_CATCH_UP,
  SCHEDULE_DEFAULT_MISFIRE,
  SCHEDULE_DEFAULT_OVERLAP,
  SCHEDULE_TRIGGER_CATALOG_FALLBACK_HELP,
  SCHEDULE_TRIGGER_COLLECTION,
  SCHEDULE_TRIGGER_PROXY_ROUTES,
  SCHEDULE_TRIGGER_ROUTE_MAP_SOURCE,
  canManageScheduleTriggers,
  canViewScheduleTriggers,
  editorScheduleTriggersHref,
  emptyScheduleTriggerDraft,
  isScheduleCatalogFallback,
  isScheduleTriggerProxySegments,
  isValidCronExpression,
  isValidIanaTimezone,
  isValidIsoDuration,
  parseScheduleTriggerList,
  parseScheduleTriggerRecord,
  resolveScheduleTriggerContract,
  retargetScheduleTriggerApiPath,
  scheduleTriggerCreatePath,
  scheduleTriggerListPath,
  scheduleTriggersHref,
  seedDraftFromYaml,
  validateScheduleTriggerDraft,
  yamlScheduleTriggers,
} from "./schedule-trigger-contract.ts";

const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
const TRIGGER_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";

function validDraft() {
  return emptyScheduleTriggerDraft({
    workflowVersionId: VERSION_ID,
    timezone: "America/Chicago",
    expressionKind: "cron",
    cron: "15 6 * * 1",
    overlapPolicy: "skip",
    misfirePolicy: "ignore",
    catchUp: "0",
  });
}

const mappedCatalog: WorkflowCatalog = {
  apiVersion: "flowforge/v1",
  triggers: [
    {
      type: "schedule",
      phase: "core",
      admin: {
        listRoute: "GET /api/v1/workflows/{workflowId}/triggers",
        createRoute: "POST /api/v1/workflows/{workflowId}/triggers",
        itemRoute: "GET|PATCH|DELETE /api/v1/triggers/{triggerId}",
        disableRoute: "POST /api/v1/triggers/{triggerId}/disable",
        enableRoute: "POST /api/v1/triggers/{triggerId}/enable",
        deleteRoute: "DELETE /api/v1/triggers/{triggerId}",
        permission: "workflow.edit",
        viewPermission: "workflow.view",
        csrf: true,
        help: "mapped schedule admin",
      },
      schedule: {
        timezoneRequired: true,
        expressionKinds: ["cron", "interval"],
        overlapPolicies: ["skip", "reject", "queue"],
        defaultOverlapPolicy: "skip",
        misfirePolicies: ["ignore", "fire-once"],
        defaultMisfirePolicy: "ignore",
        defaultCatchUp: 0,
        maxCatchUp: 5,
        publishedVersionRequired: true,
        help: "mapped schedule",
      },
    },
  ],
  nodes: [],
};

describe("schedule-trigger contract adapter", () => {
  it("marks catalog-fallback until jonny posts the E10.3 map", () => {
    const missing = resolveScheduleTriggerContract(null);
    assert.equal(missing.source, "catalog-fallback");
    assert.equal(missing.routeMapSource, SCHEDULE_TRIGGER_ROUTE_MAP_SOURCE);
    assert.equal(missing.collection, SCHEDULE_TRIGGER_COLLECTION);
    assert.equal(missing.defaultOverlapPolicy, SCHEDULE_DEFAULT_OVERLAP);
    assert.equal(missing.defaultMisfirePolicy, SCHEDULE_DEFAULT_MISFIRE);
    assert.equal(missing.defaultCatchUp, SCHEDULE_DEFAULT_CATCH_UP);
    assert.equal(missing.publishedVersionRequired, true);
    assert.match(missing.help, /contract-fallback/);
    assert.match(SCHEDULE_TRIGGER_CATALOG_FALLBACK_HELP, /Keep #108 open/);
    assert.equal(isScheduleCatalogFallback(null), true);
    assert.match(SCHEDULE_CATALOG_FALLBACK_MESSAGE, /type=schedule/);
  });

  it("reads catalog admin+schedule when present", () => {
    const mapped = resolveScheduleTriggerContract(mappedCatalog);
    assert.equal(mapped.source, "workflows-catalog");
    assert.equal(mapped.help, "mapped schedule admin");
    assert.equal(mapped.csrf, true);
    assert.equal(
      scheduleTriggerListPath(WORKFLOW_ID, mappedCatalog),
      `/workflows/${WORKFLOW_ID}/triggers`,
    );
    assert.equal(
      scheduleTriggerCreatePath(WORKFLOW_ID, mappedCatalog),
      `/workflows/${WORKFLOW_ID}/triggers`,
    );
    assert.equal(retargetScheduleTriggerApiPath("/triggers/x"), "/triggers/x");
    assert.equal(scheduleTriggersHref(WORKFLOW_ID), `/workflows?schedules=${WORKFLOW_ID}`);
    assert.equal(
      editorScheduleTriggersHref(WORKFLOW_ID),
      `/workflows/${WORKFLOW_ID}#schedule-triggers`,
    );
  });

  it("gates view/manage on workflow permissions", () => {
    assert.equal(canViewScheduleTriggers(null), false);
    assert.equal(canManageScheduleTriggers(null), false);
    assert.equal(canViewScheduleTriggers(["workflow.view"]), true);
    assert.equal(canManageScheduleTriggers(["workflow.view"]), false);
    assert.equal(
      canManageScheduleTriggers(["workflow.view", "workflow.edit"]),
      true,
    );
  });

  it("validates timezone-explicit cron with safe overlap/catch-up defaults", () => {
    const valid = validateScheduleTriggerDraft(validDraft());
    assert.equal(valid.ok, true);
    if (valid.ok) {
      assert.equal(valid.body.type, "schedule");
      assert.equal(valid.body.timezone, "America/Chicago");
      assert.equal(valid.body.cron, "15 6 * * 1");
      assert.equal(valid.body.interval, undefined);
      assert.equal(valid.body.overlapPolicy, "skip");
      assert.equal(valid.body.misfirePolicy, "ignore");
      assert.equal(valid.body.catchUp, 0);
      assert.equal("id" in valid.body, false);
      assert.equal("workspaceId" in valid.body, false);
    }
    assert.equal(isValidIanaTimezone("UTC"), true);
    assert.equal(isValidIanaTimezone("America/Chicago"), true);
    assert.equal(isValidIanaTimezone("Chicago"), false);
    assert.equal(isValidCronExpression("0 0 * * *"), true);
    assert.equal(isValidCronExpression("* * * *"), false);
    assert.equal(isValidIsoDuration("PT15M"), true);
    assert.equal(isValidIsoDuration("15m"), false);
    assert.ok(COMMON_IANA_TIMEZONES.includes("UTC"));
  });

  it("rejects both cron and interval, drafts, and unbounded catch-up", () => {
    const both = validateScheduleTriggerDraft(
      emptyScheduleTriggerDraft({
        workflowVersionId: VERSION_ID,
        timezone: "UTC",
        expressionKind: "cron",
        cron: "0 0 * * *",
        interval: "PT15M",
      }),
    );
    assert.equal(both.ok, false);
    if (!both.ok) {
      assert.ok(both.errors.some((error) => /exactly one/.test(error)));
    }
    const noVersion = validateScheduleTriggerDraft(
      emptyScheduleTriggerDraft({ timezone: "UTC" }),
    );
    assert.equal(noVersion.ok, false);
    const catchUp = validateScheduleTriggerDraft(
      emptyScheduleTriggerDraft({
        workflowVersionId: VERSION_ID,
        catchUp: "9",
      }),
    );
    assert.equal(catchUp.ok, false);
    const badTz = validateScheduleTriggerDraft(
      emptyScheduleTriggerDraft({
        workflowVersionId: VERSION_ID,
        timezone: "Central",
      }),
    );
    assert.equal(badTz.ok, false);
  });

  it("parses schedule rows and skips webhook items on the shared collection", () => {
    const listed = parseScheduleTriggerRecord({
      id: TRIGGER_ID,
      type: "schedule",
      workflowId: WORKFLOW_ID,
      workflowVersionId: VERSION_ID,
      status: "enabled",
      timezone: "UTC",
      cron: "0 * * * *",
      overlapPolicy: "skip",
      misfirePolicy: "ignore",
      catchUp: false,
    });
    assert.ok(listed);
    assert.equal(listed?.timezone, "UTC");
    assert.equal(listed?.catchUp, 0);
    assert.equal(listed?.overlapPolicy, "skip");

    const nested = parseScheduleTriggerRecord({
      id: TRIGGER_ID,
      type: "schedule",
      config: {
        timezone: "Europe/Stockholm",
        interval: "PT1H",
        overlapPolicy: "queue",
        misfirePolicy: "fire-once",
        catchUp: 2,
      },
    });
    assert.equal(nested?.timezone, "Europe/Stockholm");
    assert.equal(nested?.interval, "PT1H");
    assert.equal(nested?.catchUp, 2);

    const webhook = parseScheduleTriggerRecord({
      id: TRIGGER_ID,
      type: "webhook",
      publicId: `wh_${"ab".repeat(32)}`,
    });
    assert.equal(webhook, null);

    const items = parseScheduleTriggerList({
      items: [
        {
          id: TRIGGER_ID,
          type: "schedule",
          timezone: "UTC",
          cron: "0 0 * * *",
          overlapPolicy: "skip",
        },
        { id: "not-a-uuid", type: "schedule", timezone: "UTC" },
        { id: TRIGGER_ID, type: "webhook" },
      ],
    });
    assert.equal(items.length, 1);
    assert.equal(items[0]?.id, TRIGGER_ID);
  });

  it("reads YAML schedule fields for seeding", () => {
    const yaml = `
apiVersion: flowforge/v1
kind: Workflow
spec:
  triggers:
    - id: nightly
      type: schedule
      with:
        timezone: America/Chicago
        cron: "30 2 * * *"
        overlapPolicy: skip
        misfirePolicy: ignore
        catchUp: 0
    - id: manual
      type: manual
`;
    const declared = yamlScheduleTriggers(yaml);
    assert.equal(declared.length, 1);
    assert.equal(declared[0]?.timezone, "America/Chicago");
    assert.equal(declared[0]?.cron, "30 2 * * *");
    const seed = seedDraftFromYaml(yaml);
    assert.equal(seed.timezone, "America/Chicago");
    assert.equal(seed.expressionKind, "cron");
  });

  it("allowlists the shared trigger collection including webhook rotate", () => {
    assert.equal(
      isScheduleTriggerProxySegments(["workflows", WORKFLOW_ID, "triggers"]),
      true,
    );
    assert.equal(
      isScheduleTriggerProxySegments(["triggers", TRIGGER_ID]),
      true,
    );
    assert.equal(
      isScheduleTriggerProxySegments(["triggers", TRIGGER_ID, "disable"]),
      true,
    );
    assert.equal(
      isScheduleTriggerProxySegments(["triggers", TRIGGER_ID, "rotate"]),
      true,
    );
    assert.equal(isScheduleTriggerProxySegments(["schedules"]), false);
    assert.ok(SCHEDULE_TRIGGER_PROXY_ROUTES.length >= 3);
  });
});
