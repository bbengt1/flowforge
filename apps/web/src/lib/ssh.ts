/**
 * E8.1 SSH target + command-profile helpers.
 * Authorized selectors fail closed on 403. Unexpected secret fields
 * are stripped and never shown. Templates reject shell interpolation.
 */

import type { CredentialType } from "./credential-types.ts";
import type { ProblemDetails } from "./problem.ts";
import {
  authorizedSelectorOptions,
  failClosedReason,
  isSecretKey,
  pinFromSummary,
  sanitizeSpec,
  stripSecrets,
} from "./ops-config.ts";
import type {
  OpsConfigCatalog,
  OpsConfigKind,
  OpsConfigPin,
  OpsConfigSpec,
  OpsConfigSummary,
} from "./ops-config-types.ts";
import {
  SSH_CONTRACT_FALLBACK_CATALOG,
  SSH_FAIL_CLOSED_HELP,
  SSH_HOST_SUPPLIED_IDENTITY_DETAIL,
  SSH_PROBLEM_CODES,
  SSH_SAFETY_NOTES,
} from "./ssh-contract.ts";
import {
  SSH_ACTION_TYPES,
  SSH_CREDENTIAL_TYPE,
  SSH_CREDENTIAL_TYPE_ALIAS,
  SSH_DEFAULT_PORT,
  SSH_DENIED_FEATURES,
  SSH_MAX_PARAMETERS,
  SSH_PARAMETER_TYPES,
  SSH_PARAM_NAME_RE,
  SSH_TEMPLATE_FORBIDDEN_TOKENS,
  type SshEngineCatalog,
  type SshParameterConstraint,
  type SshParameterType,
} from "./ssh-types.ts";

export type AuthorizedSshResult<T> = {
  options: T[];
  closed: boolean;
  reason: string | null;
  strippedKeys: string[];
};

export function isSshActionType(type: string): boolean {
  return (SSH_ACTION_TYPES as readonly string[]).includes(type);
}

export function sshOpsKind(
  kind: OpsConfigKind | string | undefined,
): kind is "ssh_target" | "command_profile" {
  return kind === "ssh_target" || kind === "command_profile";
}

export function sshSafetyNotes(): readonly string[] {
  return SSH_SAFETY_NOTES;
}

export function sanitizeSshSpec(raw: unknown): OpsConfigSpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const cleaned = stripSecrets(raw as Record<string, unknown>);
  return sanitizeSpec(cleaned);
}

export function sshSecretKeysIn(value: unknown, path = ""): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const found: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      found.push(...sshSecretKeysIn(item, `${path}[${index}]`));
    });
    return found;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const next = path ? `${path}.${key}` : key;
    if (isSecretKey(key)) {
      found.push(next);
      continue;
    }
    found.push(...sshSecretKeysIn(item, next));
  }
  return found;
}

export function hostSuppliedSshIdentityKeys(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const rec = value as Record<string, unknown>;
  const hits: string[] = [];
  if (rec.id !== undefined) {
    hits.push("id");
  }
  if (rec.workspaceId !== undefined) {
    hits.push("workspaceId");
  }
  return hits;
}

export function hostSuppliedSshIdentityProblem(
  keys: string[],
  instance = "",
  requestId = "client",
): ProblemDetails {
  return {
    type: "urn:flowforge:problem:invalid-request",
    title: "Host-supplied identity is not allowed",
    status: 400,
    detail: `${SSH_HOST_SUPPLIED_IDENTITY_DETAIL} Found: ${keys.join(", ")}.`,
    instance,
    code: SSH_PROBLEM_CODES.invalidRequest,
    request_id: requestId,
  };
}

export function templateForbiddenHits(template: string): string[] {
  const hits: string[] = [];
  for (const token of SSH_TEMPLATE_FORBIDDEN_TOKENS) {
    if (template.includes(token)) {
      hits.push(token === "$(" ? "$()" : token);
    }
  }
  return hits;
}

