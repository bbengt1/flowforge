import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  WEBHOOK_CSRF_HELP,
  WEBHOOK_FIELD_MAPPING_HELP,
  WEBHOOK_FORBIDDEN_MESSAGE,
  WEBHOOK_HOST_SUPPLIED_MESSAGE,
  WEBHOOK_MAP_PENDING_MESSAGE,
  WEBHOOK_NO_REVEAL_MESSAGE,
  WEBHOOK_RATE_HELP,
  WEBHOOK_REPLAY_HELP,
  WEBHOOK_SECRET_HELP,
  WEBHOOK_SIGNATURE_HELP,
  WEBHOOK_TRIGGER_API_PR,
  WEBHOOK_TRIGGER_CONTRACT_FALLBACK_HELP,
  WEBHOOK_TRIGGER_DEFAULT_ROUTES,
  WEBHOOK_TRIGGER_EPIC,
  WEBHOOK_TRIGGER_MANAGE_PERMISSION,
  WEBHOOK_TRIGGER_ROUTE_MAP_SOURCE,
  WEBHOOK_TRIGGER_STORY,
  WEBHOOK_TRIGGER_VIEW_PERMISSION,
  WEBHOOK_UNAUTHENTICATED_MESSAGE,
  WEBHOOK_YAML_HELP,
  applyWebhookRouteTemplate,
  canManageWebhookTriggers,
  canViewWebhookTriggers,
  editorWebhookTriggersHref,
  emptyWebhookTriggerDraft,
  forgetOneTimeSecret,
  hostSuppliedWebhookIdentityKeys,
  isWebhookMapPending,
  isWebhookTriggerAuthFailure,
  parseFieldMappingText,
  parseWebhookTriggerList,
  parseWebhookTriggerRecord,
  rejectHostSuppliedWebhookBody,
  resolveWebhookTriggerContract,
  retargetWebhookTriggerApiPath,
  seedDraftFromYaml,
  takeOneTimeSecret,
  validateWebhookTriggerDraft,
  webhookMutationOutcomeMessage,
  webhookTriggerAuthFailureMessage,
  webhookTriggerCreatePath,
  webhookTriggerDisablePath,
  webhookTriggerHelp,
  webhookTriggerListPath,
  webhookTriggerRotatePath,
  webhookTriggerWriteBody,
  webhookTriggersHref,
  yamlWebhookTriggers,
} from "./webhook-trigger-contract.ts";
import type { WorkflowCatalog } from "./workflow-types.ts";

const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
const TRIGGER_ID = "22222222-2222-4222-8222-222222222222";

const fallbackCatalog: WorkflowCatalog = {
  apiVersion: "flowforge/v1",
  triggers: [{ type: "webhook", phase: "core" }],
  nodes: [],
};

const mappedCatalog: WorkflowCatalog = {
  apiVersion: "flowforge/v1",
  triggers: [
    {
      type: "webhook",
      phase: "core",
      webhook: {
        routes: {
          list: "/hooks?workflowId={workflowId}",
          create: "/hooks",
          get: "/hooks/{triggerId}",
          update: "/hooks/{triggerId}",
          rotate: "/hooks/{triggerId}/rotate",
          disable: "/hooks/{triggerId}/disable",
          enable: "/hooks/{triggerId}/enable",
        },
        help: "catalog webhook map",
      },
    },
  ],
  nodes: [],
};

