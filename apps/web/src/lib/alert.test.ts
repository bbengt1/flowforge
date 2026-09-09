import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ALERT_ACK_ACTION,
  ALERT_ACK_ROUTE_PUBLISHED,
  ALERT_API_PR,
  ALERT_EPIC,
  ALERT_STORY,
  ALERT_UI_COLLECTION,
  ALERT_UPSTREAM_COLLECTION,
  AUDIT_MUTATION_METHODS,
  ISOLATION_AUDIT_SEGMENTS,
  WORKSPACE_AUDIT_COLLECTION,
  alertAckPath,
  alertHistoryHref,
  alertPath,
  alertsPath,
  auditBrowserHref,
  buildAlertAckBody,
  executionCorrelateHref,
  isolationAuditEventsPath,
  isAlertProxySegments,
  isIsolationAuditSegments,
  isProductAuditSegments,
  listAlertsPath,
  listWorkspaceAuditEventsPath,
  retargetAlertApiPath,
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
  canAckWithPermission,
  canSeeAlertsNav,
  canSeeAuditNav,
  documentedAlertKinds,
  filterAlertList,
  hasAuditMutationAffordance,
  parseAlertList,
  parseOperationalAlert,
  parseWorkspaceAuditEvent,
  parseWorkspaceAuditList,
  safeAlertText,
  stripAlertForbiddenFields,
} from "./alert.ts";
import type { OperationalAlert } from "./alert-types.ts";

const ALERT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EXECUTION_ID = "33333333-3333-4333-8333-333333333333";
const CORRELATION_ID = "corr-e54-authorization";
const REQUEST_ID = "req-e54-authorization";

function sampleAlert(
  overrides: Partial<OperationalAlert> = {},
): OperationalAlert {
  return {
    id: ALERT_ID,
    kind: "authorization",
    severity: "warning",
    status: "open",
    action: "authorization.denied",
    resourceType: "execution",
    resourceId: EXECUTION_ID,
    correlationId: CORRELATION_ID,
    requestId: REQUEST_ID,
    actorId: "user-1",
    outcome: "denied",
    code: "forbidden",
    acknowledgedAt: "",
    acknowledgedBy: "",
    occurredAt: "2026-09-09T03:00:00.000Z",
    ...overrides,
  };
}

