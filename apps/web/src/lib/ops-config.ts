/**
 * E4.2 publish/pin and authorized-selector helpers (Chloe UI, #36).
 *
 * Drafts are editable. Publish creates an immutable revision.
 * Workflow/execution pins are display name + version id/number/digest.
 * Selectors fail closed on 403 or empty foreign results.
 */

import type { ProblemDetails } from "./problem.ts";
import { OPS_CONFIG_KIND_CATALOG } from "./ops-config-contract.ts";
import type {
  AuthorizedPinList,
  CompareConfigResult,
  KindDescriptor,
  OpsConfigDraft,
  OpsConfigGroup,
  OpsConfigKind,
  OpsConfigPin,
  OpsConfigRecord,
  OpsConfigSpec,
  OpsConfigStatus,
  OpsConfigSummary,
  OpsConfigVersion,
} from "./ops-config-types.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SECRET_SPEC_KEYS = new Set([
  "secret",
  "kubeconfig",
  "privatekey",
  "private_key",
  "passphrase",
  "token",
  "password",
  "ciphertext",
  "dekenvelope",
  "dek_envelope",
  "authorization",
  "apikey",
  "api_key",
]);

export function isUuid(value: string | undefined): boolean {
  return Boolean(value && UUID.test(value));
}

export function isDraftEditable(status: OpsConfigStatus | undefined): boolean {
  return status !== "disabled";
}

export function isPublishedVersionReadOnly(
  version: Pick<OpsConfigVersion, "id" | "versionNumber"> | null,
): boolean {
  return Boolean(version && version.id && version.versionNumber >= 1);
}

export function canPublishDraft(
  draft: Pick<OpsConfigDraft, "revision" | "name"> | null,
  dirty: boolean,
): boolean {
  if (!draft || dirty) {
    return false;
  }
  return draft.revision >= 1 && draft.name.trim().length > 0;
}

export function versionPinLabel(pin: {
  displayName?: string;
  name?: string;
  versionNumber?: number;
  digest?: string;
}): string {
  const name = (pin.displayName ?? pin.name ?? "untitled").trim() || "untitled";
  const version =
    typeof pin.versionNumber === "number" && pin.versionNumber >= 1
      ? `v${pin.versionNumber}`
      : "unpinned";
  const digest = shortDigest(pin.digest);
  return digest ? `${name} @ ${version} (${digest})` : `${name} @ ${version}`;
}

export function selectorOptionLabel(pin: OpsConfigPin): string {
  return versionPinLabel({
    displayName: pin.displayName,
    versionNumber: pin.versionNumber,
    digest: pin.digest,
  });
}

export function shortDigest(digest: string | undefined): string {
  if (!digest) {
    return "";
  }
  const hex = digest.replace(/^sha256:/i, "");
  return hex.length > 12 ? `${hex.slice(0, 12)}…` : hex;
}

export function pinFromVersion(version: OpsConfigVersion): OpsConfigPin {
  return {
    id: version.resourceId,
    kind: version.kind,
    displayName: version.name,
    versionId: version.id,
    versionNumber: version.versionNumber,
    digest: version.digest,
  };
}

export function pinFromSummary(item: OpsConfigSummary): OpsConfigPin | null {
  if (!item.latestVersionId || !item.latestVersionNumber) {
    return null;
  }
  return {
    id: item.id,
    kind: item.kind,
    displayName: item.name,
    versionId: item.latestVersionId,
    versionNumber: item.latestVersionNumber,
    digest: item.latestDigest ?? "",
  };
}

/**
 * Server-authorized selector. 403 / unauthorized empty lists fail closed
 * (no invented foreign options). 200 with items is the only success path.
 */
export function authorizedSelectorOptions(input: {
  items?: OpsConfigPin[] | null;
  problem?: ProblemDetails | null;
  statusCode?: number;
}): { options: OpsConfigPin[]; closed: boolean; reason: string | null } {
  if (input.problem || (input.statusCode && input.statusCode >= 400)) {
    return {
      options: [],
      closed: true,
      reason: failClosedReason(input.problem, input.statusCode),
    };
  }
  const items = Array.isArray(input.items) ? input.items.filter(isSafePin) : [];
  if (items.length === 0) {
    return {
      options: [],
      closed: true,
      reason: "No server-authorized resources for this workspace.",
    };
  }
  return { options: items, closed: false, reason: null };
}

