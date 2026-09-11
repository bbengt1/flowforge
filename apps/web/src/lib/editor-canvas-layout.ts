/**
 * R2.5: persist optional non-authoritative `metadata.ui.layout` (D1).
 *
 * Relates to #238 / Part of #228. Keep #238 open.
 *
 * Chloe UI only. The API field already stores and returns layout on
 * validate / normalize / draft GET|PUT / versions. This module applies
 * positions on canvas load and writes `{version: 1, nodes: {id: {x,y}}}`
 * back on draft save (normalize → PUT). Missing/invalid → auto-layout.
 * Extra node keys are stripped. Layout never invents a graph, edges,
 * types, `with`, credentials, or ports. Invalid YAML still never guesses
 * a graph. Drafts still never run. Embed + standalone share this helper.
 * No apps/api changes. No greenfield canvas package.
 */

import {
  cloneCanvasLayout,
  pruneCanvasLayout,
  type CanvasLayout,
  type CanvasPoint,
} from "./editor-canvas-history.ts";
import { editorEmbedRouteUnchanged } from "./editor-chrome.ts";
import type { WorkflowSummary, WorkflowUILayout } from "./workflow-types.ts";
import { listYamlNodes } from "./workflow-yaml-nodes.ts";

export const R25_STORY = 238;
export const R25_EPIC = 228;
export const R25_KEEP_STORY_OPEN = true;

export const UI_LAYOUT_VERSION = 1;

export const EDITOR_CANVAS_LAYOUT = {
  optionalNonAuthoritative: true,
  persistOnDraftSave: true,
  applyOnCanvasLoad: true,
  summaryOrYaml: true,
  missingInvalidAutoLayout: true,
  extraNodeKeysStripped: true,
  layoutNeverInventGraph: true,
  invalidYamlNeverGuessesGraph: true,
  neverSecondCanvasFile: true,
  noEdgesTypesWithCredentialsPorts: true,
  saveNormalizesThenPutsDraft: true,
  noDraftExecute: true,
  noSecretField: true,
  noExpressionLanguage: true,
  noAppsApiChanges: true,
  migrateInPlace: true,
  noGreenfieldPackage: true,
  embedPathUnchanged: true,
  keep238Open: true,
} as const;

const LAYOUT_POSITION_KEYS = new Set(["x", "y"]);
const LAYOUT_OBJECT_KEYS = new Set(["version", "nodes"]);

export function canvasLayoutEmbedUnchanged(): boolean {
  return EDITOR_CANVAS_LAYOUT.embedPathUnchanged && editorEmbedRouteUnchanged();
}

export function isFiniteCoord(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function parseFiniteCoord(value: unknown): number | null {
  if (isFiniteCoord(value)) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || /nan|inf/i.test(trimmed)) {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Accept a validate/normalize/draft `summary.ui.layout` value.
 * Non-object / non-finite / unsupported version → absent (auto-layout).
 * Extra keys besides version+nodes → absent. Position extras → drop that node.
 */
export function parseWorkflowUILayout(value: unknown): WorkflowUILayout | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const body = value as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!LAYOUT_OBJECT_KEYS.has(key)) {
      return null;
    }
  }
  if ("version" in body) {
    const version = parseFiniteCoord(body.version);
    if (version === null || version !== UI_LAYOUT_VERSION) {
      return null;
    }
  }
  const nodes: NonNullable<WorkflowUILayout["nodes"]> = {};
  if ("nodes" in body) {
    const raw = body.nodes;
    if (raw == null) {
      return { version: UI_LAYOUT_VERSION, nodes };
    }
    if (typeof raw !== "object" || Array.isArray(raw)) {
      return null;
    }
    for (const [id, point] of Object.entries(raw as Record<string, unknown>)) {
      const parsed = parseLayoutPoint(point);
      if (parsed) {
        nodes[id] = parsed;
      }
    }
  }
  return { version: UI_LAYOUT_VERSION, nodes };
}

export function parseLayoutPoint(value: unknown): CanvasPoint | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const body = value as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!LAYOUT_POSITION_KEYS.has(key)) {
      return null;
    }
  }
  const x = parseFiniteCoord(body.x);
  const y = parseFiniteCoord(body.y);
  if (x === null || y === null) {
    return null;
  }
  return { x, y };
}

export function canvasLayoutFromUi(
  layout: WorkflowUILayout | null | undefined,
  nodeIds?: readonly string[],
): CanvasLayout {
  const next: CanvasLayout = {};
  for (const [id, point] of Object.entries(layout?.nodes ?? {})) {
    const parsed = parseLayoutPoint(point);
    if (parsed) {
      next[id] = parsed;
    }
  }
  return nodeIds ? pruneCanvasLayout(next, nodeIds) : cloneCanvasLayout(next);
}

export function uiLayoutFromCanvas(layout: CanvasLayout): WorkflowUILayout | null {
  const nodes = cloneCanvasLayout(layout);
  if (Object.keys(nodes).length === 0) {
    return null;
  }
  return { version: UI_LAYOUT_VERSION, nodes };
}

