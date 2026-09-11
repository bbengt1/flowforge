import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HTTP_CONNECTION_FAIL_CLOSED_MESSAGE,
  HTTP_CONNECTION_REQUIRED_MESSAGE,
  HTTP_CONNECTION_TYPE_MESSAGE,
  HTTP_CONTRACT_FALLBACK_HELP,
  HTTP_DEFAULT_TIMEOUT_SECONDS,
  HTTP_DELIVERY_SECRET_KEYS,
  HTTP_EXISTING_API_PATHS,
  HTTP_NOTIFICATION_ACTION_TYPES,
  HTTP_NOTIFICATION_EPIC,
  HTTP_NOTIFICATION_API_PR,
  HTTP_NOTIFICATION_FORBIDDEN_WITH_KEYS,
  HTTP_NOTIFICATION_ROUTE_MAP_SOURCE,
  HTTP_NOTIFICATION_STORY,
  HTTP_INTEGRATION_GATE_MESSAGE,
  HTTP_RECIPIENT_REQUIRED_MESSAGE,
  HTTP_SECRET_WITH_MESSAGE,
  HTTP_TEMPLATE_REQUIRED_MESSAGE,
  HTTP_TLS_REQUIRED_MESSAGE,
  HTTP_UNRESTRICTED_URL_MESSAGE,
  adaptHttpNotificationEntries,
  authorizedHttpConnections,
  catalogListsHttpNotificationType,
  connectionTypeForAction,
  defaultHttpNotificationWith,
  deliveryHasForbiddenSecret,
  hasHttpNotificationContract,
  httpNotificationFallbackNode,
  httpNotificationForbiddenWithKeys,
  httpNotificationLibraryTypes,
  httpNotificationNodeWithFields,
  isHttpConfigurableType,
  isHttpNotificationType,
  isRelativeHttpPath,
  looksLikeUnrestrictedUrl,
  parseHttpNotificationCatalog,
  pathMatchesPrefixes,
  redactHttpNotificationDelivery,
  stripHttpNotificationForbiddenWith,
  tlsRequiredOnConnection,
  validateHttpNotificationConfig,
} from "./core-http-notification-contract.ts";
import type { WorkflowCatalog } from "./workflow-types.ts";

const CONNECTION_ID = "77777777-7777-4777-8777-777777777777";
const SCHEMA_ID = "88888888-8888-4888-8888-888888888888";
const RECIPIENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEMPLATE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const catalog: WorkflowCatalog = {
  apiVersion: "flowforge/v1",
  nodes: [
    {
      type: "http.request",
      phase: "core",
      requiredWith: ["connectionId"],
    },
  ],
};

