import {
  problemFieldErrors,
  type ProblemDetails,
  type ProblemFieldError,
} from "./problem.ts";
import {
  CATALOG_PHASE_CORE,
  COMPARE_KIND_DRAFT,
  COMPARE_KIND_VERSION,
  CONFLICT_CODE,
  INVALID_WORKFLOW_CODE,
  type CatalogNode,
  type CatalogTrigger,
  type CompareKind,
  type CompareRef,
  type CompareWorkflowResult,
  type NormalizeResponse,
  type StartExecutionBody,
  type ValidateResponse,
  type WorkflowCatalog,
  type WorkflowDraft,
  type WorkflowExecution,
  type WorkflowExport,
  type WorkflowFieldError,
  type WorkflowRecord,
  type WorkflowSummary,
  type WorkflowVersion,
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

/**
 * Action registry: core is enabled by default; next/provider stay rejected
 * unless the catalog marks them `enabled: true`. `enabled: false` always hides.
 */
export function isCatalogImplementationEnabled(item: {
  phase?: unknown;
  enabled?: boolean;
}): boolean {
  if (item.enabled === false) {
    return false;
  }
  if (isCorePhase(item.phase)) {
    return true;
  }
  return item.enabled === true;
}

/** Palette / catalog list: enabled implementations only. */
const HTTP_NOTIFICATION_CATALOG_TYPES = new Set([
  "http.request",
  "notification.webhook",
  "notification.email",
]);

export function coreCatalog(catalog: WorkflowCatalog): WorkflowCatalog {
  const gateOff =
    catalog.rules?.integrationActionsEnabled === false ||
    catalog.integrationGate?.enabled === false;
  return {
    apiVersion: catalog.apiVersion,
    ...(catalog.rules ? { rules: catalog.rules } : {}),
    ...(catalog.integrationGate ? { integrationGate: catalog.integrationGate } : {}),
    triggers: (catalog.triggers ?? []).filter(isCatalogImplementationEnabled),
    nodes: (catalog.nodes ?? [])
      .filter(isCatalogImplementationEnabled)
      .filter(
        (item) => !gateOff || !HTTP_NOTIFICATION_CATALOG_TYPES.has(item.type),
      ),
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

const RESOURCE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isResourceId(value: string | undefined | null): boolean {
  return Boolean(value && RESOURCE_ID.test(value));
}

export function isConflictProblem(problem: ProblemDetails): boolean {
  return problem.status === 409 || problem.code === CONFLICT_CODE;
}

export type AppliedDraft = {
  yaml: string;
  revision: number;
  digest: string;
  summary: WorkflowSummary;
  warnings: WorkflowFieldError[];
};

/** Replace the editor buffer from a saved/fetched draft only. */
export function applyDraftResponse(draft: WorkflowDraft): AppliedDraft | null {
  const yaml = draft.definitionYaml;
  const digest = draft.digest;
  if (typeof yaml !== "string" || !yaml || typeof digest !== "string" || !digest) {
    return null;
  }
  if (typeof draft.revision !== "number" || !Number.isInteger(draft.revision)) {
    return null;
  }
  if (!isWorkflowSummary(draft.summary)) {
    return null;
  }
  return {
    yaml,
    revision: draft.revision,
    digest,
    summary: draft.summary,
    warnings: Array.isArray(draft.warnings) ? draft.warnings : [],
  };
}

export function isWorkflowRecord(value: unknown): value is WorkflowRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const body = value as Record<string, unknown>;
  return (
    typeof body.id === "string" &&
    isResourceId(body.id) &&
    typeof body.slug === "string" &&
    typeof body.name === "string" &&
    typeof body.status === "string" &&
    typeof body.draftRevision === "number"
  );
}

export function isWorkflowDraft(value: unknown): value is WorkflowDraft {
  if (!value || typeof value !== "object") {
    return false;
  }
  const body = value as Record<string, unknown>;
  return (
    typeof body.workflowId === "string" &&
    typeof body.revision === "number" &&
    typeof body.definitionYaml === "string" &&
    typeof body.digest === "string" &&
    isWorkflowSummary(body.summary)
  );
}

export function isWorkflowVersion(value: unknown): value is WorkflowVersion {
  if (!value || typeof value !== "object") {
    return false;
  }
  const body = value as Record<string, unknown>;
  return (
    typeof body.id === "string" &&
    isResourceId(body.id) &&
    typeof body.workflowId === "string" &&
    typeof body.versionNumber === "number" &&
    typeof body.digest === "string"
  );
}

export function isWorkflowExport(value: unknown): value is WorkflowExport {
  if (!value || typeof value !== "object") {
    return false;
  }
  const body = value as Record<string, unknown>;
  return (
    typeof body.filename === "string" &&
    typeof body.definitionYaml === "string" &&
    typeof body.digest === "string" &&
    typeof body.versionId === "string"
  );
}

export function isWorkflowExecution(value: unknown): value is WorkflowExecution {
  if (!value || typeof value !== "object") {
    return false;
  }
  const body = value as Record<string, unknown>;
  return (
    typeof body.id === "string" &&
    typeof body.workflowId === "string" &&
    typeof body.workflowVersionId === "string" &&
    typeof body.workflowDigest === "string"
  );
}

/** #41 flattens Execution + pins[]; also accept a wrapped {execution,pins}. */
export function readExecutionPayload(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  const row = value as Record<string, unknown>;
  if (row.execution && typeof row.execution === "object") {
    return {
      ...(row.execution as Record<string, unknown>),
      pins: row.pins ?? (row.execution as { pins?: unknown }).pins,
    };
  }
  return value;
}

export function isCompareResult(value: unknown): value is CompareWorkflowResult {
  if (!value || typeof value !== "object") {
    return false;
  }
  const body = value as Record<string, unknown>;
  return (
    typeof body.equal === "boolean" &&
    typeof body.digestMatch === "boolean" &&
    typeof body.leftDigest === "string" &&
    typeof body.rightDigest === "string" &&
    Array.isArray(body.changes)
  );
}

/** Run control: published version UUID only. Never a draft sentinel. */
export function executionStartBody(
  workflowVersionId: string | null | undefined,
  extras: { idempotencyKey?: string; input?: Record<string, unknown> } = {},
): StartExecutionBody | null {
  const id = workflowVersionId?.trim() ?? "";
  if (!isResourceId(id)) {
    return null;
  }
  const body: StartExecutionBody = { workflowVersionId: id };
  const key = extras.idempotencyKey?.trim();
  if (key) {
    body.idempotencyKey = key.slice(0, 128);
  }
  if (extras.input && typeof extras.input === "object") {
    body.input = extras.input;
  }
  return body;
}

export function publishedVersions(versions: WorkflowVersion[]): WorkflowVersion[] {
  return versions.filter((version) => isResourceId(version.id));
}

export function draftCompareRef(): CompareRef {
  return { kind: COMPARE_KIND_DRAFT };
}

export function versionCompareRef(versionId: string): CompareRef | null {
  if (!isResourceId(versionId)) {
    return null;
  }
  return { kind: COMPARE_KIND_VERSION, versionId };
}

export function compareRefLabel(
  kind: CompareKind | string,
  version?: Pick<WorkflowVersion, "versionNumber" | "id"> | null,
): string {
  if (kind === COMPARE_KIND_DRAFT) {
    return "Current draft";
  }
  if (version) {
    return `v${version.versionNumber}`;
  }
  return "Published version";
}

export function shortDigest(digest: string | null | undefined): string {
  if (!digest) {
    return "";
  }
  if (digest.length <= 19) {
    return digest;
  }
  return `${digest.slice(0, 15)}…`;
}

export function optionalCreateFields(slug: string, name: string): {
  slug?: string;
  name?: string;
} {
  const out: { slug?: string; name?: string } = {};
  if (slug.trim()) {
    out.slug = slug.trim();
  }
  if (name.trim()) {
    out.name = name.trim();
  }
  return out;
}
