import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ALERT_ACK_ACTION,
  ALERT_ACK_ROUTE_PUBLISHED,
  ALERT_EPIC,
  ALERT_RESOLVE_ACTION,
  ALERT_STORY,
  ALERT_UI_COLLECTION,
  ALERT_UPSTREAM_COLLECTION,
  AUDIT_MUTATION_METHODS,
  ISOLATION_AUDIT_SEGMENTS,
  WORKSPACE_AUDIT_COLLECTION,
  alertAckPath,
  alertHistoryHref,
  alertPath,
  alertResolvePath,
  alertsCatalogPath,
  alertsPath,
  auditBrowserHref,
  buildAlertAckBody,
  buildAlertResolveBody,
  isolationAuditEventsPath,
  isAlertProxySegments,
  isIsolationAuditSegments,
  isProductAuditSegments,
  listAlertsPath,
  listWorkspaceAuditEventsPath,
  retargetAlertApiPath,
  workspaceAuditEventPath,
  workspaceAuditEventsPath,
} from "./alert-contract.ts";
import {
  alertContainsSecret,
  alertDetailText,
  alertKindLabel,
  alertListText,
  alertSeverityPresentation,
  alertStatusLabel,
  auditBrowserText,
  auditRowAffordances,
  canAckAlert,
  canManageAlerts,
  canResolveAlert,
  canSeeAlertsNav,
  canSeeAuditNav,
  filterAlertList,
  hasAuditMutationAffordance,
  listedResourceIds,
  parseAlertCatalog,
  parseAlertList,
  parseOperationalAlert,
  parseWorkspaceAuditEvent,
  parseWorkspaceAuditList,
  safeAlertMessage,
  stripSecretFields,
} from "./alert.ts";
import type { OperationalAlert } from "./alert-types.ts";

const ALERT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EXECUTION_ID = "33333333-3333-4333-8333-333333333333";
const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
const CORRELATION_ID = "corr-e54-authorization";

function sampleAlert(
  overrides: Partial<OperationalAlert> = {},
): OperationalAlert {
  return {
    id: ALERT_ID,
    kind: "authorization",
    severity: "high",
    status: "open",
    message: "Authorization failed for execution",
    correlationId: CORRELATION_ID,
    resourceType: "execution",
    resourceId: EXECUTION_ID,
    resourceIds: {
      executionId: EXECUTION_ID,
      workflowId: WORKFLOW_ID,
      workflowVersionId: "",
      stepId: "",
      jobId: "",
      artifactId: "",
      approvalId: "",
      policyId: "",
      credentialId: "",
      extra: {},
    },
    occurredAt: "2026-09-09T03:00:00.000Z",
    createdAt: "2026-09-09T03:00:00.000Z",
    updatedAt: "",
    acknowledgedAt: "",
    resolvedAt: "",
    permittedActions: ["ack", "resolve"],
    ...overrides,
  };
}

describe("alert contract adapter", () => {
  it("keeps story/epic citations and a single retarget point", () => {
    assert.equal(ALERT_STORY, 49);
    assert.equal(ALERT_EPIC, 45);
    assert.equal(ALERT_UI_COLLECTION, "alerts");
    assert.equal(ALERT_UPSTREAM_COLLECTION, "alerts");
    assert.equal(alertsPath(), "/alerts");
    assert.equal(alertsCatalogPath(), "/alerts/catalog");
    assert.equal(alertPath(ALERT_ID), `/alerts/${ALERT_ID}`);
    assert.equal(alertAckPath(ALERT_ID), `/alerts/${ALERT_ID}/ack`);
    assert.equal(alertResolvePath(ALERT_ID), `/alerts/${ALERT_ID}/resolve`);
    assert.equal(alertHistoryHref(ALERT_ID), `/alerts/${ALERT_ID}`);
    assert.equal(auditBrowserHref(), "/audit");
    assert.equal(workspaceAuditEventsPath(), "/audit-events");
    assert.equal(
      workspaceAuditEventPath(ALERT_ID),
      `/audit-events/${ALERT_ID}`,
    );
    assert.equal(isolationAuditEventsPath(), "/workspace/audit-events");
    assert.deepEqual(buildAlertAckBody(), {});
    assert.deepEqual(buildAlertResolveBody(), {});
    assert.ok(!("workspaceId" in buildAlertAckBody()));
    assert.ok(!("id" in buildAlertResolveBody()));
  });

  it("lists with documented query keys only", () => {
    assert.equal(
      listAlertsPath({
        kind: "authorization",
        severity: "high",
        status: "open",
        limit: 25,
      }),
      "/alerts?kind=authorization&severity=high&status=open&limit=25",
    );
    assert.equal(
      listWorkspaceAuditEventsPath({
        resourceType: "execution",
        resourceId: EXECUTION_ID,
        action: "execution.start",
        limit: 10,
      }),
      `/audit-events?resourceType=execution&resourceId=${EXECUTION_ID}&action=execution.start&limit=10`,
    );
  });

  it("retargets alerts onto /api/v1 and keeps product audit off the E2.2 stub", () => {
    assert.equal(retargetAlertApiPath("/api/v1/alerts"), "/api/v1/alerts");
    assert.equal(
      retargetAlertApiPath(`/api/v1/alerts/${ALERT_ID}/ack`),
      `/api/v1/alerts/${ALERT_ID}/ack`,
    );
    assert.equal(
      retargetAlertApiPath("/api/v1/audit-events"),
      "/api/v1/audit-events",
    );
    assert.ok(isAlertProxySegments(["alerts"]));
    assert.ok(isAlertProxySegments(["alerts", ALERT_ID]));
    assert.ok(isAlertProxySegments(["audit-events", ALERT_ID]));
    assert.ok(!isAlertProxySegments(["workspace", "audit-events"]));
    assert.ok(isProductAuditSegments(["audit-events"]));
    assert.ok(isIsolationAuditSegments([...ISOLATION_AUDIT_SEGMENTS]));
    assert.ok(!isIsolationAuditSegments([WORKSPACE_AUDIT_COLLECTION]));
    assert.equal(ALERT_ACK_ACTION, "ack");
    assert.equal(ALERT_RESOLVE_ACTION, "resolve");
    assert.equal(ALERT_ACK_ROUTE_PUBLISHED, true);
  });
});