function nodeIdsForLayout(
  summary: WorkflowSummary | null | undefined,
  yaml: string,
): string[] {
  if (summary && Array.isArray(summary.nodes) && summary.nodes.length > 0) {
    return summary.nodes.map((node) => node.id);
  }
  return listYamlNodes(yaml).map((node) => node.id);
}

/**
 * Prefer `summary.ui.layout` (validate/normalize/draft/version payloads),
 * else YAML `metadata.ui.layout`. Invalid/missing → empty (auto-layout).
 * Ghost keys (not in spec.nodes) are stripped — layout never invents a node.
 */
export function readPersistedCanvasLayout(
  summary: WorkflowSummary | null | undefined,
  yaml: string,
): CanvasLayout {
  const allowed = nodeIdsForLayout(summary, yaml);
  const fromSummary = parseWorkflowUILayout(summary?.ui?.layout);
  if (fromSummary) {
    return canvasLayoutFromUi(fromSummary, allowed);
  }
  const fromYaml = readYamlCanvasLayout(yaml);
  if (fromYaml) {
    return pruneCanvasLayout(fromYaml, allowed);
  }
  return {};
}

export function readYamlCanvasLayout(yaml: string): CanvasLayout | null {
  const parsed = parseWorkflowUILayout(readYamlUiLayoutValue(yaml));
  if (!parsed) {
    return null;
  }
  return canvasLayoutFromUi(parsed);
}

/**
 * Write only `{version: 1, nodes: {<id>: {x, y}}}`. Empty layout leaves
 * YAML unchanged (do not invent a field). Never writes edges, types,
 * `with`, credentials, or ports.
 */
export function writeCanvasLayoutYaml(yaml: string, layout: CanvasLayout): string {
  const cleaned = cloneCanvasLayout(layout);
  if (Object.keys(cleaned).length === 0) {
    return yaml;
  }
  const block = serializeUiLayoutBlock(cleaned);
  return replaceMetadataUiLayout(yaml, block);
}

export function serializeUiLayoutBlock(layout: CanvasLayout): string[] {
  const ids = Object.keys(cloneCanvasLayout(layout)).sort();
  const lines = ["  ui:", "    layout:", "      version: 1", "      nodes:"];
  for (const id of ids) {
    const point = layout[id];
    if (!point) {
      continue;
    }
    lines.push(`        ${id}: { x: ${formatLayoutCoord(point.x)}, y: ${formatLayoutCoord(point.y)} }`);
  }
  return lines;
}

export function formatLayoutCoord(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  if (Math.trunc(value) === value) {
    return String(value);
  }
  return String(value);
}

function readYamlUiLayoutValue(yaml: string): unknown {
  const lines = yaml.split("\n");
  const metadata = findTopLevelBlock(lines, "metadata");
  if (!metadata) {
    return undefined;
  }
  const ui = findChildBlock(lines, metadata.contentStart, metadata.contentEnd, metadata.indent, "ui");
  if (!ui) {
    return undefined;
  }
  const layout = findChildBlock(lines, ui.contentStart, ui.contentEnd, ui.indent, "layout");
  if (!layout) {
    return undefined;
  }
  const inline = inlineValue(lines[layout.keyLine] ?? "");
  if (inline !== undefined) {
    return parseMaybeFlowMap(inline);
  }
  return parseLayoutMapping(lines, layout.contentStart, layout.contentEnd, layout.indent + 2);
}

function parseLayoutMapping(
  lines: string[],
  start: number,
  end: number,
  indent: number,
): Record<string, unknown> | null {
  const result: Record<string, unknown> = {};
  let index = start;
  while (index < end) {
    const line = lines[index] ?? "";
    const lineIndent = leadingSpaces(line);
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      index += 1;
      continue;
    }
    if (lineIndent < indent) {
      break;
    }
    if (lineIndent > indent) {
      index += 1;
      continue;
    }
    const pair = splitPair(trimmed);
    if (!pair) {
      index += 1;
      continue;
    }
    if (pair.value !== undefined) {
      if (pair.key === "nodes") {
        const flow = parseMaybeFlowMap(pair.value);
        result.nodes = flow && typeof flow === "object" ? flow : pair.value;
      } else if (pair.key === "version") {
        result.version = parseScalar(pair.value);
      } else {
        result[pair.key] = parseScalar(pair.value);
      }
      index += 1;
      continue;
    }
    if (pair.key === "nodes") {
      const nodes = parseLayoutNodes(lines, index + 1, end, indent + 2);
      result.nodes = nodes.value;
      index = nodes.nextIndex;
      continue;
    }
    result[pair.key] = true;
    index += 1;
  }
  return result;
}

