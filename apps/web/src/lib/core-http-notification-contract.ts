/**
 * Single retarget adapter for Chloe's E10.4 HTTP / notification
 * action config (library + wizard + inspector).
 *
 * Wired to jonny's squash-merged #118 map (`e104-#118`):
 *   GET  /workflows/catalog                 allowedWith / policy / bounds /
 *                                           redaction / integrationGate /
 *                                           rules.integrationActionsEnabled
 *   GET  /http/catalog                      nodes[] / isolation / errors /
 *                                           integrationGate
 *   GET  /ops-config/catalog                httpNotificationEngine
 *   GET  /connections                       type=http|webhook|smtp
 *   GET  /recipient-lists
 *   GET  /message-templates
 *   GET  /response-schemas
 *   GET  /policies                          kind=http|notification
 *   POST /{collection}/{id}/select
 *   POST /ops-config/select
 *   GET  /workflows/{id}/versions/{v}/pins
 *
 * Required `with` (resource UUIDs only at publish/execute):
 *   http.request          connectionId
 *   notification.webhook  connectionId
 *   notification.email    connectionId + recipientListId + templateId
 *
 * Relates to #249 / Part of #229. Keep #249 open.
 * Empty or unauthorized catalogs fail closed — no invented node types,
 * allowedWith, ports, or config fields.
 *
 * Optional `with` is overlaid from the live catalog — not invented:
 *   http.request          method, path, host, timeoutSeconds,
 *                         responseSchemaRef, policyId
 *   notification.webhook  path, host, timeoutSeconds, idempotencyKey,
 *                         policyId
 *   notification.email    policyId
 *
 * Forbidden in node config: raw url / headers / to / body / secrets /
 * free-form destinations. SSRF, DNS-rebinding, redirect, and size
 * failures stay closed (surface as validation errors). Loopback/private
 * destinations are denied by default after resolve (ADV-010); opt-in is
 * ops-config `allowPrivateDestinations`, not a wizard toggle. When
 * INTEGRATION_ACTIONS_ENABLED=false the catalogs set the gate off —
 * UI respects `enabled` / absence and does not invent an enable toggle.
 *
 * Cookie session + `X-CSRF-Token` on POST select. camelCase. RFC 9457.
 * Relates to #109 / Part of #105. Keep #109 open. Do not change `apps/api`.
 */

import {
  CATALOG_SOURCE_UNAVAILABLE,
  ENGINE_CATALOG_UNAVAILABLE_HELP,
} from "./catalog-fail-closed.ts";
import { isSecretFieldName } from "./credential.ts";
import { isResourceId } from "./identity-proxy-ids.ts";
import type { ConnectionType, OpsConfigPin, OpsConfigSpec } from "./ops-config-types.ts";
import { CATALOG_PHASE_CORE } from "./workflow-types.ts";
import type {
  CatalogNode,
  CatalogNodeBounds,
  CatalogNodePolicy,
  CatalogPort,
  CatalogRedaction,
  CatalogWithField,
  WorkflowCatalog,
} from "./workflow-types.ts";
import { isCatalogImplementationEnabled } from "./workflow.ts";

export const HTTP_NOTIFICATION_STORY = 109;
export const HTTP_NOTIFICATION_EPIC = 105;
export const HTTP_NOTIFICATION_API_PR = 118;
export const HTTP_NOTIFICATION_ROUTE_MAP_SOURCE = "e104-#118" as const;

export const HTTP_REQUEST_TYPE = "http.request" as const;
export const NOTIFICATION_WEBHOOK_TYPE = "notification.webhook" as const;
export const NOTIFICATION_EMAIL_TYPE = "notification.email" as const;

export const HTTP_NOTIFICATION_ACTION_TYPES = [
  HTTP_REQUEST_TYPE,
  NOTIFICATION_WEBHOOK_TYPE,
  NOTIFICATION_EMAIL_TYPE,
] as const;

export type HttpNotificationActionType =
  (typeof HTTP_NOTIFICATION_ACTION_TYPES)[number];

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export const HTTP_DEFAULT_TIMEOUT_SECONDS = 15;
export const HTTP_MIN_TIMEOUT_SECONDS = 1;
export const HTTP_MAX_TIMEOUT_SECONDS = 60;
export const HTTP_DEFAULT_METHOD: HttpMethod = "GET";
export const HTTP_WEBHOOK_DEFAULT_PATH = "/";

export const HTTP_CONNECTION_TYPE: ConnectionType = "http";
export const WEBHOOK_CONNECTION_TYPE: ConnectionType = "webhook";
export const EMAIL_CONNECTION_TYPE: ConnectionType = "smtp";

/**
 * Never user-controlled. Stripped from wizard `with` before YAML insert.
 * Includes free-form URL / TLS-off / credential / recipient-literal keys.
 */
export const HTTP_NOTIFICATION_FORBIDDEN_WITH_KEYS = [
  "url",
  "uri",
  "href",
  "endpoint",
  "hostname",
  "headers",
  "header",
  "webhookUrl",
  "requestUrl",
  "baseUrl",
  "authorization",
  "token",
  "password",
  "apiKey",
  "secret",
  "credentials",
  "credential",
  "bearer",
  "tlsVerify",
  "insecureSkipVerify",
  "skipTLSVerify",
  "disableTLS",
  "insecure",
  "email",
  "to",
  "cc",
  "bcc",
  "recipient",
  "recipients",
  "subject",
  "body",
  "html",
  "kubeconfig",
  "privateKey",
] as const;

