import {
  MAP_CONVERT_KINDS,
  MAX_DELAY_SECONDS,
  defaultNodeName,
  isConditionOp,
  isCoreNeutralNodeType,
  isStopStatus,
  type ConditionOp,
  type CoreNeutralNodeType,
  type StopStatus,
} from "./workflow-core-nodes.ts";

/** Matches jonny's parser: secret-shaped keys are forbidden in YAML. */
export const UNSAFE_YAML_KEY =
  /^(password|passwd|secret|secrets|token|api[_-]?key|private[_-]?key|credential|credentials|authorization|auth[_-]?header|kubeconfig|access[_-]?key|refresh[_-]?token|client[_-]?secret)$/i;

export const SECRET_VALUE_HINT = /(-----BEGIN |Bearer |ghp_|sk-|xox[baprs]-)/i;

export type YamlScalar = string | number | boolean | null;

export type SetFieldKind = "string" | "number" | "boolean" | "null";

export type SetField = {
  key: string;
  kind: SetFieldKind;
  value: string;
};

export type MapPath = {
  dest: string;
  from: string;
  convert?: string;
};

export type CoreNodeWith =
  | { type: "flow.condition"; op: ConditionOp; path: string; compare: string }
  | { type: "flow.delay"; duration: string }
  | { type: "data.set"; fields: SetField[]; classification?: string }
  | { type: "data.map"; mapping: MapPath[] }
  | { type: "data.validate"; schemaType: string; additionalProperties: boolean }
  | { type: "flow.stop"; status: StopStatus; message: string }
  | { type: "flow.fail"; code: string; message: string };

export type YamlWorkflowNode = {
  id: string;
  type: string;
  name: string;
  with: Record<string, unknown>;
  startLine: number;
  endLine: number;
};

export type InsertedNode = {
  yaml: string;
  node: { id: string; type: CoreNeutralNodeType; name: string };
};

const NODE_ID_RE = /^[a-z][a-z0-9-]*$/;

export function isForbiddenYamlKey(key: string): boolean {
  return UNSAFE_YAML_KEY.test(key.trim());
}

export function looksLikeSecretValue(value: string): boolean {
  return SECRET_VALUE_HINT.test(value);
}

export function isValidNodeId(id: string): boolean {
  return NODE_ID_RE.test(id);
}

export function allocateNodeId(
  existingIds: Iterable<string>,
  type: CoreNeutralNodeType,
): string {
  const taken = new Set(existingIds);
  const base = type.slice(type.indexOf(".") + 1);
  if (!taken.has(base)) {
    return base;
  }
  let index = 2;
  while (taken.has(`${base}-${index}`)) {
    index += 1;
  }
  return `${base}-${index}`;
}

export function defaultCoreWith(type: CoreNeutralNodeType): Record<string, unknown> {
  switch (type) {
    case "flow.condition":
      return { op: "eq", compare: "ready" };
    case "flow.delay":
      return { duration: "PT5M" };
    case "data.set":
      return { value: { status: "ready" } };
    case "data.map":
      return { mapping: { "result.state": "input.status" } };
    case "data.validate":
      return { schema: { type: "object", additionalProperties: true } };
    case "flow.stop":
      return { status: "success" };
    case "flow.fail":
      return { code: "operator-failed", message: "Stopped by operator policy." };
  }
}

export function defaultCoreNode(
  type: CoreNeutralNodeType,
  id: string,
  name = defaultNodeName(type),
): { id: string; type: CoreNeutralNodeType; name: string; with: Record<string, unknown> } {
  return { id, type, name, with: defaultCoreWith(type) };
}

export function listYamlNodes(yaml: string): YamlWorkflowNode[] {
  const section = findListSection(yaml, "nodes");
  if (!section) {
    return [];
  }
  return section.items.map((item) => parseNodeItem(yaml, item));
}