describe("core HTTP/notification contract adapter", () => {
  it("cites E10.4 / #118 / #109 and keeps the story open", () => {
    assert.equal(HTTP_NOTIFICATION_STORY, 109);
    assert.equal(HTTP_NOTIFICATION_EPIC, 105);
    assert.equal(HTTP_NOTIFICATION_API_PR, 118);
    assert.equal(HTTP_NOTIFICATION_ROUTE_MAP_SOURCE, "e104-#118");
    assert.deepEqual([...HTTP_NOTIFICATION_ACTION_TYPES], [
      "http.request",
      "notification.webhook",
      "notification.email",
    ]);
    assert.ok(HTTP_NOTIFICATION_FORBIDDEN_WITH_KEYS.includes("url"));
    assert.ok(HTTP_NOTIFICATION_FORBIDDEN_WITH_KEYS.includes("headers"));
    assert.ok(HTTP_NOTIFICATION_FORBIDDEN_WITH_KEYS.includes("body"));
    assert.ok(HTTP_NOTIFICATION_FORBIDDEN_WITH_KEYS.includes("token"));
    assert.ok(HTTP_NOTIFICATION_FORBIDDEN_WITH_KEYS.includes("disableTLS"));
    assert.ok(HTTP_NOTIFICATION_FORBIDDEN_WITH_KEYS.includes("to"));
    assert.equal(HTTP_NOTIFICATION_FORBIDDEN_WITH_KEYS.includes("host"), false);
    assert.ok(HTTP_DELIVERY_SECRET_KEYS.includes("set-cookie"));
    assert.match(HTTP_CONTRACT_FALLBACK_HELP, /e104-#118/);
    assert.match(HTTP_CONTRACT_FALLBACK_HELP, /#109/);
    assert.match(HTTP_CONTRACT_FALLBACK_HELP, /Keep #109 open/);
    assert.equal(HTTP_EXISTING_API_PATHS.httpCatalog, "/http/catalog");
    assert.equal(HTTP_EXISTING_API_PATHS.workflowCatalog, "/workflows/catalog");
    assert.equal(HTTP_EXISTING_API_PATHS.opsConfigCatalog, "/ops-config/catalog");
    assert.equal(HTTP_EXISTING_API_PATHS.connections, "/connections");
    assert.equal(HTTP_EXISTING_API_PATHS.recipientLists, "/recipient-lists");
    assert.equal(HTTP_EXISTING_API_PATHS.messageTemplates, "/message-templates");
    assert.equal(HTTP_EXISTING_API_PATHS.responseSchemas, "/response-schemas");
    assert.equal(HTTP_EXISTING_API_PATHS.batchSelect, "/ops-config/select");
    assert.equal(
      HTTP_EXISTING_API_PATHS.workflowPins(
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      ),
      "/workflows/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/versions/cccccccc-cccc-4ccc-8ccc-cccccccccccc/pins",
    );
  });

  it("fails closed when catalog is thin or missing — no invented HTTP nodes or fields", () => {
    assert.deepEqual([...httpNotificationLibraryTypes(null)], []);
    assert.equal(isHttpNotificationType("http.request"), true);
    assert.equal(isHttpConfigurableType("notification.email"), true);
    assert.equal(isHttpConfigurableType("ssh.run"), false);
    assert.equal(catalogListsHttpNotificationType(catalog, "http.request"), true);
    assert.deepEqual([...httpNotificationLibraryTypes(catalog)], ["http.request"]);
    const fallback = httpNotificationFallbackNode("http.request");
    assert.equal(fallback.title, "http.request");
    assert.match(fallback.description ?? "", /fails closed/i);
    assert.deepEqual(fallback.requiredWith, []);
    assert.deepEqual(fallback.allowedWith, []);
    assert.equal(hasHttpNotificationContract(fallback), false);
    assert.deepEqual(adaptHttpNotificationEntries(null), []);
    const thin = adaptHttpNotificationEntries(catalog);
    assert.equal(thin[0]?.type, "http.request");
    assert.deepEqual(thin[0]?.allowedWith ?? [], []);
  });

  it("defaults method and timeout for http.request only", () => {
    assert.deepEqual(defaultHttpNotificationWith("http.request"), {
      method: "GET",
      timeoutSeconds: HTTP_DEFAULT_TIMEOUT_SECONDS,
    });
    assert.deepEqual(defaultHttpNotificationWith("notification.webhook"), {});
    assert.deepEqual(defaultHttpNotificationWith("notification.email"), {});
    assert.deepEqual(defaultHttpNotificationWith("ssh.run"), {});
  });

  it("maps connection types and strips forbidden with keys", () => {
    assert.equal(connectionTypeForAction("http.request"), "http");
    assert.equal(connectionTypeForAction("notification.webhook"), "webhook");
    assert.equal(connectionTypeForAction("notification.email"), "smtp");
    const stripped = stripHttpNotificationForbiddenWith({
      connectionId: CONNECTION_ID,
      url: "https://evil.example",
      token: "sk-leaked",
      disableTLS: true,
      method: "GET",
    });
    assert.equal("url" in stripped, false);
    assert.equal("token" in stripped, false);
    assert.equal("disableTLS" in stripped, false);
    assert.equal(stripped.connectionId, CONNECTION_ID);
    assert.deepEqual(
      httpNotificationForbiddenWithKeys({ url: "x", token: "x" }),
      ["url", "token"],
    );
  });

  it("rejects unrestricted URLs, disabled TLS, and missing pins", () => {
    assert.equal(looksLikeUnrestrictedUrl("https://evil.example/v1"), true);
    assert.equal(looksLikeUnrestrictedUrl("//evil.example/v1"), true);
    assert.equal(looksLikeUnrestrictedUrl("/v1/status"), false);
    assert.equal(isRelativeHttpPath("/v1/status"), true);
    assert.equal(isRelativeHttpPath("https://x"), false);
    assert.equal(isRelativeHttpPath("//x"), false);
    assert.equal(pathMatchesPrefixes("/v1/status", ["/v1"]), true);
    assert.equal(pathMatchesPrefixes("/admin", ["/v1"]), false);
    assert.equal(tlsRequiredOnConnection({ endpointPolicy: { tlsRequired: true } }), true);
    assert.equal(tlsRequiredOnConnection({ endpointPolicy: { tlsRequired: false } }), false);

    const missing = validateHttpNotificationConfig("http.request", {});
    assert.ok(missing.includes(HTTP_CONNECTION_REQUIRED_MESSAGE));
    assert.equal(missing.some((error) => /path is required/i.test(error)), false);

    const url = validateHttpNotificationConfig("http.request", {
      connectionId: CONNECTION_ID,
      method: "GET",
      path: "https://evil.example/v1",
    });
    assert.ok(url.includes(HTTP_UNRESTRICTED_URL_MESSAGE));

    const leaked = validateHttpNotificationConfig("http.request", {
      connectionId: CONNECTION_ID,
      method: "GET",
      path: "/v1/status",
      token: "sk-leaked",
      url: "https://evil.example",
    });
    assert.ok(leaked.includes(HTTP_SECRET_WITH_MESSAGE));
    assert.ok(leaked.includes(HTTP_UNRESTRICTED_URL_MESSAGE));

    const tls = validateHttpNotificationConfig(
      "http.request",
      {
        connectionId: CONNECTION_ID,
        method: "GET",
        path: "/v1/status",
        disableTLS: true,
      },
      { endpointPolicy: { tlsRequired: false } },
    );
    assert.ok(tls.includes(HTTP_TLS_REQUIRED_MESSAGE));

    const methodDenied = validateHttpNotificationConfig(
      "http.request",
      {
        connectionId: CONNECTION_ID,
        method: "DELETE",
        path: "/v1/status",
      },
      { endpointPolicy: { methods: ["GET"], pathPrefixes: ["/v1"] } },
    );
    assert.ok(methodDenied.some((error) => /DELETE/.test(error)));

    const closed = validateHttpNotificationConfig(
      "http.request",
      {
        connectionId: CONNECTION_ID,
        method: "GET",
        path: "/v1/status",
      },
      { connectionSelectorClosed: true },
    );
    assert.ok(closed.includes(HTTP_CONNECTION_FAIL_CLOSED_MESSAGE));
  });

  it("requires recipient list + template pins for email and connection type match", () => {
    const missing = validateHttpNotificationConfig("notification.email", {
      connectionId: CONNECTION_ID,
    });
    assert.ok(missing.includes(HTTP_RECIPIENT_REQUIRED_MESSAGE));
    assert.ok(missing.includes(HTTP_TEMPLATE_REQUIRED_MESSAGE));

    const typeMismatch = validateHttpNotificationConfig(
      "notification.email",
      {
        connectionId: CONNECTION_ID,
        recipientListId: RECIPIENT_ID,
        templateId: TEMPLATE_ID,
      },
      { connectionType: "http" },
    );
    assert.ok(typeMismatch.includes(HTTP_CONNECTION_TYPE_MESSAGE));

    const ok = validateHttpNotificationConfig(
      "notification.email",
      {
        connectionId: CONNECTION_ID,
        recipientListId: RECIPIENT_ID,
        templateId: TEMPLATE_ID,
      },
      { connectionType: "smtp" },
    );
    assert.deepEqual(ok, []);

    const webhookOk = validateHttpNotificationConfig("notification.webhook", {
      connectionId: CONNECTION_ID,
    });
    assert.deepEqual(webhookOk, []);

    const gated = validateHttpNotificationConfig(
      "http.request",
      { connectionId: CONNECTION_ID },
      {
        workflowCatalog: {
          apiVersion: "flowforge/v1",
          rules: { integrationActionsEnabled: false },
          integrationGate: { enabled: false, nodes: ["http.request"] },
          triggers: [],
          nodes: [],
        },
      },
    );
    assert.ok(gated.includes(HTTP_INTEGRATION_GATE_MESSAGE));
  });

  it("filters published connections by node type and fail-closes 403", () => {
    const forbidden = authorizedHttpConnections({
      pins: [],
      nodeType: "http.request",
      statusCode: 403,
    });
    assert.equal(forbidden.closed, true);
    assert.equal(forbidden.options.length, 0);
    assert.equal(forbidden.reason, HTTP_CONNECTION_FAIL_CLOSED_MESSAGE);

    const pins = [
      {
        kind: "connection" as const,
        resourceId: CONNECTION_ID,
        versionId: SCHEMA_ID,
        versionNumber: 1,
        digest: "sha256:conn",
        name: "status-api",
        spec: { type: "http", endpointPolicy: { tlsRequired: true } },
      },
      {
        kind: "connection" as const,
        resourceId: RECIPIENT_ID,
        versionId: TEMPLATE_ID,
        versionNumber: 1,
        digest: "sha256:hook",
        name: "ops-hook",
        spec: { type: "webhook" },
      },
    ];
    const httpOnly = authorizedHttpConnections({
      pins,
      nodeType: "http.request",
    });
    assert.equal(httpOnly.closed, false);
    assert.equal(httpOnly.options.length, 1);
    assert.equal(httpOnly.options[0]?.name, "status-api");

    const none = authorizedHttpConnections({
      pins: pins.filter((pin) => pin.spec?.type === "webhook"),
      nodeType: "http.request",
    });
    assert.equal(none.closed, true);
    assert.match(none.reason ?? "", /http/);
  });

  it("overlays catalog allowedWith and parses GET /http/catalog + httpNotificationEngine", () => {
    assert.deepEqual(httpNotificationNodeWithFields("http.request"), []);

    const parsed = parseHttpNotificationCatalog({
      isolation: {
        tlsVerificationRequired: true,
        connectVerifiedAddressOnly: true,
        ssrfDenied: true,
        dnsRebindingDenied: true,
        userSuppliedURLDenied: true,
      },
      integrationGate: { name: "integration", enabled: true, nodes: ["http.request"] },
      nodes: [
        {
          type: "http.request",
          title: "HTTP request",
          requiredWith: ["connectionId"],
          enabled: true,
          connectionType: "http",
          allowedWith: [
            { name: "connectionId", kind: "uuid", required: true },
            { name: "url", kind: "string" },
            { name: "host", kind: "string" },
            { name: "timeoutSeconds", kind: "integer" },
          ],
        },
      ],
    });
    assert.equal(parsed.source, "http-catalog");
    assert.equal(parsed.integrationGate?.enabled, true);
    const overlaid = httpNotificationNodeWithFields("http.request", parsed);
    assert.equal(overlaid.some((field) => field.name === "connectionId"), true);
    assert.equal(overlaid.some((field) => field.name === "url"), false);
    assert.equal(overlaid.some((field) => field.name === "host"), true);
    assert.equal(overlaid.some((field) => field.name === "timeoutSeconds"), true);

    const ops = parseHttpNotificationCatalog({
      httpNotificationEngine: {
        notes: "jonny #118",
        nodes: [
          {
            type: "http.request",
            title: "Call API",
            requiredWith: ["connectionId"],
            allowedWith: [{ name: "connectionId", kind: "uuid", required: true }],
          },
        ],
        integrationGate: { enabled: true },
      },
    });
    assert.equal(ops.source, "ops-config-catalog");
    assert.equal(ops.nodes[0]?.title, "Call API");

    const empty = parseHttpNotificationCatalog({});
    assert.equal(empty.source, "unavailable");
    assert.match(empty.notes ?? "", /fails closed/i);
    assert.deepEqual(empty.nodes, []);

    const gateOff = {
      apiVersion: "flowforge/v1",
      rules: { integrationActionsEnabled: false },
      integrationGate: { enabled: false },
      triggers: [],
      nodes: [
        { type: "http.request", phase: "core" as const },
        { type: "notification.email", phase: "core" as const },
      ],
    };
    assert.deepEqual([...httpNotificationLibraryTypes(gateOff)], []);
    assert.deepEqual(adaptHttpNotificationEntries(gateOff), []);
  });

  it("redacts delivery results and treats leaked secret keys as a contract bug", () => {
    const redacted = redactHttpNotificationDelivery({
      status: 200,
      authorization: "Bearer leaked",
      "set-cookie": "sid=1",
      body: { token: "sk-leaked", ok: true },
    });
    const rec = redacted as Record<string, unknown>;
    assert.equal("authorization" in rec, false);
    assert.equal("set-cookie" in rec, false);
    const body = rec.body as Record<string, unknown>;
    assert.equal("token" in body, false);
    assert.equal(body.ok, true);
    assert.equal(rec.status, 200);
    assert.equal(
      deliveryHasForbiddenSecret({ authorization: "Bearer x" }),
      true,
    );
    assert.equal(
      deliveryHasForbiddenSecret({ authorization: "[redacted]", status: 200 }),
      false,
    );
  });
});
