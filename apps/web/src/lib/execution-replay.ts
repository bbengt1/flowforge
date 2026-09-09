/**
 * E6.4 execution history + graph replay helpers.
 *
 * Extends E5.1–E5.3 list/detail and the E6.2 canvas projection.
 * Prefer existing E5 routes. Do not invent wait/resume APIs — E10.3
 * resume is POST /approvals/{id}/decide.
 * Secrets stay [redacted] or stripped — never compared as plaintext.
 */

import { isExecutionAwaitingApproval } from "./approval.ts";
import type { ApprovalRequest, PolicyEvaluation } from "./approval-types.ts";
import {
  APPROVAL_RESUME_DISABLED_HELP,
  APPROVAL_WAIT_DISABLED_HELP,
  COMPARE_REDACTION_HELP,
  E10_APPROVAL_RESUME_ENABLED,
  E10_APPROVAL_WAIT_ENABLED,
  INDETERMINATE_STATUS_HELP,
  PRE_RUN_PUBLISHED_ONLY_HELP,
  PRE_RUN_SIDE_EFFECT_HELP,
  RETRY_INDETERMINATE_MESSAGE,
} from "./execution-contract.ts";
import {
  boundRedactedDisplay,
  canRetryExecution,
  canRetryExecutionStep,
  executionStatusPresentation,
  isIndeterminateStatus,
  isSecretFieldName,
  normalizeExecutionStatus,
  stripSecretFields,
} from "./execution.ts";
import {
  REDACTED_MARKER,
  type ExecutionDetail,
  type ExecutionStatusPresentation,
  type ExecutionStep,
} from "./execution-types.ts";
import type { OpsConfigPin } from "./ops-config-types.ts";
import type { ProblemDetails } from "./problem.ts";
import {
  canvasNodeStateIcon,
  canvasNodeStateLabel,
  parseYamlGraph,
  projectCanvasGraph,
  type CanvasNodeState,
  type WorkflowGraph,
} from "./workflow-graph.ts";
import { executionStartBody, publishedVersions } from "./workflow.ts";
import type {
  CatalogNode,
  StartExecutionBody,
  WorkflowCatalog,
  WorkflowSummary,
  WorkflowVersion,
} from "./workflow-types.ts";
import { isValidNodeId } from "./workflow-yaml-nodes.ts";

export {
  APPROVAL_RESUME_DISABLED_HELP,
  APPROVAL_WAIT_DISABLED_HELP,
  COMPARE_REDACTION_HELP,
  E10_APPROVAL_RESUME_ENABLED,
  E10_APPROVAL_WAIT_ENABLED,
  GRAPH_REPLAY_HELP,
  KEYBOARD_HISTORY_HELP,
  PRE_RUN_PUBLISHED_ONLY_HELP,
  PRE_RUN_SIDE_EFFECT_HELP,
} from "./execution-contract.ts";

const SIDE_EFFECT_TYPE_RE =
  /^(kubernetes|k8s|ssh|http|notification|notify|script|python|go)\./i;

const DRAFT_SENTINELS = new Set(["", "draft", "current", "latest-draft"]);

export type ReplayStepView = {
  step: ExecutionStep;
  nodeId: string;
  status: string;
  presentation: ExecutionStatusPresentation;
  durationMs: number | null;
  durationLabel: string;
  attempts: number;
  waiting: boolean;
  current: boolean;
  outputText: string;
};

export type PreRunReview = {
  versionId: string;
  versionLabel: string;
  digest: string;
  published: boolean;
  triggers: { id: string; type: string }[];
  triggerInput: unknown;
  triggerInputText: string;
  targets: { kind: string; name: string; digest: string }[];
  environment: string;
  sideEffectWarnings: string[];
  approvalRequired: boolean;
  dispatchAllowed: boolean;
  canStart: boolean;
  blockReason: string;
};

export type ExecutionCompareChange = {
  path: string;
  op: "add" | "remove" | "replace";
  left: unknown;
  right: unknown;
};

