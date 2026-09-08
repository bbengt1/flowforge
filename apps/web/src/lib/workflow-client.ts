import { callIdentityProxy, type IdentityClientResult } from "./identity-client.ts";
import type { DevIdentity } from "./identity-headers.ts";
import { problemFieldErrors, type ProblemDetails } from "./problem.ts";
import {
  applyNormalizeResponse,
  coreCatalog,
  isNormalizeResponse,
  isValidateResponse,
  workflowErrorsFromProblem,
  type AppliedNormalize,
} from "./workflow.ts";
import type {
  DefinitionYamlBody,
  NormalizeResponse,
  ValidateResponse,
  WorkflowCatalog,
  WorkflowFieldError,
} from "./workflow-types.ts";

export const WORKFLOW_CATALOG_PATH = "/workflows/catalog";
export const WORKFLOW_VALIDATE_PATH = "/workflows/validate";
export const WORKFLOW_NORMALIZE_PATH = "/workflows/normalize";

export type CatalogClientSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  catalog: WorkflowCatalog;
};

export type ValidateClientSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  valid: true;
  summary: ValidateResponse["summary"];
  warnings: WorkflowFieldError[];
};

export type NormalizeClientSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  applied: AppliedNormalize;
};

export type WorkflowClientFailure = {
  ok: false;
  statusCode: number;
  requestId: string;
  problem: ProblemDetails;
  errors: WorkflowFieldError[];
};

export async function fetchWorkflowCatalog(
  identity: DevIdentity,
): Promise<CatalogClientSuccess | WorkflowClientFailure> {
  const result = await callIdentityProxy<WorkflowCatalog>(
    WORKFLOW_CATALOG_PATH,
    identity,
  );
  if (!result.ok) {
    return failure(result);
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    catalog: coreCatalog(result.data),
  };
}

export async function validateWorkflowYaml(
  identity: DevIdentity,
  yaml: string,
): Promise<ValidateClientSuccess | WorkflowClientFailure> {
  const result = await callIdentityProxy<ValidateResponse>(
    WORKFLOW_VALIDATE_PATH,
    identity,
    { method: "POST", body: definitionBody(yaml) },
  );
  if (!result.ok) {
    return failure(result);
  }
  if (!isValidateResponse(result.data)) {
    return {
      ok: false,
      statusCode: result.statusCode,
      requestId: result.requestId,
      problem: {
        type: "urn:flowforge:problem:upstream-error",
        title: "Upstream Error",
        status: result.statusCode,
        detail: "Validate returned a payload that is not a valid summary.",
        instance: WORKFLOW_VALIDATE_PATH,
        code: "upstream-error",
        request_id: result.requestId,
      },
      errors: [],
    };
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    valid: true,
    summary: result.data.summary,
    warnings: result.data.warnings ?? [],
  };
}

export async function normalizeWorkflowYaml(
  identity: DevIdentity,
  yaml: string,
): Promise<NormalizeClientSuccess | WorkflowClientFailure> {
  const result = await callIdentityProxy<NormalizeResponse>(
    WORKFLOW_NORMALIZE_PATH,
    identity,
    { method: "POST", body: definitionBody(yaml) },
  );
  if (!result.ok) {
    return failure(result);
  }
  if (!isNormalizeResponse(result.data)) {
    return {
      ok: false,
      statusCode: result.statusCode,
      requestId: result.requestId,
      problem: {
        type: "urn:flowforge:problem:upstream-error",
        title: "Upstream Error",
        status: result.statusCode,
        detail: "Normalize returned a payload without definitionYaml and digest.",
        instance: WORKFLOW_NORMALIZE_PATH,
        code: "upstream-error",
        request_id: result.requestId,
      },
      errors: [],
    };
  }
  const applied = applyNormalizeResponse(result.data);
  if (!applied) {
    return {
      ok: false,
      statusCode: result.statusCode,
      requestId: result.requestId,
      problem: {
        type: "urn:flowforge:problem:upstream-error",
        title: "Upstream Error",
        status: result.statusCode,
        detail: "Normalize response could not replace the editor buffer.",
        instance: WORKFLOW_NORMALIZE_PATH,
        code: "upstream-error",
        request_id: result.requestId,
      },
      errors: [],
    };
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    applied,
  };
}

function definitionBody(yaml: string): DefinitionYamlBody {
  return { definitionYaml: yaml };
}

function failure(
  result: Extract<IdentityClientResult<unknown>, { ok: false }>,
): WorkflowClientFailure {
  return {
    ok: false,
    statusCode: result.statusCode,
    requestId: result.requestId,
    problem: {
      ...result.problem,
      errors: problemFieldErrors(result.problem),
    },
    errors: workflowErrorsFromProblem(result.problem),
  };
}
