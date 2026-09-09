/**
 * E6.2 action library: searchable, categorized, enabled implementations only.
 * Triggers stay on spec.triggers when rules.triggersAreWorkflowLevel.
 */

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
  if (!listed) {
    if (isCoreNeutralNodeType(type)) {
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
  const fallback = isCoreNeutralNodeType(node.type)
    ? adaptCoreNeutralPalette({
        apiVersion: "flowforge/v1",
        triggers: [],
        nodes: [node],
      }).find((entry) => entry.type === node.type)
    : undefined;
  return {
    type: node.type,
    name: node.title || fallback?.name || node.type,
    description: node.description || fallback?.description || "",
    phase: isCorePhase(node.phase) ? "core" : String(node.phase),
    family: actionFamilyForType(node.type),
    inputs: node.inputs?.length ? node.inputs : fallback?.inputs ?? [],
    outputs: node.outputs?.length ? node.outputs : fallback?.outputs ?? [],
    requiredWith: node.requiredWith?.length ? node.requiredWith : fallback?.requiredWith ?? [],
    allowedWith: node.allowedWith?.length ? node.allowedWith : fallback?.allowedWith ?? [],
    policy: node.policy ?? fallback?.policy ?? null,
    bounds: node.bounds ?? fallback?.bounds ?? null,
    redaction: node.redaction ?? fallback?.redaction ?? null,
    source: fallback?.source === "catalog" || node.title || node.policy ? "catalog" : "contract-fallback",
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
): ActionLibraryEntry[] {
  const enabled = filterEnabledActionNodes(catalog?.nodes);
  const byType = new Map(enabled.map((item) => [item.type, fromCatalogNode(item)]));
  if (!catalog) {
    return adaptCoreNeutralPalette(null).map((entry) => ({
      ...entry,
      type: entry.type,
      enabled: true,
      placeable: true,
    }));
  }
  for (const type of CORE_NEUTRAL_NODE_TYPES) {
    if (!byType.has(type)) {
      const fallback = adaptCoreNeutralPalette(catalog).find((entry) => entry.type === type);
      if (fallback) {
        byType.set(type, { ...fallback, enabled: true, placeable: true });
      }
    }
  }
  return [...byType.values()].sort((left, right) => {
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
