import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorkflowCatalog } from "./workflow-types.ts";
import {
  COMMON_IANA_TIMEZONES,
  SCHEDULE_CATALOG_FALLBACK_MESSAGE,
  SCHEDULE_DEFAULT_CATCH_UP,
  SCHEDULE_DEFAULT_MISFIRE,
  SCHEDULE_DEFAULT_OVERLAP,
  SCHEDULE_TRIGGER_API_PR,
  SCHEDULE_TRIGGER_CATALOG_FALLBACK_HELP,
  SCHEDULE_TRIGGER_COLLECTION,
  SCHEDULE_TRIGGER_PROXY_ROUTES,
  SCHEDULE_TRIGGER_ROUTE_MAP_SOURCE,
  canDispatchScheduleTriggers,
  canManageScheduleTriggers,
  canViewScheduleTriggers,
  editorScheduleTriggersHref,
  emptyScheduleTriggerDraft,
  isScheduleCatalogFallback,
  isScheduleTriggerProxySegments,
  isValidCronExpression,
  isValidIanaTimezone,
  isValidIsoDuration,
  isValidScheduleInterval,
  parseScheduleTypeCatalog,
  parseScheduleTriggerList,
  parseScheduleTriggerRecord,
  resolveScheduleTriggerContract,
  retargetScheduleTriggerApiPath,
  scheduleCatalogPath,
  scheduleDispatchPath,
  scheduleTriggerCreatePath,
  scheduleTriggerListPath,
  scheduleTriggersHref,
  seedDraftFromYaml,
  validateScheduleTriggerDraft,
  yamlScheduleTriggers,
} from "./schedule-trigger-contract.ts";

const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
const SCHEDULE_ID = "22222222-2222-4222-8222-222222222222";
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
        listRoute: "GET /api/v1/schedules",
        createRoute: "POST /api/v1/schedules",
        itemRoute: "GET|PATCH|DELETE /api/v1/schedules/{scheduleId}",
        disableRoute: "POST /api/v1/schedules/{scheduleId}/disable",
        enableRoute: "POST /api/v1/schedules/{scheduleId}/enable",
        deleteRoute: "DELETE /api/v1/schedules/{scheduleId}",
        dispatchRoute: "POST /api/v1/schedules/dispatch",
        permission: "workflow.edit",
        viewPermission: "workflow.view",
        dispatchPermission: "workflow.execute",
        csrf: true,
        help: "mapped schedule admin",
      },
    },
  ],
  nodes: [],
};

const scheduleCatalog = parseScheduleTypeCatalog({
  defaultOverlapPolicy: "skip",
  defaultMisfirePolicy: "ignore",
  defaultCatchUp: 0,
  maxCatchUp: 5,
  dispatchRoute: "POST /api/v1/schedules/dispatch",
  permission: "workflow.edit",
  viewPermission: "workflow.view",
  dispatchPermission: "workflow.execute",
  csrf: true,
  help: "GET /schedules/catalog",
});