export function insertCoreNode(
  yaml: string,
  type: CoreNeutralNodeType,
  options: { id?: string; name?: string } = {},
): InsertedNode {
  const existing = listYamlNodes(yaml);
  const id = options.id && isValidNodeId(options.id)
    ? uniqueId(options.id, existing.map((node) => node.id))
    : allocateNodeId(
        existing.map((node) => node.id),
        type,
      );
  const node = defaultCoreNode(type, id, options.name);
  const block = serializeNodeBlock(node, 4);
  return { yaml: insertNodeBlock(yaml, block), node };
}

export function updateYamlNode(
  yaml: string,
  next: { id: string; type: string; name: string; with: Record<string, unknown> },
): string | null {
  const existing = listYamlNodes(yaml).find((node) => node.id === next.id);
  if (!existing) {
    return null;
  }
  const block = serializeNodeBlock(
    { id: next.id, type: next.type, name: next.name, with: next.with },
    4,
  );
  const lines = yaml.split("\n");
  const before = lines.slice(0, existing.startLine - 1);
  const after = lines.slice(existing.endLine);
  const blockLines = block.replace(/\n$/, "").split("\n");
  return [...before, ...blockLines, ...after].join("\n");
}

export function applyCoreNodeConfig(
  yaml: string,
  id: string,
  name: string,
  config: CoreNodeWith,
): { yaml: string | null; errors: string[] } {
  const existing = listYamlNodes(yaml).find((node) => node.id === id);
  if (!existing) {
    return { yaml: null, errors: [`Node ${id} was not found in YAML.`] };
  }
  const serialized = serializeCoreWith(config);
  if (serialized.errors.length > 0) {
    return { yaml: null, errors: serialized.errors };
  }
  return {
    yaml: updateYamlNode(yaml, {
      id,
      type: config.type,
      name: name.trim() || defaultNodeName(config.type),
      with: serialized.with,
    }),
    errors: [],
  };
}