describe("secret-free alert rendering", () => {
  it("shows kind, severity, timestamps, correlation id, and resource ids", () => {
    const text = alertDetailText(sampleAlert());
    assert.match(text, /Authorization/);
    assert.match(text, /High/);
    assert.match(text, new RegExp(CORRELATION_ID));
    assert.match(text, new RegExp(EXECUTION_ID));
    assert.match(text, new RegExp(WORKFLOW_ID));
    assert.match(text, /2026-09-09T03:00:00.000Z/);
    assert.equal(alertContainsSecret(text), false);
  });

  it("strips unexpected secret fields and never renders leaked values", () => {
    const stripped: string[] = [];
    const cleaned = stripSecretFields(
      {
        id: ALERT_ID,
        kind: "redaction",
        severity: "critical",
        status: "open",
        message: "Redaction failed",
        correlationId: CORRELATION_ID,
        resourceId: EXECUTION_ID,
        secret: "should-not-leak",
        token: "hunter2",
        kubeconfig: "cluster-admin",
        privateKey: "-----BEGIN PRIVATE KEY-----",
        password: "super-secret",
      },
      stripped,
    );
    const parsed = parseOperationalAlert(cleaned);
    assert.ok(parsed);
    const text = alertDetailText(parsed);
    assert.equal(alertContainsSecret(text), false);
    assert.ok(!text.includes("should-not-leak"));
    assert.ok(!text.includes("hunter2"));
    assert.ok(!text.includes("cluster-admin"));
    assert.ok(!text.includes("BEGIN PRIVATE KEY"));
    assert.ok(stripped.includes("secret"));
    assert.ok(stripped.includes("token"));
  });

  it("replaces a secret-shaped message with the redacted marker", () => {
    assert.equal(safeAlertMessage("-----BEGIN RSA PRIVATE KEY-----"), "[redacted]");
    assert.equal(safeAlertMessage("Authorization failed"), "Authorization failed");
    const parsed = parseOperationalAlert({
      id: ALERT_ID,
      kind: "redaction",
      message: "super-secret leaked",
      correlationId: CORRELATION_ID,
    });
    assert.ok(parsed);
    assert.equal(parsed.message, "[redacted]");
    assert.equal(alertContainsSecret(alertListText([parsed])), false);
  });

  it("parses resource id maps without secret leaves", () => {
    const parsed = parseOperationalAlert({
      id: ALERT_ID,
      kind: "policy",
      severity: "medium",
      message: "Policy denied dispatch",
      correlationId: CORRELATION_ID,
      resourceType: "execution",
      resourceId: EXECUTION_ID,
      resourceIds: {
        executionId: EXECUTION_ID,
        workflowId: WORKFLOW_ID,
        token: "should-not-leak",
      },
      secret: "hunter2",
    });
    assert.ok(parsed);
    const ids = listedResourceIds(parsed.resourceIds);
    assert.deepEqual(ids, [
      ["executionId", EXECUTION_ID],
      ["workflowId", WORKFLOW_ID],
    ]);
    assert.equal(alertContainsSecret(alertDetailText(parsed)), false);
  });

  it("parses a list envelope and filters by documented fields", () => {
    const items = parseAlertList({
      items: [
        sampleAlert(),
        {
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          kind: "replay",
          severity: "low",
          status: "resolved",
          message: "Replay rejected",
          correlationId: "corr-e54-replay",
          resourceId: EXECUTION_ID,
        },
      ],
    });
    assert.equal(items.length, 2);
    const openAuth = filterAlertList(items, {
      kind: "authorization",
      status: "open",
    });
    assert.equal(openAuth.length, 1);
    assert.equal(openAuth[0]?.id, ALERT_ID);
    assert.match(alertListText(items), /Replay/);
  });

  it("falls back to a catalog when the API omits kinds", () => {
    const catalog = parseAlertCatalog({});
    assert.ok(catalog.kinds.includes("authorization"));
    assert.ok(catalog.kinds.includes("replay"));
    assert.ok(catalog.kinds.includes("policy"));
    assert.ok(catalog.kinds.includes("redaction"));
  });
});

