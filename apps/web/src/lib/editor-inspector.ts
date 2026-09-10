/**
 * UX.4: selected-node inspector edits with, pins, and credentials
 * (display names only).
 *
 * Relates to #199 / Part of #195. Keep #199 open until merge.
 *
 * Chloe UI only. Reuses CredentialRefSelect, AuthorizedResourceSelect,
 * KubernetesTargetSelect, HttpNotificationPinsPanel, and ops-config /
 * SSH / credential clients. Wizard stays guided add; inspector is edit.
 * No apps/api routes, no UX.7 credential-from-inspector modal.
 */

import { isHttpConfigurableType } from "./core-http-notification-contract.ts";
import { authorizedSelectorOptions } from "./ops-config.ts";
import type { OpsConfigKind, OpsConfigPin } from "./ops-config-types.ts";
import type { ProblemDetails } from "./problem.ts";
import {
  ACTION_WIZARD_STEPS,
  authorizedCredentialOptions,
  credentialTypesForAction,
  opsConfigKindsForAction,
  withFieldForKind,
  type WizardConfigField,
} from "./workflow-action-wizard.ts";
import type { ActionLibraryEntry } from "./workflow-action-library.ts";
import { isCoreNeutralNodeType } from "./workflow-core-nodes.ts";
import {
  groupValidationErrors,
  groupedValidationBuckets,
  type GroupedValidationError,
} from "./workflow-graph.ts";
import type { WorkflowFieldError } from "./workflow-types.ts";
import { canCreateWorkflows } from "./workspace-nav.ts";

export const UX4_STORY = 199;
export const UX4_EPIC = 195;
export const UX4_KEEP_STORY_OPEN = true;

export const INSPECTOR_EDIT_PERMISSION = "workflow.edit";
export const INSPECTOR_MISSING_EDIT_HELP =
  "Editing this node requires workflow.edit. The inspector stays read-only; Add action is also unavailable without that permission.";
export const INSPECTOR_SESSION_HELP =
  "The session cannot call the control plane, so pin and credential selectors stay closed.";
export const INSPECTOR_HTTP_403_HELP =
  "HTTP 403 empties pin and credential selectors. No leftover rows.";
export const INSPECTOR_METADATA_ONLY_HELP =
  "Selectors show display name and version only. YAML stores workspace UUIDs. Secrets, kubeconfig, and private keys are never listed.";

export const EDITOR_INSPECTOR = {
  wizardIsAdd: true,
  inspectorIsEdit: true,
  wizardSteps: ACTION_WIZARD_STEPS,
  credentialSelectEnabledWhenWorkflowEdit: true,
  metadataOnly: true,
  yamlStoresUuids: true,
  secretsNeverShown: true,
  http403EmptiesSelectors: true,
  missingPermissionExplainsConstraint: true,
  workflowSelectionShowsTriggers: true,
  triggersAreNotCanvasNodes: true,
  edgeSelectionExplainsPortCompatibility: true,
  validationErrorsLinkToNodeOrYaml: true,
  noCredentialFromInspectorModal: true,
} as const;

const CREDENTIAL_FIELD = /credential|connectionid/i;

export type InspectorFocus = "workflow" | "edge" | "node";

export function inspectorFocus(
  selection: { kind: InspectorFocus } | null | undefined,
): InspectorFocus {
  return selection?.kind === "edge" || selection?.kind === "node"
    ? selection.kind
    : "workflow";
}

export function canEditInspector(
  permissions: readonly string[] | null | undefined,
  canCall: boolean,
): boolean {
  return canCall && canCreateWorkflows(permissions);
}

export function inspectorEditConstraint(
  permissions: readonly string[] | null | undefined,
  canCall: boolean,
): string | null {
  if (canEditInspector(permissions, canCall)) {
    return null;
  }
  if (!canCall) {
    return INSPECTOR_SESSION_HELP;
  }
  return INSPECTOR_MISSING_EDIT_HELP;
}

export function inspectorPinKinds(type: string): OpsConfigKind[] {
  return opsConfigKindsForAction(type);
}

export function inspectorPinField(kind: OpsConfigKind): string | null {
  return withFieldForKind(kind);
}

export function inspectorCredentialTypes(type: string) {
  return credentialTypesForAction(type);
}

export function inspectorCredentialFields(
  entry: Pick<ActionLibraryEntry, "requiredWith" | "allowedWith"> | undefined,
  nodeType: string,
): string[] {
  if (!entry || isHttpConfigurableType(nodeType)) {
    return [];
  }
  const names = [
    ...entry.requiredWith,
    ...entry.allowedWith.map((field) => field.name),
  ];
  return names.filter(
    (name, index, all) =>
      all.indexOf(name) === index && CREDENTIAL_FIELD.test(name),
  );
}

export function inspectorWithFields(
  fields: readonly WizardConfigField[],
  nodeType: string,
): WizardConfigField[] {
  return fields.filter((field) => {
    if (field.selectorKind) {
      return false;
    }
    if (CREDENTIAL_FIELD.test(field.name) && !isHttpConfigurableType(nodeType)) {
      return false;
    }
    return true;
  });
}

export function inspectorShowsCoreWith(type: string): boolean {
  return isCoreNeutralNodeType(type);
}

export function failClosedSelectorOptions(input: {
  items?: OpsConfigPin[] | null;
  problem?: ProblemDetails | null;
  statusCode?: number;
}): { options: OpsConfigPin[]; closed: boolean; reason: string | null } {
  return authorizedSelectorOptions(input);
}

export function failClosedCredentialOptions(
  input: Parameters<typeof authorizedCredentialOptions>[0],
) {
  return authorizedCredentialOptions(input);
}

export function inspectorValidationLinks(
  errors: WorkflowFieldError[],
  nodes: { id: string }[] = [],
  edges: { from: string; to: string }[] = [],
): {
  workflow: GroupedValidationError[];
  node: GroupedValidationError[];
  edge: GroupedValidationError[];
  nodeIds: string[];
  yamlPaths: string[];
} {
  const grouped = groupedValidationBuckets(
    groupValidationErrors(errors, nodes, edges),
  );
  const nodeIds = grouped.node
    .map((error) => error.nodeId)
    .filter((id): id is string => Boolean(id));
  const yamlPaths = [...grouped.workflow, ...grouped.node, ...grouped.edge]
    .map((error) => error.path)
    .filter((path): path is string => Boolean(path));
  return {
    workflow: grouped.workflow,
    node: grouped.node,
    edge: grouped.edge,
    nodeIds,
    yamlPaths,
  };
}
