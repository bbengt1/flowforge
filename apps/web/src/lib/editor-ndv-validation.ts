/**
 * R3.3: validation and policy density in the NDV.
 *
 * Relates to #248 / Part of #229. Keep #248 open.
 *
 * Chloe UI only. Selected-node inspector surfaces validate/normalize
 * problems and catalog policy/bounds, plus POST /policy/evaluate when
 * a published version is in play. Failures jump to a field or YAML
 * path. Wizard remains guided add; NDV is edit. No draft execute.
 * Approval resume stays decide. No new policy engine, no invented
 * evaluate routes, no SecretField, no expression language.
 *
 * jonny: no unless evaluate payload gap. Existing evaluate already
 * returns nodeId on operations / requirements / denied.
 */

import {
  APPROVAL_DECIDE_HELP,
  APPROVAL_RESUME_VIA_DECIDE_HELP,
  policyEvaluatePath,
} from "./approval-contract.ts";
import {
  canDispatchFromEvaluation,
  policyDecisionLabel,
} from "./approval.ts";
import type {
  ApprovalRequest,
  PolicyDenied,
  PolicyEvaluation,
  PolicyOperationResult,
  PolicyRequirement,
} from "./approval-types.ts";
import { editorEmbedRouteUnchanged } from "./editor-chrome.ts";
import {
  EDITOR_INSPECTOR,
  inspectorPinField,
  inspectorValidationLinks,
  isInspectorCredentialRefField,
} from "./editor-inspector.ts";
import { ndvInspectorIsEdit, ndvWizardStaysAdd } from "./editor-ndv.ts";
import { projectCanvasGraph } from "./workflow-graph.ts";
import {
  errorTargetsNode,
  groupValidationErrors,
  groupedValidationBuckets,
  type GroupedValidationError,
} from "./workflow-graph.ts";
import { canShowSummary, formatFieldLocation } from "./workflow.ts";
import type { ActionLibraryEntry } from "./workflow-action-library.ts";
import {
  formatBounds,
  formatPolicy,
  formatRedaction,
} from "./workflow-core-nodes.ts";
import type {
  CatalogNodeBounds,
  CatalogNodePolicy,
  CatalogRedaction,
  WorkflowFieldError,
  WorkflowSummary,
} from "./workflow-types.ts";

export const R33_STORY = 248;
export const R33_EPIC = 229;
export const R33_KEEP_STORY_OPEN = true;

export const NDV_VALIDATION_PANEL = "validation" as const;

export const NDV_NO_DRAFT_EXECUTE_HELP =
  "Drafts never execute. POST /policy/evaluate needs a published workflowVersionId. Start published stays the run path.";

export const NDV_EVALUATE_WHEN_PUBLISHED_HELP =
  "Policy evaluate is POST /policy/evaluate {workflowId, workflowVersionId} when a published version is in play. This rail does not invent an evaluate route or a draft execute.";

export const NDV_APPROVAL_DECIDE_HELP = APPROVAL_RESUME_VIA_DECIDE_HELP;

export const NDV_VALIDATION_JUMP_HELP =
  "Failures are actionable: jump to the typed field in this inspector or the YAML path from validate/normalize.";

/**
 * jonny: no unless evaluate payload gap.
 * POST /policy/evaluate already returns nodeId on operations,
 * requirements, and denied. Body stays {workflowId, workflowVersionId}.
 * Field/YAML paths come from validate/normalize — not evaluate.
 */
export const JONNY_EVALUATE_PAYLOAD_GAP: string | null = null;

export const EDITOR_NDV_VALIDATION = {
  wizardIsAdd: true,
  inspectorIsEdit: true,
  surfacesValidateNormalizeProblems: true,
  surfacesPolicyBounds: true,
  workflowLevelNotesWhenRelevant: true,
  failuresAreActionable: true,
  jumpToFieldOrYamlPath: true,
  noDraftExecute: true,
  approvalResumeStaysDecide: true,
  reuseEvaluateClient: true,
  evaluatePath: policyEvaluatePath(),
  noInventedEvaluateRoute: true,
  noNewPolicyEngine: true,
  noSecretField: true,
  noExpressionLanguage: true,
  noAppsApiChanges: true,
  catalogFallbackRemovalIsR34: true,
  embedPathUnchanged: true,
  keep248Open: true,
  jonnyOnlyIfEvaluatePayloadGap: true,
} as const;

