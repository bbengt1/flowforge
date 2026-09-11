/**
 * E6.2 action library: searchable, categorized, enabled implementations only.
 * Triggers stay on spec.triggers when rules.triggersAreWorkflowLevel.
 */

import {
  adaptKubernetesNodeEntries,
  isKubernetesConfigurableType,
  kubernetesLibraryTypes,
} from "./kubernetes-node-contract.ts";
import type { KubernetesEngineCatalog } from "./kubernetes-types.ts";
import {
  adaptSshNodeEntries,
  isSshConfigurableType,
  sshLibraryTypes,
  type SshNodeCatalog,
} from "./ssh-node-contract.ts";
import {
  adaptScriptNodeEntries,
  isScriptConfigurableType,
  scriptLibraryTypes,
  type ScriptNodeCatalog,
} from "./script-contract.ts";
import {
  HTTP_NOTIFICATION_ACTION_TYPES,
  adaptHttpNotificationEntries,
  httpNotificationLibraryTypes,
  isHttpConfigurableType,
  isHttpNotificationNodeEnabled,
  type HttpNotificationCatalog,
} from "./core-http-notification-contract.ts";
import {
  CORE_NEUTRAL_NODE_TYPES,
  adaptCoreNeutralPalette,
  catalogExcludesTriggerNodes,
  familyLabel as coreFamilyLabel,
  filterPaletteEntries,
  isCoreNeutralNodeType,
  type CoreNeutralFamily,
  type CoreNeutralPaletteEntry,
} from "./workflow-core-nodes.ts";
import { isCatalogImplementationEnabled, isCorePhase } from "./workflow.ts";
import type { CatalogNode, CatalogPort, WorkflowCatalog } from "./workflow-types.ts";

export type ActionFamily =
  | CoreNeutralFamily
  | "kubernetes"
  | "ssh"
  | "script"
  | "http"
  | "notification"
  | "other";

export type ActionLibraryEntry = Omit<CoreNeutralPaletteEntry, "type" | "family" | "phase"> & {
  type: string;
  family: ActionFamily;
  phase: string;
  enabled: boolean;
  placeable: boolean;
};

export const ACTION_FAMILY_ORDER: ActionFamily[] = [
  "control",
  "data",
  "lifecycle",
  "kubernetes",
  "ssh",
  "script",
  "http",
  "notification",
  "other",
];

const TRIGGER_TYPES = new Set(["manual", "webhook", "schedule", "event"]);

export function actionFamilyForType(type: string): ActionFamily {
  if (type.startsWith("kubernetes.")) {
    return "kubernetes";
  }
  if (type.startsWith("ssh.")) {
    return "ssh";
  }
  if (type.startsWith("script.")) {
    return "script";
  }
  if (type.startsWith("http.")) {
    return "http";
  }
  if (type.startsWith("notification.")) {
    return "notification";
  }
  if (type === "flow.stop" || type === "flow.fail") {
    return "lifecycle";
  }
  if (type.startsWith("flow.")) {
    return "control";
  }
  if (type.startsWith("data.")) {
    return "data";
  }
  return "other";
}

export function actionFamilyLabel(family: ActionFamily): string {
  if (family === "kubernetes") {
    return "Kubernetes";
  }
  if (family === "ssh") {
    return "SSH";
  }
  if (family === "script") {
    return "Scripts";
  }
  if (family === "http") {
    return "HTTP";
  }
  if (family === "notification") {
    return "Notifications";
  }
  if (family === "other") {
    return "Other";
  }
  return coreFamilyLabel(family);
}

export function isTriggerActionType(type: string): boolean {
  return TRIGGER_TYPES.has(type);
}

export function filterEnabledActionNodes(nodes: CatalogNode[] | undefined | null): CatalogNode[] {
  return (nodes ?? []).filter(
    (item) => isCatalogImplementationEnabled(item) && !isTriggerActionType(item.type),
  );
}

export function rejectDisabledActionType(
  type: string,
  catalog: WorkflowCatalog | null | undefined,
): { ok: boolean; reason: string } {
  if (isTriggerActionType(type) && catalogExcludesTriggerNodes(catalog)) {
    return {
      ok: false,
      reason: "Triggers are workflow-level and are not canvas nodes.",
    };
  }
  const listed = (catalog?.nodes ?? []).find((item) => item.type === type);
  if (
    isHttpConfigurableType(type) &&
    (catalog?.rules?.integrationActionsEnabled === false ||
      catalog?.integrationGate?.enabled === false)
  ) {
    return {
      ok: false,
      reason: `${type} is disabled by the catalog integration gate.`,
    };
  }
  if (!listed) {
    if (
      isCoreNeutralNodeType(type) ||
      kubernetesLibraryTypes(catalog).includes(type) ||
      sshLibraryTypes(catalog).includes(type) ||
      scriptLibraryTypes(catalog).includes(type) ||
      httpNotificationLibraryTypes(catalog).includes(type)
    ) {
      return { ok: true, reason: "" };
    }
    return { ok: false, reason: `${type} is not an enabled catalog implementation.` };
  }
  if (!isCatalogImplementationEnabled(listed)) {
    return {
      ok: false,
      reason: `${type} is not enabled (${listed.phase} phase).`,
    };
  }
  return { ok: true, reason: "" };
}