export function serializeCoreWith(config: CoreNodeWith): {
  with: Record<string, unknown>;
  errors: string[];
} {
  const errors: string[] = [];
  switch (config.type) {
    case "flow.condition": {
      if (!isConditionOp(config.op)) {
        errors.push("op must be a declarative comparison operator.");
      }
      if (config.path && looksLikeExpression(config.path)) {
        errors.push("path must be a field path, not an expression.");
      }
      if (config.compare && looksLikeExpression(config.compare)) {
        errors.push("compare must be a literal, not an expression.");
      }
      if (looksLikeSecretValue(config.compare) || looksLikeSecretValue(config.path)) {
        errors.push("Condition fields must not contain secret material.");
      }
      if (config.op !== "exists" && !config.compare.trim()) {
        errors.push("Condition needs compare unless op is exists.");
      }
      if (config.op === "exists" && config.compare.trim()) {
        errors.push("exists must not include compare.");
      }
      const withValue: Record<string, unknown> = { op: config.op };
      if (config.path.trim()) {
        withValue.path = config.path.trim();
      }
      if (config.compare.trim() && config.op !== "exists") {
        withValue.compare = config.compare.trim();
      }
      return { with: withValue, errors };
    }
    case "flow.delay": {
      const duration = config.duration.trim();
      const seconds = isoDurationSeconds(duration);
      if (seconds == null) {
        errors.push(
          "duration must be ISO-8601 using weeks, days, or time units (for example PT5M or P7D). Years and months are not allowed.",
        );
      } else if (seconds <= 0) {
        errors.push("duration must be greater than zero.");
      } else if (seconds > MAX_DELAY_SECONDS) {
        errors.push("duration must be at most P7D.");
      }
      return { with: { duration }, errors };
    }
    case "data.set": {
      const value: Record<string, YamlScalar> = {};
      for (const field of config.fields) {
        const key = field.key.trim();
        if (!key) {
          continue;
        }
        if (isForbiddenYamlKey(key)) {
          errors.push(`Field ${key} is not allowed in YAML (secrets stay out of the graph).`);
          continue;
        }
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          errors.push(`Field ${key} must be a simple identifier.`);
          continue;
        }
        const parsed = parseSetFieldValue(field);
        if (parsed.error) {
          errors.push(parsed.error);
          continue;
        }
        if (typeof parsed.value === "string" && looksLikeSecretValue(parsed.value)) {
          errors.push(`Field ${key} looks like secret material.`);
          continue;
        }
        value[key] = parsed.value;
      }
      if (Object.keys(value).length === 0) {
        errors.push("data.set requires at least one non-secret field.");
      }
      const withValue: Record<string, unknown> = { value };
      if (config.classification === "public" || config.classification === "internal") {
        withValue.classification = config.classification;
      }
      return { with: withValue, errors };
    }
    case "data.map": {
      const mapping: Record<string, unknown> = {};
      for (const pair of config.mapping) {
        const dest = pair.dest.trim();
        const from = pair.from.trim();
        const convert = pair.convert?.trim() ?? "";
        if (!dest && !from) {
          continue;
        }
        if (!dest || !from) {
          errors.push("Each mapping needs dest and from paths.");
          continue;
        }
        if (looksLikeExpression(dest) || looksLikeExpression(from)) {
          errors.push("Mapping paths must be field paths, not expressions.");
          continue;
        }
        if (convert && !(MAP_CONVERT_KINDS as readonly string[]).includes(convert)) {
          errors.push("convert must be string, integer, boolean, or object.");
          continue;
        }
        mapping[dest] = convert ? { from, convert } : from;
      }
      if (Object.keys(mapping).length === 0) {
        errors.push("data.map requires at least one dest → from mapping.");
      }
      return { with: { mapping }, errors };
    }
    case "data.validate": {
      const schemaType = config.schemaType.trim() || "object";
      if (looksLikeSecretValue(schemaType) || isForbiddenYamlKey(schemaType)) {
        errors.push("schema type must be a non-secret JSON-schema type.");
      }
      return {
        with: {
          schema: {
            type: schemaType,
            additionalProperties: config.additionalProperties !== false,
          },
        },
        errors,
      };
    }
    case "flow.stop": {
      if (!isStopStatus(config.status)) {
        errors.push("status must be success, failure, or canceled.");
      }
      if (looksLikeSecretValue(config.message)) {
        errors.push("Stop message must not contain secret material.");
      }
      const withValue: Record<string, unknown> = { status: config.status };
      if (config.message.trim()) {
        withValue.message = config.message.trim();
      }
      return { with: withValue, errors };
    }
    case "flow.fail": {
      const code = config.code.trim();
      if (!code) {
        errors.push("Fail requires with.code.");
      } else if (!validFailCode(code)) {
        errors.push("Fail code must be a DNS label or 2–4 dotted labels (for example tenant.denied).");
      }
      if (looksLikeSecretValue(code) || looksLikeSecretValue(config.message)) {
        errors.push("Failure code/message must not contain secret material.");
      }
      const withValue: Record<string, unknown> = { code };
      if (config.message.trim()) {
        withValue.message = config.message.trim();
      }
      return { with: withValue, errors };
    }
  }
}

export function configFromNode(node: YamlWorkflowNode): CoreNodeWith | null {
  if (!isCoreNeutralNodeType(node.type)) {
    return null;
  }
  const withValue = node.with;
  switch (node.type) {
    case "flow.condition": {
      const opRaw = typeof withValue.op === "string" ? withValue.op : "eq";
      return {
        type: "flow.condition",
        op: isConditionOp(opRaw) ? opRaw : "eq",
        path: stringField(withValue.path),
        compare: stringField(withValue.compare),
      };
    }
    case "flow.delay":
      return {
        type: "flow.delay",
        duration: stringField(withValue.duration) || "PT5M",
      };
    case "data.set": {
      const classification = stringField(withValue.classification);
      return {
        type: "data.set",
        fields: objectToSetFields(withValue.value),
        classification: classification === "public" || classification === "internal" ? classification : "",
      };
    }
    case "data.map":
      return {
        type: "data.map",
        mapping: toMapPaths(withValue.mapping),
      };
    case "data.validate": {
      const schema =
        withValue.schema && typeof withValue.schema === "object" && !Array.isArray(withValue.schema)
          ? (withValue.schema as Record<string, unknown>)
          : {};
      return {
        type: "data.validate",
        schemaType: stringField(schema.type) || "object",
        additionalProperties: schema.additionalProperties !== false,
      };
    }
    case "flow.stop": {
      const statusRaw = stringField(withValue.status) || "success";
      return {
        type: "flow.stop",
        status: isStopStatus(statusRaw) ? statusRaw : "success",
        message: stringField(withValue.message),
      };
    }
    case "flow.fail":
      return {
        type: "flow.fail",
        code: stringField(withValue.code),
        message: stringField(withValue.message),
      };
  }
}

