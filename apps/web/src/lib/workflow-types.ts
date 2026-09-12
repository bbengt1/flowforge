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

/** Jonny's E10.1 catalog start map (#111) on `triggers[type=manual].start`. */
export type CatalogTriggerStart = {
  route?: string;
  method?: string;
  permission?: string;
  csrf?: boolean;
  publishedVersionRequired?: boolean;
  versionField?: string;
  inputField?: string;
  schemaFields?: string[];
  idempotencyKeyField?: string;
  idempotencyHeader?: string;
  idempotencyKeyRequired?: boolean;
  idempotencyKeyPattern?: string;
  maxInputBytes?: number;
  createdStatus?: number;
  replayStatus?: number;
  conflictStatus?: number;
  policyDenyStatus?: number;
  approvalRequiredStatus?: number;
  draftStatus?: number;
  help?: string;
};

/** Jonny's E10.2 catalog ingress map (#113) on `triggers[type=webhook].ingress`. */
export type CatalogTriggerIngress = {
  route?: string;
  method?: string;
  public?: boolean;
  csrf?: boolean;
  session?: boolean;
  signatureHeader?: string;
  timestampHeader?: string;
  signatureVersion?: string;
  idempotencyHeader?: string;
  maxBodyBytes?: number;
  maxInputBytes?: number;
  clockSkewSeconds?: number;
  replayRetentionSeconds?: number;
  defaultRatePerMinute?: number;
  defaultWorkspaceRatePerMinute?: number;
  defaultMaxConcurrency?: number;
  defaultWorkspaceMaxConcurrency?: number;
  contentTypes?: string[];
  createdStatus?: number;
  replayStatus?: number;
  conflictStatus?: number;
  unauthorizedStatus?: number;
  rateLimitedStatus?: number;
  tooLargeStatus?: number;
  disabledStatus?: number;
  help?: string;
};

/** Jonny's catalog admin map (#113 webhook / #116 schedule). */
export type CatalogTriggerAdmin = {
  listRoute?: string;
  createRoute?: string;
  itemRoute?: string;
  rotateRoute?: string;
  disableRoute?: string;
  enableRoute?: string;
  deleteRoute?: string;
  dispatchRoute?: string;
  permission?: string;
  viewPermission?: string;
  dispatchPermission?: string;
  csrf?: boolean;
  secretNeverReturned?: boolean;
  help?: string;
};

/**
 * Optional schedule vocabulary. #116 defaults live on GET /schedules/catalog;
 * `triggers[type=schedule].admin` is the route map on GET /workflows/catalog.
 */
export type CatalogTriggerSchedule = {
  timezoneRequired?: boolean;
  expressionKinds?: string[];
  overlapPolicies?: string[];
  defaultOverlapPolicy?: string;
  misfirePolicies?: string[];
  defaultMisfirePolicy?: string;
  defaultCatchUp?: number | boolean;
  maxCatchUp?: number;
  publishedVersionRequired?: boolean;
  help?: string;
};

export type CatalogTrigger = {
  type: string;
  phase: CatalogPhase;
  enabled?: boolean;
  title?: string;
  description?: string;
  outputs?: CatalogPort[];
  allowedWith?: CatalogWithField[];
  bounds?: CatalogNodeBounds;
  redaction?: CatalogRedaction;
  start?: CatalogTriggerStart;
  ingress?: CatalogTriggerIngress;
  admin?: CatalogTriggerAdmin;
  schedule?: CatalogTriggerSchedule;
};

export type CatalogRules = {
  triggersAreWorkflowLevel?: boolean;
  graphNodesExcludeTriggers?: boolean;
  unsupportedPhasesRejected?: boolean;
  integrationActionsEnabled?: boolean;
};

export type CatalogIntegrationGate = {
  name?: string;
  enabled?: boolean;
  nodes?: string[];
  suites?: string[];
  note?: string;
};

export type CatalogNode = {
  type: string;
  phase: CatalogPhase;
  enabled?: boolean;
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
  integrationGate?: CatalogIntegrationGate;
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

/** D1 (#238): finite canvas coordinate. Non-finite values are treated as absent. */
export type WorkflowUILayoutNode = {
  x: number;
  y: number;
};

/**
 * D1 (#238): optional non-authoritative canvas layout on `metadata.ui.layout`.
 * API stores and returns it on validate/normalize/draft/version. Executor,
 * policy evaluate, port typing, and dispatch ignore it. Missing/invalid →
 * auto-layout. Never a second canvas file. Chloe applies this on canvas
 * load and writes it back on draft save (R2.5 / #238 — keep #238 open).
 */
export type WorkflowUILayout = {
  version: 1 | number;
  nodes?: Record<string, WorkflowUILayoutNode>;
};

export type WorkflowUI = {
  layout?: WorkflowUILayout;
};

export type WorkflowSummary = {
  apiVersion: string;
  name: string;
  description?: string;
  triggers: TriggerSummary[];
  nodes: NodeSummary[];
  edges: EdgeSummary[];
  outputs: OutputSummary[];
  ui?: WorkflowUI;
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
  /** D5 additive publish flavor. Current API ignores this; note is the equivalent. */
  kind?: "test";
};

export type PublishWorkflowResult = {
  workflow: WorkflowRecord;
  version: WorkflowVersion;
  pins?: OpsConfigPin[];
  scriptArtifacts?: unknown;
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
  idempotencyKey?: string;
  input?: Record<string, unknown>;
};

export type StartExecutionOptions = {
  idempotencyKey?: string;
  input?: Record<string, unknown>;
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
  idempotencyKey?: string;
  correlationId?: string;
  replayed?: boolean;
  reused?: boolean;
  input?: unknown;
};