export function templatePlaceholders(template: string): string[] {
  const names: string[] = [];
  const re = /\{([A-Za-z][A-Za-z0-9_]{0,31})\}/g;
  let match = re.exec(template);
  while (match) {
    const name = match[1];
    if (name && !names.includes(name)) {
      names.push(name);
    }
    match = re.exec(template);
  }
  return names;
}

export function fingerprintPublishGap(fingerprint: string): string | null {
  const trimmed = fingerprint.trim();
  if (!trimmed) {
    return "Publish requires a known-host fingerprint.";
  }
  if (!/^sha256:/i.test(trimmed)) {
    return "hostKeyFingerprint must be sha256:<64 hex> or SHA256:<base64>.";
  }
  const rest = trimmed.slice(trimmed.indexOf(":") + 1).replaceAll(":", "");
  if (/^[0-9a-fA-F]{64}$/.test(rest)) {
    return null;
  }
  const b64 = trimmed.slice(trimmed.indexOf(":") + 1);
  if (/^[A-Za-z0-9+/]{43}$/.test(b64)) {
    return null;
  }
  return "hostKeyFingerprint must be sha256:<64 hex> or SHA256:<base64>.";
}

export function addressPublishGap(
  addresses: string[] | undefined,
): string | null {
  if (addresses === undefined) {
    return null;
  }
  if (addresses.length === 0) {
    return "allowedAddresses must not be empty when present (fail closed).";
  }
  for (const item of addresses) {
    if (item === "0.0.0.0/0" || item === "::/0") {
      return "allowedAddresses cannot include a default-route CIDR.";
    }
  }
  return null;
}

export function sshTargetPublishGap(spec: OpsConfigSpec): string | null {
  const cred = String(spec.credentialId ?? "").trim();
  if (!cred) {
    return "Publish requires spec.credentialId (workspace ssh_private_key vault).";
  }
  if (!String(spec.hostname ?? "").trim()) {
    return "Publish requires hostname.";
  }
  const fingerprintGap = fingerprintPublishGap(
    String(spec.hostKeyFingerprint ?? ""),
  );
  if (fingerprintGap) {
    return fingerprintGap;
  }
  const port = spec.port ?? SSH_DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return "Publish requires a port between 1 and 65535.";
  }
  return addressPublishGap(spec.allowedAddresses);
}

export function commandProfilePublishGap(spec: OpsConfigSpec): string | null {
  const template = String(spec.template ?? "");
  if (!template.trim()) {
    return "Publish requires a reviewed command template.";
  }
  const hits = templateForbiddenHits(template);
  if (hits.length > 0) {
    return `Template must not use raw shell interpolation (${hits.join(", ")}).`;
  }
  if (spec.parameterSchema === undefined || spec.parameterSchema === null) {
    return "Publish requires a typed parameterSchema.";
  }
  const rows = parseParameterSchema(spec.parameterSchema);
  const schemaGaps = parameterSchemaGaps(rows);
  if (schemaGaps.length > 0) {
    return schemaGaps[0] ?? "Parameter schema is invalid.";
  }
  const names = new Set(rows.map((row) => row.name.trim()).filter(Boolean));
  for (const placeholder of templatePlaceholders(template)) {
    if (!names.has(placeholder)) {
      return `Template placeholder {${placeholder}} is not in parameterSchema.`;
    }
  }
  return null;
}

export function sshCredentialTypes(
  catalog: SshEngineCatalog = SSH_CONTRACT_FALLBACK_CATALOG,
): CredentialType[] {
  const allowed = catalog.allowedCredentialTypes.length
    ? catalog.allowedCredentialTypes
    : [catalog.credentialType];
  const types = new Set<CredentialType>();
  for (const item of allowed) {
    if (item === SSH_CREDENTIAL_TYPE || item === SSH_CREDENTIAL_TYPE_ALIAS) {
      types.add(SSH_CREDENTIAL_TYPE);
      continue;
    }
    if (item === "kubernetes" || item === "token" || item === "webhook_secret" || item === "provider") {
      types.add(item);
    }
  }
  return types.size > 0 ? [...types] : [SSH_CREDENTIAL_TYPE];
}