export function serializeNodeBlock(
  node: { id: string; type: string; name: string; with: Record<string, unknown> },
  indent = 4,
): string {
  const pad = " ".repeat(indent);
  const field = " ".repeat(indent + 2);
  const lines = [
    `${pad}- id: ${formatScalar(node.id)}`,
    `${field}type: ${formatScalar(node.type)}`,
    `${field}name: ${formatScalar(node.name)}`,
  ];
  if (Object.keys(node.with).length > 0) {
    lines.push(`${field}with:`);
    lines.push(formatYamlValue(node.with, indent + 4));
  }
  return `${lines.join("\n")}\n`;
}

function uniqueId(preferred: string, existing: string[]): string {
  if (!existing.includes(preferred)) {
    return preferred;
  }
  return allocateNodeId(existing, "flow.stop");
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function objectToSetFields(value: unknown): SetField[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [{ key: "status", kind: "string", value: "ready" }];
  }
  const fields = Object.entries(value as Record<string, unknown>).map(([key, raw]) => {
    if (raw === null) {
      return { key, kind: "null" as const, value: "" };
    }
    if (typeof raw === "boolean") {
      return { key, kind: "boolean" as const, value: raw ? "true" : "false" };
    }
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return { key, kind: "number" as const, value: String(raw) };
    }
    return { key, kind: "string" as const, value: raw == null ? "" : String(raw) };
  });
  return fields.length > 0 ? fields : [{ key: "status", kind: "string", value: "ready" }];
}

function toMapPaths(value: unknown): MapPath[] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const mapping = Object.entries(value as Record<string, unknown>).map(([dest, spec]) => {
      if (typeof spec === "string") {
        return { dest, from: spec };
      }
      if (spec && typeof spec === "object" && !Array.isArray(spec)) {
        const row = spec as Record<string, unknown>;
        const convert = stringField(row.convert);
        return convert ? { dest, from: stringField(row.from), convert } : { dest, from: stringField(row.from) };
      }
      return { dest, from: "" };
    });
    return mapping.length > 0 ? mapping : [{ dest: "result.state", from: "input.status" }];
  }
  if (Array.isArray(value)) {
    const mapping = value
      .map((item) => {
        if (!item || typeof item !== "object") {
          return null;
        }
        const row = item as Record<string, unknown>;
        const dest = stringField(row.to) || stringField(row.dest);
        const from = stringField(row.from);
        const convert = stringField(row.convert);
        return convert ? { dest, from, convert } : { dest, from };
      })
      .filter((item): item is MapPath => Boolean(item));
    return mapping.length > 0 ? mapping : [{ dest: "result.state", from: "input.status" }];
  }
  return [{ dest: "result.state", from: "input.status" }];
}

function parseSetFieldValue(field: SetField): { value: YamlScalar; error?: string } {
  if (field.kind === "null") {
    return { value: null };
  }
  if (field.kind === "boolean") {
    if (field.value === "true" || field.value === "false") {
      return { value: field.value === "true" };
    }
    return { value: false, error: `${field.key} boolean must be true or false.` };
  }
  if (field.kind === "number") {
    const parsed = Number(field.value);
    if (!Number.isFinite(parsed) || field.value.trim() === "") {
      return { value: 0, error: `${field.key} must be a finite number.` };
    }
    return { value: parsed };
  }
  return { value: field.value };
}