export const NDV_VALIDATION_RAIL_SOURCES = [
  "src/components/workflows/NdvValidationPanel.tsx",
  "src/components/workflows/EditorInspector.tsx",
  "src/components/workflows/NodeInspector.tsx",
  "src/components/workflows/NdvParameterEditors.tsx",
] as const;

const SECRET_SURFACE_IN_SOURCE =
  /SecretField\b|type=["']password["']|rotateCredential|forgetSecretDraft|rotateWebhookTrigger/;
const EXPRESSION_LANGUAGE_IN_SOURCE =
  /\{\{|ExpressionEditor/;
const INVENTED_ROUTE_IN_SOURCE =
  /["'`]\/(?:replay|policy\/evaluate\/draft|evaluate\/node)(?:["'`/?]|$)/;
const DRAFT_EXECUTE_IN_SOURCE =
  /startDraft|runDraft|draftExecute|executeDraft/;

const PIN_FIELDS = new Set(
  (
    [
      "cluster_target",
      "ssh_target",
      "command_profile",
      "runtime_profile",
      "connection",
      "recipient_list",
      "message_template",
      "response_schema",
    ] as const
  )
    .map((kind) => inspectorPinField(kind))
    .filter((field): field is string => Boolean(field)),
);

const MAPPING_FIELDS = new Set(["mapping", "path", "inputs", "input"]);

export type NdvValidationStatus = "idle" | "pending" | "valid" | "invalid";

export type NdvValidationPanelId =
  | "parameters"
  | "mapping"
  | "pins"
  | "credentials"
  | "validation";

export type NdvValidationJump = {
  yamlPath: string;
  field: string | null;
  panel: NdvValidationPanelId | null;
  line?: number;
  column?: number;
  nodeId?: string;
  location: string;
};

export type NdvCatalogPolicyBounds = {
  policy: CatalogNodePolicy | null;
  bounds: CatalogNodeBounds | null;
  redaction: CatalogRedaction | null;
  policyLabel: string;
  boundsLabel: string;
  redactionLabel: string;
};

export type NdvEvaluateNodeView = {
  publishedVersionInPlay: boolean;
  decision: string | null;
  dispatchAllowed: boolean | null;
  decisionLabel: string | null;
  operations: PolicyOperationResult[];
  requirements: PolicyRequirement[];
  denied: PolicyDenied[];
  approvals: ApprovalRequest[];
  workflowNotes: string[];
};

export type NdvValidationView = {
  status: NdvValidationStatus;
  node: GroupedValidationError[];
  workflow: GroupedValidationError[];
  edge: GroupedValidationError[];
  warnings: GroupedValidationError[];
  jumps: NdvValidationJump[];
};

export function ndvWizardRemainsAdd(): boolean {
  return (
    EDITOR_NDV_VALIDATION.wizardIsAdd &&
    EDITOR_INSPECTOR.wizardIsAdd &&
    ndvWizardStaysAdd()
  );
}

export function ndvValidationIsEdit(): boolean {
  return (
    EDITOR_NDV_VALIDATION.inspectorIsEdit &&
    EDITOR_INSPECTOR.inspectorIsEdit &&
    ndvInspectorIsEdit()
  );
}

export function ndvValidationEmbedUnchanged(): boolean {
  return (
    EDITOR_NDV_VALIDATION.embedPathUnchanged && editorEmbedRouteUnchanged()
  );
}

export function ndvValidationNeverGuessesGraph(input: {
  errors: WorkflowFieldError[];
  summary: WorkflowSummary | null;
  yaml: string;
}): boolean {
  if (!canShowSummary(input.errors, input.summary)) {
    return (
      projectCanvasGraph({
        errors: input.errors,
        summary: input.summary,
        yaml: input.yaml,
      }) === null
    );
  }
  return true;
}

export function ndvValidationSourceForbidsSecretSurface(source: string): boolean {
  return !SECRET_SURFACE_IN_SOURCE.test(source);
}

export function ndvValidationSourceForbidsExpressionLanguage(
  source: string,
): boolean {
  return !EXPRESSION_LANGUAGE_IN_SOURCE.test(source);
}

export function ndvValidationSourceForbidsInventedRoutes(
  source: string,
): boolean {
  return !INVENTED_ROUTE_IN_SOURCE.test(source);
}

export function ndvValidationSourceForbidsDraftExecute(source: string): boolean {
  return !DRAFT_EXECUTE_IN_SOURCE.test(source);
}

export function ndvApprovalResumeStaysDecide(): boolean {
  return (
    EDITOR_NDV_VALIDATION.approvalResumeStaysDecide &&
    APPROVAL_DECIDE_HELP.includes("/decide") &&
    APPROVAL_RESUME_VIA_DECIDE_HELP.includes("/decide")
  );
}

export function ndvFieldFromYamlPath(path: string): {
  field: string | null;
  panel: NdvValidationPanelId | null;
} {
  const trimmed = path.trim();
  if (!trimmed) {
    return { field: null, panel: null };
  }
  const nodeName = /(?:^|[.\]])name$/.exec(trimmed);
  if (nodeName && /nodes/.test(trimmed) && !/\.with\./.test(trimmed)) {
    return { field: "name", panel: "parameters" };
  }
  const withMatch = /(?:with|inputs)\.([A-Za-z_][A-Za-z0-9_]*)/.exec(trimmed);
  if (!withMatch?.[1]) {
    if (/edges/.test(trimmed) || /inputs/.test(trimmed)) {
      return { field: null, panel: "mapping" };
    }
    return { field: null, panel: null };
  }
  const field = withMatch[1];
  if (field === "schemaType" || field === "schema") {
    return { field: "schemaType", panel: "parameters" };
  }
  if (isInspectorCredentialRefField(field) && field !== "connectionId") {
    return { field, panel: "credentials" };
  }
  if (PIN_FIELDS.has(field) || field === "connectionId") {
    return { field, panel: "pins" };
  }
  if (MAPPING_FIELDS.has(field)) {
    return { field, panel: "mapping" };
  }
  return { field, panel: "parameters" };
}

export function ndvActionableJump(
  error: WorkflowFieldError & { nodeId?: string },
): NdvValidationJump {
  const { field, panel } = ndvFieldFromYamlPath(error.path ?? "");
  return {
    yamlPath: error.path ?? "",
    field,
    panel,
    line: error.line,
    column: error.column,
    nodeId: error.nodeId,
    location: formatFieldLocation(error),
  };
}

export function ndvCatalogPolicyBounds(
  entry: Pick<ActionLibraryEntry, "policy" | "bounds" | "redaction"> | undefined,
): NdvCatalogPolicyBounds {
  const policy = entry?.policy ?? null;
  const bounds = entry?.bounds ?? null;
  const redaction = entry?.redaction ?? null;
  return {
    policy,
    bounds,
    redaction,
    policyLabel: formatPolicy(policy),
    boundsLabel: formatBounds(bounds),
    redactionLabel: formatRedaction(redaction),
  };
}

function rowMatchesNode(
  nodeId: string,
  row: { nodeId?: string | null },
): boolean {
  const value = row.nodeId?.trim() ?? "";
  return value === nodeId;
}

function rowIsWorkflowLevel(row: { nodeId?: string | null }): boolean {
  return !(row.nodeId ?? "").trim();
}

export function ndvEvaluateForNode(input: {
  nodeId: string;
  evaluation?: PolicyEvaluation | null;
  publishedVersionId?: string | null;
}): NdvEvaluateNodeView {
  const publishedVersionInPlay = Boolean(input.publishedVersionId?.trim());
  const evaluation = input.evaluation ?? null;
  if (!publishedVersionInPlay || !evaluation) {
    return {
      publishedVersionInPlay,
      decision: null,
      dispatchAllowed: null,
      decisionLabel: null,
      operations: [],
      requirements: [],
      denied: [],
      approvals: [],
      workflowNotes: publishedVersionInPlay
        ? []
        : [NDV_NO_DRAFT_EXECUTE_HELP],
    };
  }
  const operations = (evaluation.operations ?? []).filter((row) =>
    rowMatchesNode(input.nodeId, row),
  );
  const requirements = evaluation.requirements.filter((row) =>
    rowMatchesNode(input.nodeId, row),
  );
  const denied = evaluation.denied.filter((row) =>
    rowMatchesNode(input.nodeId, row),
  );
  const approvals = evaluation.approvals.filter((row) =>
    rowMatchesNode(input.nodeId, row.binding),
  );
  const workflowNotes: string[] = [
    `Published version evaluate: ${policyDecisionLabel(evaluation.decision)}${
      canDispatchFromEvaluation(evaluation)
        ? " · dispatch allowed"
        : " · dispatch blocked"
    }.`,
  ];
  for (const row of evaluation.denied.filter(rowIsWorkflowLevel)) {
    workflowNotes.push(
      `Workflow deny ${row.operation || "operation"}: ${row.reason || "policy deny"}`,
    );
  }
  for (const row of evaluation.requirements.filter(
    (requirement) =>
      rowIsWorkflowLevel(requirement) ||
      (requirement.nodeId.trim() && requirement.nodeId !== input.nodeId),
  )) {
    const who = row.nodeId.trim() ? row.nodeId : "workflow";
    workflowNotes.push(
      `${who} requires approval for ${row.operation}${
        row.reason ? ` — ${row.reason}` : ""
      }.`,
    );
  }
  return {
    publishedVersionInPlay: true,
    decision: evaluation.decision,
    dispatchAllowed: canDispatchFromEvaluation(evaluation),
    decisionLabel: policyDecisionLabel(evaluation.decision),
    operations,
    requirements,
    denied,
    approvals,
    workflowNotes,
  };
}

/**
 * Report a jonny gap only when evaluate rows that must be node-scoped
 * all lack nodeId. Workflow-level decision / dispatchAllowed is expected.
 */
export function ndvEvaluatePayloadHasGap(
  evaluation: PolicyEvaluation | null | undefined,
): string | null {
  if (JONNY_EVALUATE_PAYLOAD_GAP) {
    return JONNY_EVALUATE_PAYLOAD_GAP;
  }
  if (!evaluation) {
    return null;
  }
  const rows: { nodeId?: string; operation?: string }[] = [
    ...evaluation.requirements,
    ...evaluation.denied,
    ...(evaluation.operations ?? []),
  ];
  const scoped = rows.filter((row) => (row.operation ?? "").trim());
  if (scoped.length <= 1) {
    return null;
  }
  const missing = scoped.filter((row) => !(row.nodeId ?? "").trim());
  if (missing.length === scoped.length) {
    return "POST /policy/evaluate rows lack nodeId; cannot scope policy to the selected node. Ping jonny — do not invent an evaluate route.";
  }
  return null;
}

export function ndvValidationView(input: {
  nodeId: string;
  status: NdvValidationStatus;
  errors: WorkflowFieldError[];
  warnings?: WorkflowFieldError[];
  nodes?: { id: string }[];
  edges?: { from: string; to: string }[];
}): NdvValidationView {
  const nodes = input.nodes ?? [];
  const edges = input.edges ?? [];
  const grouped = groupedValidationBuckets(
    groupValidationErrors(input.errors, nodes, edges),
  );
  const warningGrouped = groupedValidationBuckets(
    groupValidationErrors(input.warnings ?? [], nodes, edges),
  );
  const node = grouped.node.filter(
    (error) => error.nodeId === input.nodeId || errorTargetsNode(error, input.nodeId),
  );
  const edge = grouped.edge.filter((error) => {
    if (error.nodeId === input.nodeId) {
      return true;
    }
    if (error.edgeId?.includes(input.nodeId)) {
      return true;
    }
    return errorTargetsNode(error, input.nodeId);
  });
  const workflow = grouped.workflow;
  const warnings = [
    ...warningGrouped.node.filter(
      (error) =>
        error.nodeId === input.nodeId || errorTargetsNode(error, input.nodeId),
    ),
    ...warningGrouped.workflow,
  ];
  const jumps = [...node, ...edge, ...workflow].map(ndvActionableJump);
  return {
    status: input.status,
    node,
    workflow,
    edge,
    warnings,
    jumps,
  };
}

export function ndvValidationLinks(
  errors: WorkflowFieldError[],
  nodes: { id: string }[] = [],
  edges: { from: string; to: string }[] = [],
) {
  return inspectorValidationLinks(errors, nodes, edges);
}

export function ndvDecideHref(approvalId: string): string {
  return `/approvals/${approvalId}`;
}

export function ndvFieldDomSelector(field: string): string {
  return `[data-ndv-field="${cssEscape(field)}"]`;
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, "\\$&");
}

/** Focus a typed inspector field. YAML jump stays a separate caller. */
export function focusNdvRailField(field: string | null | undefined): boolean {
  if (typeof document === "undefined" || !field?.trim()) {
    return false;
  }
  const root = document.getElementById("editor-ndv-shell");
  if (!root) {
    return false;
  }
  root
    .querySelectorAll("[data-ndv-field-active]")
    .forEach((el) => el.removeAttribute("data-ndv-field-active"));
  const target = root.querySelector(ndvFieldDomSelector(field.trim()));
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  target.setAttribute("data-ndv-field-active", "1");
  target.classList.add("ring-2", "ring-amber-500", "rounded-lg");
  target.scrollIntoView({ block: "nearest" });
  const focusable = target.querySelector<HTMLElement>(
    "input,select,textarea,button",
  );
  (focusable ?? target).focus();
  return true;
}

