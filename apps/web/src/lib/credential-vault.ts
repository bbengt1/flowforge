/**
 * R5.1: Vault find by display name.
 *
 * Relates to #264 / Part of #231. Keep #264 open.
 *
 * Chloe UI only. Densify the existing `/credentials` list in place
 * (D6). Reuse E4.1 list/detail clients — `GET /credentials` (no query
 * params). Filter display name / tags / type / status in the browser.
 * Do not invent list query params, new credential types, KEK in the
 * browser, or `/config` merge. Isolation hook
 * `POST /workspace/credentials/{id}/use` is not the product vault.
 *
 * Metadata only. Unexpected plaintext is a contract bug (strip +
 * stop). Display-name + UUID after submit. No secret material in
 * chrome. CSRF on mutations stays with existing vault clients.
 * ADV/RBAC/embed stay.
 */

import { maybeEmbedDeepLink } from "./embed-tenancy-contract.ts";
import { EMBED_ROUTES } from "./embed-contract.ts";
import { historyKeyAction } from "./execution-replay.ts";
import {
  CREDENTIAL_PROBLEM_CODES,
  credentialListPath,
  credentialPath,
} from "./credential-contract.ts";
import {
  credentialStatusLabel,
  credentialTypeLabel,
  filterCredentialList,
  isSecretFieldName,
  stripSecretFields,
} from "./credential.ts";
import {
  CREDENTIAL_MVP_TYPES,
  CREDENTIAL_STATUSES,
  type CredentialCatalog,
  type CredentialListQuery,
  type CredentialRecord,
  type CredentialStatus,
  type CredentialType,
} from "./credential-types.ts";
import type { ProblemDetails } from "./problem.ts";
import { WORKSPACE_NAV_ITEMS } from "./workspace-nav.ts";

export const R51_STORY = 264;
export const R51_EPIC = 231;
export const R51_KEEP_STORY_OPEN = true;

export const CREDENTIAL_VAULT_HREF = "/credentials";
export const CREDENTIAL_VAULT_DETAIL_PATH = "/credentials/{id}";
export const CREDENTIAL_VAULT_OPEN_LABEL = "Open";
export const CREDENTIAL_KEK_ENV = "CREDENTIAL_KEK";
export const ISOLATION_CREDENTIAL_USE_PATH = "/workspace/credentials/{id}/use";
export const INVENTED_CONFIG_MERGE = "/config";

export const CREDENTIAL_VAULT_QUERY_KEYS = [
  "q",
  "type",
  "tag",
  "status",
] as const;

/** UI-only workbench keys — never send these on GET /credentials. */
export const CREDENTIAL_VAULT_LIST_MUST_OMIT_KEYS = [
  "q",
  "type",
  "tag",
  "status",
  "cursor",
  "limit",
  "secret",
  "kubeconfig",
  "privateKey",
  "token",
  "password",
  "plaintext",
] as const;

export const CREDENTIAL_VAULT_KEYBOARD_HELP =
  "Arrow keys move the vault. Enter or Space opens the focused credential on existing /credentials/{id} detail. Display-name search stays on this page.";

export const CREDENTIAL_VAULT_HELP =
  "Find credentials by display name. Filter type, tag, or status in the browser. GET /credentials returns metadata only — no list query params. Open a row into existing /credentials/{id} detail. Unexpected plaintext is a contract bug. The UI never reads CREDENTIAL_KEK.";

export const CREDENTIAL_VAULT_SOURCES: readonly string[] = [
  "src/lib/credential-vault.ts",
  "src/lib/credential-client.ts",
  "src/lib/credential-contract.ts",
  "src/lib/credential.ts",
  "src/components/credentials/CredentialVault.tsx",
  "src/components/credentials/CredentialVaultListbox.tsx",
  "src/app/credentials/page.tsx",
];

/** Gracie / charter R5 guardrails — inherited by R5.2–R5.3. */
export const R5_GUARDRAILS = {
  metadataOnly: true,
  displayNamePlusUuidOnly: true,
  neverShowSecretMaterial: true,
  unexpectedPlaintextIsContractBug: true,
  stripAndStop: true,
  noKekInBrowser: true,
  noConfigMerge: true,
  isolationUseIsNotProductVault: true,
  csrfOnMutations: true,
  noNewApiRoutes: true,
  noNewCredentialTypes: true,
  reuseExistingListClients: true,
  migrateInPlace: true,
  rbacFailClosed: true,
  embedUnchanged: true,
} as const;