describe("alert contract adapter", () => {
  it("keeps story/epic citations and the #58 retarget point", () => {
    assert.equal(ALERT_STORY, 49);
    assert.equal(ALERT_EPIC, 45);
    assert.equal(ALERT_API_PR, 58);
    assert.equal(ALERT_UI_COLLECTION, "alerts");
    assert.equal(ALERT_UPSTREAM_COLLECTION, "alerts");
    assert.equal(alertsPath(), "/alerts");
    assert.equal(alertPath(ALERT_ID), `/alerts/${ALERT_ID}`);
    assert.equal(alertAckPath(ALERT_ID), `/alerts/${ALERT_ID}/ack`);
    assert.equal(alertHistoryHref(ALERT_ID), `/alerts/${ALERT_ID}`);
    assert.equal(auditBrowserHref(), "/audit");
    assert.equal(workspaceAuditEventsPath(), "/audit-events");
    assert.equal(isolationAuditEventsPath(), "/workspace/audit-events");
    assert.deepEqual(buildAlertAckBody(), {});
    assert.ok(!("workspaceId" in buildAlertAckBody()));
    assert.ok(!("id" in buildAlertAckBody()));
    assert.equal(
      executionCorrelateHref("execution", EXECUTION_ID),
      `/executions/${EXECUTION_ID}`,
    );
    assert.equal(executionCorrelateHref("workflow", EXECUTION_ID), "");
  });

  it("lists with documented #58 query keys only", () => {
    assert.equal(
      listAlertsPath({
        kind: "authorization",
        status: "open",
        resourceType: "execution",
        resourceId: EXECUTION_ID,
        limit: 25,
      }),
      `/alerts?kind=authorization&status=open&resourceType=execution&resourceId=${EXECUTION_ID}&limit=25`,
    );
    assert.equal(
      listWorkspaceAuditEventsPath({
        resourceType: "execution",
        resourceId: EXECUTION_ID,
        action: "alert.authorization",
        limit: 10,
      }),
      `/audit-events?resourceType=execution&resourceId=${EXECUTION_ID}&action=alert.authorization&limit=10`,
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
    assert.ok(!isAlertProxySegments(["audit-events", ALERT_ID]));
    assert.ok(!isAlertProxySegments(["workspace", "audit-events"]));
    assert.ok(isProductAuditSegments(["audit-events"]));
    assert.ok(isIsolationAuditSegments([...ISOLATION_AUDIT_SEGMENTS]));
    assert.ok(!isIsolationAuditSegments([WORKSPACE_AUDIT_COLLECTION]));
    assert.equal(ALERT_ACK_ACTION, "ack");
    assert.equal(ALERT_ACK_ROUTE_PUBLISHED, true);
  });
});

describe("secret-free alert rendering", () => {
  it("shows kind, severity, timestamps, and identifier fields only", () => {
    const text = alertDetailText(sampleAlert());
    assert.match(text, /Authorization/);
    assert.match(text, /Warning/);
    assert.match(text, new RegExp(CORRELATION_ID));
    assert.match(text, new RegExp(REQUEST_ID));
    assert.match(text, new RegExp(EXECUTION_ID));
    assert.match(text, /2026-09-09T03:00:00.000Z/);
    assert.match(text, /authorization.denied/);
    assert.match(text, /forbidden/);
    assert.equal(alertContainsSecret(text), false);
  });

  it("strips unexpected secret fields and never renders leaked values", () => {
    const stripped: string[] = [];
    const cleaned = stripAlertForbiddenFields(
      {
        id: ALERT_ID,
        kind: "redaction",
        severity: "critical",
        status: "open",
        action: "redaction.failed",
        outcome: "denied",
        code: "unsafe-artifact",
        correlationId: CORRELATION_ID,
        requestId: REQUEST_ID,
        resourceId: EXECUTION_ID,
        details: { secret: "should-not-leak" },
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
    assert.ok(stripped.includes("details"));
  });

  it("replaces a secret-shaped identifier field with the redacted marker", () => {
    assert.equal(safeAlertText("-----BEGIN RSA PRIVATE KEY-----"), "[redacted]");
    assert.equal(safeAlertText("authorization.denied"), "authorization.denied");
    const parsed = parseOperationalAlert({
      id: ALERT_ID,
      kind: "redaction",
      action: "super-secret leaked",
      correlationId: CORRELATION_ID,
    });
    assert.ok(parsed);
    assert.equal(parsed.action, "[redacted]");
    assert.equal(alertContainsSecret(alertListText([parsed])), false);
  });

  it("parses #58 identifier fields and never a details payload", () => {
    const parsed = parseOperationalAlert({
      id: ALERT_ID,
      kind: "policy",
      severity: "critical",
      action: "policy.denied",
      outcome: "denied",
      code: "policy-deny",
      correlationId: CORRELATION_ID,
      requestId: REQUEST_ID,
      resourceType: "execution",
      resourceId: EXECUTION_ID,
      actorId: "user-1",
      details: { token: "should-not-leak" },
      secret: "hunter2",
    });
    assert.ok(parsed);
    assert.equal(parsed.kind, "policy");
    assert.equal(parsed.severity, "critical");
    assert.equal(parsed.status, "open");
    assert.equal(parsed.requestId, REQUEST_ID);
    assert.equal(alertContainsSecret(alertDetailText(parsed)), false);
    assert.ok(!alertDetailText(parsed).includes("should-not-leak"));
  });

  it("parses a list envelope and filters by documented #58 fields", () => {
    const items = parseAlertList({
      items: [
        sampleAlert(),
        {
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          kind: "replay",
          severity: "warning",
          status: "acked",
          action: "replay.rejected",
          outcome: "denied",
          code: "replay",
          correlationId: "corr-e54-replay",
          resourceType: "execution",
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
    const byResource = filterAlertList(items, {
      resourceType: "execution",
      resourceId: EXECUTION_ID,
    });
    assert.equal(byResource.length, 2);
    assert.match(alertListText(items), /Replay/);
  });

  it("documents the four #58 kinds without a catalog route", () => {
    const kinds = documentedAlertKinds();
    assert.deepEqual([...kinds], [
      "authorization",
      "replay",
      "policy",
      "redaction",
    ]);
  });
});

describe("RBAC and ack affordances", () => {
  it("shows Alerts nav for alert.view only", () => {
    assert.equal(canSeeAlertsNav(null), true);
    assert.equal(canSeeAlertsNav(["alert.view"]), true);
    assert.equal(canSeeAlertsNav(["execution.view"]), false);
    assert.equal(canSeeAuditNav(["alert.view"]), true);
    assert.equal(canSeeAuditNav(["execution.view"]), true);
    assert.equal(canSeeAlertsNav([]), false);
    assert.equal(canSeeAlertsNav(["workflow.view"]), false);
  });

  it("gates ack on alert.ack, open status, and the published mutation", () => {
    assert.equal(
      canAckAlert({
        permissions: ["alert.ack"],
        status: "open",
      }),
      true,
    );
    assert.equal(
      canAckAlert({
        permissions: ["alert.view"],
        status: "open",
      }),
      false,
    );
    assert.equal(
      canAckAlert({
        permissions: ["alert.ack"],
        status: "acked",
      }),
      false,
    );
    assert.equal(
      canAckAlert({
        permissions: ["alert.ack"],
        status: "open",
        acknowledgedAt: "2026-09-09T03:01:00.000Z",
      }),
      false,
    );
    assert.equal(canAckWithPermission(["alert.ack"]), true);
    assert.equal(canAckWithPermission(["alert.view"]), false);
    assert.equal(alertSeverityPresentation("critical", "policy").tone, "critical");
    assert.equal(alertSeverityPresentation(undefined, "replay").tone, "warning");
    assert.equal(alertKindLabel("redaction"), "Redaction");
    assert.equal(alertStatusLabel("acked"), "Acknowledged");
    assert.equal(alertStatusLabel("open"), "Open");
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
        action: "alert.authorization",
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
      action: "alert.policy",
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
