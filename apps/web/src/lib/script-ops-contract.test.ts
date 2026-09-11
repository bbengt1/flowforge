import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_SCRIPT_EMERGENCY_STOP,
  DEFAULT_SCRIPT_REVOCATION,
  SCRIPT_EMERGENCY_STOP_ACTION,
  SCRIPT_EMERGENCY_STOP_HELP,
  SCRIPT_EMERGENCY_STOP_INDETERMINATE_HELP,
  SCRIPT_EMERGENCY_STOP_PERMISSION,
  SCRIPT_NO_BLIND_RETRY_AFTER_STOP_HELP,
  SCRIPT_OPS_API_PR,
  SCRIPT_OPS_CONTRACT_FALLBACK_CATALOG,
  SCRIPT_OPS_CONTRACT_FALLBACK_HELP,
  SCRIPT_OPS_EPIC,
  SCRIPT_OPS_EXISTING_API_PATHS,
  SCRIPT_OPS_MAX_REASON_BYTES,
  SCRIPT_OPS_PROXY_ROUTES,
  SCRIPT_OPS_ROUTE_MAP_SOURCE,
  SCRIPT_OPS_STORY,
  SCRIPT_REVOKE_HELP,
  SCRIPT_REVOKE_PERMISSION,
  SCRIPT_REVOKED_RUN_BLOCK_HELP,
  buildScriptEmergencyStopBody,
  buildScriptRevokeBody,
  canBlindRetryAfterEmergencyStop,
  canOfferScriptEmergencyStop,
  canRevokeScriptArtifact,
  emergencyStopExpectedOutcome,
  emergencyStopShouldMarkUncertain,
  executionEmergencyStopPath,
  executionStepEmergencyStopPath,
  hasRevokedScriptPin,
  isArtifactRevoked,
  isScriptOpsProxySegments,
  parseScriptOpsCatalog,
  pinLooksRevoked,
  scriptEmergencyStopCopy,
  scriptRevokePath,
  validateScriptRevokeReason,
} from "./script-ops-contract.ts";

const ARTIFACT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EXECUTION_ID = "33333333-3333-4333-8333-333333333333";
const STEP_ID = "44444444-4444-4444-8444-444444444444";