function looksLikeExpression(value: string): boolean {
  return /[{}$]|{{|}}|\?\s|:|\|\||&&/.test(value);
}

function validDNSLabel(value: string): boolean {
  return /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

function validFailCode(value: string): boolean {
  if (validDNSLabel(value)) {
    return true;
  }
  const parts = value.split(".");
  if (parts.length < 2 || parts.length > 4) {
    return false;
  }
  return parts.every(validDNSLabel);
}

/** Jonny's E3.3 delay parser: weeks/days/time only, no years/months. */
function isoDurationSeconds(value: string): number | null {
  if (!value || value[0] !== "P") {
    return null;
  }
  const rest = value.slice(1);
  const tIndex = rest.indexOf("T");
  const date = tIndex >= 0 ? rest.slice(0, tIndex) : rest;
  const timePart = tIndex >= 0 ? rest.slice(tIndex + 1) : "";
  if (/Y/.test(rest) || /M/.test(date)) {
    return null;
  }
  if (!date && !timePart) {
    return null;
  }
  const dateMatch = /^(?:(\d+)W)?(?:(\d+)D)?$/.exec(date);
  if (!dateMatch) {
    return null;
  }
  if (tIndex >= 0) {
    const timeMatch = /^(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(timePart);
    if (!timeMatch || timePart === "") {
      return null;
    }
    const hours = Number(timeMatch[1] ?? 0);
    const minutes = Number(timeMatch[2] ?? 0);
    const seconds = Number(timeMatch[3] ?? 0);
    const weeks = Number(dateMatch[1] ?? 0);
    const days = Number(dateMatch[2] ?? 0);
    return weeks * 7 * 24 * 3600 + days * 24 * 3600 + hours * 3600 + minutes * 60 + seconds;
  }
  const weeks = Number(dateMatch[1] ?? 0);
  const days = Number(dateMatch[2] ?? 0);
  return weeks * 7 * 24 * 3600 + days * 24 * 3600;
}

type ListItemRange = {
  startLine: number;
  endLine: number;
  indent: number;
};

type ListSection = {
  keyLine: number;
  items: ListItemRange[];
  emptyInline: boolean;
  insertLine: number;
  indent: number;
};

function findListSection(yaml: string, key: string): ListSection | null {
  const lines = yaml.split("\n");
  let specIndent: number | null = null;
  let inSpec = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const indent = leadingSpaces(line);
    const trimmed = line.trim();
    if (!inSpec) {
      if (trimmed === "spec:" || trimmed.startsWith("spec:")) {
        inSpec = true;
        specIndent = indent;
      }
      continue;
    }
    if (trimmed && specIndent !== null && indent <= specIndent && !trimmed.startsWith("#")) {
      break;
    }
    if (trimmed === `${key}:` || trimmed.startsWith(`${key}:`)) {
      return collectListItems(lines, index, indent, key);
    }
  }
  return null;
}

function collectListItems(
  lines: string[],
  keyLine: number,
  keyIndent: number,
  key: string,
): ListSection {
  const keyText = (lines[keyLine] ?? "").trim();
  const inline = keyText.slice(`${key}:`.length).trim();
  const items: ListItemRange[] = [];
  let cursor = keyLine + 1;
  if (inline === "[]" || inline === "") {
    while (cursor < lines.length) {
      const line = lines[cursor] ?? "";
      const indent = leadingSpaces(line);
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        cursor += 1;
        continue;
      }
      if (indent <= keyIndent) {
        break;
      }
      if (trimmed.startsWith("- ")) {
        const start = cursor;
        cursor += 1;
        while (cursor < lines.length) {
          const next = lines[cursor] ?? "";
          const nextIndent = leadingSpaces(next);
          const nextTrim = next.trim();
          if (!nextTrim) {
            cursor += 1;
            continue;
          }
          if (nextTrim.startsWith("- ") && nextIndent === indent) {
            break;
          }
          if (nextIndent <= keyIndent) {
            break;
          }
          cursor += 1;
        }
        items.push({ startLine: start + 1, endLine: cursor, indent });
        continue;
      }
      break;
    }
    return {
      keyLine: keyLine + 1,
      items,
      emptyInline: inline === "[]" && items.length === 0,
      insertLine: items.length > 0 ? items[items.length - 1]!.endLine : keyLine + 1,
      indent: keyIndent + 2,
    };
  }
  return {
    keyLine: keyLine + 1,
    items,
    emptyInline: false,
    insertLine: keyLine + 1,
    indent: keyIndent + 2,
  };
}