export type ExecutionCompareResult = {
  equal: boolean;
  digestMatch: boolean;
  leftDigest: string;
  rightDigest: string;
  leftLabel: string;
  rightLabel: string;
  changes: ExecutionCompareChange[];
  redacted: true;
  help: string;
};

export type HistoryKeyAction = {
  index: number;
  activate: boolean;
};

export type ExecutionErrorNavLink = {
  id: string;
  href: string;
  label: string;
  nodeId?: string;
  stepId?: string;
  tone: "failed" | "indeterminate" | "problem";
};

export function isDraftRunSelection(versionId: string | null | undefined): boolean {
  const folded = versionId?.trim().toLowerCase() ?? "";
  return DRAFT_SENTINELS.has(folded) || folded.startsWith("draft:");
}

export function publishedRunVersions(versions: WorkflowVersion[]): WorkflowVersion[] {
  return publishedVersions(versions).filter((version) => !isDraftRunSelection(version.id));
}

export function canStartPublishedRun(input: {
  versions: WorkflowVersion[];
  selectedVersionId: string;
  extras?: { idempotencyKey?: string; input?: Record<string, unknown> };
}): { ok: boolean; reason: string; body: StartExecutionBody | null } {
  if (isDraftRunSelection(input.selectedVersionId)) {
    return {
      ok: false,
      reason: PRE_RUN_PUBLISHED_ONLY_HELP,
      body: null,
    };
  }
  const published = publishedRunVersions(input.versions);
  const selected = published.find((version) => version.id === input.selectedVersionId);
  if (!selected) {
    return {
      ok: false,
      reason: PRE_RUN_PUBLISHED_ONLY_HELP,
      body: null,
    };
  }
  const body = executionStartBody(selected.id, input.extras);
  if (!body) {
    return {
      ok: false,
      reason: PRE_RUN_PUBLISHED_ONLY_HELP,
      body: null,
    };
  }
  return { ok: true, reason: "", body };
}

export function parseTriggerInput(text: string): {
  ok: boolean;
  value?: Record<string, unknown>;
  error: string;
  strippedKeys: string[];
} {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: true, error: "", strippedKeys: [] };
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        ok: false,
        error: "Trigger input must be a JSON object.",
        strippedKeys: [],
      };
    }
    const strippedKeys: string[] = [];
    const cleaned = stripSecretFields(parsed, strippedKeys);
    return {
      ok: true,
      value: cleaned as Record<string, unknown>,
      error: "",
      strippedKeys,
    };
  } catch {
    return {
      ok: false,
      error: "Trigger input is not valid JSON.",
      strippedKeys: [],
    };
  }
}

export function summaryFromPublishedYaml(yaml: string): WorkflowSummary | null {
  const parsed = parseYamlGraph(yaml);
  if (!parsed.meta.name && parsed.nodes.length === 0 && parsed.edges.length === 0) {
    return null;
  }
  if (parsed.nodes.some((node) => !isValidNodeId(node.id))) {
    return null;
  }
  return {
    apiVersion: "flowforge/v1",
    name: parsed.meta.name,
    description: parsed.meta.description,
    triggers: parsed.triggers,
    nodes: parsed.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      name: node.name,
    })),
    edges: parsed.edges.map((edge) => ({ from: edge.from, to: edge.to })),
    outputs: [],
  };
}

/** Project the pinned published version only. Invalid YAML never becomes a graph. */
export function projectPinnedVersionGraph(input: {
  yaml?: string;
  summary?: WorkflowSummary | null;
  catalog?: WorkflowCatalog | null;
}): WorkflowGraph | null {
  const yaml = input.yaml?.trim() ?? "";
  if (!yaml) {
    return null;
  }
  const summary = input.summary ?? summaryFromPublishedYaml(yaml);
  if (!summary) {
    return null;
  }
  return projectCanvasGraph({
    errors: [],
    summary,
    yaml,
    catalog: input.catalog,
  });
}

