import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  WEBHOOK_CSRF_HELP,
  WEBHOOK_FIELD_MAPPING_HELP,
  WEBHOOK_FORBIDDEN_MESSAGE,
  WEBHOOK_HOST_SUPPLIED_MESSAGE,
  WEBHOOK_INGRESS_HELP,
  WEBHOOK_RATE_HELP,
  WEBHOOK_REPLAY_HELP,
  WEBHOOK_SECRET_HELP,
  WEBHOOK_SECRET_LEAK_MESSAGE,
  WEBHOOK_SIGNATURE_HELP,
  WEBHOOK_TRIGGER_API_PR,
  WEBHOOK_TRIGGER_CATALOG_FALLBACK_HELP,
  WEBHOOK_TRIGGER_DEFAULT_ADMIN,
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
  catalogPath,
  editorWebhookTriggersHref,
  emptyWebhookTriggerDraft,
  hostSuppliedWebhookIdentityKeys,
  isWebhookCatalogFallback,
  isWebhookPublicId,
  isWebhookTriggerAuthFailure,
  isWebhookTriggerRef,
  parseFieldMappingText,
  parseWebhookTriggerList,
  parseWebhookTriggerRecord,
  rejectHostSuppliedWebhookBody,
  resolveWebhookTriggerContract,
  retargetWebhookTriggerApiPath,
  seedDraftFromYaml,
  stripUnexpectedWebhookSecret,
  validateWebhookTriggerDraft,
  webhookIngressDisplayPath,
  webhookIngressHelp,
  webhookIngressPath,
  webhookMutationOutcomeMessage,
  webhookTriggerAuthFailureMessage,
  webhookTriggerCreateBody,
  webhookTriggerCreatePath,
  webhookTriggerDeletePath,
  webhookTriggerDisablePath,
  webhookTriggerHelp,
  webhookTriggerListPath,
  webhookTriggerPath,
  webhookTriggerRotateBody,
  webhookTriggerRotatePath,
  webhookTriggersHref,
  yamlWebhookTriggers,
} from "./webhook-trigger-contract.ts";
import type { WorkflowCatalog } from "./workflow-types.ts";

const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
const TRIGGER_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";
const CREDENTIAL_ID = "44444444-4444-4444-8444-444444444444";
const PUBLIC_ID = `wh_${"ab".repeat(32)}`;

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
      ingress: {
        route: "POST /api/v1/hooks/{publicId}",
        method: "POST",
        public: true,
        csrf: false,
        session: false,
        signatureHeader: "X-FlowForge-Signature",
        timestampHeader: "X-FlowForge-Timestamp",
        signatureVersion: "v1",
        idempotencyHeader: "Idempotency-Key",
        maxBodyBytes: 65536,
        clockSkewSeconds: 300,
        replayRetentionSeconds: 600,
        defaultRatePerMinute: 60,
        defaultWorkspaceRatePerMinute: 300,
        defaultMaxConcurrency: 5,
        defaultWorkspaceMaxConcurrency: 20,
        contentTypes: ["application/json"],
        help: "catalog ingress map",
      },
      admin: {
        listRoute: "GET /api/v1/workflows/{workflowId}/triggers",
        createRoute: "POST /api/v1/workflows/{workflowId}/triggers",
        itemRoute: "GET|PATCH|DELETE /api/v1/triggers/{triggerId}",
        rotateRoute: "POST /api/v1/triggers/{triggerId}/rotate",
        disableRoute: "POST /api/v1/triggers/{triggerId}/disable",
        enableRoute: "POST /api/v1/triggers/{triggerId}/enable",
        deleteRoute: "DELETE /api/v1/triggers/{triggerId}",
        permission: "workflow.edit",
        viewPermission: "workflow.view",
        csrf: true,
        secretNeverReturned: true,
        help: "catalog admin map",
      },
    },
  ],
  nodes: [],
};

function validDraft() {
  return emptyWebhookTriggerDraft({
    workflowVersionId: VERSION_ID,
    secretMode: "vault",
    secretCredentialId: CREDENTIAL_ID,
    fieldMappingText: "alert.id: payload.id\n",
  });
}

