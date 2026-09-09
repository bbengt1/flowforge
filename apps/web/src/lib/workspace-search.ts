/**
 * E6.1 global search. Indexes only safe metadata: workflow names,
 * action types, credential display names/tags, execution IDs, and
 * documentation. Plaintext secrets, redacted payloads, and unexpected
 * secret-bearing keys are stripped and never searchable.
 */

import { isSecretFieldName, stripSecretFields as stripCredentialSecrets } from "./credential.ts";
import { stripSecretFields as stripExecutionSecrets } from "./execution.ts";
import type { CredentialRecord } from "./credential-types.ts";
import type { ExecutionRecord } from "./execution-types.ts";
import type { OperationalAlert } from "./alert-types.ts";
import type { WorkflowCatalog, WorkflowRecord } from "./workflow-types.ts";
import { coreCatalog } from "./workflow.ts";
import {
  CREDENTIAL_VIEW_PERMISSION,
  WORKFLOW_VIEW_PERMISSION,
  canSeeCredentialsNav,
  canSeeWorkflowsNav,
} from "./workspace-nav.ts";
import { canSeeExecutionsNav } from "./execution.ts";
import { canSeeAlertsNav } from "./alert.ts";

export const SEARCH_KINDS = [
  "workflow",
  "action",
  "credential",
  "execution",
  "doc",
  "alert",
] as const;

export type SearchKind = (typeof SEARCH_KINDS)[number];

export type SearchHit = {
  kind: SearchKind;
  id: string;
  title: string;
  subtitle: string;
  href: string;
};

const UNSAFE_INDEX_KEYS = new Set([
  "definitionyaml",
  "definition_yaml",
  "input",
  "output",
  "details",
  "payload",
  "body",
  "raw",
  "yaml",
]);

function foldedKey(key: string): string {
  return key.trim().toLowerCase().replace(/-/g, "_");
}

export function isUnsafeSearchKey(key: string): boolean {
  if (isSecretFieldName(key)) {
    return true;
  }
  return UNSAFE_INDEX_KEYS.has(foldedKey(key));
}

/**
 * Recursively drop secret and payload fields before anything is
 * tokenized. Unexpected secret names are a contract bug: strip.
 */
export function sanitizeSearchSource(
  value: unknown,
  strippedKeys: string[] = [],
  path = "",
): unknown {
  const credentialPass = stripCredentialSecrets(value, path);
  strippedKeys.push(...credentialPass.strippedKeys);
  return stripExecutionSecrets(credentialPass.value, strippedKeys, path);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readSafeString(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed === "[redacted]") {
    return "";
  }
  return trimmed;
}

function pickSafeStrings(
  raw: unknown,
  keys: readonly string[],
  strippedKeys: string[],
): string[] {
  const cleaned = sanitizeSearchSource(raw, strippedKeys);
  const record = asRecord(cleaned);
  if (!record) {
    return [];
  }
  const out: string[] = [];
  for (const key of keys) {
    if (isUnsafeSearchKey(key)) {
      continue;
    }
    const value = record[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        const text = readSafeString(item);
        if (text) {
          out.push(text);
        }
      }
      continue;
    }
    const text = readSafeString(value);
    if (text) {
      out.push(text);
    }
  }
  return out;
}

export type TokenizedHit = SearchHit & { tokens: string[] };

function workflowHits(
  items: readonly WorkflowRecord[],
  permissions: readonly string[] | null | undefined,
): TokenizedHit[] {
  if (!canSeeWorkflowsNav(permissions)) {
    return [];
  }
  return items.map((item) => {
    const strippedKeys: string[] = [];
    const tokens = pickSafeStrings(
      item,
      ["name", "slug", "id", "status"],
      strippedKeys,
    );
    return {
      kind: "workflow" as const,
      id: item.id,
      title: item.name,
      subtitle: [item.slug, item.status].filter(Boolean).join(" · "),
      href: `/workflows/${item.id}`,
      tokens,
    };
  });
}

function actionHits(
  catalog: WorkflowCatalog | null | undefined,
  permissions: readonly string[] | null | undefined,
): TokenizedHit[] {
  if (!canSeeWorkflowsNav(permissions) || !catalog) {
    return [];
  }
  const core = coreCatalog(catalog);
  const hits: TokenizedHit[] = [];
  for (const node of core.nodes) {
    const strippedKeys: string[] = [];
    const tokens = pickSafeStrings(
      node,
      ["type", "title", "description"],
      strippedKeys,
    );
    hits.push({
      kind: "action",
      id: `action:${node.type}`,
      title: node.title || node.type,
      subtitle: node.type,
      href: "/actions",
      tokens,
    });
  }
  for (const trigger of core.triggers) {
    const strippedKeys: string[] = [];
    const tokens = pickSafeStrings(trigger, ["type"], strippedKeys);
    hits.push({
      kind: "action",
      id: `trigger:${trigger.type}`,
      title: trigger.type,
      subtitle: "trigger",
      href: "/actions",
      tokens,
    });
  }
  return hits;
}