export function canvasStateFromExecutionStatus(
  status: string | undefined,
): CanvasNodeState {
  const folded = normalizeExecutionStatus(status);
  if (folded === "indeterminate") {
    return "indeterminate";
  }
  if (folded === "running" || folded === "claimed") {
    return "running";
  }
  if (folded === "succeeded") {
    return "succeeded";
  }
  if (folded === "failed") {
    return "failed";
  }
  if (folded === "canceled") {
    return "canceled";
  }
  if (isExecutionAwaitingApproval(folded)) {
    return "approval-required";
  }
  return "valid";
}

export function latestStepsByNode(
  steps: readonly ExecutionStep[],
): Map<string, ExecutionStep> {
  const latest = new Map<string, ExecutionStep>();
  for (const step of steps) {
    const current = latest.get(step.nodeId);
    if (!current || step.attempt >= current.attempt) {
      latest.set(step.nodeId, step);
    }
  }
  return latest;
}

export function overlayExecutionOnGraph(
  graph: WorkflowGraph,
  steps: readonly ExecutionStep[],
  options: { waitingApprovalNodeIds?: readonly string[] } = {},
): WorkflowGraph {
  const latest = latestStepsByNode(steps);
  const waiting = new Set(options.waitingApprovalNodeIds ?? []);
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const step = latest.get(node.id);
      let state = node.state;
      if (waiting.has(node.id)) {
        state = "approval-required";
      } else if (step) {
        state = canvasStateFromExecutionStatus(step.status);
      }
      return { ...node, state };
    }),
  };
}

export function currentReplayNodeId(
  steps: readonly ExecutionStep[],
  waitingApprovalNodeIds: readonly string[] = [],
): string | null {
  const latest = [...latestStepsByNode(steps).values()];
  const running = latest.find(
    (step) =>
      normalizeExecutionStatus(step.status) === "running" ||
      normalizeExecutionStatus(step.status) === "claimed",
  );
  if (running) {
    return running.nodeId;
  }
  const waitingStep = latest.find((step) => isExecutionAwaitingApproval(step.status));
  if (waitingStep) {
    return waitingStep.nodeId;
  }
  if (waitingApprovalNodeIds[0]) {
    return waitingApprovalNodeIds[0];
  }
  const attention = latest.find(
    (step) =>
      isIndeterminateStatus(step.status) ||
      normalizeExecutionStatus(step.status) === "failed",
  );
  if (attention) {
    return attention.nodeId;
  }
  const finished = [...latest].sort((a, b) =>
    (b.finishedAt || b.startedAt || "").localeCompare(a.finishedAt || a.startedAt || ""),
  );
  return finished[0]?.nodeId ?? latest[0]?.nodeId ?? null;
}

export function stepDurationMs(step: Pick<ExecutionStep, "startedAt" | "finishedAt">): number | null {
  const start = Date.parse(step.startedAt);
  const end = Date.parse(step.finishedAt);
  if (!Number.isFinite(start)) {
    return null;
  }
  if (!Number.isFinite(end) || end < start) {
    return null;
  }
  return end - start;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) {
    return "—";
  }
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)} s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

export function waitingApprovalNodeIds(
  approvals: readonly ApprovalRequest[],
): string[] {
  return approvals
    .filter((item) => item.status === "pending")
    .map((item) => item.binding.nodeId)
    .filter(Boolean);
}

export function replayStepViews(
  steps: readonly ExecutionStep[],
  options: { waitingApprovalNodeIds?: readonly string[] } = {},
): ReplayStepView[] {
  const current = currentReplayNodeId(steps, options.waitingApprovalNodeIds);
  const waiting = new Set(options.waitingApprovalNodeIds ?? []);
  return steps.map((step) => {
    const durationMs = stepDurationMs(step);
    return {
      step,
      nodeId: step.nodeId,
      status: step.status,
      presentation: executionStatusPresentation(step.status),
      durationMs,
      durationLabel: formatDuration(durationMs),
      attempts: step.attempt,
      waiting:
        waiting.has(step.nodeId) || isExecutionAwaitingApproval(step.status),
      current: step.nodeId === current,
      outputText: boundRedactedDisplay(step.output ?? step.error ?? step.input).text,
    };
  });
}

