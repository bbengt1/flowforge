import type { OpsConfigPin } from "./ops-config-types.ts";

/** Shapes from jonny's E3.1 workflow YAML API (PR #27). */

export const WORKFLOW_API_VERSION = "flowforge/v1";
export const CATALOG_PHASE_CORE = "core";
export const INVALID_WORKFLOW_CODE = "invalid-workflow";

export type CatalogPhase = "core" | "next" | "provider" | string;

export type CatalogPort = {
  name: string;
  kind: string;
  required?: boolean;
  classification?: string;
  maxBytes?: number;
  description?: string;
};

export type CatalogTrigger = {
  type: string;
  phase: CatalogPhase;
  outputs?: CatalogPort[];
};

/** Allowlisted `with` key from jonny's E3.3 catalog (#32). */
export type CatalogWithField = {
  name: string;
  kind: string;
  required?: boolean;
  enum?: string[];
  description?: string;
};

export type CatalogNodePolicy = {
  permissions?: string[];
  retrySafe?: boolean;
  sideEffects?: boolean;
  idempotent?: boolean;
  cancellation?: string;
  verification?: string;
  defaultMaxAttempts?: number;
};

export type CatalogNodeBounds = {
  maxInputBytes?: number;
  maxOutputBytes?: number;
  maxWithBytes?: number;
  maxAggregationItems?: number;
  maxDurationSeconds?: number;
};

export type CatalogRedaction = {
  auditFields?: string[];
  redactInputs?: boolean;
  redactOutputs?: boolean;
  strategy?: string;
};

export type CatalogRules = {
  triggersAreWorkflowLevel?: boolean;
  graphNodesExcludeTriggers?: boolean;
  unsupportedPhasesRejected?: boolean;
};

export type CatalogNode = {
  type: string;
  phase: CatalogPhase;
  title?: string;
  description?: string;
  inputs?: CatalogPort[];
  outputs?: CatalogPort[];
  requiredWith?: string[];
  allowedWith?: CatalogWithField[];
  policy?: CatalogNodePolicy;
  bounds?: CatalogNodeBounds;
  redaction?: CatalogRedaction;
};

export type WorkflowCatalog = {
  apiVersion: string;
  rules?: CatalogRules;
  triggers: CatalogTrigger[];
  nodes: CatalogNode[];
};

export type WorkflowFieldError = {
  path: string;
  line?: number;
  column?: number;
  code: string;
  message: string;
};

export type TriggerSummary = {
  id: string;
  type: string;
};

export type NodeSummary = {
  id: string;
  type: string;
  name: string;
};

export type EdgeSummary = {
  from: string;
  to: string;
};

export type OutputSummary = {
  name: string;
  from: string;
};

export type WorkflowSummary = {
  apiVersion: string;
  name: string;
  description?: string;
  triggers: TriggerSummary[];
  nodes: NodeSummary[];
  edges: EdgeSummary[];
  outputs: OutputSummary[];
};

export type ValidateResponse = {
  valid: boolean;
  summary: WorkflowSummary;
  warnings: WorkflowFieldError[];
};

export type NormalizeResponse = {
  definitionYaml: string;
  digest: string;
  summary: WorkflowSummary;
  warnings: WorkflowFieldError[];
};

export type DefinitionYamlBody = {
  definitionYaml: string;
};

/** Shapes from jonny's E3.2 draft/publish/version API (PR #29). */

export const WORKFLOW_STATUS_DRAFT = "draft";
export const WORKFLOW_STATUS_PUBLISHED = "published";
export const COMPARE_KIND_DRAFT = "draft";
export const COMPARE_KIND_VERSION = "version";
export const CONFLICT_CODE = "conflict";

export type WorkflowStatus = "draft" | "published" | "archived" | string;

export type WorkflowRecord = {
  id: string;
  slug: string;
  name: string;
  status: WorkflowStatus;
  draftRevision: number;
  draftDigest: string;
  latestVersionNumber: number;
  latestVersionId?: string;
  latestVersionDigest?: string;
  createdBy?: string;
  updatedBy?: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowList = {
  items: WorkflowRecord[];
};

export type WorkflowDraft = {
  workflowId: string;
  revision: number;
  definitionYaml: string;
  digest: string;
  summary: WorkflowSummary;
  warnings: WorkflowFieldError[];
  validationState: "valid" | "invalid" | string;
  updatedBy?: string;
  updatedAt: string;
};

export type WorkflowDetail = {
  workflow: WorkflowRecord;
  draft: WorkflowDraft;
};

export type WorkflowVersion = {
  id: string;
  workflowId: string;
  versionNumber: number;
  definitionYaml?: string;
  digest: string;
  summary?: WorkflowSummary;
  publishNote: string;
  publishedBy?: string;
  publishedAt: string;
};

export type WorkflowVersionList = {
  items: WorkflowVersion[];
};

export type CreateWorkflowBody = {
  definitionYaml: string;
  slug?: string;
  name?: string;
};

export type SaveDraftBody = {
  revision: number;
  definitionYaml: string;
};

export type PublishWorkflowBody = {
  revision?: number;
  note?: string;
};

export type PublishWorkflowResult = {
  workflow: WorkflowRecord;
  version: WorkflowVersion;
  pins?: OpsConfigPin[];
};

export type CompareKind = "draft" | "version";

export type CompareRef = {
  kind: CompareKind;
  versionId?: string;
  versionNumber?: number;
};

export type CompareWorkflowBody = {
  left: CompareRef;
  right: CompareRef;
};

export type CompareChange = {
  path: string;
  op: "add" | "remove" | "replace" | string;
  left?: unknown;
  right?: unknown;
};

export type CompareWorkflowResult = {
  equal: boolean;
  digestMatch: boolean;
  left: CompareRef;
  right: CompareRef;
  leftDigest: string;
  rightDigest: string;
  changes: CompareChange[];
};

export type RestoreDraftBody = {
  expectedRevision?: number;
};

export type WorkflowExport = {
  workflowId: string;
  versionId: string;
  versionNumber: number;
  digest: string;
  filename: string;
  definitionYaml: string;
};

export type StartExecutionBody = {
  workflowVersionId: string;
};

export type WorkflowExecution = {
  id: string;
  workflowId: string;
  workflowVersionId: string;
  workflowDigest: string;
  status: "queued" | "pinned" | string;
  requestedBy?: string;
  createdAt: string;
  pins?: OpsConfigPin[];
};