export const HTTP_NOTIFICATION_NODE_POLICY_NOTES = [
  "Pick a published workspace connection. The connection pins host, method, path prefix, TLS, redirect, destination-IP, and size policy. YAML stores resource UUIDs only.",
  "Free-form unrestricted URLs, headers, and destinations are denied. path is a relative allowlisted prefix on the pinned connection. host is an optional allowlisted host on that connection — never a scheme or credential.",
  "TLS is required on the connection. This UI has no toggle that disables verification and no toggle that enables integration actions.",
  "Credentials stay in the vault and bind through the connection. They are never written to node with, YAML, or logs.",
  "http.request may pin an optional published response schema. Request/response bodies are bounded and redacted.",
  "notification.webhook delivers to the pinned webhook connection. Idempotency and redirect policy are connection-owned.",
  "notification.email uses a pinned SMTP connection plus published recipient-list and message-template revisions. Recipients and body text are not free-form.",
  "Secret-bearing fields may cross the HTTP boundary only when the connection policy authorizes that exact field. Delivery results are redacted before display.",
  "SSRF, DNS-rebinding, redirect, and size failures stay closed and surface as validation errors. Loopback and private destinations are denied by default after resolve; opt-in is endpointPolicy.allowPrivateDestinations or a published http/notification policy flag — this UI does not add a toggle.",
  "Selectors fail closed on HTTP 403. Only published workspace resources of the matching connection type are listed.",
] as const;

export const HTTP_CONNECTION_REQUIRED_MESSAGE =
  "connectionId is required. Choose a published workspace connection.";

export const HTTP_CONNECTION_FAIL_CLOSED_MESSAGE =
  "Connection selector failed closed. Only published workspace connections of the matching type are listed; unauthorized or cross-workspace connections are not shown.";

export const HTTP_CONNECTION_TYPE_MESSAGE =
  "The selected connection type must match the node (http.request → http, notification.webhook → webhook, notification.email → smtp).";

export const HTTP_PATH_REQUIRED_MESSAGE =
  "path must be a relative allowlisted path on the pinned connection — never a URL.";

export const HTTP_HOST_MESSAGE =
  "host must be an allowlisted hostname on the pinned connection — never a URL, scheme, or free-form destination.";

export const HTTP_INTEGRATION_GATE_MESSAGE =
  "HTTP and notification actions are disabled by the catalog integration gate. This UI does not offer an enable toggle.";

export const HTTP_UNRESTRICTED_URL_MESSAGE =
  "Free-form unrestricted URLs are denied. Choose a pinned connection and a relative path that stays on that connection's host/path allowlist.";

export const HTTP_TLS_REQUIRED_MESSAGE =
  "TLS verification cannot be disabled. The pinned connection must require TLS.";

export const HTTP_SECRET_WITH_MESSAGE =
  "Credentials, tokens, Authorization headers, and secret-shaped values cannot be stored in HTTP or notification YAML.";

export const HTTP_METHOD_MESSAGE =
  "method must be GET, POST, PUT, PATCH, DELETE, or HEAD.";

export const HTTP_RECIPIENT_REQUIRED_MESSAGE =
  "recipientListId is required. Choose a published recipient list revision.";

export const HTTP_TEMPLATE_REQUIRED_MESSAGE =
  "templateId is required. Choose a published message template revision.";

export const HTTP_RECIPIENT_FAIL_CLOSED_MESSAGE =
  "Recipient list selector failed closed. Only published workspace recipient lists are listed.";

export const HTTP_TEMPLATE_FAIL_CLOSED_MESSAGE =
  "Message template selector failed closed. Only published workspace message templates are listed.";

export const HTTP_SCHEMA_FAIL_CLOSED_MESSAGE =
  "Response schema selector failed closed. Only published workspace response schemas are listed.";

export const HTTP_CONTRACT_FALLBACK_HELP =
  "Using the marked e104-#118 HTTP/notification map because GET /http/catalog, GET /ops-config/catalog httpNotificationEngine, and GET /workflows/catalog allowedWith were unavailable. Collections stay on /connections, /recipient-lists, /message-templates, and /response-schemas. Relates to #109. Keep #109 open.";

export const HTTP_PIN_ONLY_HELP =
  "Operators pick pinned authorized ops-config resources. The UI never offers a free-form URL, recipient address, or credential field.";

export const HTTP_REDACTION_HELP =
  "Delivery results are redacted before display. Authorization, cookies, tokens, and secret-shaped bodies are dropped. Audit fields are connection/template/recipient UUIDs, status, and size — never credentials.";

export const HTTP_EXISTING_API_PATHS = {
  httpCatalog: "/http/catalog",
  workflowCatalog: "/workflows/catalog",
  opsConfigCatalog: "/ops-config/catalog",
  connections: "/connections",
  recipientLists: "/recipient-lists",
  messageTemplates: "/message-templates",
  responseSchemas: "/response-schemas",
  policies: "/policies",
  batchSelect: "/ops-config/select",
  workflowPins: (workflowId: string, versionId: string) =>
    `/workflows/${workflowId}/versions/${versionId}/pins`,
} as const;

export const HTTP_CATALOG_UI_COLLECTION = "http";
export const HTTP_CATALOG_ACTION = "catalog";

export function httpCatalogPath(): string {
  return HTTP_EXISTING_API_PATHS.httpCatalog;
}

export function retargetHttpNotificationApiPath(uiApiPath: string): string {
  return uiApiPath;
}

export function isHttpNotificationProxySegments(segments: string[]): boolean {
  return (
    segments.length === 2 &&
    segments[0] === HTTP_CATALOG_UI_COLLECTION &&
    segments[1] === HTTP_CATALOG_ACTION
  );
}

export type HttpNotificationProxyRoute = {
  methods: readonly string[];
  match: (segments: string[]) => boolean;
};

/** Allowlisted Next proxy route. identity-proxy spreads this so a retarget only edits this file. */
export const HTTP_NOTIFICATION_PROXY_ROUTES: readonly HttpNotificationProxyRoute[] =
  [
    {
      methods: ["GET"],
      match: (s) =>
        s.length === 2 &&
        s[0] === HTTP_CATALOG_UI_COLLECTION &&
        s[1] === HTTP_CATALOG_ACTION,
    },
  ];