describe("script ops contract adapter", () => {
  it("cites E9.4 / #103 and Keep #95 open", () => {
    assert.equal(SCRIPT_OPS_STORY, 95);
    assert.equal(SCRIPT_OPS_EPIC, 91);
    assert.equal(SCRIPT_OPS_API_PR, 103);
    assert.equal(SCRIPT_OPS_ROUTE_MAP_SOURCE, "e94-#103");
    assert.match(SCRIPT_OPS_CONTRACT_FALLBACK_HELP, /e94-#103/);
    assert.match(SCRIPT_OPS_CONTRACT_FALLBACK_HELP, /script\.revoke/);
    assert.match(SCRIPT_OPS_CONTRACT_FALLBACK_HELP, /script\.emergencyStop/);
    assert.match(SCRIPT_OPS_CONTRACT_FALLBACK_HELP, /allowEmergencyStop/);
    assert.match(SCRIPT_OPS_CONTRACT_FALLBACK_HELP, /409 artifact-revoked/);
    assert.equal(SCRIPT_OPS_CONTRACT_FALLBACK_CATALOG.source, "unavailable");
    assert.equal(
      SCRIPT_OPS_CONTRACT_FALLBACK_CATALOG.revocation.permission,
      SCRIPT_REVOKE_PERMISSION,
    );
    assert.equal(
      SCRIPT_OPS_CONTRACT_FALLBACK_CATALOG.emergencyStop.permission,
      SCRIPT_EMERGENCY_STOP_PERMISSION,
    );
    assert.equal(SCRIPT_OPS_CONTRACT_FALLBACK_CATALOG.revocation.idempotent, true);
    assert.equal(SCRIPT_OPS_CONTRACT_FALLBACK_CATALOG.revocation.failClosed, true);
    assert.equal(
      SCRIPT_OPS_CONTRACT_FALLBACK_CATALOG.emergencyStop.uncertainOutcome,
      "indeterminate",
    );
    assert.equal(
      SCRIPT_OPS_CONTRACT_FALLBACK_CATALOG.emergencyStop.beforeDispatch,
      "canceled",
    );
    assert.equal(SCRIPT_OPS_CONTRACT_FALLBACK_CATALOG.emergencyStop.missingPolicyAllows, false);
    assert.equal(SCRIPT_OPS_EXISTING_API_PATHS.scriptsCatalog, "/scripts/catalog");
    assert.equal(scriptRevokePath(ARTIFACT_ID), `/scripts/${ARTIFACT_ID}/revoke`);
    assert.equal(
      executionEmergencyStopPath(EXECUTION_ID),
      `/executions/${EXECUTION_ID}/emergency-stop`,
    );
    assert.equal(
      executionStepEmergencyStopPath(EXECUTION_ID, STEP_ID),
      `/executions/${EXECUTION_ID}/steps/${STEP_ID}/emergency-stop`,
    );
    assert.match(SCRIPT_REVOKE_HELP, /Already-running/);
    assert.match(SCRIPT_EMERGENCY_STOP_HELP, /distinct from Cancel/);
    assert.match(SCRIPT_REVOKED_RUN_BLOCK_HELP, /revoked/);
    assert.match(SCRIPT_NO_BLIND_RETRY_AFTER_STOP_HELP, /never offers a blind retry/);
    assert.equal(canBlindRetryAfterEmergencyStop(), false);
  });

  it("overlays GET /scripts/catalog revocation / emergencyStop from #103", () => {
    const parsed = parseScriptOpsCatalog({
      revocation: {
        permission: "script.revoke",
        route: "POST /scripts/{artifactId}/revoke",
        idempotent: true,
        blocksNewRuns: true,
        recheckOn: ["start", "claim"],
        failClosed: true,
        errorCode: "artifact-revoked",
        auditAction: "script.artifact.revoke",
        auditSecretFree: true,
      },
      emergencyStop: {
        permission: "script.emergencyStop",
        route: "POST /executions/{executionId}/emergency-stop",
        policyGated: true,
        missingPolicyAllows: true,
        policyAllowField: "policy.allowEmergencyStop",
        uncertainOutcome: "indeterminate",
        beforeDispatch: "canceled",
        neverAssumeAbsent: true,
      },
      errors: [
        { code: "artifact-revoked", status: 409, meaning: "Revoked cannot start." },
      ],
    });
    assert.equal(parsed.source, "scripts-catalog");
    assert.equal(parsed.revocation.permission, "script.revoke");
    assert.deepEqual(parsed.revocation.recheckOn, ["start", "claim"]);
    assert.equal(parsed.emergencyStop.policyAllowField, "policy.allowEmergencyStop");
    assert.equal(parsed.errors[0]?.code, "artifact-revoked");
    assert.ok(parsed.errors.some((item) => item.code === "emergency-stop-denied"));

    const empty = parseScriptOpsCatalog({});
    assert.equal(empty.source, "unavailable");
    assert.equal(empty.notes, SCRIPT_OPS_CONTRACT_FALLBACK_HELP);
    assert.equal(empty.revocation.route, DEFAULT_SCRIPT_REVOCATION.route);
    assert.equal(empty.emergencyStop.route, DEFAULT_SCRIPT_EMERGENCY_STOP.route);
  });

  it("treats revokedAt as fail-closed for start/publish UX", () => {
    assert.equal(isArtifactRevoked({ revokedAt: "2026-09-09T15:00:00Z", status: "published" }), true);
    assert.equal(isArtifactRevoked({ status: "revoked" }), true);
    assert.equal(isArtifactRevoked({ status: "published" }), false);
    assert.equal(
      pinLooksRevoked(
        {
          workflowVersionId: ARTIFACT_ID,
          nodeId: "run",
          artifactId: ARTIFACT_ID,
          digest: "sha256:abc",
          scanStatus: "clean",
        },
        [{ id: ARTIFACT_ID, digest: "sha256:abc", revokedAt: "2026-09-09T15:00:00Z", language: "python", entrypoint: "main.py", signature: "hmac-sha256:x", scanStatus: "clean", status: "published" }],
      ),
      true,
    );
    assert.equal(
      hasRevokedScriptPin({
        pins: [
          {
            workflowVersionId: ARTIFACT_ID,
            nodeId: "run",
            artifactId: ARTIFACT_ID,
            digest: "sha256:abc",
            scanStatus: "clean",
          },
        ],
        artifacts: [
          {
            id: ARTIFACT_ID,
            digest: "sha256:abc",
            revokedAt: "2026-09-09T15:00:00Z",
            language: "go",
            entrypoint: "main.go",
            signature: "hmac-sha256:x",
            scanStatus: "clean",
            status: "published",
          },
        ],
      }),
      true,
    );
    assert.equal(
      canRevokeScriptArtifact({
        permissions: ["script.revoke"],
        artifact: {
          id: ARTIFACT_ID,
          digest: "sha256:abc",
          language: "python",
          entrypoint: "main.py",
          signature: "hmac-sha256:x",
          scanStatus: "clean",
          status: "published",
        },
      }),
      true,
    );
    assert.equal(
      canRevokeScriptArtifact({
        permissions: ["workflow.view"],
        artifact: {
          id: ARTIFACT_ID,
          digest: "sha256:abc",
          language: "python",
          entrypoint: "main.py",
          signature: "hmac-sha256:x",
          scanStatus: "clean",
          status: "published",
        },
      }),
      false,
    );
    assert.equal(
      canRevokeScriptArtifact({
        permissions: ["script.revoke"],
        artifact: {
          id: ARTIFACT_ID,
          digest: "sha256:abc",
          language: "python",
          entrypoint: "main.py",
          signature: "hmac-sha256:x",
          scanStatus: "clean",
          status: "published",
          revokedAt: "2026-09-09T15:00:00Z",
        },
      }),
      false,
    );
  });

  it("keeps emergency stop distinct from cancel and loud-indeterminate until verified", () => {
    assert.equal(
      canOfferScriptEmergencyStop({
        permissions: ["script.emergencyStop"],
        status: "running",
        nodeType: "script.python",
      }),
      true,
    );
    assert.equal(
      canOfferScriptEmergencyStop({
        permissions: ["execution.cancel"],
        status: "running",
        nodeType: "script.python",
      }),
      false,
    );
    assert.equal(
      canOfferScriptEmergencyStop({
        permissions: ["script.emergencyStop"],
        status: "running",
        nodeType: "ssh.run",
      }),
      false,
    );
    assert.equal(
      canOfferScriptEmergencyStop({
        permissions: ["script.emergencyStop"],
        status: "succeeded",
        nodeType: "script.go",
      }),
      false,
    );
    assert.equal(emergencyStopShouldMarkUncertain("running"), true);
    assert.equal(emergencyStopShouldMarkUncertain("queued"), false);
    assert.equal(emergencyStopExpectedOutcome({ status: "queued" }), "canceled");
    assert.equal(
      emergencyStopExpectedOutcome({ status: "running", uncertain: true }),
      "indeterminate",
    );
    assert.match(scriptEmergencyStopCopy({ outcome: "indeterminate" }), /indeterminate/);
    assert.match(SCRIPT_EMERGENCY_STOP_INDETERMINATE_HELP, /Do not assume the script did not run/);
    assert.equal(canBlindRetryAfterEmergencyStop(), false);
    assert.deepEqual(buildScriptRevokeBody({ reason: " leaked key " }), { reason: "leaked key" });
    assert.deepEqual(buildScriptRevokeBody({}), {});
    assert.deepEqual(buildScriptEmergencyStopBody({ uncertain: true }), { uncertain: true });
    assert.deepEqual(validateScriptRevokeReason("ok"), []);
    assert.ok(
      validateScriptRevokeReason("x".repeat(SCRIPT_OPS_MAX_REASON_BYTES + 1))[0]?.includes("256"),
    );
  });

  it("allowlists only the #103 revoke and emergency-stop proxy routes", () => {
    assert.equal(
      isScriptOpsProxySegments(["scripts", ARTIFACT_ID, SCRIPT_EMERGENCY_STOP_ACTION]),
      false,
    );
    assert.equal(isScriptOpsProxySegments(["scripts", ARTIFACT_ID, "revoke"]), true);
    assert.equal(
      isScriptOpsProxySegments(["executions", EXECUTION_ID, "emergency-stop"]),
      true,
    );
    assert.equal(
      isScriptOpsProxySegments(["executions", EXECUTION_ID, "steps", STEP_ID, "emergency-stop"]),
      true,
    );
    assert.equal(isScriptOpsProxySegments(["executions", EXECUTION_ID, "cancel"]), false);
    assert.equal(
      SCRIPT_OPS_PROXY_ROUTES.some((route) =>
        route.match(["scripts", ARTIFACT_ID, "revoke"]),
      ),
      true,
    );
  });
});