describe("webhook-trigger contract adapter", () => {
  it("cites #113 and keeps #107/#105 open", () => {
    assert.equal(WEBHOOK_TRIGGER_STORY, 107);
    assert.equal(WEBHOOK_TRIGGER_EPIC, 105);
    assert.equal(WEBHOOK_TRIGGER_API_PR, 113);
    assert.equal(WEBHOOK_TRIGGER_ROUTE_MAP_SOURCE, "e102-#113");
    assert.equal(WEBHOOK_TRIGGER_VIEW_PERMISSION, "workflow.view");
    assert.equal(WEBHOOK_TRIGGER_MANAGE_PERMISSION, "workflow.edit");
    assert.match(WEBHOOK_TRIGGER_CATALOG_FALLBACK_HELP, /#113/);
    assert.match(WEBHOOK_TRIGGER_CATALOG_FALLBACK_HELP, /#107/);
    assert.match(WEBHOOK_INGRESS_HELP, /POST \/hooks\/\{publicId\}/);
    assert.match(WEBHOOK_INGRESS_HELP, /X-FlowForge-Signature/);
    assert.match(WEBHOOK_SIGNATURE_HELP, /raw body/);
    assert.match(WEBHOOK_REPLAY_HELP, /Replay/);
    assert.match(WEBHOOK_RATE_HELP, /64 KiB/);
    assert.match(WEBHOOK_SECRET_HELP, /never returns secret/);
    assert.match(WEBHOOK_YAML_HELP, /inputSchema/);
    assert.match(WEBHOOK_FIELD_MAPPING_HELP, /dotted/);
    assert.match(WEBHOOK_HOST_SUPPLIED_MESSAGE, /workspaceId/);
  });

  it("prefers catalog ingress+admin and falls back only when those objects are missing", () => {
    const missing = resolveWebhookTriggerContract(null);
    assert.equal(missing.source, "catalog-fallback");
    assert.equal(missing.routeMapSource, "e102-#113");
    assert.equal(missing.apiPr, 113);
    assert.deepEqual(missing.admin, WEBHOOK_TRIGGER_DEFAULT_ADMIN);
    assert.equal(missing.secretNeverReturned, true);
    assert.equal(missing.signatureRequired, true);
    assert.equal(missing.ingress.session, false);
    assert.equal(missing.ingress.csrf, false);
    assert.equal(isWebhookCatalogFallback(fallbackCatalog), true);
    assert.match(webhookTriggerHelp(fallbackCatalog), /catalog-fallback/);

    const mapped = resolveWebhookTriggerContract(mappedCatalog);
    assert.equal(mapped.source, "workflows-catalog");
    assert.equal(mapped.admin.rotateRoute, "/triggers/{triggerId}/rotate");
    assert.equal(mapped.admin.itemRoute, "/triggers/{triggerId}");
    assert.equal(mapped.ingress.route, "POST /api/v1/hooks/{publicId}");
    assert.match(webhookTriggerHelp(mappedCatalog), /catalog admin map/);
    assert.match(webhookIngressHelp(mappedCatalog), /catalog ingress map/);
  });

  it("builds #113 admin paths and documents ingress without calling it", () => {
    assert.equal(catalogPath("GET /api/v1/workflows/{workflowId}/triggers", ""), "/workflows/{workflowId}/triggers");
    assert.equal(
      catalogPath("GET|PATCH|DELETE /api/v1/triggers/{triggerId}", ""),
      "/triggers/{triggerId}",
    );
    assert.equal(
      webhookTriggerListPath(WORKFLOW_ID),
      `/workflows/${WORKFLOW_ID}/triggers`,
    );
    assert.equal(
      webhookTriggerCreatePath(WORKFLOW_ID),
      `/workflows/${WORKFLOW_ID}/triggers`,
    );
    assert.equal(webhookTriggerPath(TRIGGER_ID), `/triggers/${TRIGGER_ID}`);
    assert.equal(
      webhookTriggerRotatePath(TRIGGER_ID),
      `/triggers/${TRIGGER_ID}/rotate`,
    );
    assert.equal(
      webhookTriggerDisablePath(TRIGGER_ID),
      `/triggers/${TRIGGER_ID}/disable`,
    );
    assert.equal(
      webhookTriggerDeletePath(PUBLIC_ID),
      `/triggers/${PUBLIC_ID}`,
    );
    assert.equal(
      webhookTriggerListPath(WORKFLOW_ID, mappedCatalog),
      `/workflows/${WORKFLOW_ID}/triggers`,
    );
    assert.equal(
      webhookIngressPath(PUBLIC_ID, mappedCatalog),
      `/hooks/${PUBLIC_ID}`,
    );
    assert.equal(
      webhookIngressDisplayPath(PUBLIC_ID, mappedCatalog),
      `/api/v1/hooks/${PUBLIC_ID}`,
    );
    assert.equal(
      applyWebhookRouteTemplate("POST /api/v1/hooks/{publicId}", {
        publicId: PUBLIC_ID,
      }),
      `/hooks/${PUBLIC_ID}`,
    );
    assert.equal(
      retargetWebhookTriggerApiPath("/triggers/x"),
      "/triggers/x",
    );
    assert.equal(webhookTriggersHref(WORKFLOW_ID), `/workflows?webhooks=${WORKFLOW_ID}`);
    assert.equal(
      editorWebhookTriggersHref(WORKFLOW_ID),
      `/workflows/${WORKFLOW_ID}#webhook-triggers`,
    );
    assert.equal(isWebhookPublicId(PUBLIC_ID), true);
    assert.equal(isWebhookTriggerRef(PUBLIC_ID), true);
    assert.equal(isWebhookTriggerRef(TRIGGER_ID), true);
    assert.equal(isWebhookTriggerRef("not-an-id"), false);
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

  it("validates #113 fields and never offers signature or replay off switches", () => {
    const valid = validateWebhookTriggerDraft(validDraft());
    assert.equal(valid.ok, true);
    if (valid.ok) {
      assert.equal(valid.settings.signatureRequired, true);
      assert.equal(valid.settings.replayRequired, true);
      assert.equal(valid.settings.rawBodyBeforeParse, true);
      assert.equal(valid.settings.fieldMapping["alert.id"], "payload.id");
      assert.equal(valid.body.type, "webhook");
      assert.equal(valid.body.workflowVersionId, VERSION_ID);
      assert.equal(valid.body.secretCredentialId, CREDENTIAL_ID);
      assert.equal(valid.body.clockSkewSeconds, 300);
      assert.equal(valid.body.replayRetentionSeconds, 600);
      assert.equal(valid.body.maxConcurrency, 5);
      assert.equal("id" in valid.body, false);
      assert.equal("workspaceId" in valid.body, false);
      assert.equal("secret" in valid.body, false);
      assert.equal("inputSchema" in valid.body, false);
      assert.equal("timestampSkewSeconds" in valid.body, false);
    }

    const inline = validateWebhookTriggerDraft(
      emptyWebhookTriggerDraft({
        workflowVersionId: VERSION_ID,
        secretMode: "inline",
        inlineSecret: "whsec_operator",
      }),
    );
    assert.equal(inline.ok, true);
    if (inline.ok) {
      assert.deepEqual(inline.body.secret, { secret: "whsec_operator" });
      assert.equal(inline.body.secretCredentialId, undefined);
    }

    const secretMap = parseFieldMappingText("token: payload.token");
    assert.ok(secretMap.errors.some((error) => /secret-shaped/.test(error)));

    const badType = validateWebhookTriggerDraft(
      validDraft() && emptyWebhookTriggerDraft({
        ...validDraft(),
        contentType: "text/yaml",
      }),
    );
    assert.equal(badType.ok, false);

    const tinyReplay = validateWebhookTriggerDraft(
      emptyWebhookTriggerDraft({
        ...validDraft(),
        clockSkewSeconds: "300",
        replayRetentionSeconds: "30",
      }),
    );
    assert.equal(tinyReplay.ok, false);

    const noVersion = validateWebhookTriggerDraft(
      emptyWebhookTriggerDraft({ secretMode: "vault", secretCredentialId: CREDENTIAL_ID }),
    );
    assert.equal(noVersion.ok, false);

    const patchSecret = validateWebhookTriggerDraft(
      emptyWebhookTriggerDraft({
        ...validDraft(),
        secretMode: "inline",
        inlineSecret: "nope",
      }),
      null,
      "update",
    );
    assert.equal(patchSecret.ok, false);

    const host = hostSuppliedWebhookIdentityKeys({
      id: TRIGGER_ID,
      workspaceId: "ws",
      contentType: "application/json",
    });
    assert.deepEqual(host, ["id", "workspaceId"]);
    const cleaned = rejectHostSuppliedWebhookBody({
      type: "webhook" as const,
      workflowVersionId: VERSION_ID,
      maxBodyBytes: 16,
    });
    assert.equal("workspaceId" in cleaned, false);
    assert.deepEqual(webhookTriggerRotateBody("next"), { secret: { secret: "next" } });
  });

  it("never returns or keeps a secret from API payloads", () => {
    const leaked = stripUnexpectedWebhookSecret({
      id: TRIGGER_ID,
      publicId: PUBLIC_ID,
      secret: "whsec_should_not_exist",
      secretCredentialId: CREDENTIAL_ID,
    });
    assert.equal(leaked.leaked, true);
    assert.equal("secret" in leaked.record, false);
    assert.ok(leaked.strippedKeys.includes("secret"));

    const listed = parseWebhookTriggerRecord({
      id: TRIGGER_ID,
      workflowId: WORKFLOW_ID,
      workflowVersionId: VERSION_ID,
      publicId: PUBLIC_ID,
      ingressPath: `/api/v1/hooks/${PUBLIC_ID}`,
      status: "enabled",
      secret: "should-never-stick",
      secretCredentialId: CREDENTIAL_ID,
      fieldMapping: { env: "environment" },
      clockSkewSeconds: 300,
      replayRetentionSeconds: 600,
      maxConcurrency: 5,
    });
    assert.ok(listed);
    assert.equal(listed.publicId, PUBLIC_ID);
    assert.equal(listed.ingressPath, `/api/v1/hooks/${PUBLIC_ID}`);
    assert.equal(listed.status, "enabled");
    assert.equal(listed.fieldMapping.env, "environment");
    assert.equal("secret" in listed, false);
    assert.equal("opaqueId" in listed, false);
    assert.match(
      webhookMutationOutcomeMessage("create", { leaked: true, strippedKeys: ["secret"] }),
      /never returned/,
    );
    assert.match(
      webhookMutationOutcomeMessage("create", { leaked: true, strippedKeys: ["secret"] }),
      new RegExp(WEBHOOK_SECRET_LEAK_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.match(webhookMutationOutcomeMessage("rotate"), /not returned/);
    const createBody = webhookTriggerCreateBody(validDraft(), {
      workflowVersionId: VERSION_ID,
      contentType: "application/json",
      maxBodyBytes: 65536,
      clockSkewSeconds: 300,
      replayRetentionSeconds: 600,
      rateLimitPerMinute: 60,
      workspaceRatePerMinute: 300,
      maxConcurrency: 5,
      workspaceMaxConcurrency: 20,
      fieldMapping: {},
      signatureRequired: true,
      replayRequired: true,
      rawBodyBeforeParse: true,
    });
    assert.equal(createBody.secretCredentialId, CREDENTIAL_ID);
    assert.equal(createBody.secret, undefined);
  });

  it("parses list payloads and YAML-only webhook declarations", () => {
    const items = parseWebhookTriggerList(
      {
        items: [
          {
            id: TRIGGER_ID,
            publicId: PUBLIC_ID,
            type: "webhook",
            status: "disabled",
            ingressPath: `/api/v1/hooks/${PUBLIC_ID}`,
          },
          {
            id: "55555555-5555-4555-8555-555555555555",
            type: "schedule",
            timezone: "UTC",
            cron: "0 0 * * *",
          },
        ],
      },
      WORKFLOW_ID,
    );
    assert.equal(items.length, 1);
    assert.equal(items[0]?.status, "disabled");
    assert.equal(items[0]?.workflowId, WORKFLOW_ID);
    assert.equal(items[0]?.publicId, PUBLIC_ID);

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
  });

  it("maps RFC 9457 auth failures closed", () => {
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
    assert.match(WEBHOOK_CSRF_HELP, /X-CSRF-Token/);
  });
});
