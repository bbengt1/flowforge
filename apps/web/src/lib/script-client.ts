/**
 * Typed E9.1 script catalog / artifact client. Paths come from
 * script-contract.ts so a retarget only edits that adapter.
 * Cookie session + CSRF on POST. Never persist package/storageRef.
 */

import { callIdentityProxy } from "./identity-client.ts";
import type { DevIdentity } from "./identity-headers.ts";
import type { ProblemDetails } from "./problem.ts";
import {
  SCRIPT_BLOB_FORBIDDEN_MESSAGE,
  SCRIPT_CATALOG_PATH,
  SCRIPT_OPS_CONFIG_CATALOG_PATH,
  SCRIPTS_PATH,
  artifactHasForbiddenBlob,
  buildScriptPublishBody,
  hostSuppliedScriptIdentityKeys,
  hostSuppliedScriptIdentityProblem,
  parseScriptArtifact,
  parseScriptNodeCatalog,
  parseScriptVersionPins,
  scriptArtifactPath,
  workflowScriptArtifactsPath,
  type ScriptArtifact,
  type ScriptNodeCatalog,
  type ScriptVersionPin,
} from "./script-contract.ts";

export type ScriptClientFailure = {
  ok: false;
  statusCode: number;
  requestId: string;
  problem: ProblemDetails;
};

export type ScriptCatalogSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  catalog: ScriptNodeCatalog;
};

export type ScriptArtifactSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  artifact: ScriptArtifact;
};

export type ScriptPinListSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  items: ScriptVersionPin[];
};

function failure(result: {
  statusCode: number;
  requestId: string;
  problem: ProblemDetails;
}): ScriptClientFailure {
  return {
    ok: false,
    statusCode: result.statusCode,
    requestId: result.requestId,
    problem: result.problem,
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

export async function getScriptCatalog(
  identity: DevIdentity,
): Promise<ScriptCatalogSuccess | ScriptClientFailure> {
  const result = await callIdentityProxy<unknown>(SCRIPT_CATALOG_PATH, identity);
  if (result.ok) {
    return {
      ok: true,
      statusCode: result.statusCode,
      requestId: result.requestId,
      catalog: parseScriptNodeCatalog(result.data),
    };
  }
  const ops = await callIdentityProxy<unknown>(
    SCRIPT_OPS_CONFIG_CATALOG_PATH,
    identity,
  );
  if (ops.ok) {
    const catalog = parseScriptNodeCatalog(ops.data);
    if (catalog.source !== "unavailable") {
      return {
        ok: true,
        statusCode: ops.statusCode,
        requestId: ops.requestId,
        catalog,
      };
    }
  }
  return failure(result);
}

export async function getScriptArtifact(
  identity: DevIdentity,
  artifactId: string,
): Promise<ScriptArtifactSuccess | ScriptClientFailure> {
  const path = scriptArtifactPath(artifactId);
  const result = await callIdentityProxy<unknown>(path, identity);
  if (!result.ok) {
    return failure(result);
  }
  if (artifactHasForbiddenBlob(result.data)) {
    return {
      ok: false,
      statusCode: 502,
      requestId: result.requestId,
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
  const artifact = parseScriptArtifact(result.data);
  if (!artifact) {
    return {
      ok: false,
      statusCode: result.statusCode,
      requestId: result.requestId,
      problem: localProblem(
        path,
        result.requestId,
        result.statusCode,
        "malformed",
        "Malformed response",
        "Script artifact metadata was missing id or digest.",
      ),
    };
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    artifact,
  };
}

export async function listWorkflowScriptArtifacts(
  identity: DevIdentity,
  workflowId: string,
  versionId: string,
): Promise<ScriptPinListSuccess | ScriptClientFailure> {
  const path = workflowScriptArtifactsPath(workflowId, versionId);
  const result = await callIdentityProxy<unknown>(path, identity);
  if (!result.ok) {
    return failure(result);
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    items: parseScriptVersionPins(result.data),
  };
}

export async function packageScript(
  identity: DevIdentity,
  body: Parameters<typeof buildScriptPublishBody>[0],
): Promise<ScriptArtifactSuccess | ScriptClientFailure> {
  const payload = buildScriptPublishBody(body);
  const hostKeys = hostSuppliedScriptIdentityKeys(payload);
  if (hostKeys.length > 0) {
    const local = hostSuppliedScriptIdentityProblem(hostKeys);
    return {
      ok: false,
      statusCode: 400,
      requestId: "",
      problem: localProblem(
        SCRIPTS_PATH,
        "",
        local.status,
        local.code,
        local.title,
        local.detail,
      ),
    };
  }
  const result = await callIdentityProxy<unknown>(SCRIPTS_PATH, identity, {
    method: "POST",
    body: payload,
  });
  if (!result.ok) {
    return failure(result);
  }
  if (artifactHasForbiddenBlob(result.data)) {
    return {
      ok: false,
      statusCode: 502,
      requestId: result.requestId,
      problem: localProblem(
        SCRIPTS_PATH,
        result.requestId,
        502,
        "contract-bug",
        "Contract bug",
        SCRIPT_BLOB_FORBIDDEN_MESSAGE,
      ),
    };
  }
  const artifact = parseScriptArtifact(result.data);
  if (!artifact) {
    return {
      ok: false,
      statusCode: result.statusCode,
      requestId: result.requestId,
      problem: localProblem(
        SCRIPTS_PATH,
        result.requestId,
        result.statusCode,
        "malformed",
        "Malformed response",
        "POST /scripts did not return artifact metadata.",
      ),
    };
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    artifact,
  };
}