export function parseParameterSchema(
  raw: unknown,
): SshParameterConstraint[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return [];
  }
  const rec = raw as Record<string, unknown>;
  const properties =
    rec.properties && typeof rec.properties === "object" && !Array.isArray(rec.properties)
      ? (rec.properties as Record<string, unknown>)
      : rec.type === "object"
        ? {}
        : rec;
  const required = new Set(stringList(rec.required));
  const rows: SshParameterConstraint[] = [];
  for (const [name, item] of Object.entries(properties)) {
    if (name === "type" || name === "required" || name === "properties") {
      continue;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const field = item as Record<string, unknown>;
    const type = asParameterType(field.type);
    if (!type) {
      continue;
    }
    const row: SshParameterConstraint = {
      name,
      type,
      required: required.has(name) || field.required === true,
    };
    if (typeof field.description === "string" && field.description.trim()) {
      row.description = field.description.trim();
    }
    if (typeof field.pattern === "string" && field.pattern.trim()) {
      row.pattern = field.pattern.trim();
    }
    const minLength = asFiniteNumber(field.minLength);
    if (minLength !== undefined) {
      row.minLength = minLength;
    }
    const maxLength = asFiniteNumber(field.maxLength);
    if (maxLength !== undefined) {
      row.maxLength = maxLength;
    }
    const minimum = asFiniteNumber(field.minimum);
    if (minimum !== undefined) {
      row.minimum = minimum;
    }
    const maximum = asFiniteNumber(field.maximum);
    if (maximum !== undefined) {
      row.maximum = maximum;
    }
    const enums = stringList(field.enum);
    if (enums.length > 0) {
      row.enum = enums;
    }
    if (field.sensitive === true) {
      row.sensitive = true;
    }
    rows.push(row);
  }
  return rows;
}

export function writeParameterSchema(
  rows: SshParameterConstraint[],
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) {
      continue;
    }
    const field: Record<string, unknown> = { type: row.type };
    if (row.description?.trim()) {
      field.description = row.description.trim();
    }
    if (row.pattern?.trim()) {
      field.pattern = row.pattern.trim();
    }
    if (typeof row.minLength === "number") {
      field.minLength = row.minLength;
    }
    if (typeof row.maxLength === "number") {
      field.maxLength = row.maxLength;
    }
    if (typeof row.minimum === "number") {
      field.minimum = row.minimum;
    }
    if (typeof row.maximum === "number") {
      field.maximum = row.maximum;
    }
    if (row.enum && row.enum.length > 0) {
      field.enum = [...row.enum];
    }
    if (row.sensitive === true && row.type === "string") {
      field.sensitive = true;
    }
    properties[name] = field;
    if (row.required) {
      required.push(name);
    }
  }
  const schema: Record<string, unknown> = {
    type: "object",
    additionalProperties: false,
    properties,
  };
  if (required.length > 0) {
    schema.required = required;
  }
  return schema;
}

export function applyParameterSchemaToSpec(
  spec: OpsConfigSpec,
  rows: SshParameterConstraint[],
): OpsConfigSpec {
  return sanitizeSshSpec({
    ...spec,
    parameterSchema: writeParameterSchema(rows),
  });
}

export function parameterSchemaGaps(rows: SshParameterConstraint[]): string[] {
  const gaps: string[] = [];
  const seen = new Set<string>();
  if (rows.length > SSH_MAX_PARAMETERS) {
    gaps.push(`parameterSchema.properties exceeds ${SSH_MAX_PARAMETERS} items.`);
  }
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) {
      gaps.push("Every parameter needs a name.");
      continue;
    }
    if (!SSH_PARAM_NAME_RE.test(name)) {
      gaps.push(`${name} must match [A-Za-z][A-Za-z0-9_]{0,31}.`);
    }
    if (seen.has(name)) {
      gaps.push(`Duplicate parameter name: ${name}.`);
    }
    seen.add(name);
    if (
      row.type === "string" &&
      typeof row.minLength === "number" &&
      typeof row.maxLength === "number" &&
      row.minLength > row.maxLength
    ) {
      gaps.push(`${name} minLength cannot exceed maxLength.`);
    }
    if (
      row.type === "integer" &&
      typeof row.minimum === "number" &&
      typeof row.maximum === "number" &&
      row.minimum > row.maximum
    ) {
      gaps.push(`${name} minimum cannot exceed maximum.`);
    }
  }
  return gaps;
}

