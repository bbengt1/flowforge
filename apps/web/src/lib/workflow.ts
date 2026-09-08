import {
  problemFieldErrors,
  type ProblemDetails,
  type ProblemFieldError,
} from "./problem.ts";
import {
  CATALOG_PHASE_CORE,
  INVALID_WORKFLOW_CODE,
  type CatalogNode,
  type CatalogTrigger,
  type NormalizeResponse,
  type ValidateResponse,
  type WorkflowCatalog,
  type WorkflowFieldError,
  type WorkflowSummary,
} from "./workflow-types.ts";

export const VALIDATE_DEBOUNCE_MS = 450;

/** Minimal valid core-phase document for the E3.1 operator. */
export const STARTER_WORKFLOW_YAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: validate-example
spec:
  description: Minimal core-phase example for validate and normalize.
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: seed
      type: data.set
      name: Seed value
      with:
        value:
          status: ready
    - id: done
      type: flow.stop
      name: Stop
  edges:
    - from: seed.result
      to: done.input
`;

/** Intentionally invalid — surfaces errors[] without a guessed graph. */
export const INVALID_WORKFLOW_YAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: broken example
spec:
  triggers: []
  nodes:
    - id: Bad_ID
      type: workflow.call
      name: Next-phase call
`;

export function isCorePhase(phase: unknown): boolean {
  return phase === CATALOG_PHASE_CORE;
}

/** Palette entries: `phase: core` only. Missing / next / provider fail closed. */
export function coreCatalog(catalog: WorkflowCatalog): WorkflowCatalog {
  return {
    apiVersion: catalog.apiVersion,
    triggers: (catalog.triggers ?? []).filter((item) => isCorePhase(item.phase)),
    nodes: (catalog.nodes ?? []).filter((item) => isCorePhase(item.phase)),
  };
}

export function catalogHasNonCore(
  catalog: Pick<WorkflowCatalog, "triggers" | "nodes">,
): boolean {
  const triggers = catalog.triggers ?? [];
  const nodes = catalog.nodes ?? [];
  return (
    triggers.some((item) => !isCorePhase(item.phase)) ||
    nodes.some((item) => !isCorePhase(item.phase))
  );
}

export function isInvalidWorkflowProblem(problem: ProblemDetails): boolean {
  return problem.code === INVALID_WORKFLOW_CODE || problem.status === 400;
}

export function workflowErrorsFromProblem(
  problem: ProblemDetails,
): WorkflowFieldError[] {
  return problemFieldErrors(problem).map(toWorkflowFieldError);
}

function toWorkflowFieldError(error: ProblemFieldError): WorkflowFieldError {
  return {
    path: error.path,
    code: error.code,
    message: error.message,
    ...(error.line !== undefined ? { line: error.line } : {}),
    ...(error.column !== undefined ? { column: error.column } : {}),
  };
}

export type AppliedNormalize = {
  yaml: string;
  digest: string;
  summary: WorkflowSummary;
  warnings: WorkflowFieldError[];
};

/** Replace the editor buffer from the normalize response only. */
export function applyNormalizeResponse(
  response: NormalizeResponse,
): AppliedNormalize | null {
  const yaml = response.definitionYaml;
  const digest = response.digest;
  if (typeof yaml !== "string" || !yaml || typeof digest !== "string" || !digest) {
    return null;
  }
  if (!isWorkflowSummary(response.summary)) {
    return null;
  }
  return {
    yaml,
    digest,
    summary: response.summary,
    warnings: Array.isArray(response.warnings) ? response.warnings : [],
  };
}

export function isWorkflowSummary(value: unknown): value is WorkflowSummary {
  if (!value || typeof value !== "object") {
    return false;
  }
  const body = value as Record<string, unknown>;
  return (
    typeof body.apiVersion === "string" &&
    typeof body.name === "string" &&
    Array.isArray(body.triggers) &&
    Array.isArray(body.nodes) &&
    Array.isArray(body.edges) &&
    Array.isArray(body.outputs)
  );
}

export function isValidateResponse(value: unknown): value is ValidateResponse {
  if (!value || typeof value !== "object") {
    return false;
  }
  const body = value as Record<string, unknown>;
  return body.valid === true && isWorkflowSummary(body.summary);
}

export function isNormalizeResponse(value: unknown): value is NormalizeResponse {
  if (!value || typeof value !== "object") {
    return false;
  }
  const body = value as Record<string, unknown>;
  return (
    typeof body.definitionYaml === "string" &&
    typeof body.digest === "string" &&
    isWorkflowSummary(body.summary)
  );
}

export type SummaryCounts = {
  triggers: number;
  nodes: number;
  edges: number;
  outputs: number;
};

export function summaryCounts(summary: WorkflowSummary): SummaryCounts {
  return {
    triggers: summary.triggers.length,
    nodes: summary.nodes.length,
    edges: summary.edges.length,
    outputs: summary.outputs.length,
  };
}

/**
 * Invalid YAML must never produce a canvas/graph projection.
 * Only a successful validate/normalize summary is displayable.
 */
export function canShowSummary(
  errors: WorkflowFieldError[],
  summary: WorkflowSummary | null,
): summary is WorkflowSummary {
  return errors.length === 0 && summary !== null;
}

export function formatFieldLocation(error: WorkflowFieldError): string {
  if (error.line && error.column) {
    return `${error.line}:${error.column}`;
  }
  if (error.line) {
    return `line ${error.line}`;
  }
  return "";
}

export function catalogItemKey(
  kind: "trigger" | "node",
  item: CatalogTrigger | CatalogNode,
): string {
  return `${kind}:${item.type}`;
}

export function lineCount(yaml: string): number {
  if (!yaml) {
    return 1;
  }
  return yaml.split("\n").length;
}

export function offsetForLine(yaml: string, line: number): number {
  if (line < 1) {
    return 0;
  }
  const lines = yaml.split("\n");
  let offset = 0;
  for (let index = 0; index < lines.length && index < line - 1; index += 1) {
    offset += (lines[index] ?? "").length + 1;
  }
  return offset;
}