export type HttpNotificationCatalogSource =
  | "http-catalog"
  | "workflow-catalog"
  | "ops-config-catalog"
  | "unavailable";

export type HttpNotificationIntegrationGate = {
  name?: string;
  enabled?: boolean;
  nodes?: string[];
  suites?: string[];
  note?: string;
};

export type HttpNotificationEngineNode = {
  type: string;
  title: string;
  description: string;
  permissions: string[];
  requiredWith: string[];
  allowedWith: CatalogWithField[];
  outputs: string[];
  sideEffects: boolean;
  retrySafe: boolean;
  idempotent?: boolean;
  connectionType?: string;
  enabled?: boolean;
  defaultMaxAttempts: number;
};

export type HttpNotificationErrorShape = {
  code: string;
  status: number;
  meaning: string;
};

export type HttpNotificationPolicyRules = {
  tlsRequired: boolean;
  allowRedirectsDefault: boolean;
  maxRequestBytes: number;
  maxResponseBytes: number;
  resolveThenAllowlist: boolean;
  connectVerifiedAddressOnly: boolean;
  secretFieldsPolicyAuthorized: boolean;
  note?: string;
};

export type HttpNotificationCatalog = {
  source: HttpNotificationCatalogSource;
  nodes: HttpNotificationEngineNode[];
  errors: HttpNotificationErrorShape[];
  policy: HttpNotificationPolicyRules;
  permissions: string[];
  integrationGate?: HttpNotificationIntegrationGate;
  notes?: string;
};

export type HttpNotificationWithField = CatalogWithField & {
  label: string;
  advanced?: boolean;
  readOnly?: boolean;
  controlHint: "text" | "textarea" | "enum" | "uuid" | "number" | "object-lines";
  defaultValue?: unknown;
};

export type HttpNotificationConfigContext = {
  connectionSelectorClosed?: boolean;
  recipientSelectorClosed?: boolean;
  templateSelectorClosed?: boolean;
  schemaSelectorClosed?: boolean;
  connectionType?: string | null;
  endpointPolicy?: Record<string, unknown> | null;
  httpCatalog?: HttpNotificationCatalog | null;
  workflowCatalog?: WorkflowCatalog | null;
};

export const DEFAULT_HTTP_POLICY: HttpNotificationPolicyRules = {
  tlsRequired: true,
  allowRedirectsDefault: false,
  maxRequestBytes: 16 * 1024,
  maxResponseBytes: 64 * 1024,
  resolveThenAllowlist: true,
  connectVerifiedAddressOnly: true,
  secretFieldsPolicyAuthorized: true,
  note: "Destination IPs, including redirects, must stay on the connection allowlist. Loopback/private addresses are denied unless allowPrivateDestinations is explicitly true. TLS is required.",
};

export const HTTP_NOTIFICATION_PERMISSIONS = [
  "workflow.execute",
  "connection.use",
] as const;

export const DEFAULT_HTTP_NOTIFICATION_ERRORS: HttpNotificationErrorShape[] = [
  {
    code: "invalid-request",
    status: 400,
    meaning: "Unknown with field, unrestricted URL, or missing required pin.",
  },
  {
    code: "tls-required",
    status: 400,
    meaning: HTTP_TLS_REQUIRED_MESSAGE,
  },
  {
    code: "url-denied",
    status: 400,
    meaning: HTTP_UNRESTRICTED_URL_MESSAGE,
  },
  {
    code: "secret-field",
    status: 400,
    meaning: HTTP_SECRET_WITH_MESSAGE,
  },
  {
    code: "forbidden",
    status: 403,
    meaning:
      "Missing workflow.execute, connection.use, or the matching recipient/template/schema use permission.",
  },
  {
    code: "address-denied",
    status: 403,
    meaning:
      "A resolved destination address, including a redirect, was outside the connection allowlist.",
  },
];

export function isHttpNotificationType(
  type: string,
): type is HttpNotificationActionType {
  return (HTTP_NOTIFICATION_ACTION_TYPES as readonly string[]).includes(type);
}

export function isHttpConfigurableType(type: string): boolean {
  return isHttpNotificationType(type);
}

export function httpNotificationGateClosed(
  catalog?: WorkflowCatalog | null,
  httpCatalog?: HttpNotificationCatalog | null,
): boolean {
  return (
    catalog?.rules?.integrationActionsEnabled === false ||
    catalog?.integrationGate?.enabled === false ||
    httpCatalog?.integrationGate?.enabled === false
  );
}

export function httpNotificationActionsEnabled(
  catalog?: WorkflowCatalog | null,
  httpCatalog?: HttpNotificationCatalog | null,
): boolean {
  if (httpNotificationGateClosed(catalog, httpCatalog)) {
    return false;
  }
  return HTTP_NOTIFICATION_ACTION_TYPES.some((type) =>
    isHttpNotificationNodeEnabled(type, httpCatalog, catalog),
  );
}

export function isHttpNotificationNodeEnabled(
  type: string,
  httpCatalog?: HttpNotificationCatalog | null,
  catalog?: WorkflowCatalog | null,
): boolean {
  if (!isHttpNotificationType(type)) {
    return false;
  }
  if (httpNotificationGateClosed(catalog, httpCatalog)) {
    return false;
  }
  const listed = catalogListsHttpNotificationType(catalog, type);
  const engineListed = Boolean(
    httpCatalog &&
      httpCatalog.source !== "unavailable" &&
      httpCatalog.nodes.some((item) => item.type === type && item.enabled !== false),
  );
  return listed || engineListed;
}