export const R5_LATER_STORY_NOTES = {
  r52: "R5.2 / #265: densify test/rotate/usage/deletion-impact on existing vault detail routes. Do not invent types or KEK-in-browser.",
  r53: "R5.3 / #266: NDV add via masked wizard without leaving the graph (return-to-editor). Isolation POST /workspace/credentials/{id}/use is not the product vault.",
} as const;

export const CREDENTIAL_VAULT = {
  findByDisplayName: true,
  operateDensity: true,
  searchAndFilter: true,
  usefulColumns: true,
  openToDetailWithoutHunting: true,
  metadataOnly: true,
  neverShowSecretMaterial: true,
  noKekInBrowser: true,
  noConfigMerge: true,
  noNewApiRoutes: true,
  noNewCredentialTypes: true,
  noInventedListQueryParams: true,
  clientSideDisplayNameFilter: true,
  isolationUseIsNotProductVault: true,
  csrfOnMutations: true,
  rbacFailClosed: true,
  embedUnchanged: true,
  migrateInPlace: true,
} as const;

export const CREDENTIAL_VAULT_COLUMNS = [
  { id: "name", label: "Display name" },
  { id: "type", label: "Type" },
  { id: "status", label: "Status" },
  { id: "tags", label: "Tags" },
  { id: "lastTest", label: "Last test" },
  { id: "rotated", label: "Rotated" },
  { id: "open", label: "Open" },
] as const;

export type CredentialVaultColumnId =
  (typeof CREDENTIAL_VAULT_COLUMNS)[number]["id"];

export type CredentialVaultRow = {
  id: string;
  displayName: string;
  type: CredentialType;
  typeLabel: string;
  status: CredentialStatus;
  statusLabel: string;
  tags: readonly string[];
  tagsLabel: string;
  lastTestLabel: string;
  rotatedLabel: string;
  href: string;
  openLabel: typeof CREDENTIAL_VAULT_OPEN_LABEL;
};

type VaultSearchInput =
  | string
  | URLSearchParams
  | Readonly<Record<string, string | string[] | undefined | null>>;

function readSearchValue(
  raw: string | string[] | undefined | null,
): string {
  if (Array.isArray(raw)) {
    return raw[0]?.trim() ?? "";
  }
  return typeof raw === "string" ? raw.trim() : "";
}

export function credentialVaultSearchParams(
  search: VaultSearchInput,
): URLSearchParams {
  if (typeof search === "string") {
    return new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  }
  if (search instanceof URLSearchParams) {
    return search;
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    const trimmed = readSearchValue(value);
    if (trimmed) {
      params.set(key, trimmed);
    }
  }
  return params;
}

export function parseCredentialVaultQuery(
  search: VaultSearchInput = "",
): CredentialListQuery {
  const params = credentialVaultSearchParams(search);
  const q = params.get("q")?.trim() ?? "";
  const typeRaw = params.get("type")?.trim() ?? "";
  const type = CREDENTIAL_MVP_TYPES.includes(typeRaw as CredentialType)
    ? (typeRaw as CredentialType)
    : "";
  const tag = params.get("tag")?.trim() ?? "";
  const statusRaw = params.get("status")?.trim() ?? "";
  const status = CREDENTIAL_STATUSES.includes(statusRaw as CredentialStatus)
    ? (statusRaw as CredentialStatus)
    : "";
  return { q, type, tag, status };
}

export function serializeCredentialVaultQuery(
  query: CredentialListQuery,
): URLSearchParams {
  const params = new URLSearchParams();
  const q = query.q?.trim();
  const type = query.type?.trim();
  const tag = query.tag?.trim();
  const status = query.status?.trim();
  if (q) {
    params.set("q", q);
  }
  if (type && CREDENTIAL_MVP_TYPES.includes(type as CredentialType)) {
    params.set("type", type);
  }
  if (tag) {
    params.set("tag", tag);
  }
  if (status && CREDENTIAL_STATUSES.includes(status as CredentialStatus)) {
    params.set("status", status);
  }
  return params;
}

export function credentialVaultHref(
  query: CredentialListQuery = {},
  embed = false,
): string {
  const qs = serializeCredentialVaultQuery(query).toString();
  const href = qs ? `${CREDENTIAL_VAULT_HREF}?${qs}` : CREDENTIAL_VAULT_HREF;
  return maybeEmbedDeepLink(href, embed);
}

export function credentialVaultListPath(
  query: CredentialListQuery = {},
): string {
  void query;
  return credentialListPath();
}