describe("webhook-trigger contract adapter", () => {
  it("keeps story links and marks the map as pending", () => {
    assert.equal(WEBHOOK_TRIGGER_STORY, 107);
    assert.equal(WEBHOOK_TRIGGER_EPIC, 105);
    assert.equal(WEBHOOK_TRIGGER_API_PR, 0);
    assert.equal(WEBHOOK_TRIGGER_ROUTE_MAP_SOURCE, "contract-fallback");
    assert.equal(WEBHOOK_TRIGGER_VIEW_PERMISSION, "workflow.view");
    assert.equal(WEBHOOK_TRIGGER_MANAGE_PERMISSION, "workflow.edit");
    assert.match(WEBHOOK_TRIGGER_CONTRACT_FALLBACK_HELP, /contract-fallback/);
    assert.match(WEBHOOK_TRIGGER_CONTRACT_FALLBACK_HELP, /#107/);
    assert.match(WEBHOOK_MAP_PENDING_MESSAGE, /#107/);
    assert.match(WEBHOOK_SIGNATURE_HELP, /raw body/);
    assert.match(WEBHOOK_REPLAY_HELP, /Replay/);
    assert.match(WEBHOOK_RATE_HELP, /16 KiB/);
    assert.match(WEBHOOK_SECRET_HELP, /shown once/);
    assert.match(WEBHOOK_YAML_HELP, /inputSchema/);
    assert.match(WEBHOOK_FIELD_MAPPING_HELP, /dotted/);
    assert.match(WEBHOOK_HOST_SUPPLIED_MESSAGE, /workspaceId/);
  });

  it("uses marked contract-fallback until catalog posts routes", () => {
    const missing = resolveWebhookTriggerContract(null);
    assert.equal(missing.source, "contract-fallback");
    assert.equal(missing.routeMapSource, "contract-fallback");
    assert.deepEqual(missing.routes, WEBHOOK_TRIGGER_DEFAULT_ROUTES);
    assert.equal(missing.signatureRequired, true);
    assert.equal(missing.replayRequired, true);
    assert.equal(missing.rawBodyBeforeParse, true);
    assert.equal(missing.csrf, true);
    assert.equal(missing.secretRevealOnce, true);
    assert.match(webhookTriggerHelp(fallbackCatalog), /contract-fallback/);

    const listed = resolveWebhookTriggerContract(fallbackCatalog);
    assert.equal(listed.source, "contract-fallback");

    const mapped = resolveWebhookTriggerContract(mappedCatalog);
    assert.equal(mapped.source, "workflows-catalog");
    assert.equal(mapped.routes.rotate, "/hooks/{triggerId}/rotate");
    assert.match(webhookTriggerHelp(mappedCatalog), /catalog webhook map/);
  });

  it("builds nested fallback paths and retargets through one function", () => {
    assert.equal(
      webhookTriggerListPath(WORKFLOW_ID),
      `/workflows/${WORKFLOW_ID}/triggers?type=webhook`,
    );
    assert.equal(
      webhookTriggerCreatePath(WORKFLOW_ID),
      `/workflows/${WORKFLOW_ID}/triggers`,
    );
    assert.equal(
      webhookTriggerRotatePath(WORKFLOW_ID, TRIGGER_ID),
      `/workflows/${WORKFLOW_ID}/triggers/${TRIGGER_ID}/rotate`,
    );
    assert.equal(
      webhookTriggerDisablePath(WORKFLOW_ID, TRIGGER_ID),
      `/workflows/${WORKFLOW_ID}/triggers/${TRIGGER_ID}/disable`,
    );
    assert.equal(
      applyWebhookRouteTemplate("/api/v1/hooks/{triggerId}", {
        workflowId: WORKFLOW_ID,
        triggerId: TRIGGER_ID,
      }),
      `/hooks/${TRIGGER_ID}`,
    );
    assert.equal(
      retargetWebhookTriggerApiPath("/workflows/x/triggers"),
      "/workflows/x/triggers",
    );
    assert.equal(
      webhookTriggerListPath(WORKFLOW_ID, mappedCatalog),
      `/hooks?workflowId=${WORKFLOW_ID}&type=webhook`,
    );
    assert.equal(webhookTriggersHref(WORKFLOW_ID), `/workflows?webhooks=${WORKFLOW_ID}`);
    assert.equal(
      editorWebhookTriggersHref(WORKFLOW_ID),
      `/workflows/${WORKFLOW_ID}#webhook-triggers`,
    );
  });

  it("fails closed on permissions and never treats viewers as managers", () => {
    assert.equal(canViewWebhookTriggers(null), false);
    assert.equal(canManageWebhookTriggers(null), false);
    assert.equal(canViewWebhookTriggers(["workflow.view"]), true);
    assert.equal(canManageWebhookTriggers(["workflow.view"]), false);
    assert.equal(
      canManageWebhookTriggers(["workflow.view", "workflow.edit"]),
      true,
    );
  });

  it("validates settings without offering signature or replay off switches", () => {
    const valid = validateWebhookTriggerDraft(
      emptyWebhookTriggerDraft({
        fieldMappingText: "alert.id: payload.id\n",
      }),
    );
    assert.equal(valid.ok, true);
    if (valid.ok) {
      assert.equal(valid.settings.signatureRequired, true);
      assert.equal(valid.settings.replayRequired, true);
      assert.equal(valid.settings.rawBodyBeforeParse, true);
      assert.equal(valid.settings.fieldMapping[0]?.dest, "alert.id");
      const body = webhookTriggerWriteBody(valid.settings);
      assert.equal("id" in body, false);
      assert.equal("workspaceId" in body, false);
      assert.equal("secret" in body, false);
    }

    const secretMap = parseFieldMappingText("token: payload.token");
    assert.ok(secretMap.errors.some((error) => /secret-shaped/.test(error)));

    const badType = validateWebhookTriggerDraft(
      emptyWebhookTriggerDraft({ contentType: "text/yaml" }),
    );
    assert.equal(badType.ok, false);

    const tinyReplay = validateWebhookTriggerDraft(
      emptyWebhookTriggerDraft({
        timestampSkewSeconds: "300",
        replayWindowSeconds: "30",
      }),
    );
    assert.equal(tinyReplay.ok, false);

    const host = hostSuppliedWebhookIdentityKeys({
      id: TRIGGER_ID,
      workspaceId: "ws",
      contentType: "application/json",
    });
    assert.deepEqual(host, ["id", "workspaceId"]);
    const cleaned = rejectHostSuppliedWebhookBody({
      contentType: "application/json",
      maxBodyBytes: 16,
      timestampSkewSeconds: 30,
      replayWindowSeconds: 30,
      rateLimitPerMinute: 10,
      maxConcurrent: 1,
      fieldMapping: [],
    });
    assert.equal("workspaceId" in cleaned, false);
  });

  it("shows a one-time secret then forgets it and never re-displays from GET", () => {
    const created = takeOneTimeSecret({
      id: TRIGGER_ID,
      opaqueId: "wh_opaque_1",
      secret: "whsec_once",
      fingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      secretRef: "cred-1",
    });
    assert.equal(created.secret, "whsec_once");
    assert.equal("secret" in created.record, false);
    assert.ok(created.strippedKeys.includes("secret"));

    const listed = parseWebhookTriggerRecord({
      id: TRIGGER_ID,
      workflowId: WORKFLOW_ID,
      opaqueId: "wh_opaque_1",
      status: "active",
      secret: "should-never-stick",
      fingerprint: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
    assert.ok(listed);
    assert.equal(listed.opaqueId, "wh_opaque_1");
    assert.equal("secret" in listed, false);
    assert.equal(listed.signatureRequired, true);

    const forgotten = forgetOneTimeSecret({ secret: "whsec_once", revealed: true });
    assert.equal(forgotten.secret, null);
    assert.equal(forgotten.revealed, false);
    assert.equal(
      webhookMutationOutcomeMessage("create", { secret: null, revealed: false }),
      WEBHOOK_NO_REVEAL_MESSAGE,
    );
    assert.match(
      webhookMutationOutcomeMessage("rotate", { secret: "x", revealed: true }),
      /rotated/i,
    );
  });

  it("parses list payloads and YAML-only webhook declarations", () => {
    const items = parseWebhookTriggerList(
      {
        items: [
          { id: TRIGGER_ID, opaqueId: "wh_a", type: "webhook", status: "disabled" },
        ],
      },
      WORKFLOW_ID,
    );
    assert.equal(items[0]?.status, "disabled");
    assert.equal(items[0]?.workflowId, WORKFLOW_ID);

    const yaml = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: hook
spec:
  triggers:
    - id: inbound
      type: webhook
      with:
        contentType: application/json
        inputSchema:
          type: object
    - id: manual
      type: manual
  nodes:
    - id: stop
      type: flow.stop
      name: Stop
`;
    const declared = yamlWebhookTriggers(yaml);
    assert.equal(declared[0]?.id, "inbound");
    assert.equal(declared[0]?.hasSchema, true);
    const seeded = seedDraftFromYaml(yaml);
    assert.equal(seeded.contentType, "application/json");
    assert.match(seeded.inputSchemaText, /object/);
  });

  it("maps RFC 9457 auth and missing-map failures closed", () => {
    assert.match(
      webhookTriggerAuthFailureMessage({
        type: "urn:flowforge:problem:csrf-required",
        title: "CSRF",
        status: 403,
        detail: "csrf",
        instance: "/triggers",
        code: "csrf-required",
        request_id: "r1",
      }),
      /X-CSRF-Token/,
    );
    assert.equal(
      webhookTriggerAuthFailureMessage({
        type: "urn:flowforge:problem:unauthenticated",
        title: "Unauthenticated",
        status: 401,
        detail: "stale",
        instance: "/triggers",
        code: "unauthenticated",
        request_id: "r2",
      }),
      WEBHOOK_UNAUTHENTICATED_MESSAGE,
    );
    assert.equal(
      webhookTriggerAuthFailureMessage({
        type: "urn:flowforge:problem:forbidden",
        title: "Forbidden",
        status: 403,
        detail: "nope",
        instance: "/triggers",
        code: "forbidden",
        request_id: "r3",
      }),
      WEBHOOK_FORBIDDEN_MESSAGE,
    );
    assert.equal(isWebhookTriggerAuthFailure(null), false);
    assert.equal(isWebhookMapPending(404), true);
    assert.match(WEBHOOK_CSRF_HELP, /X-CSRF-Token/);
  });
});