export function parseSshEngineCatalog(catalog: unknown): SshEngineCatalog {
  if (!catalog || typeof catalog !== "object") {
    return { ...SSH_CONTRACT_FALLBACK_CATALOG };
  }
  const rec = catalog as Record<string, unknown>;
  const nested =
    rec.sshEngine && typeof rec.sshEngine === "object" && !Array.isArray(rec.sshEngine)
      ? (rec.sshEngine as Record<string, unknown>)
      : null;
  const engine = nested ?? rec;
  const kinds = Array.isArray((catalog as OpsConfigCatalog).kinds)
    ? (catalog as OpsConfigCatalog).kinds
    : [];
  const sshKind = kinds.find(
    (item) => item.kind === "ssh_target" || item.kind === "command_profile",
  );
  const looksLikeEngine =
    typeof engine.credentialType === "string" ||
    Array.isArray(engine.parameterTypes) ||
    (engine.render && typeof engine.render === "object") ||
    (engine.retry && typeof engine.retry === "object");
  if (!looksLikeEngine && !sshKind) {
    return { ...SSH_CONTRACT_FALLBACK_CATALOG };
  }
  const render =
    engine.render && typeof engine.render === "object" && !Array.isArray(engine.render)
      ? (engine.render as Record<string, unknown>)
      : {};
  const retry =
    engine.retry && typeof engine.retry === "object" && !Array.isArray(engine.retry)
      ? (engine.retry as Record<string, unknown>)
      : {};
  const forbidden = stringList(render.forbiddenTokens);
  const paramTypes = parameterTypeNames(engine.parameterTypes);
  const secrets = stringList(engine.credentialSecretFields);
  const source = nested
    ? "ops-config-catalog"
    : looksLikeEngine
      ? "ssh-catalog"
      : "ops-config-catalog";
  return {
    source,
    credentialType: String(engine.credentialType ?? SSH_CREDENTIAL_TYPE),
    allowedCredentialTypes: sshKind?.allowedCredentialTypes?.length
      ? sshKind.allowedCredentialTypes
      : [String(engine.credentialType ?? SSH_CREDENTIAL_TYPE)],
    credentialSecretFields: secrets.length
      ? secrets
      : [...SSH_CONTRACT_FALLBACK_CATALOG.credentialSecretFields],
    defaultPort: SSH_DEFAULT_PORT,
    authMethods: SSH_CONTRACT_FALLBACK_CATALOG.authMethods,
    denied: SSH_DENIED_FEATURES,
    templateForbidden: forbidden.length ? forbidden : SSH_TEMPLATE_FORBIDDEN_TOKENS,
    parameterTypes: paramTypes.length ? paramTypes : SSH_PARAMETER_TYPES,
    retrySafeExposed: true,
    retryNote: String(retry.note ?? "").trim() || undefined,
    renderOwner: String(render.owner ?? "").trim() || undefined,
    quoting: String(render.quoting ?? "").trim() || undefined,
    placeholderSyntax: String(render.placeholderSyntax ?? "").trim() || undefined,
    notes: String(engine.notes ?? "").trim() || undefined,
  };
}

function parameterTypeNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) {
      names.push(item.trim());
      continue;
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const type = String((item as { type?: unknown }).type ?? "").trim();
      if (type) {
        names.push(type);
      }
    }
  }
  return names;
}

/**
 * Published SSH targets only. 403 / empty fail closed.
 * When the API reports credentialId, require a workspace vault bind.
 * Specs are secret-stripped — keys never reach the selector.
 */