export function sideEffectWarnings(
  nodes: readonly { type: string; id?: string; name?: string }[],
  catalog?: WorkflowCatalog | null,
): string[] {
  const byType = new Map((catalog?.nodes ?? []).map((node) => [node.type, node]));
  const warnings: string[] = [];
  for (const node of nodes) {
    const catalogNode = byType.get(node.type);
    const flagged =
      catalogNode?.policy?.sideEffects === true || SIDE_EFFECT_TYPE_RE.test(node.type);
    if (!flagged) {
      continue;
    }
    const label = node.name || node.id || node.type;
    warnings.push(`${label} (${node.type}) may have remote side effects.`);
  }
  return warnings;
}

export function targetEnvSummary(pins: readonly OpsConfigPin[] = []): {
  targets: { kind: string; name: string; digest: string }[];
  environment: string;
} {
  const targets = pins.map((pin) => ({
    kind: pin.kind,
    name: pin.name || pin.slug || pin.resourceId,
    digest: pin.digest,
  }));
  const environment = targets.length
    ? targets.map((item) => `${item.kind}:${item.name}`).join(", ")
    : "No pinned target or environment";
  return { targets, environment };
}

export function buildPreRunReview(input: {
  version?: WorkflowVersion | null;
  versions?: WorkflowVersion[];
  selectedVersionId?: string;
  pins?: OpsConfigPin[];
  triggerInput?: unknown;
  evaluation?: PolicyEvaluation | null;
  catalog?: WorkflowCatalog | null;
}): PreRunReview {
  const versions = input.versions ?? (input.version ? [input.version] : []);
  const selectedId = input.selectedVersionId || input.version?.id || "";
  const version =
    input.version ?? versions.find((item) => item.id === selectedId) ?? null;
  const start = canStartPublishedRun({
    versions,
    selectedVersionId: selectedId,
  });
  const fromYaml = version?.definitionYaml
    ? parseYamlGraph(version.definitionYaml).nodes
    : [];
  const fromSummary = version?.summary?.nodes ?? [];
  const yamlNodes = mergeNamedNodes(fromYaml, fromSummary);
  const { targets, environment } = targetEnvSummary(input.pins ?? []);
  const triggerInput = stripSecretFields(input.triggerInput ?? null);
  const sideEffects = sideEffectWarnings(yamlNodes, input.catalog);
  const approvalRequired = input.evaluation?.decision === "approval-required";
  const dispatchAllowed = Boolean(input.evaluation?.dispatchAllowed);
  let blockReason = start.reason;
  if (start.ok && input.evaluation && !dispatchAllowed) {
    blockReason = approvalRequired
      ? "Policy requires a current approval before dispatch."
      : "Server evaluation does not allow dispatch.";
  }
  return {
    versionId: version?.id ?? "",
    versionLabel: version ? `v${version.versionNumber}` : "No published version",
    digest: version?.digest ?? "",
    published: start.ok,
    triggers:
      version?.summary?.triggers ??
      (version?.definitionYaml ? parseYamlGraph(version.definitionYaml).triggers : []),
    triggerInput,
    triggerInputText: boundRedactedDisplay(triggerInput).text,
    targets,
    environment,
    sideEffectWarnings: sideEffects,
    approvalRequired,
    dispatchAllowed,
    canStart: start.ok && (input.evaluation == null || dispatchAllowed),
    blockReason,
  };
}

function mergeNamedNodes(
  left: readonly { id: string; type: string; name?: string }[],
  right: readonly { id: string; type: string; name?: string }[],
): { id: string; type: string; name?: string }[] {
  const byId = new Map<string, { id: string; type: string; name?: string }>();
  for (const node of [...left, ...right]) {
    if (node.id) {
      byId.set(node.id, node);
    }
  }
  return [...byId.values()];
}

export function catalogNodeForType(
  catalog: WorkflowCatalog | null | undefined,
  type: string,
): CatalogNode | undefined {
  return catalog?.nodes.find((node) => node.type === type);
}