function parseNodeItem(yaml: string, item: ListItemRange): YamlWorkflowNode {
  const raw = yaml.split("\n").slice(item.startLine - 1, item.endLine);
  const fieldIndent = item.indent + 2;
  const lines = raw.map((line, index) => {
    if (index !== 0) {
      return line;
    }
    return `${" ".repeat(fieldIndent)}${line.trim().replace(/^-\s*/, "")}`;
  });
  const mapping = parseIndentedMap(lines, fieldIndent, 0);
  const withValue =
    mapping.with && typeof mapping.with === "object" && !Array.isArray(mapping.with)
      ? (mapping.with as Record<string, unknown>)
      : {};
  return {
    id: stringField(mapping.id),
    type: stringField(mapping.type),
    name: stringField(mapping.name),
    with: withValue,
    startLine: item.startLine,
    endLine: item.endLine,
  };
}

function parseIndentedMap(
  lines: string[],
  indent: number,
  startIndex: number,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const lineIndent = leadingSpaces(line);
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      index += 1;
      continue;
    }
    if (trimmed.startsWith("- ")) {
      break;
    }
    if (lineIndent < indent) {
      break;
    }
    if (lineIndent > indent) {
      index += 1;
      continue;
    }
    const pair = parseInlinePair(trimmed);
    if (!pair) {
      index += 1;
      continue;
    }
    if (pair.value !== undefined) {
      result[pair.key] = pair.value;
      index += 1;
      continue;
    }
    const next = peekNextContent(lines, index + 1);
    if (next && next.trimmed.startsWith("- ") && next.indent >= indent + 2) {
      const parsed = parseIndentedSeq(lines, indent + 2, index + 1);
      result[pair.key] = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    const parsed = parseIndentedMap(lines, indent + 2, index + 1);
    result[pair.key] = parsed;
    index = skipConsumedMap(lines, indent + 2, index + 1);
  }
  return result;
}

function skipConsumedMap(lines: string[], indent: number, startIndex: number): number {
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const lineIndent = leadingSpaces(line);
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      index += 1;
      continue;
    }
    if (lineIndent < indent && !trimmed.startsWith("- ")) {
      break;
    }
    if (trimmed.startsWith("- ") && lineIndent < indent) {
      break;
    }
    if (lineIndent < indent) {
      break;
    }
    index += 1;
  }
  return index;
}

function parseIndentedSeq(
  lines: string[],
  indent: number,
  startIndex: number,
): { value: unknown[]; nextIndex: number } {
  const items: unknown[] = [];
  let index = startIndex;
  while (index < lines.length) {
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
    if (!trimmed.startsWith("- ") || lineIndent !== indent) {
      break;
    }
    const rest = trimmed.slice(2);
    const pair = parseInlinePair(rest);
    const item: Record<string, unknown> = {};
    if (pair && pair.value !== undefined) {
      item[pair.key] = pair.value;
    } else if (pair) {
      item[pair.key] = null;
    }
    index += 1;
    const nested = parseIndentedMap(lines, indent + 2, index);
    Object.assign(item, nested);
    items.push(item);
    index = skipConsumedMap(lines, indent + 2, index);
  }
  return { value: items, nextIndex: index };
}

function peekNextContent(
  lines: string[],
  startIndex: number,
): { indent: number; trimmed: string } | null {
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    return { indent: leadingSpaces(line), trimmed };
  }
  return null;
}