export function credentialVaultOpenHref(
  credentialId: string,
  embed = false,
): string {
  return maybeEmbedDeepLink(credentialPath(credentialId), embed);
}

export function credentialVaultHasActiveFilters(
  query: CredentialListQuery,
): boolean {
  return Boolean(
    query.q?.trim() ||
      query.type?.trim() ||
      query.tag?.trim() ||
      query.status?.trim(),
  );
}

export function credentialVaultTimeLabel(iso: string | undefined): string {
  if (!iso || iso === "—") {
    return "—";
  }
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) {
    return iso;
  }
  return iso.replace("T", " ").replace(/\.\d+Z$/, "Z");
}

export function credentialVaultLastTestLabel(
  record: CredentialRecord,
): string {
  const status = record.lastTestStatus || "untested";
  const when = credentialVaultTimeLabel(record.lastTestedAt);
  return when === "—" ? status : `${status} · ${when}`;
}

/**
 * Rank display-name hits ahead of tag-only hits so find-by-name
 * surfaces the named credential without hunting.
 */
export function credentialVaultDisplayNameRank(
  record: CredentialRecord,
  q: string,
): number {
  const needle = q.trim().toLowerCase();
  if (!needle) {
    return 0;
  }
  const name = record.displayName.trim().toLowerCase();
  if (name === needle) {
    return 0;
  }
  if (name.startsWith(needle)) {
    return 1;
  }
  if (name.includes(needle)) {
    return 2;
  }
  return 3;
}

export function credentialVaultDisplay(
  items: readonly CredentialRecord[],
  query: CredentialListQuery = {},
  catalog?: CredentialCatalog,
  embed = false,
): CredentialVaultRow[] {
  const filtered = filterCredentialList([...items], query);
  const ranked = [...filtered].sort((left, right) => {
    const rankDelta =
      credentialVaultDisplayNameRank(left, query.q ?? "") -
      credentialVaultDisplayNameRank(right, query.q ?? "");
    if (rankDelta !== 0) {
      return rankDelta;
    }
    return left.displayName.localeCompare(right.displayName);
  });
  return ranked.map((record) => ({
    id: record.id,
    displayName: record.displayName,
    type: record.type,
    typeLabel: credentialTypeLabel(record.type, catalog),
    status: record.status,
    statusLabel: credentialStatusLabel(record.status),
    tags: record.tags,
    tagsLabel: record.tags.length ? record.tags.join(", ") : "—",
    lastTestLabel: credentialVaultLastTestLabel(record),
    rotatedLabel: credentialVaultTimeLabel(record.rotatedAt),
    href: credentialVaultOpenHref(record.id, embed),
    openLabel: CREDENTIAL_VAULT_OPEN_LABEL,
  }));
}

export function credentialVaultColumnText(row: CredentialVaultRow): string {
  return [
    row.displayName,
    row.id,
    row.typeLabel,
    row.statusLabel,
    row.tagsLabel,
    row.lastTestLabel,
    row.rotatedLabel,
    row.openLabel,
    row.href,
  ].join(" ");
}

export function credentialVaultColumnIds(): readonly CredentialVaultColumnId[] {
  return CREDENTIAL_VAULT_COLUMNS.map((column) => column.id);
}

export function credentialVaultKeyAction(
  key: string,
  index: number,
  length: number,
): ReturnType<typeof historyKeyAction> {
  return historyKeyAction(key, index, length);
}

export function credentialVaultUsesExistingListParams(
  query: CredentialListQuery = {},
): boolean {
  const path = credentialVaultListPath(query);
  return path === credentialListPath() && !path.includes("?");
}

export function credentialVaultQueryNeverSentToList(
  search: VaultSearchInput,
): boolean {
  const query = parseCredentialVaultQuery(search);
  const path = credentialVaultListPath(query);
  const href = credentialVaultHref(query);
  return (
    credentialVaultUsesExistingListParams(query) &&
    CREDENTIAL_VAULT_LIST_MUST_OMIT_KEYS.every(
      (key) => !path.includes(`${key}=`) && !path.includes(`?${key}`),
    ) &&
    href.startsWith(CREDENTIAL_VAULT_HREF)
  );
}

const FORBIDDEN_VAULT_CHROME = [
  "-----begin",
  "credential_kek",
  "dek_envelope",
  "ciphertext",
  "kind: config",
];

export function credentialVaultChromeOmitsSecretKeys(
  text: string,
): boolean {
  const compact = text.toLowerCase();
  return !FORBIDDEN_VAULT_CHROME.some((needle) => compact.includes(needle));
}