export type ApprovalWaitControls = {
  waitEnabled: boolean;
  resumeEnabled: boolean;
  waitHelp: string;
  resumeHelp: string;
};

export function approvalWaitControls(): ApprovalWaitControls {
  return {
    waitEnabled: E10_APPROVAL_WAIT_ENABLED,
    resumeEnabled: E10_APPROVAL_RESUME_ENABLED,
    waitHelp: APPROVAL_WAIT_DISABLED_HELP,
    resumeHelp: APPROVAL_RESUME_DISABLED_HELP,
  };
}

export function retryBlockedForIndeterminate(input: {
  executionStatus?: string;
  stepStatus?: string;
  nodeType?: string;
  steps?: readonly { status?: string; nodeType?: string }[];
}): boolean {
  if (isIndeterminateStatus(input.executionStatus) || isIndeterminateStatus(input.stepStatus)) {
    return true;
  }
  if (input.stepStatus) {
    return !canRetryExecutionStep({
      permissions: ["workflow.execute"],
      executionStatus: input.executionStatus,
      stepStatus: input.stepStatus,
      nodeType: input.nodeType,
    });
  }
  return !canRetryExecution({
    permissions: ["workflow.execute"],
    status: input.executionStatus,
    steps: input.steps,
  });
}

export function indeterminatePresentation(
  status?: string,
): ExecutionStatusPresentation {
  return executionStatusPresentation(status ?? "indeterminate");
}

export function isIndeterminateUnmistakable(
  presentation: ExecutionStatusPresentation,
): boolean {
  return (
    presentation.indeterminate &&
    Boolean(presentation.icon) &&
    /indeterminate/i.test(`${presentation.label} ${presentation.description}`)
  );
}

export function indeterminateReplayAnnouncement(status?: string): string {
  const presentation = indeterminatePresentation(status);
  return `${presentation.icon} ${presentation.label}. ${INDETERMINATE_STATUS_HELP}`;
}

function summarizeExecution(detail: ExecutionDetail): Record<string, unknown> {
  return {
    status: detail.status,
    workflowVersionId: detail.workflowVersionId,
    workflowDigest: detail.workflowDigest,
    input: detail.input,
    policySnapshot: detail.policySnapshot,
    outcomes: detail.steps.map((step) => ({
      nodeId: step.nodeId,
      status: step.status,
      attempt: step.attempt,
    })),
    pins: detail.pins.map((pin) => ({
      kind: pin.kind,
      name: pin.name ?? pin.slug ?? pin.resourceId,
      digest: pin.digest,
    })),
  };
}

function jsonValue(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return String(value);
  }
}

function walkCompare(
  left: unknown,
  right: unknown,
  path: string,
  changes: ExecutionCompareChange[],
): void {
  if (jsonValue(left) === jsonValue(right)) {
    return;
  }
  const leftRecord = left && typeof left === "object" && !Array.isArray(left)
    ? (left as Record<string, unknown>)
    : null;
  const rightRecord = right && typeof right === "object" && !Array.isArray(right)
    ? (right as Record<string, unknown>)
    : null;
  if (leftRecord && rightRecord) {
    const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
    for (const key of keys) {
      if (isSecretFieldName(key)) {
        continue;
      }
      const child = path ? `${path}.${key}` : key;
      walkCompare(leftRecord[key], rightRecord[key], child, changes);
    }
    return;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    const max = Math.max(left.length, right.length);
    for (let index = 0; index < max; index += 1) {
      walkCompare(left[index], right[index], `${path}[${index}]`, changes);
    }
    return;
  }
  if (left === undefined) {
    changes.push({ path, op: "add", left: undefined, right: redactCompareValue(right) });
    return;
  }
  if (right === undefined) {
    changes.push({ path, op: "remove", left: redactCompareValue(left), right: undefined });
    return;
  }
  changes.push({
    path,
    op: "replace",
    left: redactCompareValue(left),
    right: redactCompareValue(right),
  });
}