function parseInlinePair(text: string): { key: string; value?: unknown } | null {
  const match = /^([^:#]+):(.*)$/.exec(text);
  if (!match) {
    return null;
  }
  const key = match[1]?.trim() ?? "";
  const raw = match[2] ?? "";
  if (!key) {
    return null;
  }
  if (raw.trim() === "") {
    return { key };
  }
  return { key, value: parseScalar(raw.trim()) };
}

function parseScalar(raw: string): YamlScalar {
  if (raw === "null" || raw === "~") {
    return null;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    return Number(raw);
  }
  return raw;
}

function formatYamlValue(value: unknown, indent: number): string {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          const entries = Object.entries(item as Record<string, unknown>);
          if (entries.length === 0) {
            return `${pad}- {}`;
          }
          const [firstKey, firstValue] = entries[0]!;
          const head = `${pad}- ${firstKey}: ${inlineOrBlank(firstValue)}`;
          const rest = entries.slice(1).map(([key, nested]) => {
            if (isPlainObject(nested) || Array.isArray(nested)) {
              return `${pad}  ${key}:\n${formatYamlValue(nested, indent + 4)}`;
            }
            return `${pad}  ${key}: ${formatScalar(nested)}`;
          });
          if (isPlainObject(firstValue) || Array.isArray(firstValue)) {
            return [`${pad}- ${firstKey}:`, formatYamlValue(firstValue, indent + 4), ...rest].join(
              "\n",
            );
          }
          return [head, ...rest].join("\n");
        }
        return `${pad}- ${formatScalar(item)}`;
      })
      .join("\n");
  }
  if (isPlainObject(value)) {
    return Object.entries(value)
      .map(([key, nested]) => {
        if (isPlainObject(nested) || Array.isArray(nested)) {
          return `${pad}${key}:\n${formatYamlValue(nested, indent + 2)}`;
        }
        return `${pad}${key}: ${formatScalar(nested)}`;
      })
      .join("\n");
  }
  return `${pad}${formatScalar(value)}`;
}

function inlineOrBlank(value: unknown): string {
  if (isPlainObject(value) || Array.isArray(value)) {
    return "";
  }
  return formatScalar(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function formatScalar(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  const text = String(value);
  if (text === "") {
    return '""';
  }
  if (
    /[:#{}[\],&*?|<>=!%@`'"\\]/.test(text) ||
    /^\s|\s$/.test(text) ||
    /^(true|false|null|yes|no|on|off)$/i.test(text) ||
    (/^-?\d/.test(text) &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text))
  ) {
    return JSON.stringify(text);
  }
  return text;
}

function leadingSpaces(line: string): number {
  const match = /^( *)/.exec(line);
  return match?.[1]?.length ?? 0;
}

function insertNodeBlock(yaml: string, block: string): string {
  const section = findListSection(yaml, "nodes");
  const lines = yaml.split("\n");
  const blockLines = block.replace(/\n$/, "").split("\n");
  if (!section) {
    return appendNodesSection(yaml, blockLines);
  }
  if (section.emptyInline) {
    const keyLine = lines[section.keyLine - 1] ?? "  nodes: []";
    const replaced = keyLine.replace(/:\s*\[\]\s*$/, ":");
    const next = [...lines];
    next[section.keyLine - 1] = replaced;
    next.splice(section.keyLine, 0, ...blockLines);
    return next.join("\n");
  }
  nextInsert(lines, section.insertLine, blockLines);
  return lines.join("\n");
}

function nextInsert(lines: string[], insertLine: number, blockLines: string[]): void {
  const index = Math.min(insertLine, lines.length);
  lines.splice(index, 0, ...blockLines);
}

function appendNodesSection(yaml: string, blockLines: string[]): string {
  const lines = yaml.split("\n");
  const specIndex = lines.findIndex((line) => line.trim() === "spec:" || line.trim().startsWith("spec:"));
  if (specIndex < 0) {
    return `${yaml.replace(/\s*$/, "")}\nspec:\n  nodes:\n${blockLines.join("\n")}\n`;
  }
  lines.splice(specIndex + 1, 0, "  nodes:", ...blockLines);
  return lines.join("\n");
}