export function credentialVaultPreservesMetadataOnly(
  items: readonly CredentialRecord[],
  query: CredentialListQuery = {},
): boolean {
  const rows = credentialVaultDisplay(items, query);
  const text = rows.map(credentialVaultColumnText).join("\n");
  const leaked = stripSecretFields(
    rows.map((row) => ({
      displayName: row.displayName,
      type: row.type,
      status: row.status,
      tags: row.tags,
      lastTest: row.lastTestLabel,
      rotated: row.rotatedLabel,
      href: row.href,
    })),
  ).strippedKeys;
  return (
    CREDENTIAL_VAULT.metadataOnly &&
    CREDENTIAL_VAULT.neverShowSecretMaterial &&
    leaked.length === 0 &&
    credentialVaultChromeOmitsSecretKeys(text) &&
    !text.includes(CREDENTIAL_KEK_ENV) &&
    rows.every(
      (row) =>
        Boolean(row.displayName) &&
        Boolean(row.id) &&
        !isSecretFieldName(row.displayName) &&
        row.href.startsWith("/credentials/"),
    )
  );
}

export function isCredentialForbidden(
  problem: ProblemDetails | null | undefined,
): boolean {
  return (
    problem?.status === 403 ||
    problem?.code === CREDENTIAL_PROBLEM_CODES.forbidden
  );
}

export function credentialVaultDoesNotReadKek(): boolean {
  const chromeIds = CREDENTIAL_VAULT_COLUMNS.map((column) => column.id);
  return (
    R5_GUARDRAILS.noKekInBrowser &&
    CREDENTIAL_VAULT.noKekInBrowser &&
    CREDENTIAL_KEK_ENV === "CREDENTIAL_KEK" &&
    !chromeIds.includes("keyReference" as CredentialVaultColumnId) &&
    !chromeIds.includes("kek" as CredentialVaultColumnId) &&
    /never reads CREDENTIAL_KEK/.test(CREDENTIAL_VAULT_HELP) &&
    !/process\.env/.test(CREDENTIAL_VAULT_HELP)
  );
}

export function credentialVaultIsolationUseIsNotProduct(): boolean {
  const open = credentialVaultOpenHref("11111111-1111-4111-8111-111111111111");
  return (
    R5_GUARDRAILS.isolationUseIsNotProductVault &&
    CREDENTIAL_VAULT.isolationUseIsNotProductVault &&
    ISOLATION_CREDENTIAL_USE_PATH === "/workspace/credentials/{id}/use" &&
    !open.includes("/workspace/credentials/") &&
    credentialVaultListPath() === "/credentials" &&
    CREDENTIAL_VAULT_DETAIL_PATH === "/credentials/{id}"
  );
}

export function credentialVaultDoesNotMergeConfig(): boolean {
  return (
    R5_GUARDRAILS.noConfigMerge &&
    CREDENTIAL_VAULT.noConfigMerge &&
    !credentialVaultHref().startsWith(INVENTED_CONFIG_MERGE) &&
    !CREDENTIAL_VAULT_SOURCES.some((source) => source.includes("/config/"))
  );
}

export function credentialVaultTypesUnchanged(): boolean {
  return (
    R5_GUARDRAILS.noNewCredentialTypes &&
    CREDENTIAL_VAULT.noNewCredentialTypes &&
    CREDENTIAL_MVP_TYPES.length === 5
  );
}

export function credentialVaultEmbedUnchanged(): boolean {
  const item = WORKSPACE_NAV_ITEMS.find((entry) => entry.id === "credentials");
  const list = EMBED_ROUTES.filter((route) => route.id === "credentials");
  const detail = EMBED_ROUTES.filter((route) => route.id === "credential");
  const create = EMBED_ROUTES.filter((route) => route.id === "credentialNew");
  return (
    CREDENTIAL_VAULT.embedUnchanged &&
    item?.href === CREDENTIAL_VAULT_HREF &&
    list.length === 1 &&
    list[0]?.standalone === "/credentials" &&
    list[0]?.embed === "/embed/v1/credentials" &&
    detail.length === 1 &&
    detail[0]?.standalone === "/credentials/{id}" &&
    detail[0]?.embed === "/embed/v1/credentials/{id}" &&
    create.length === 1 &&
    create[0]?.standalone === "/credentials/new" &&
    create[0]?.embed === "/embed/v1/credentials/new"
  );
}