function redactCompareValue(value: unknown): unknown {
  if (typeof value === "string" && looksLikeSecretPlaintext(value)) {
    return REDACTED_MARKER;
  }
  return value;
}

function looksLikeSecretPlaintext(value: string): boolean {
  return (
    /-----BEGIN |Bearer |ghp_|sk-|xox[baprs]-/i.test(value) &&
    value !== REDACTED_MARKER
  );
}

export function compareRedactedExecutions(
  left: ExecutionDetail,
  right: ExecutionDetail,
): ExecutionCompareResult {
  const leftClean = stripSecretFields(summarizeExecution(left)) as Record<string, unknown>;
  const rightClean = stripSecretFields(summarizeExecution(right)) as Record<string, unknown>;
  const changes: ExecutionCompareChange[] = [];
  walkCompare(leftClean, rightClean, "", changes);
  return {
    equal: changes.length === 0,
    digestMatch: left.workflowDigest === right.workflowDigest,
    leftDigest: left.workflowDigest,
    rightDigest: right.workflowDigest,
    leftLabel: `${left.id} · ${left.status}`,
    rightLabel: `${right.id} · ${right.status}`,
    changes,
    redacted: true,
    help: COMPARE_REDACTION_HELP,
  };
}

export function compareContainsPlaintextSecret(
  result: ExecutionCompareResult,
  needle: string,
): boolean {
  if (!needle.trim()) {
    return false;
  }
  const blob = JSON.stringify(result.changes);
  return blob.includes(needle);
}

export function moveHistoryFocus(
  index: number,
  delta: number,
  length: number,
): number {
  if (length <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(length - 1, index + delta));
}

export function historyKeyAction(
  key: string,
  index: number,
  length: number,
): HistoryKeyAction {
  if (key === "ArrowDown" || key === "ArrowRight") {
    return { index: moveHistoryFocus(index, 1, length), activate: false };
  }
  if (key === "ArrowUp" || key === "ArrowLeft") {
    return { index: moveHistoryFocus(index, -1, length), activate: false };
  }
  if (key === "Home") {
    return { index: 0, activate: false };
  }
  if (key === "End") {
    return { index: Math.max(0, length - 1), activate: false };
  }
  if (key === "Enter" || key === " ") {
    return { index, activate: true };
  }
  return { index, activate: false };
}

export function executionErrorNavLinks(input: {
  steps?: readonly ExecutionStep[];
  problem?: ProblemDetails | null;
}): ExecutionErrorNavLink[] {
  const links: ExecutionErrorNavLink[] = [];
  if (input.problem) {
    links.push({
      id: "execution-errors",
      href: "#execution-errors",
      label: `${input.problem.title}: ${input.problem.detail}`,
      tone: "problem",
    });
  }
  for (const step of input.steps ?? []) {
    if (isIndeterminateStatus(step.status)) {
      links.push({
        id: `replay-node-${step.nodeId}`,
        href: `#replay-node-${step.nodeId}`,
        label: `${canvasNodeStateIcon("indeterminate")} Indeterminate node ${step.nodeId}`,
        nodeId: step.nodeId,
        stepId: step.id,
        tone: "indeterminate",
      });
      continue;
    }
    if (normalizeExecutionStatus(step.status) === "failed") {
      links.push({
        id: `replay-node-${step.nodeId}`,
        href: `#replay-node-${step.nodeId}`,
        label: `${canvasNodeStateIcon("failed")} Failed node ${step.nodeId}`,
        nodeId: step.nodeId,
        stepId: step.id,
        tone: "failed",
      });
    }
  }
  return links;
}

export function replayNodeHref(nodeId: string): string {
  return `#replay-node-${nodeId}`;
}

export function replayNodeStateLabel(state: CanvasNodeState): string {
  return `${canvasNodeStateIcon(state)} ${canvasNodeStateLabel(state)}`;
}

export function retryIndeterminateCopy(): string {
  return RETRY_INDETERMINATE_MESSAGE;
}

export function preRunSideEffectCopy(): string {
  return PRE_RUN_SIDE_EFFECT_HELP;
}