function credentialHits(
  items: readonly CredentialRecord[],
  permissions: readonly string[] | null | undefined,
): TokenizedHit[] {
  if (!canSeeCredentialsNav(permissions)) {
    return [];
  }
  return items.map((item) => {
    const strippedKeys: string[] = [];
    const tokens = pickSafeStrings(
      item,
      ["displayName", "tags", "type", "status", "id"],
      strippedKeys,
    );
    return {
      kind: "credential" as const,
      id: item.id,
      title: item.displayName,
      subtitle: [item.type, ...(item.tags ?? [])].filter(Boolean).join(" · "),
      href: `/credentials/${item.id}`,
      tokens,
    };
  });
}

function executionHits(
  items: readonly ExecutionRecord[],
  permissions: readonly string[] | null | undefined,
): TokenizedHit[] {
  if (!canSeeExecutionsNav(permissions ?? [])) {
    return [];
  }
  return items.map((item) => {
    const strippedKeys: string[] = [];
    const tokens = pickSafeStrings(
      item,
      ["id", "workflowName", "workflowSlug", "status", "correlationId"],
      strippedKeys,
    );
    return {
      kind: "execution" as const,
      id: item.id,
      title: item.id,
      subtitle: [item.workflowName, item.status].filter(Boolean).join(" · "),
      href: `/executions/${item.id}`,
      tokens,
    };
  });
}

function alertHits(
  items: readonly OperationalAlert[],
  permissions: readonly string[] | null | undefined,
): TokenizedHit[] {
  if (!canSeeAlertsNav(permissions ?? [])) {
    return [];
  }
  return items.map((item) => {
    const strippedKeys: string[] = [];
    const tokens = pickSafeStrings(
      item,
      ["id", "kind", "code", "correlationId", "resourceId"],
      strippedKeys,
    );
    return {
      kind: "alert" as const,
      id: item.id,
      title: `${item.kind} · ${item.code || item.id}`,
      subtitle: item.correlationId,
      href: `/alerts/${item.id}`,
      tokens,
    };
  });
}

function docHits(swaggerUrl: string): TokenizedHit[] {
  return [
    {
      kind: "doc",
      id: "doc-openapi",
      title: "OpenAPI / Swagger",
      subtitle: "Control-plane API reference",
      href: swaggerUrl,
      tokens: ["openapi", "swagger", "docs", "api"],
    },
    {
      kind: "doc",
      id: "doc-yaml",
      title: "Workflow YAML",
      subtitle: "Canonical flowforge/v1 definition",
      href: "/workflows",
      tokens: ["yaml", "schema", "workflow", "docs", "definition"],
    },
    {
      kind: "doc",
      id: "doc-security",
      title: "Credentials and secrets",
      subtitle: "Vault metadata only — never plaintext",
      href: "/credentials",
      tokens: ["docs", "security", "vault", "credentials"],
    },
  ];
}

export type SearchSources = {
  workflows?: readonly WorkflowRecord[];
  catalog?: WorkflowCatalog | null;
  credentials?: readonly CredentialRecord[];
  executions?: readonly ExecutionRecord[];
  alerts?: readonly OperationalAlert[];
  swaggerUrl?: string;
};

export function buildSearchIndex(
  sources: SearchSources,
  permissions: readonly string[] | null | undefined,
): TokenizedHit[] {
  return [
    ...workflowHits(sources.workflows ?? [], permissions),
    ...actionHits(sources.catalog, permissions),
    ...credentialHits(sources.credentials ?? [], permissions),
    ...executionHits(sources.executions ?? [], permissions),
    ...alertHits(sources.alerts ?? [], permissions),
    ...docHits(sources.swaggerUrl ?? "/"),
  ];
}

export function querySearchIndex(
  index: readonly TokenizedHit[],
  query: string,
): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [];
  }
  return index
    .filter((hit) => {
      const haystack = [hit.title, hit.subtitle, ...hit.tokens]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    })
    .map((hit) => ({
      kind: hit.kind,
      id: hit.id,
      title: hit.title,
      subtitle: hit.subtitle,
      href: hit.href,
    }))
    .slice(0, 20);
}

/** True when a serialized index still contains a secret-bearing leaf. */
export function searchIndexContainsSecret(
  index: readonly TokenizedHit[],
  secret: string,
): boolean {
  if (!secret) {
    return false;
  }
  return JSON.stringify(index).includes(secret);
}

export { WORKFLOW_VIEW_PERMISSION, CREDENTIAL_VIEW_PERMISSION };