export function failClosedReason(
  problem: ProblemDetails | null | undefined,
  statusCode?: number,
): string {
  if (problem?.status === 403 || statusCode === 403) {
    return "Forbidden. Cross-workspace or unauthorized resources are not listed.";
  }
  if (problem?.status === 401 || statusCode === 401) {
    return "Unauthenticated. Establish a workspace session before selecting config.";
  }
  if (problem) {
    return problem.title;
  }
  return "Selector failed closed.";
}

export function isSafePin(value: unknown): value is OpsConfigPin {
  if (!value || typeof value !== "object") {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    isUuid(readString(row.id)) &&
    isUuid(readString(row.versionId, row.version_id)) &&
    typeof (row.displayName ?? row.display_name ?? row.name) === "string" &&
    typeof (row.versionNumber ?? row.version_number) === "number"
  );
}

export function kindsForGroup(group: OpsConfigGroup): KindDescriptor[] {
  return OPS_CONFIG_KIND_CATALOG.filter((item) => item.group === group);
}

export function canSeeOpsConfigNav(
  permissions: readonly string[] | null | undefined,
): boolean {
  if (permissions == null) {
    return true;
  }
  return permissions.some((key) =>
    ["credential.view", "workflow.edit", "workspace.administer"].includes(key),
  );
}

export function canEditOpsConfig(
  permissions: readonly string[] | null | undefined,
): boolean {
  if (!permissions) {
    return false;
  }
  return permissions.some((key) =>
    ["credential.manage", "workflow.edit", "workspace.administer"].includes(key),
  );
}

export function canPublishOpsConfig(
  permissions: readonly string[] | null | undefined,
): boolean {
  if (!permissions) {
    return false;
  }
  return permissions.some((key) =>
    ["workflow.publish", "workspace.administer"].includes(key),
  );
}

export function sanitizeSpec(raw: unknown): OpsConfigSpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  return stripSecrets(raw as Record<string, unknown>) as OpsConfigSpec;
}

export function stripSecrets(
  value: Record<string, unknown>,
  stripped: string[] = [],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSecretKey(key)) {
      stripped.push(key);
      continue;
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      out[key] = stripSecrets(item as Record<string, unknown>, stripped);
      continue;
    }
    out[key] = item;
  }
  return out;
}

export function isSecretKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (
    normalized === "credentialid" ||
    normalized === "credentialdisplayname"
  ) {
    return false;
  }
  return SECRET_SPEC_KEYS.has(key.toLowerCase()) || SECRET_SPEC_KEYS.has(normalized);
}

export function readString(
  ...values: unknown[]
): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function parseOpsConfigSummary(raw: unknown): OpsConfigSummary | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const row = raw as Record<string, unknown>;
  const id = readString(row.id);
  const kind = readString(row.kind) as OpsConfigKind | undefined;
  const name = readString(row.name, row.displayName, row.display_name);
  const status = readString(row.status) as OpsConfigStatus | undefined;
  if (!id || !kind || !name || !status) {
    return null;
  }
  return {
    id,
    kind,
    name,
    status,
    draftRevision: asNumber(row.draftRevision, row.draft_revision),
    latestVersionId: readString(row.latestVersionId, row.latest_version_id),
    latestVersionNumber: asNumber(
      row.latestVersionNumber,
      row.latest_version_number,
    ),
    latestDigest: readString(row.latestDigest, row.latest_digest),
    updatedAt: readString(row.updatedAt, row.updated_at),
  };
}

export function parseOpsConfigRecord(raw: unknown): OpsConfigRecord | null {
  const summary = parseOpsConfigSummary(raw);
  if (!summary) {
    return null;
  }
  const row = raw as Record<string, unknown>;
  return {
    ...summary,
    spec: sanitizeSpec(row.spec ?? row.document ?? {}),
    draftRevision: summary.draftRevision ?? 1,
  };
}