describe("schedule-trigger contract adapter", () => {
  it("cites #116 and falls back only when both catalogs are missing", () => {
    const missing = resolveScheduleTriggerContract(null);
    assert.equal(missing.source, "catalog-fallback");
    assert.equal(missing.routeMapSource, SCHEDULE_TRIGGER_ROUTE_MAP_SOURCE);
    assert.equal(missing.apiPr, SCHEDULE_TRIGGER_API_PR);
    assert.equal(missing.collection, SCHEDULE_TRIGGER_COLLECTION);
    assert.equal(missing.collection, "schedules");
    assert.equal(missing.defaultOverlapPolicy, SCHEDULE_DEFAULT_OVERLAP);
    assert.equal(missing.defaultMisfirePolicy, SCHEDULE_DEFAULT_MISFIRE);
    assert.equal(missing.defaultCatchUp, SCHEDULE_DEFAULT_CATCH_UP);
    assert.equal(missing.publishedVersionRequired, true);
    assert.equal(missing.admin.listRoute, "/schedules");
    assert.equal(missing.admin.dispatchRoute, "/schedules/dispatch");
    assert.match(missing.help, /catalog-fallback/);
    assert.match(SCHEDULE_TRIGGER_CATALOG_FALLBACK_HELP, /Keep #108 open/);
    assert.match(SCHEDULE_TRIGGER_CATALOG_FALLBACK_HELP, /#116/);
    assert.equal(isScheduleCatalogFallback(null), true);
    assert.match(SCHEDULE_CATALOG_FALLBACK_MESSAGE, /\/schedules/);
    assert.equal(SCHEDULE_TRIGGER_API_PR, 116);
    assert.equal(SCHEDULE_TRIGGER_ROUTE_MAP_SOURCE, "e103-#116");
  });

  it("reads workflows-catalog admin from #116 without requiring .schedule", () => {
    const mapped = resolveScheduleTriggerContract(mappedCatalog);
    assert.equal(mapped.source, "workflows-catalog");
    assert.equal(mapped.help, "mapped schedule admin");
    assert.equal(mapped.csrf, true);
    assert.equal(mapped.dispatchPermission, "workflow.execute");
    assert.equal(
      scheduleTriggerListPath(WORKFLOW_ID, mappedCatalog),
      `/schedules?workflowId=${WORKFLOW_ID}`,
    );
    assert.equal(scheduleTriggerCreatePath(WORKFLOW_ID, mappedCatalog), "/schedules");
    assert.equal(scheduleCatalogPath(mappedCatalog), "/schedules/catalog");
    assert.equal(scheduleDispatchPath(mappedCatalog), "/schedules/dispatch");
    assert.equal(retargetScheduleTriggerApiPath("/schedules/x"), "/schedules/x");
    assert.equal(scheduleTriggersHref(WORKFLOW_ID), `/workflows?schedules=${WORKFLOW_ID}`);
    assert.equal(
      editorScheduleTriggersHref(WORKFLOW_ID),
      `/workflows/${WORKFLOW_ID}#schedule-triggers`,
    );
  });

  it("uses schedules-catalog when only GET /schedules/catalog is present", () => {
    const fromSchedule = resolveScheduleTriggerContract(null, scheduleCatalog);
    assert.equal(fromSchedule.source, "schedules-catalog");
    assert.equal(fromSchedule.admin.dispatchRoute, "/schedules/dispatch");
    assert.equal(isScheduleCatalogFallback(null, scheduleCatalog), false);
  });

  it("gates view/manage/dispatch on workflow permissions", () => {
    assert.equal(canViewScheduleTriggers(null), false);
    assert.equal(canManageScheduleTriggers(null), false);
    assert.equal(canDispatchScheduleTriggers(null), false);
    assert.equal(canViewScheduleTriggers(["workflow.view"]), true);
    assert.equal(canManageScheduleTriggers(["workflow.view"]), false);
    assert.equal(
      canManageScheduleTriggers(["workflow.view", "workflow.edit"]),
      true,
    );
    assert.equal(canDispatchScheduleTriggers(["workflow.edit"]), false);
    assert.equal(canDispatchScheduleTriggers(["workflow.execute"]), true);
  });

  it("validates timezone-explicit cron with safe overlap/catch-up defaults", () => {
    const valid = validateScheduleTriggerDraft(validDraft());
    assert.equal(valid.ok, true);
    if (valid.ok) {
      assert.equal("type" in valid.body, false);
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
    assert.equal(isValidScheduleInterval("PT15M"), true);
    assert.equal(isValidScheduleInterval("P7D"), true);
    assert.equal(isValidScheduleInterval("P8D"), false);
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
    const longInterval = validateScheduleTriggerDraft(
      emptyScheduleTriggerDraft({
        workflowVersionId: VERSION_ID,
        timezone: "UTC",
        expressionKind: "interval",
        interval: "P8D",
      }),
    );
    assert.equal(longInterval.ok, false);
  });

  it("parses schedule rows including nextFireAt and skips webhook items", () => {
    const listed = parseScheduleTriggerRecord({
      id: SCHEDULE_ID,
      workflowId: WORKFLOW_ID,
      workflowVersionId: VERSION_ID,
      status: "enabled",
      timezone: "UTC",
      cron: "0 * * * *",
      overlapPolicy: "skip",
      misfirePolicy: "ignore",
      catchUp: 0,
      nextFireAt: "2026-09-10T00:00:00Z",
    });
    assert.ok(listed);
    assert.equal(listed?.timezone, "UTC");
    assert.equal(listed?.catchUp, 0);
    assert.equal(listed?.overlapPolicy, "skip");
    assert.equal(listed?.nextFireAt, "2026-09-10T00:00:00Z");

    const nested = parseScheduleTriggerRecord({
      id: SCHEDULE_ID,
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
      id: SCHEDULE_ID,
      type: "webhook",
      publicId: `wh_${"ab".repeat(32)}`,
    });
    assert.equal(webhook, null);

    const items = parseScheduleTriggerList({
      items: [
        {
          id: SCHEDULE_ID,
          timezone: "UTC",
          cron: "0 0 * * *",
          overlapPolicy: "skip",
        },
        { id: "not-a-uuid", type: "schedule", timezone: "UTC" },
        { id: SCHEDULE_ID, type: "webhook" },
      ],
    });
    assert.equal(items.length, 1);
    assert.equal(items[0]?.id, SCHEDULE_ID);
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

  it("allowlists the #116 /schedules collection and not /triggers", () => {
    assert.equal(isScheduleTriggerProxySegments(["schedules"]), true);
    assert.equal(isScheduleTriggerProxySegments(["schedules", "catalog"]), true);
    assert.equal(isScheduleTriggerProxySegments(["schedules", "dispatch"]), true);
    assert.equal(
      isScheduleTriggerProxySegments(["schedules", SCHEDULE_ID]),
      true,
    );
    assert.equal(
      isScheduleTriggerProxySegments(["schedules", SCHEDULE_ID, "disable"]),
      true,
    );
    assert.equal(
      isScheduleTriggerProxySegments(["workflows", WORKFLOW_ID, "triggers"]),
      false,
    );
    assert.equal(isScheduleTriggerProxySegments(["triggers", SCHEDULE_ID]), false);
    assert.equal(isScheduleTriggerProxySegments(["cron"]), false);
    assert.ok(SCHEDULE_TRIGGER_PROXY_ROUTES.length >= 4);
  });
});