describe("RBAC and ack/resolve affordances", () => {
  it("shows Alerts / Audit nav for execution.view until alert.* lands", () => {
    assert.equal(canSeeAlertsNav(null), true);
    assert.equal(canSeeAlertsNav(["execution.view"]), true);
    assert.equal(canSeeAlertsNav(["alert.view"]), true);
    assert.equal(canSeeAuditNav(["audit.view"]), true);
    assert.equal(canSeeAuditNav(["execution.view"]), true);
    assert.equal(canSeeAlertsNav([]), false);
    assert.equal(canSeeAlertsNav(["workflow.view"]), false);
  });

  it("gates ack/resolve on published mutations, status, and manage perms", () => {
    assert.equal(
      canAckAlert({
        permissions: ["execution.cancel"],
        status: "open",
      }),
      true,
    );
    assert.equal(
      canAckAlert({
        permissions: ["execution.view"],
        status: "open",
      }),
      false,
    );
    assert.equal(
      canAckAlert({
        permissions: ["execution.cancel"],
        status: "acknowledged",
      }),
      false,
    );
    assert.equal(
      canResolveAlert({
        permissions: ["workspace.administer"],
        status: "acknowledged",
      }),
      true,
    );
    assert.equal(
      canResolveAlert({
        permissions: ["alert.manage"],
        status: "resolved",
      }),
      false,
    );
    assert.equal(canManageAlerts(["execution.view"]), false);
    assert.equal(canManageAlerts(["execution.cancel"]), true);
    assert.equal(alertSeverityPresentation("critical").tone, "critical");
    assert.equal(alertKindLabel("redaction"), "Redaction");
    assert.equal(alertStatusLabel("acked"), "Acknowledged");
  });
});

describe("append-only audit browsing", () => {
  it("never offers edit/delete affordances on audit rows", () => {
    const affordances = auditRowAffordances();
    assert.equal(affordances.canEdit, false);
    assert.equal(affordances.canDelete, false);
    assert.equal(affordances.canMutate, false);
    assert.ok(AUDIT_MUTATION_METHODS.includes("PUT"));
    assert.ok(AUDIT_MUTATION_METHODS.includes("PATCH"));
    assert.ok(AUDIT_MUTATION_METHODS.includes("DELETE"));
    assert.ok(AUDIT_MUTATION_METHODS.includes("POST"));
    const text = auditBrowserText([
      {
        id: ALERT_ID,
        action: "alert.emit",
        outcome: "denied",
        resourceType: "execution",
        resourceId: EXECUTION_ID,
        correlationId: CORRELATION_ID,
        occurredAt: "2026-09-09T03:00:00.000Z",
        actorId: "user-1",
        details: { secret: "[redacted]" },
      },
    ]);
    assert.equal(hasAuditMutationAffordance(text), false);
    assert.match(text, /append-only/);
    assert.ok(!text.toLowerCase().includes("edit audit"));
    assert.ok(!text.toLowerCase().includes("delete audit"));
  });

  it("parses workspace audit rows and strips secrets from details", () => {
    const parsed = parseWorkspaceAuditEvent({
      id: ALERT_ID,
      action: "policy.denied",
      outcome: "denied",
      resourceType: "execution",
      resourceId: EXECUTION_ID,
      correlationId: CORRELATION_ID,
      occurredAt: "2026-09-09T03:00:00.000Z",
      actorId: "user-1",
      details: { reason: "deny", token: "should-not-leak" },
      password: "super-secret",
    });
    assert.ok(parsed);
    const text = auditBrowserText([parsed]);
    assert.equal(alertContainsSecret(text), false);
    assert.ok(!text.includes("should-not-leak"));
    assert.ok(!text.includes("super-secret"));
    const list = parseWorkspaceAuditList({
      items: [{ id: ALERT_ID, action: "execution.start" }],
    });
    assert.equal(list.length, 1);
  });
});