export function parseOpsConfigDraft(raw: unknown): OpsConfigDraft | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const row = raw as Record<string, unknown>;
  const resourceId = readString(row.resourceId, row.resource_id, row.id);
  const kind = readString(row.kind) as OpsConfigKind | undefined;
  const name = readString(row.name, row.displayName, row.display_name);
  const revision = asNumber(row.revision);
  if (!resourceId || !kind || !name || revision == null) {
    return null;
  }
  return {
    resourceId,
    kind,
    name,
    revision,
    spec: sanitizeSpec(row.spec ?? row.document ?? {}),
    digest: readString(row.digest),
  };
}

export function parseOpsConfigVersion(raw: unknown): OpsConfigVersion | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const row = raw as Record<string, unknown>;
  const id = readString(row.id);
  const resourceId = readString(row.resourceId, row.resource_id);
  const kind = readString(row.kind) as OpsConfigKind | undefined;
  const name = readString(row.name, row.displayName, row.display_name);
  const versionNumber = asNumber(row.versionNumber, row.version_number);
  const digest = readString(row.digest);
  if (!id || !resourceId || !kind || !name || versionNumber == null || !digest) {
    return null;
  }
  return {
    id,
    resourceId,
    kind,
    name,
    versionNumber,
    digest,
    spec: sanitizeSpec(row.spec ?? row.document ?? {}),
    publishNote: readString(row.publishNote, row.publish_note, row.note),
    publishedAt: readString(row.publishedAt, row.published_at),
    publishedBy: readString(row.publishedBy, row.published_by),
  };
}

export function parseOpsConfigList(raw: unknown): OpsConfigSummary[] {
  const items = itemsOf(raw);
  return items
    .map(parseOpsConfigSummary)
    .filter((item): item is OpsConfigSummary => item !== null);
}

export function parseAuthorizedPins(
  raw: unknown,
  kind: OpsConfigKind,
): OpsConfigPin[] {
  const items = itemsOf(raw);
  const out: OpsConfigPin[] = [];
  for (const item of items) {
    if (isSafePin(item)) {
      const row = item as unknown as Record<string, unknown>;
      out.push({
        id: readString(row.id) ?? "",
        kind,
        displayName:
          readString(row.displayName, row.display_name, row.name) ?? "",
        versionId: readString(row.versionId, row.version_id) ?? "",
        versionNumber: asNumber(row.versionNumber, row.version_number) ?? 0,
        digest: readString(row.digest) ?? "",
      });
      continue;
    }
    const summary = parseOpsConfigSummary(item);
    const pin = summary ? pinFromSummary(summary) : null;
    if (pin && pin.kind === kind) {
      out.push(pin);
    }
  }
  return out.filter(isSafePin);
}

export function parseCompareResult(raw: unknown): CompareConfigResult | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const row = raw as Record<string, unknown>;
  if (typeof row.equal !== "boolean" || typeof row.digestMatch !== "boolean") {
    return null;
  }
  const changes = Array.isArray(row.changes)
    ? row.changes
        .filter((item) => item && typeof item === "object")
        .map((item) => {
          const change = item as Record<string, unknown>;
          return {
            path: typeof change.path === "string" ? change.path : "",
            code: typeof change.code === "string" ? change.code : undefined,
            message:
              typeof change.message === "string" ? change.message : undefined,
          };
        })
    : [];
  return {
    equal: row.equal,
    digestMatch: row.digestMatch,
    leftDigest: readString(row.leftDigest, row.left_digest),
    rightDigest: readString(row.rightDigest, row.right_digest),
    changes,
  };
}

export function parseAuthorizedPinList(
  raw: unknown,
  kind: OpsConfigKind,
): AuthorizedPinList {
  return { items: parseAuthorizedPins(raw, kind) };
}

export function specJson(spec: OpsConfigSpec): string {
  return JSON.stringify(spec, null, 2);
}

export function parseSpecJson(text: string): OpsConfigSpec | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return sanitizeSpec(parsed);
  } catch {
    return null;
  }
}

function itemsOf(raw: unknown): unknown[] {
  if (Array.isArray(raw)) {
    return raw;
  }
  if (raw && typeof raw === "object" && Array.isArray((raw as { items?: unknown }).items)) {
    return (raw as { items: unknown[] }).items;
  }
  return [];
}

function asNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return undefined;
}
