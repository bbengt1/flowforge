/**
 * Typed E9.4 revoke / emergency-stop client. Paths come from
 * script-ops-contract.ts so a retarget only edits that adapter.
 * Cookie session + CSRF on POST. Never persist package/storageRef.
 */

import { callIdentityProxy } from "./identity-client.ts";
import type { DevIdentity } from "./identity-headers.ts";
import type { ProblemDetails } from "./problem.ts";
import {
  SCRIPT_BLOB_FORBIDDEN_MESSAGE,
  artifactHasForbiddenBlob,
  hostSuppliedScriptIdentityKeys,
  hostSuppliedScriptIdentityProblem,
  parseScriptArtifact,
  type ScriptArtifact,
} from "./script-contract.ts";
import {
  SCRIPT_EMERGENCY_STOP_CANCELED_HELP,
  SCRIPT_EMERGENCY_STOP_DENIED_MESSAGE,
  SCRIPT_EMERGENCY_STOP_FORBIDDEN_MESSAGE,
  SCRIPT_EMERGENCY_STOP_INDETERMINATE_HELP,
  SCRIPT_REVOKE_FORBIDDEN_MESSAGE,
  buildScriptEmergencyStopBody,
  buildScriptRevokeBody,
  canBlindRetryAfterEmergencyStop,
  emergencyStopExpectedOutcome,
  executionEmergencyStopPath,
  executionStepEmergencyStopPath,
  parseRevokedArtifact,
  scriptRevokePath,
  validateScriptRevokeReason,
} from "./script-ops-contract.ts";

export type ScriptOpsClientFailure = {
  ok: false;
  statusCode: number;
  requestId: string;
  problem: ProblemDetails;
  forbidden: boolean;
};

export type ScriptRevokeSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  artifact: ScriptArtifact;
  message: string;
};

export type ScriptEmergencyStopSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  execution: unknown;
  outcome: "canceled" | "indeterminate";
  uncertain: boolean;
  retryOffered: false;
  message: string;
};

function failure(result: {
  statusCode: number;
  requestId: string;
  problem: ProblemDetails;
}): ScriptOpsClientFailure {
  const code = String(result.problem.code ?? "").trim();
  return {
    ok: false,
    statusCode: result.statusCode,
    requestId: result.requestId,
    problem: result.problem,
    forbidden:
      result.statusCode === 403 ||
      code === "forbidden" ||
      code === "permission-denied" ||
      code === "emergency-stop-denied" ||
      code === "policy-denied",
  };
}

function localProblem(
  path: string,
  requestId: string,
  status: number,
  code: string,
  title: string,
  detail: string,
): ProblemDetails {
  return {
    type: `urn:flowforge:problem:${code}`,
    title,
    status,
    detail,
    instance: path,
    code,
    request_id: requestId,
  };
}

export async function revokeScriptArtifact(
  identity: DevIdentity,
  artifactId: string,
  input: { reason?: string } = {},
): Promise<ScriptRevokeSuccess | ScriptOpsClientFailure> {
  const path = scriptRevokePath(artifactId);
  const reasonErrors = validateScriptRevokeReason(input.reason);
  if (reasonErrors.length > 0) {
    return {
      ok: false,
      statusCode: 400,
      requestId: "",
      forbidden: false,
      problem: localProblem(
        path,
        "",
        400,
        "invalid-request",
        "Invalid request",
        reasonErrors[0] ?? "reason is invalid.",
      ),
    };
  }
  const payload = buildScriptRevokeBody(input);
  const hostKeys = hostSuppliedScriptIdentityKeys(payload);
  if (hostKeys.length > 0) {
    const local = hostSuppliedScriptIdentityProblem(hostKeys);
    return {
      ok: false,
      statusCode: 400,
      requestId: "",
      forbidden: false,
      problem: localProblem(path, "", local.status, local.code, local.title, local.detail),
    };
  }
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "POST",
    body: payload,
  });
  if (!result.ok) {
    const failed = failure(result);
    if (failed.forbidden && !failed.problem.detail) {
      failed.problem = {
        ...failed.problem,
        detail: SCRIPT_REVOKE_FORBIDDEN_MESSAGE,
      };
    }
    return failed;
  }
  if (artifactHasForbiddenBlob(result.data)) {
    return {
      ok: false,
      statusCode: 502,
      requestId: result.requestId,
      forbidden: false,
      problem: localProblem(
        path,
        result.requestId,
        502,
        "contract-bug",
        "Contract bug",
        SCRIPT_BLOB_FORBIDDEN_MESSAGE,
      ),
    };
  }
  const artifact = parseRevokedArtifact(result.data) ?? parseScriptArtifact(result.data);
  if (!artifact?.revokedAt) {
    return {
      ok: false,
      statusCode: result.statusCode,
      requestId: result.requestId,
      forbidden: false,
      problem: localProblem(
        path,
        result.requestId,
        result.statusCode,
        "malformed",
        "Malformed response",
        "POST /scripts/{id}/revoke did not return revokedAt. The UI stays fail-closed.",
      ),
    };
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    artifact,
    message: `Artifact revoked at ${artifact.revokedAt}. New starts fail closed with 409 artifact-revoked.`,
  };
}

export async function emergencyStopExecution(
  identity: DevIdentity,
  executionId: string,
  input: { stepId?: string; uncertain?: boolean; status?: string } = {},
): Promise<ScriptEmergencyStopSuccess | ScriptOpsClientFailure> {
  const stepId = input.stepId?.trim() || undefined;
  const path = stepId
    ? executionStepEmergencyStopPath(executionId, stepId)
    : executionEmergencyStopPath(executionId);
  const payload = buildScriptEmergencyStopBody({
    uncertain: input.uncertain,
  });
  const hostKeys = hostSuppliedScriptIdentityKeys(payload);
  if (hostKeys.length > 0) {
    const local = hostSuppliedScriptIdentityProblem(hostKeys);
    return {
      ok: false,
      statusCode: 400,
      requestId: "",
      forbidden: false,
      problem: localProblem(path, "", local.status, local.code, local.title, local.detail),
    };
  }
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "POST",
    body: payload,
  });
  if (!result.ok) {
    const failed = failure(result);
    if (failed.forbidden) {
      const denied =
        failed.problem.code === "emergency-stop-denied" ||
        failed.problem.code === "policy-denied";
      failed.problem = {
        ...failed.problem,
        detail: denied
          ? SCRIPT_EMERGENCY_STOP_DENIED_MESSAGE
          : SCRIPT_EMERGENCY_STOP_FORBIDDEN_MESSAGE,
      };
    }
    return failed;
  }
  const execution = result.data;
  const status = readExecutionStatus(execution) || input.status;
  const uncertain =
    input.uncertain === true ||
    String(status ?? "").trim().toLowerCase() === "indeterminate";
  const outcome = emergencyStopExpectedOutcome({
    status,
    uncertain,
  });
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    execution,
    outcome,
    uncertain: outcome === "indeterminate",
    retryOffered: canBlindRetryAfterEmergencyStop(),
    message:
      outcome === "indeterminate"
        ? SCRIPT_EMERGENCY_STOP_INDETERMINATE_HELP
        : SCRIPT_EMERGENCY_STOP_CANCELED_HELP,
  };
}

function readExecutionStatus(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const rec = raw as Record<string, unknown>;
  const execution =
    rec.execution && typeof rec.execution === "object" && !Array.isArray(rec.execution)
      ? (rec.execution as Record<string, unknown>)
      : rec;
  const status = String(execution.status ?? rec.status ?? "").trim();
  return status || undefined;
}