function fromCatalogNode(node: CatalogNode): ActionLibraryEntry {
  const coreFallback = isCoreNeutralNodeType(node.type)
    ? adaptCoreNeutralPalette({
        apiVersion: "flowforge/v1",
        triggers: [],
        nodes: [node],
      }).find((entry) => entry.type === node.type)
    : undefined;
  const engineFamily =
    isKubernetesConfigurableType(node.type) ||
    isSshConfigurableType(node.type) ||
    isScriptConfigurableType(node.type) ||
    isHttpConfigurableType(node.type);
  const fallbackName = coreFallback?.name;
  const fallbackDescription = coreFallback?.description || "";
  return {
    type: node.type,
    name: node.title || fallbackName || node.type,
    description: node.description || fallbackDescription,
    phase: isCorePhase(node.phase) ? "core" : String(node.phase),
    family: actionFamilyForType(node.type),
    inputs: node.inputs?.length ? node.inputs : coreFallback?.inputs ?? [],
    outputs: node.outputs?.length ? node.outputs : coreFallback?.outputs ?? [],
    requiredWith: node.requiredWith?.length
      ? node.requiredWith
      : coreFallback?.requiredWith ?? [],
    allowedWith: node.allowedWith?.length
      ? node.allowedWith
      : coreFallback?.allowedWith ?? [],
    policy: node.policy ?? coreFallback?.policy ?? null,
    bounds: node.bounds ?? coreFallback?.bounds ?? null,
    redaction: node.redaction ?? coreFallback?.redaction ?? null,
    source: engineFamily || coreFallback?.source === "catalog" || Boolean(node.title || node.policy)
      ? "catalog"
      : "contract-fallback",
    enabled: isCatalogImplementationEnabled(node),
    placeable: !isTriggerActionType(node.type),
  };
}

/**
 * Placeable action library. Triggers are never returned when the catalog
 * says they are workflow-level. Next/provider appear only if enabled.
 */
export function adaptActionLibrary(
  catalog: WorkflowCatalog | null | undefined,
  engineCatalog?: KubernetesEngineCatalog | null,
  sshCatalog?: SshNodeCatalog | null,
  scriptCatalog?: ScriptNodeCatalog | null,
  httpCatalog?: HttpNotificationCatalog | null,
): ActionLibraryEntry[] {
  const enabled = filterEnabledActionNodes(catalog?.nodes);
  const byType = new Map(enabled.map((item) => [item.type, fromCatalogNode(item)]));
  if (!catalog) {
    return sortLibraryEntries(
      adaptCoreNeutralPalette(null).map((entry) => ({
        ...entry,
        type: entry.type,
        enabled: true,
        placeable: true,
      })),
    );
  }
  for (const type of CORE_NEUTRAL_NODE_TYPES) {
    if (!byType.has(type)) {
      const fallback = adaptCoreNeutralPalette(catalog).find((entry) => entry.type === type);
      if (fallback) {
        byType.set(type, { ...fallback, enabled: true, placeable: true });
      }
    }
  }
  for (const node of adaptKubernetesNodeEntries(catalog, engineCatalog)) {
    mergeLibraryNode(byType, node, "catalog");
  }
  for (const node of adaptSshNodeEntries(catalog, sshCatalog)) {
    mergeLibraryNode(byType, node, "catalog");
  }
  for (const node of adaptScriptNodeEntries(catalog, scriptCatalog)) {
    mergeLibraryNode(byType, node, "catalog");
  }
  for (const node of adaptHttpNotificationEntries(catalog, httpCatalog)) {
    mergeLibraryNode(byType, node, "catalog");
  }
  for (const type of HTTP_NOTIFICATION_ACTION_TYPES) {
    if (!isHttpNotificationNodeEnabled(type, httpCatalog, catalog)) {
      byType.delete(type);
    }
  }
  return sortLibraryEntries([...byType.values()]);
}

function mergeLibraryNode(
  byType: Map<string, ActionLibraryEntry>,
  node: CatalogNode,
  source: "catalog" | "contract-fallback",
): void {
  const existing = byType.get(node.type);
  if (!existing) {
    byType.set(node.type, {
      ...fromCatalogNode(node),
      source,
    });
    return;
  }
  if ((existing.allowedWith?.length ?? 0) === 0 && (node.allowedWith?.length ?? 0) > 0) {
    byType.set(node.type, {
      ...existing,
      name: existing.name || node.title || existing.name,
      description: existing.description || node.description || existing.description,
      allowedWith: node.allowedWith ?? existing.allowedWith,
      requiredWith: existing.requiredWith.length
        ? existing.requiredWith
        : node.requiredWith ?? existing.requiredWith,
      policy: existing.policy ?? node.policy ?? existing.policy,
      source,
    });
  }
}

function sortLibraryEntries(entries: ActionLibraryEntry[]): ActionLibraryEntry[] {
  return entries.sort((left, right) => {
    const familyDelta =
      ACTION_FAMILY_ORDER.indexOf(left.family) - ACTION_FAMILY_ORDER.indexOf(right.family);
    if (familyDelta !== 0) {
      return familyDelta;
    }
    return left.name.localeCompare(right.name);
  });
}

export function filterActionLibrary(
  entries: ActionLibraryEntry[],
  query: string,
): ActionLibraryEntry[] {
  return filterPaletteEntries(entries as unknown as CoreNeutralPaletteEntry[], query).map(
    (entry) => entries.find((item) => item.type === entry.type) ?? (entry as ActionLibraryEntry),
  );
}

export function actionPortHints(entry: Pick<ActionLibraryEntry, "inputs" | "outputs">): string {
  const ports: CatalogPort[] = [...(entry.inputs ?? []), ...(entry.outputs ?? [])];
  if (ports.length === 0) {
    return "no ports";
  }
  const inputs = (entry.inputs ?? []).map((port) => `in:${port.name}`).join(" ");
  const outputs = (entry.outputs ?? []).map((port) => `out:${port.name}`).join(" ");
  return [inputs, outputs].filter(Boolean).join(" · ");
}