export function httpNotificationLibraryTypes(
  catalog?: WorkflowCatalog | null,
  httpCatalog?: HttpNotificationCatalog | null,
): readonly string[] {
  if (httpNotificationGateClosed(catalog, httpCatalog)) {
    return [];
  }
  const types = new Set<string>();
  for (const node of catalog?.nodes ?? []) {
    if (isHttpNotificationNodeEnabled(node.type, httpCatalog, catalog)) {
      types.add(node.type);
    }
  }
  if (httpCatalog && httpCatalog.source !== "unavailable") {
    for (const node of httpCatalog.nodes) {
      if (isHttpNotificationNodeEnabled(node.type, httpCatalog, catalog)) {
        types.add(node.type);
      }
    }
  }
  return [...types];
}

export function catalogListsHttpNotificationType(
  catalog: WorkflowCatalog | null | undefined,
  type: string,
): boolean {
  return (catalog?.nodes ?? []).some(
    (item) => item.type === type && isCatalogImplementationEnabled(item),
  );
}

export function hasHttpNotificationContract(
  node: CatalogNode | undefined,
): boolean {
  return Boolean(
    node &&
      ((node.allowedWith && node.allowedWith.length > 0) ||
        node.policy ||
        node.bounds ||
        node.redaction),
  );
}

export function connectionTypeForAction(
  type: string,
): ConnectionType | null {
  switch (type) {
    case HTTP_REQUEST_TYPE:
      return HTTP_CONNECTION_TYPE;
    case NOTIFICATION_WEBHOOK_TYPE:
      return WEBHOOK_CONNECTION_TYPE;
    case NOTIFICATION_EMAIL_TYPE:
      return EMAIL_CONNECTION_TYPE;
    default:
      return null;
  }
}

export function defaultHttpNotificationWith(
  type: string,
): Record<string, unknown> {
  if (type === HTTP_REQUEST_TYPE) {
    return {
      method: HTTP_DEFAULT_METHOD,
      timeoutSeconds: HTTP_DEFAULT_TIMEOUT_SECONDS,
    };
  }
  if (isHttpNotificationType(type)) {
    return {};
  }
  return {};
}

export function httpNotificationNodeContract(
  type: string,
  catalog?: HttpNotificationCatalog | null,
): HttpNotificationEngineNode | undefined {
  return catalog?.nodes.find((item) => item.type === type);
}

export function httpNotificationErrorShapes(
  catalog?: HttpNotificationCatalog | null,
): HttpNotificationErrorShape[] {
  return catalog?.errors ?? DEFAULT_HTTP_NOTIFICATION_ERRORS;
}

export function httpNotificationPolicyRules(
  catalog?: HttpNotificationCatalog | null,
): HttpNotificationPolicyRules {
  return catalog?.policy ?? DEFAULT_HTTP_POLICY;
}

export function httpNotificationNodeWithFields(
  type: string,
  httpCatalog?: HttpNotificationCatalog | null,
): HttpNotificationWithField[] {
  const engineNode = httpNotificationNodeContract(type, httpCatalog);
  if (!engineNode?.allowedWith.length) {
    return [];
  }
  return overlayHttpNotificationFields(engineNode.allowedWith, type);
}


function httpNotificationFieldChrome(
  name: string,
  type: string,
): Partial<HttpNotificationWithField> {
  switch (name) {
    case "connectionId":
      return { label: "Connection", controlHint: "uuid" };
    case "method":
      return {
        label: "Method",
        controlHint: "enum",
        defaultValue: HTTP_DEFAULT_METHOD,
        enum: [...HTTP_METHODS],
      };
    case "path":
      return { label: "Path", controlHint: "text" };
    case "host":
      return { label: "Host", controlHint: "text", advanced: true };
    case "timeoutSeconds":
      return {
        label: "Timeout (seconds)",
        controlHint: "number",
        defaultValue: HTTP_DEFAULT_TIMEOUT_SECONDS,
      };
    case "responseSchemaRef":
      return { label: "Response schema", controlHint: "uuid" };
    case "recipientListId":
      return { label: "Recipient list", controlHint: "uuid" };
    case "templateId":
      return { label: "Message template", controlHint: "uuid" };
    case "idempotencyKey":
      return { label: "Idempotency key", controlHint: "text", advanced: true };
    case "policyId":
      return { label: "Policy", controlHint: "uuid", advanced: true };
    default:
      void type;
      return {};
  }
}

export function overlayHttpNotificationFields(
  fields: CatalogWithField[],
  type: string,
): HttpNotificationWithField[] {
  return fields
    .filter((field) => isExposedHttpNotificationField(field.name))
    .map((field) => {
      const chrome = httpNotificationFieldChrome(field.name, type);
      const controlHint =
        chrome.controlHint ??
        (field.kind === "uuid"
          ? "uuid"
          : field.kind === "integer"
            ? "number"
            : field.kind === "object"
              ? "object-lines"
              : field.enum?.length
                ? "enum"
                : "text");
      return {
        name: field.name,
        kind: field.kind,
        required: field.required === true,
        enum: field.enum?.length ? field.enum : chrome.enum,
        description: field.description || chrome.description || "",
        label: chrome.label || field.name,
        advanced:
          field.name === "policyId" ||
          field.name === "host" ||
          field.name === "idempotencyKey" ||
          chrome.advanced,
        readOnly: chrome.readOnly,
        controlHint,
        defaultValue: chrome.defaultValue,
      };
    });
}

export function isExposedHttpNotificationField(name: string): boolean {
  return !(HTTP_NOTIFICATION_FORBIDDEN_WITH_KEYS as readonly string[]).includes(
    name,
  );
}

export function httpNotificationForbiddenWithKeys(
  value: Record<string, unknown>,
): string[] {
  return HTTP_NOTIFICATION_FORBIDDEN_WITH_KEYS.filter((key) => key in value);
}

export function stripHttpNotificationForbiddenWith(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (
      (HTTP_NOTIFICATION_FORBIDDEN_WITH_KEYS as readonly string[]).includes(key)
    ) {
      continue;
    }
    if (isSecretFieldName(key)) {
      continue;
    }
    out[key] = raw;
  }
  return out;
}

export function looksLikeUnrestrictedUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return true;
  }
  if (trimmed.startsWith("//")) {
    return true;
  }
  if (/https?:/i.test(trimmed)) {
    return true;
  }
  if (/^[a-z0-9.-]+\.[a-z]{2,}[:/]/i.test(trimmed)) {
    return true;
  }
  return false;
}

export function isRelativeHttpPath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return false;
  }
  if (looksLikeUnrestrictedUrl(trimmed)) {
    return false;
  }
  if (trimmed.includes("://") || trimmed.includes("\\")) {
    return false;
  }
  return true;
}

export function pathMatchesPrefixes(
  path: string,
  prefixes: readonly string[],
): boolean {
  if (prefixes.length === 0) {
    return true;
  }
  return prefixes.some(
    (prefix) => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}`),
  );
}

export function connectionMatchesAction(
  type: string,
  spec: OpsConfigSpec | null | undefined,
): boolean {
  const expected = connectionTypeForAction(type);
  if (!expected) {
    return false;
  }
  const actual = typeof spec?.type === "string" ? spec.type.trim() : "";
  if (!actual) {
    return true;
  }
  return actual === expected;
}

export function authorizedHttpConnections(input: {
  pins?: OpsConfigPin[] | null;
  nodeType?: string | null;
  problem?: unknown;
  statusCode?: number;
}): {
  options: OpsConfigPin[];
  closed: boolean;
  reason: string | null;
} {
  if (input.problem || (input.statusCode && input.statusCode >= 400)) {
    return {
      options: [],
      closed: true,
      reason: HTTP_CONNECTION_FAIL_CLOSED_MESSAGE,
    };
  }
  const pins = (input.pins ?? []).filter(
    (pin) => pin.kind === "connection" || !pin.kind,
  );
  const matching = pins.filter((pin) => {
    if (!pin.resourceId) {
      return false;
    }
    if (
      input.nodeType &&
      pin.spec &&
      !connectionMatchesAction(input.nodeType, pin.spec)
    ) {
      return false;
    }
    return true;
  });
  if (matching.length === 0) {
    if (pins.length > 0 && input.nodeType) {
      const expected = connectionTypeForAction(input.nodeType);
      return {
        options: [],
        closed: true,
        reason: expected
          ? `No published ${expected} connections. ${HTTP_CONNECTION_TYPE_MESSAGE}`
          : HTTP_CONNECTION_FAIL_CLOSED_MESSAGE,
      };
    }
    return {
      options: [],
      closed: true,
      reason: HTTP_CONNECTION_FAIL_CLOSED_MESSAGE,
    };
  }
  return { options: matching, closed: false, reason: null };
}

export function connectionSelectorLabel(pin: OpsConfigPin): string {
  const name = pin.name?.trim() || pin.slug?.trim() || pin.resourceId;
  const type = typeof pin.spec?.type === "string" ? pin.spec.type.trim() : "";
  const version = pin.versionNumber ? `v${pin.versionNumber}` : pin.versionId;
  return type ? `${name} (${type}) @ ${version}` : `${name} @ ${version}`;
}

export function tlsRequiredOnConnection(
  spec: OpsConfigSpec | null | undefined,
): boolean {
  const policy = asRecord(spec?.endpointPolicy);
  if (!policy) {
    return true;
  }
  return policy.tlsRequired !== false;
}

export function methodsFromConnection(
  spec: OpsConfigSpec | null | undefined,
): string[] {
  const policy = asRecord(spec?.endpointPolicy);
  return stringList(policy?.methods).map((item) => item.toUpperCase());
}

export function pathPrefixesFromConnection(
  spec: OpsConfigSpec | null | undefined,
): string[] {
  const policy = asRecord(spec?.endpointPolicy);
  return stringList(policy?.pathPrefixes);
}

export function validateHttpNotificationConfig(
  type: string,
  withValue: Record<string, unknown>,
  context: HttpNotificationConfigContext = {},
): string[] {
  if (!isHttpNotificationType(type)) {
    return [];
  }
  const errors: string[] = [];
  if (httpNotificationGateClosed(context.workflowCatalog, context.httpCatalog)) {
    errors.push(HTTP_INTEGRATION_GATE_MESSAGE);
  }
  if (context.connectionSelectorClosed) {
    errors.push(HTTP_CONNECTION_FAIL_CLOSED_MESSAGE);
  }
  if (type === NOTIFICATION_EMAIL_TYPE && context.recipientSelectorClosed) {
    errors.push(HTTP_RECIPIENT_FAIL_CLOSED_MESSAGE);
  }
  if (type === NOTIFICATION_EMAIL_TYPE && context.templateSelectorClosed) {
    errors.push(HTTP_TEMPLATE_FAIL_CLOSED_MESSAGE);
  }
  if (type === HTTP_REQUEST_TYPE && context.schemaSelectorClosed) {
    errors.push(HTTP_SCHEMA_FAIL_CLOSED_MESSAGE);
  }

  const forbidden = httpNotificationForbiddenWithKeys(withValue);
  if (forbidden.length > 0) {
    if (
      forbidden.some((key) =>
        [
          "url",
          "uri",
          "href",
          "endpoint",
          "hostname",
          "headers",
          "header",
          "webhookUrl",
          "requestUrl",
          "baseUrl",
        ].includes(key),
      )
    ) {
      errors.push(HTTP_UNRESTRICTED_URL_MESSAGE);
    }
    if (
      forbidden.some((key) =>
        [
          "tlsVerify",
          "insecureSkipVerify",
          "skipTLSVerify",
          "disableTLS",
          "insecure",
        ].includes(key),
      )
    ) {
      errors.push(HTTP_TLS_REQUIRED_MESSAGE);
    }
    if (
      forbidden.some((key) =>
        [
          "authorization",
          "token",
          "password",
          "apiKey",
          "secret",
          "credentials",
          "credential",
          "bearer",
          "kubeconfig",
          "privateKey",
        ].includes(key),
      )
    ) {
      errors.push(HTTP_SECRET_WITH_MESSAGE);
    }
    if (
      type === NOTIFICATION_EMAIL_TYPE &&
      forbidden.some((key) =>
        [
          "email",
          "to",
          "cc",
          "bcc",
          "recipient",
          "recipients",
          "subject",
          "body",
          "html",
        ].includes(key),
      )
    ) {
      errors.push(HTTP_RECIPIENT_REQUIRED_MESSAGE);
    }
  }

  const connectionId =
    typeof withValue.connectionId === "string"
      ? withValue.connectionId.trim()
      : "";
  if (!connectionId) {
    errors.push(HTTP_CONNECTION_REQUIRED_MESSAGE);
  } else if (!isResourceId(connectionId)) {
    errors.push("connectionId must be a workspace UUID.");
  }

  const expectedType = connectionTypeForAction(type);
  if (
    context.connectionType &&
    expectedType &&
    context.connectionType !== expectedType
  ) {
    errors.push(HTTP_CONNECTION_TYPE_MESSAGE);
  }
  if (context.endpointPolicy && context.endpointPolicy.tlsRequired === false) {
    errors.push(HTTP_TLS_REQUIRED_MESSAGE);
  }

  if (typeof withValue.method === "string" && withValue.method.trim()) {
    const method = withValue.method.trim().toUpperCase();
    if (!(HTTP_METHODS as readonly string[]).includes(method)) {
      errors.push(HTTP_METHOD_MESSAGE);
    } else {
      const allowed = methodsFromPolicy(context.endpointPolicy);
      if (allowed.length > 0 && !allowed.includes(method)) {
        errors.push(
          `method ${method} is not allowlisted on the pinned connection (${allowed.join(", ")}).`,
        );
      }
    }
  }

  if (typeof withValue.path === "string" && withValue.path.trim()) {
    const path = withValue.path.trim();
    if (!isRelativeHttpPath(path) || looksLikeUnrestrictedUrl(path)) {
      errors.push(HTTP_UNRESTRICTED_URL_MESSAGE);
    } else {
      const prefixes = pathPrefixesFromPolicy(context.endpointPolicy);
      if (prefixes.length > 0 && !pathMatchesPrefixes(path, prefixes)) {
        errors.push(
          `path must stay on the pinned connection path prefixes (${prefixes.join(", ")}).`,
        );
      }
    }
  }

  if (typeof withValue.host === "string" && withValue.host.trim()) {
    const host = withValue.host.trim();
    if (looksLikeUnrestrictedUrl(host) || host.includes("/") || host.includes("@")) {
      errors.push(HTTP_HOST_MESSAGE);
    } else {
      const allowedHosts = hostsFromPolicy(context.endpointPolicy);
      if (allowedHosts.length > 0 && !allowedHosts.includes(host)) {
        errors.push(
          `host must stay on the pinned connection allowlist (${allowedHosts.join(", ")}).`,
        );
      }
    }
  }

  if (type === NOTIFICATION_EMAIL_TYPE) {
    const recipientListId =
      typeof withValue.recipientListId === "string"
        ? withValue.recipientListId.trim()
        : "";
    if (!recipientListId) {
      errors.push(HTTP_RECIPIENT_REQUIRED_MESSAGE);
    } else if (!isResourceId(recipientListId)) {
      errors.push("recipientListId must be a workspace UUID.");
    }
    const templateId =
      typeof withValue.templateId === "string"
        ? withValue.templateId.trim()
        : "";
    if (!templateId) {
      errors.push(HTTP_TEMPLATE_REQUIRED_MESSAGE);
    } else if (!isResourceId(templateId)) {
      errors.push("templateId must be a workspace UUID.");
    }
  }

  if (withValue.responseSchemaRef !== undefined && withValue.responseSchemaRef !== "") {
    const schemaRef = String(withValue.responseSchemaRef).trim();
    if (!isResourceId(schemaRef)) {
      errors.push("responseSchemaRef must be a workspace UUID.");
    }
  }
  if (withValue.policyId !== undefined && withValue.policyId !== "") {
    const policyId = String(withValue.policyId).trim();
    if (!isResourceId(policyId)) {
      errors.push("policyId must be a workspace UUID.");
    }
  }
  if (withValue.timeoutSeconds !== undefined) {
    const timeout = Number(withValue.timeoutSeconds);
    if (
      !Number.isFinite(timeout) ||
      timeout < HTTP_MIN_TIMEOUT_SECONDS ||
      timeout > HTTP_MAX_TIMEOUT_SECONDS
    ) {
      errors.push(
        `timeoutSeconds must be between ${HTTP_MIN_TIMEOUT_SECONDS} and ${HTTP_MAX_TIMEOUT_SECONDS}.`,
      );
    }
  }

  for (const [key, value] of Object.entries(withValue)) {
    if (
      typeof value === "string" &&
      looksLikeUnrestrictedUrl(value) &&
      key !== "path" &&
      key !== "host"
    ) {
      errors.push(HTTP_UNRESTRICTED_URL_MESSAGE);
    }
    if (typeof value === "string" && isSecretFieldName(key)) {
      errors.push(HTTP_SECRET_WITH_MESSAGE);
    }
  }

  return unique(errors);
}

export function httpNotificationFallbackNode(type: string): CatalogNode {
  return {
    type,
    phase: CATALOG_PHASE_CORE,
    title: type,
    description: ENGINE_CATALOG_UNAVAILABLE_HELP,
    inputs: [],
    outputs: [],
    requiredWith: [],
    allowedWith: [],
  };
}

export function adaptHttpNotificationEntries(
  catalog: WorkflowCatalog | null | undefined,
  httpCatalog?: HttpNotificationCatalog | null,
): CatalogNode[] {
  return httpNotificationLibraryTypes(catalog, httpCatalog).flatMap((type) => {
    const listed = (catalog?.nodes ?? []).find((item) => item.type === type);
    const engine = httpNotificationNodeContract(type, httpCatalog);
    if (!listed && !engine) {
      return [];
    }
    const engineAllowed = engine?.allowedWith.length
      ? engine.allowedWith
      : undefined;
    return [
      {
        type,
        phase: listed?.phase ?? CATALOG_PHASE_CORE,
        title: listed?.title || engine?.title || type,
        description: listed?.description || engine?.description || "",
        inputs: listed?.inputs ?? [],
        outputs: listed?.outputs ?? [],
        requiredWith: listed?.requiredWith?.length
          ? listed.requiredWith
          : engine?.requiredWith ?? [],
        allowedWith: listed?.allowedWith?.length
          ? listed.allowedWith
          : engineAllowed ?? [],
        policy: listed?.policy ?? null,
        bounds: listed?.bounds ?? null,
        redaction: listed?.redaction ?? null,
      },
    ];
  });
}

export function parseHttpNotificationCatalog(
  raw: unknown,
): HttpNotificationCatalog {
  if (!raw || typeof raw !== "object") {
    return { ...HTTP_NOTIFICATION_UNAVAILABLE_CATALOG };
  }
  const rec = raw as Record<string, unknown>;
  const hasHttpNotificationEngine = Boolean(firstRecord(rec.httpNotificationEngine));
  const hasLegacyEngine = Boolean(
    rec.httpEngine || rec.notificationEngine || rec.http || rec.notifications,
  );
  const engineBlob =
    firstRecord(rec.httpNotificationEngine) ??
    firstRecord(rec.httpEngine) ??
    firstRecord(rec.notificationEngine) ??
    firstRecord(rec.http) ??
    firstRecord(rec.notifications) ??
    rec;
  const nodesRaw = Array.isArray(engineBlob.nodes)
    ? engineBlob.nodes
    : Array.isArray(rec.nodes)
      ? rec.nodes
      : [];
  const nodes = nodesRaw
    .map(parseEngineNode)
    .filter((item): item is HttpNotificationEngineNode => item !== null);
  const errorsRaw = Array.isArray(engineBlob.errors)
    ? engineBlob.errors
    : Array.isArray(rec.errors)
      ? rec.errors
      : [];
  const errors = errorsRaw
    .map(parseEngineError)
    .filter((item): item is HttpNotificationErrorShape => item !== null);
  const policy =
    parsePolicy(engineBlob.policy ?? rec.policy) ??
    parseIsolationAsPolicy(engineBlob.isolation ?? rec.isolation);
  const permissions = stringList(engineBlob.permissions ?? rec.permissions);
  const integrationGate = parseIntegrationGate(
    engineBlob.integrationGate ?? rec.integrationGate ?? engineBlob.gate ?? rec.gate,
  );
  const looksLikeHttpCatalog = Boolean(
    engineBlob.isolation ||
      rec.isolation ||
      engineBlob.publishRules ||
      rec.publishRules ||
      integrationGate,
  );
  if (
    nodes.length === 0 &&
    errors.length === 0 &&
    !policy &&
    permissions.length === 0 &&
    !integrationGate
  ) {
    return { ...HTTP_NOTIFICATION_UNAVAILABLE_CATALOG };
  }
  const source: HttpNotificationCatalogSource = hasHttpNotificationEngine || hasLegacyEngine
    ? "ops-config-catalog"
    : looksLikeHttpCatalog
      ? "http-catalog"
      : nodes.length > 0
        ? "workflow-catalog"
        : "unavailable";
  return {
    source,
    nodes,
    errors,
    policy: policy ?? DEFAULT_HTTP_POLICY,
    permissions,
    integrationGate,
    notes: String(engineBlob.notes ?? rec.notes ?? "").trim() || undefined,
  };
}

export const HTTP_NOTIFICATION_UNAVAILABLE_CATALOG: HttpNotificationCatalog = {
  source: CATALOG_SOURCE_UNAVAILABLE,
  nodes: [],
  errors: [],
  policy: DEFAULT_HTTP_POLICY,
  permissions: [],
  notes: ENGINE_CATALOG_UNAVAILABLE_HELP,
};

/** @deprecated R3.4 — empty fail-closed catalog. Kept for import compatibility. */
export const HTTP_NOTIFICATION_CONTRACT_FALLBACK_CATALOG =
  HTTP_NOTIFICATION_UNAVAILABLE_CATALOG;

/**
 * Extra delivery keys stripped from HTTP/notification execution
 * results. Generic stripSecretFields already covers authorization /
 * token / cookie / set_cookie.
 */
export const HTTP_DELIVERY_SECRET_KEYS = [
  "set-cookie",
  "setcookie",
  "www-authenticate",
  "wwwauthenticate",
  "proxy-authorization",
  "proxyauthorization",
  "rawbody",
  "raw_body",
  "rawBody",
] as const;

export function redactHttpNotificationDelivery(value: unknown): unknown {
  return dropDeliverySecrets(value);
}

export function deliveryHasForbiddenSecret(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(deliveryHasForbiddenSecret);
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isHttpDeliverySecretKey(key) || isSecretFieldName(key)) {
      if (child !== "[redacted]") {
        return true;
      }
    }
    if (deliveryHasForbiddenSecret(child)) {
      return true;
    }
  }
  return false;
}

function dropDeliverySecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(dropDeliverySecrets);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isHttpDeliverySecretKey(key) || isSecretFieldName(key)) {
      continue;
    }
    out[key] = dropDeliverySecrets(child);
  }
  return out;
}

function isHttpDeliverySecretKey(key: string): boolean {
  const compact = key.toLowerCase().replace(/[-_]/g, "");
  return (HTTP_DELIVERY_SECRET_KEYS as readonly string[]).some(
    (item) => item.toLowerCase().replace(/[-_]/g, "") === compact,
  );
}

function parseEngineNode(raw: unknown): HttpNotificationEngineNode | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const rec = raw as Record<string, unknown>;
  const type = String(rec.type ?? "").trim();
  if (!isHttpNotificationType(type)) {
    return null;
  }
  const allowedWith = Array.isArray(rec.allowedWith)
    ? rec.allowedWith
        .map(parseAllowedField)
        .filter((item): item is CatalogWithField => item !== null)
    : [];
  return {
    type,
    title: String(rec.title ?? "").trim() || type,
    description: String(rec.description ?? "").trim(),
    permissions: stringList(rec.permissions),
    requiredWith: stringList(rec.requiredWith),
    allowedWith,
    outputs: stringList(rec.outputs),
    sideEffects: rec.sideEffects !== false,
    retrySafe: rec.retrySafe === true,
    idempotent: rec.idempotent === true,
    connectionType: String(rec.connectionType ?? rec.connection ?? "").trim() || undefined,
    enabled: rec.enabled !== false,
    defaultMaxAttempts: Number.isFinite(Number(rec.defaultMaxAttempts))
      ? Number(rec.defaultMaxAttempts)
      : 1,
  };
}

function parseAllowedField(raw: unknown): CatalogWithField | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const rec = raw as Record<string, unknown>;
  const name = String(rec.name ?? "").trim();
  if (!name || !isExposedHttpNotificationField(name)) {
    return null;
  }
  return {
    name,
    kind: String(rec.kind ?? "string"),
    required: rec.required === true,
    enum: stringList(rec.enum),
    description: String(rec.description ?? "").trim() || undefined,
  };
}

function parseEngineError(raw: unknown): HttpNotificationErrorShape | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const rec = raw as Record<string, unknown>;
  const code = String(rec.code ?? "").trim();
  if (!code) {
    return null;
  }
  return {
    code,
    status: Number.isFinite(Number(rec.status)) ? Number(rec.status) : 400,
    meaning: String(rec.meaning ?? rec.detail ?? "").trim(),
  };
}

function parsePolicy(raw: unknown): HttpNotificationPolicyRules | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const rec = raw as Record<string, unknown>;
  const looksLike =
    rec.tlsRequired !== undefined ||
    rec.connectVerifiedAddressOnly !== undefined ||
    rec.resolveThenAllowlist !== undefined ||
    rec.maxResponseBytes !== undefined;
  if (!looksLike) {
    return undefined;
  }
  return {
    tlsRequired: rec.tlsRequired !== false,
    allowRedirectsDefault: rec.allowRedirectsDefault === true,
    maxRequestBytes: Number.isFinite(Number(rec.maxRequestBytes))
      ? Number(rec.maxRequestBytes)
      : DEFAULT_HTTP_POLICY.maxRequestBytes,
    maxResponseBytes: Number.isFinite(Number(rec.maxResponseBytes))
      ? Number(rec.maxResponseBytes)
      : DEFAULT_HTTP_POLICY.maxResponseBytes,
    resolveThenAllowlist: rec.resolveThenAllowlist !== false,
    connectVerifiedAddressOnly: rec.connectVerifiedAddressOnly !== false,
    secretFieldsPolicyAuthorized: rec.secretFieldsPolicyAuthorized !== false,
    note: String(rec.note ?? "").trim() || DEFAULT_HTTP_POLICY.note,
  };
}

function methodsFromPolicy(
  policy: Record<string, unknown> | null | undefined,
): string[] {
  return stringList(policy?.methods).map((item) => item.toUpperCase());
}

function pathPrefixesFromPolicy(
  policy: Record<string, unknown> | null | undefined,
): string[] {
  return stringList(policy?.pathPrefixes);
}

function hostsFromPolicy(
  policy: Record<string, unknown> | null | undefined,
): string[] {
  return stringList(
    policy?.hosts ?? policy?.allowedHosts ?? policy?.allowedHostnames,
  );
}

function parseIsolationAsPolicy(
  raw: unknown,
): HttpNotificationPolicyRules | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const rec = raw as Record<string, unknown>;
  const looksLike =
    rec.tlsVerificationRequired !== undefined ||
    rec.connectVerifiedAddressOnly !== undefined ||
    rec.ssrfDenied !== undefined ||
    rec.dnsRebindingDenied !== undefined ||
    rec.userSuppliedURLDenied !== undefined;
  if (!looksLike) {
    return undefined;
  }
  return {
    tlsRequired: rec.tlsVerificationRequired !== false,
    allowRedirectsDefault: rec.redirectsDefaultDenied === false,
    maxRequestBytes: DEFAULT_HTTP_POLICY.maxRequestBytes,
    maxResponseBytes: DEFAULT_HTTP_POLICY.maxResponseBytes,
    resolveThenAllowlist: rec.dnsRebindingDenied !== false,
    connectVerifiedAddressOnly: rec.connectVerifiedAddressOnly !== false,
    secretFieldsPolicyAuthorized: rec.secretFieldsPolicyGated !== false,
    note: String(rec.note ?? "").trim() || DEFAULT_HTTP_POLICY.note,
  };
}

function parseIntegrationGate(
  raw: unknown,
): HttpNotificationIntegrationGate | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const rec = raw as Record<string, unknown>;
  if (
    rec.enabled === undefined &&
    rec.name === undefined &&
    rec.nodes === undefined
  ) {
    return undefined;
  }
  return {
    name: String(rec.name ?? "").trim() || undefined,
    enabled: rec.enabled !== false,
    nodes: stringList(rec.nodes),
    suites: stringList(rec.suites),
    note: String(rec.note ?? "").trim() || undefined,
  };
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
