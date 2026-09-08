/** Shapes from jonny's E3.1 workflow YAML API (PR #27). */

export const WORKFLOW_API_VERSION = "flowforge/v1";
export const CATALOG_PHASE_CORE = "core";
export const INVALID_WORKFLOW_CODE = "invalid-workflow";

export type CatalogPhase = "core" | "next" | "provider" | string;

export type CatalogPort = {
  name: string;
  kind: string;
  required?: boolean;
};

export type CatalogTrigger = {
  type: string;
  phase: CatalogPhase;
  outputs?: CatalogPort[];
};

export type CatalogNode = {
  type: string;
  phase: CatalogPhase;
  inputs?: CatalogPort[];
  outputs?: CatalogPort[];
  requiredWith?: string[];
};

export type WorkflowCatalog = {
  apiVersion: string;
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