function parseLayoutNodes(
  lines: string[],
  start: number,
  end: number,
  indent: number,
): { value: Record<string, unknown>; nextIndex: number } {
  const nodes: Record<string, unknown> = {};
  let index = start;
  while (index < end) {
    const line = lines[index] ?? "";
    const lineIndent = leadingSpaces(line);
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      index += 1;
      continue;
    }
    if (lineIndent < indent) {
      break;
    }
    if (lineIndent > indent) {
      index += 1;
      continue;
    }
    const pair = splitPair(trimmed);
    if (!pair) {
      index += 1;
      continue;
    }
    if (pair.value !== undefined) {
      nodes[pair.key] = parseMaybeFlowMap(pair.value) ?? parseScalar(pair.value);
      index += 1;
      continue;
    }
    const point: Record<string, unknown> = {};
    index += 1;
    while (index < end) {
      const nested = lines[index] ?? "";
      const nestedIndent = leadingSpaces(nested);
      const nestedTrim = nested.trim();
      if (!nestedTrim || nestedTrim.startsWith("#")) {
        index += 1;
        continue;
      }
      if (nestedIndent <= indent) {
        break;
      }
      const nestedPair = splitPair(nestedTrim);
      if (nestedPair?.value !== undefined) {
        point[nestedPair.key] = parseScalar(nestedPair.value);
      }
      index += 1;
    }
    nodes[pair.key] = point;
  }
  return { value: nodes, nextIndex: index };
}

function parseMaybeFlowMap(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return parseScalar(trimmed);
  }
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const part of inner.split(",")) {
    const pair = splitPair(part.trim());
    if (!pair || pair.value === undefined) {
      return trimmed;
    }
    result[pair.key] = parseScalar(pair.value);
  }
  return result;
}

function parseScalar(raw: string): unknown {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (trimmed === "null" || trimmed === "~") {
    return null;
  }
  if (/^(?:[+-])?(?:inf|\.inf|nan|\.nan)$/i.test(trimmed)) {
    return Number.NaN;
  }
  if (/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  return trimmed;
}

function splitPair(text: string): { key: string; value?: string } | null {
  const match = /^([^:#]+):(.*)$/.exec(text);
  if (!match) {
    return null;
  }
  const key = match[1]?.trim() ?? "";
  if (!key) {
    return null;
  }
  const raw = (match[2] ?? "").trim();
  return raw ? { key, value: raw } : { key };
}

function inlineValue(line: string): string | undefined {
  const pair = splitPair(line.trim());
  return pair?.value;
}

type YamlBlock = {
  keyLine: number;
  indent: number;
  contentStart: number;
  contentEnd: number;
};

function findTopLevelBlock(lines: string[], key: string): YamlBlock | null {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const indent = leadingSpaces(line);
    const trimmed = line.trim();
    if (indent !== 0 || trimmed.startsWith("#") || !trimmed) {
      continue;
    }
    if (trimmed === `${key}:` || trimmed.startsWith(`${key}:`)) {
      return blockAt(lines, index, 0);
    }
  }
  return null;
}

function findChildBlock(
  lines: string[],
  start: number,
  end: number,
  parentIndent: number,
  key: string,
): YamlBlock | null {
  const childIndent = parentIndent + 2;
  for (let index = start; index < end; index += 1) {
    const line = lines[index] ?? "";
    const indent = leadingSpaces(line);
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    if (indent <= parentIndent) {
      break;
    }
    if (indent !== childIndent) {
      continue;
    }
    if (trimmed === `${key}:` || trimmed.startsWith(`${key}:`)) {
      return blockAt(lines, index, childIndent, end);
    }
  }
  return null;
}

function blockAt(
  lines: string[],
  keyLine: number,
  indent: number,
  limit = lines.length,
): YamlBlock {
  let contentEnd = keyLine + 1;
  for (let index = keyLine + 1; index < limit; index += 1) {
    const line = lines[index] ?? "";
    const lineIndent = leadingSpaces(line);
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      contentEnd = index + 1;
      continue;
    }
    if (lineIndent <= indent) {
      break;
    }
    contentEnd = index + 1;
  }
  return {
    keyLine,
    indent,
    contentStart: keyLine + 1,
    contentEnd,
  };
}

function replaceMetadataUiLayout(yaml: string, uiLines: string[]): string {
  const lines = yaml.split("\n");
  const metadata = findTopLevelBlock(lines, "metadata");
  if (!metadata) {
    const spec = findTopLevelBlock(lines, "spec");
    const insertAt = spec ? spec.keyLine : lines.length;
    lines.splice(insertAt, 0, "metadata:", ...uiLines);
    return lines.join("\n");
  }
  const ui = findChildBlock(
    lines,
    metadata.contentStart,
    metadata.contentEnd,
    metadata.indent,
    "ui",
  );
  if (ui) {
    lines.splice(ui.keyLine, ui.contentEnd - ui.keyLine, ...uiLines);
    return lines.join("\n");
  }
  lines.splice(metadata.contentEnd, 0, ...uiLines);
  return lines.join("\n");
}

function leadingSpaces(line: string): number {
  const match = /^( *)/.exec(line);
  return match?.[1]?.length ?? 0;
}
