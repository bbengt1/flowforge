/**
 * UX.2: move starter / invalid / normalize out of primary editor chrome.
 *
 * Relates to #197 / Part of #195. Keep #197 open until merge.
 *
 * Chloe UI only: fixtures stay available from Settings → Developer or a
 * YAML-mode disclosure. Normalize is YAML mode or Commands — not a Save
 * peer. Import stays on /workflows and still validates before create.
 */

import {
  INVALID_WORKFLOW_YAML,
  STARTER_WORKFLOW_YAML,
} from "./workflow.ts";
import type { WorkflowFieldError } from "./workflow-types.ts";

export const UX2_STORY = 197;
export const UX2_EPIC = 195;
export const UX2_KEEP_STORY_OPEN = true;

export const SETTINGS_DEVELOPER_HREF = "/settings#developer";
export const WORKFLOWS_IMPORT_HREF = "/workflows?import=1";
export const EDITOR_YAML_DEVELOPER_DISCLOSURE = "Developer samples";
export const EDITOR_YAML_FILE_MENU = "YAML file";

export const EDITOR_TOP_BAR_PRIMARY_ACTIONS = [
  "yaml",
  "save-draft",
  "publish",
  "start-published",
] as const;

export const EDITOR_YAML_PRIMARY_TOOLS = ["validate", "normalize"] as const;

export const EDITOR_YAML_DISCLOSURE_TOOLS = [
  "load-starter-yaml",
  "load-invalid-yaml",
] as const;

export const EDITOR_YAML_OPTIONAL_MENU = ["import-yaml"] as const;

export const EDITOR_DEVELOPER = {
  starterInvalidNotPrimaryButtons: true,
  starterInvalidPlacement: "yaml-disclosure-or-settings-developer",
  normalizePlacement: "yaml-mode-or-commands",
  normalizeNotSavePeer: true,
  importOnHome: true,
  importOptionalYamlMenu: true,
  importValidatesBeforeCreate: true,
  localSeedExamplesOpenAndSave: true,
} as const;

/** Errors shown when the operator loads the intentional invalid fixture. */
export const INVALID_YAML_FIXTURE_ERRORS: WorkflowFieldError[] = [
  {
    path: "spec.nodes[0].id",
    line: 9,
    column: 7,
    code: "invalid-id",
    message: "Node IDs must be DNS labels.",
  },
  {
    path: "spec.nodes[0].type",
    line: 10,
    column: 7,
    code: "unsupported-node",
    message: "workflow.call is not enabled.",
  },
];

export type DeveloperYamlLoad =
  | {
      kind: "starter";
      yaml: string;
      digest: null;
      status: "idle";
      errors: WorkflowFieldError[];
      clearGraph: false;
    }
  | {
      kind: "invalid";
      yaml: string;
      digest: null;
      status: "invalid";
      errors: WorkflowFieldError[];
      clearGraph: true;
    };

export function loadDeveloperYaml(kind: "starter" | "invalid"): DeveloperYamlLoad {
  if (kind === "invalid") {
    return {
      kind: "invalid",
      yaml: INVALID_WORKFLOW_YAML,
      digest: null,
      status: "invalid",
      errors: INVALID_YAML_FIXTURE_ERRORS,
      clearGraph: true,
    };
  }
  return {
    kind: "starter",
    yaml: STARTER_WORKFLOW_YAML,
    digest: null,
    status: "idle",
    errors: [],
    clearGraph: false,
  };
}

export function isPrimaryEditorAction(
  action: string,
): action is (typeof EDITOR_TOP_BAR_PRIMARY_ACTIONS)[number] {
  return (EDITOR_TOP_BAR_PRIMARY_ACTIONS as readonly string[]).includes(action);
}

export function isDemotedDeveloperTool(tool: string): boolean {
  return (
    tool === "load-starter-yaml" ||
    tool === "load-invalid-yaml" ||
    tool === "normalize"
  );
}