export function authorizedSshTargets(input: {
  items?: OpsConfigSummary[] | null;
  problem?: ProblemDetails | null;
  statusCode?: number;
}): AuthorizedSshResult<OpsConfigPin> {
  if (input.problem || (input.statusCode && input.statusCode >= 400)) {
    return {
      options: [],
      closed: true,
      reason: failClosedReason(input.problem, input.statusCode),
      strippedKeys: [],
    };
  }
  const reportsCredential = (input.items ?? []).some(
    (item) => item.credentialId !== undefined,
  );
  const strippedKeys: string[] = [];
  const pins: OpsConfigPin[] = [];
  for (const item of input.items ?? []) {
    if (item.kind && item.kind !== "ssh_target") {
      continue;
    }
    if (item.status === "disabled") {
      continue;
    }
    if (reportsCredential && !item.credentialId) {
      continue;
    }
    const pin = pinFromSummary(item);
    if (!pin) {
      continue;
    }
    if (pin.spec) {
      strippedKeys.push(...sshSecretKeysIn(pin.spec));
      pin.spec = sanitizeSshSpec(pin.spec);
    }
    pins.push(pin);
  }
  const selected = authorizedSelectorOptions({
    items: pins,
    statusCode: 200,
  });
  if (selected.closed) {
    return {
      options: [],
      closed: true,
      reason: selected.reason ?? SSH_FAIL_CLOSED_HELP,
      strippedKeys,
    };
  }
  return {
    options: selected.options,
    closed: false,
    reason: null,
    strippedKeys,
  };
}

export function authorizedCommandProfiles(input: {
  items?: OpsConfigSummary[] | null;
  pins?: OpsConfigPin[] | null;
  problem?: ProblemDetails | null;
  statusCode?: number;
}): AuthorizedSshResult<OpsConfigPin> {
  if (input.problem || (input.statusCode && input.statusCode >= 400)) {
    return {
      options: [],
      closed: true,
      reason: failClosedReason(input.problem, input.statusCode),
      strippedKeys: [],
    };
  }
  const strippedKeys: string[] = [];
  const fromPins = (input.pins ?? []).filter((pin) => {
    if (pin.kind !== "command_profile") {
      return false;
    }
    if (pin.spec) {
      strippedKeys.push(...sshSecretKeysIn(pin.spec));
    }
    return true;
  });
  const fromList = (input.items ?? [])
    .filter((item) => item.kind === "command_profile" && item.status !== "disabled")
    .map(pinFromSummary)
    .filter((pin): pin is OpsConfigPin => pin !== null);
  const merged = fromPins.length > 0 ? fromPins : fromList;
  const selected = authorizedSelectorOptions({
    items: merged.map((pin) =>
      pin.spec ? { ...pin, spec: sanitizeSshSpec(pin.spec) } : pin,
    ),
    statusCode: 200,
  });
  if (selected.closed) {
    return {
      options: [],
      closed: true,
      reason: selected.reason ?? SSH_FAIL_CLOSED_HELP,
      strippedKeys,
    };
  }
  return {
    options: selected.options,
    closed: false,
    reason: null,
    strippedKeys,
  };
}

export function sshTargetSelectorLabel(pin: OpsConfigPin): string {
  const name = (pin.name ?? "SSH target").trim() || "SSH target";
  const version =
    typeof pin.versionNumber === "number" ? `v${pin.versionNumber}` : "unpinned";
  return `${name} @ ${version}`;
}

export function commandProfileSelectorLabel(pin: OpsConfigPin): string {
  const name = (pin.name ?? "command profile").trim() || "command profile";
  const version =
    typeof pin.versionNumber === "number" ? `v${pin.versionNumber}` : "unpinned";
  return `${name} @ ${version}`;
}

function asParameterType(value: unknown): SshParameterType | null {
  const type = String(value ?? "").trim();
  if ((SSH_PARAMETER_TYPES as readonly string[]).includes(type)) {
    return type as SshParameterType;
  }
  if (type === "number") {
    return "integer";
  }
  return null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}
