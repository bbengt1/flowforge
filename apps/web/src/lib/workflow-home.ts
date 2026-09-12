/**
 * E6.1 workflow home: client-side list/filter on safe metadata.
 * GET /workflows has no search query params. Trigger, last run,
 * validation, approvals, and R6.2 activation (D2 compose of trigger
 * status + version pin) are joined from existing list/draft
 * /execution/approval/trigger/version responses when those
 * capabilities are present. GET /workflows has no computed
 * activation field — that is not a real list-projection gap.
 */

import type { ApprovalRequest } from "./approval-types.ts";
import type { ExecutionRecord } from "./execution-types.ts";
import {
  homeActivationFromListHint,
  matchesHomeActivationFilter,
  type HomeActivationColumn,
  type HomeActivationFilter,
} from "./home-activation.ts";
import type { WorkflowDraft, WorkflowRecord } from "./workflow-types.ts";

export type WorkflowHomeView = "list" | "card";

export type LastRunFilter =
  | ""
  | "any"
  | "running"
  | "succeeded"
  | "failed"
  | "never"
  | "24h";

export type LastModifiedFilter = "" | "any" | "24h" | "7d" | "30d";

export type WorkflowHomeFilters = {
  query: string;
  folder: string;
  tag: string;
  owner: string;
  trigger: string;
  environment: string;
  status: string;
  lastRun: LastRunFilter;
  lastModified: LastModifiedFilter;
  activation: HomeActivationFilter;
};

export const EMPTY_WORKFLOW_HOME_FILTERS: WorkflowHomeFilters = {
  query: "",
  folder: "",
  tag: "",
  owner: "",
  trigger: "",
  environment: "",
  status: "",
  lastRun: "",
  lastModified: "",
  activation: "",
};

export type WorkflowHomeItem = {
  id: string;
  slug: string;
  name: string;
  status: string;
  draftRevision: number;
  latestVersionNumber: number;
  latestVersionId?: string;
  latestVersionDigest?: string;
  owner: string;
  updatedAt: string;
  createdAt: string;
  folder: string;
  tags: string[];
  triggers: string[];
  environment: string;
  validationHealth: "valid" | "invalid" | "unknown";
  pendingApprovals: number;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunId: string | null;
  lastRunKnown: boolean;
  activation: HomeActivationColumn;
};

function readOwner(record: WorkflowRecord): string {
  return (record.updatedBy || record.createdBy || "").trim();
}

export function folderFromSlug(slug: string): string {
  return folderBeforeSeparator(slug, "/");
}

/**
 * Folders are not an API field. Slugs are `[a-z0-9-]+`, so `/` never
 * survives create. Use a name prefix (`ops/…` or `ops: …`) or encode
 * the folder in the slug as `ops--name`.
 */
export function workflowFolder(slug: string, name = ""): string {
  const fromName =
    folderBeforeSeparator(name, "/") || folderBeforeSeparator(name, ":");
  if (fromName) {
    return fromName;
  }
  const dashed = slug.trim().toLowerCase().split("--");
  if (dashed.length >= 2 && dashed[0]) {
    return dashed[0];
  }
  return folderFromSlug(slug);
}

function folderBeforeSeparator(value: string, separator: string): string {
  const trimmed = value.trim();
  const index = trimmed.indexOf(separator);
  if (index <= 0) {
    return "";
  }
  return trimmed.slice(0, index).trim();
}

export function deriveWorkflowTags(record: WorkflowRecord): string[] {
  const tags = new Set<string>();
  if (record.status) {
    tags.add(record.status);
  }
  if (record.latestVersionNumber > 0) {
    tags.add("published");
  } else {
    tags.add("draft");
  }
  return [...tags];
}

function latestExecution(
  workflowId: string,
  executions: readonly ExecutionRecord[],
): ExecutionRecord | null {
  const matches = executions.filter((item) => item.workflowId === workflowId);
  if (matches.length === 0) {
    return null;
  }
  return matches.reduce((best, item) => {
    const bestAt = best.startedAt || best.createdAt || "";
    const nextAt = item.startedAt || item.createdAt || "";
    return nextAt > bestAt ? item : best;
  });
}

export function toWorkflowHomeItem(
  record: WorkflowRecord,
  extras: {
    environment?: string;
    draft?: WorkflowDraft | null;
    executions?: readonly ExecutionRecord[];
    approvals?: readonly ApprovalRequest[];
    lastRunKnown?: boolean;
    activation?: HomeActivationColumn;
  } = {},
): WorkflowHomeItem {
  const draft = extras.draft ?? null;
  const triggers = (draft?.summary?.triggers ?? []).map((item) => item.type);
  const last = latestExecution(record.id, extras.executions ?? []);
  const lastRunKnown = extras.lastRunKnown === true;
  const pendingApprovals = (extras.approvals ?? []).filter(
    (item) => item.workflowId === record.id && item.status === "pending",
  ).length;
  let validationHealth: WorkflowHomeItem["validationHealth"] = "unknown";
  if (draft?.validationState === "valid") {
    validationHealth = "valid";
  } else if (draft?.validationState === "invalid") {
    validationHealth = "invalid";
  }
  return {
    id: record.id,
    slug: record.slug,
    name: record.name,
    status: record.status,
    draftRevision: record.draftRevision,
    latestVersionNumber: record.latestVersionNumber,
    latestVersionId: record.latestVersionId,
    latestVersionDigest: record.latestVersionDigest,
    owner: readOwner(record),
    updatedAt: record.updatedAt,
    createdAt: record.createdAt,
    folder: workflowFolder(record.slug, record.name),
    tags: deriveWorkflowTags(record),
    triggers,
    environment: extras.environment?.trim() ?? "",
    validationHealth,
    pendingApprovals,
    lastRunAt: last?.startedAt || last?.createdAt || null,
    lastRunStatus: last?.status ?? null,
    lastRunId: last?.id ?? null,
    lastRunKnown,
    activation:
      extras.activation ??
      homeActivationFromListHint({
        id: record.id,
        latestVersionNumber: record.latestVersionNumber,
        latestVersionId: record.latestVersionId,
      }),
  };
}

export function buildWorkflowHomeItems(
  records: readonly WorkflowRecord[],
  extras: {
    environment?: string;
    drafts?: ReadonlyMap<string, WorkflowDraft>;
    executions?: readonly ExecutionRecord[];
    approvals?: readonly ApprovalRequest[];
    lastRunKnownIds?: ReadonlySet<string>;
    activations?: ReadonlyMap<string, HomeActivationColumn>;
  } = {},
): WorkflowHomeItem[] {
  return records.map((record) =>
    toWorkflowHomeItem(record, {
      environment: extras.environment,
      draft: extras.drafts?.get(record.id) ?? null,
      executions: extras.executions,
      approvals: extras.approvals,
      lastRunKnown: extras.lastRunKnownIds?.has(record.id) ?? false,
      activation: extras.activations?.get(record.id),
    }),
  );
}

function withinWindow(iso: string | null | undefined, ms: number, now: number): boolean {
  if (!iso) {
    return false;
  }
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) {
    return false;
  }
  return now - ts <= ms;
}

export function matchesWorkflowHomeFilters(
  item: WorkflowHomeItem,
  filters: WorkflowHomeFilters,
  now = Date.now(),
): boolean {
  const query = filters.query.trim().toLowerCase();
  if (query) {
    const haystack = [
      item.name,
      item.slug,
      item.owner,
      item.status,
      item.folder,
      item.activation.label,
      ...item.tags,
      ...item.triggers,
    ]
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(query)) {
      return false;
    }
  }
  if (filters.folder && item.folder !== filters.folder) {
    return false;
  }
  if (filters.tag && !item.tags.includes(filters.tag)) {
    return false;
  }
  if (filters.owner && item.owner !== filters.owner) {
    return false;
  }
  if (filters.trigger && !item.triggers.includes(filters.trigger)) {
    return false;
  }
  if (filters.environment && item.environment !== filters.environment) {
    return false;
  }
  if (filters.status && item.status !== filters.status) {
    return false;
  }
  if (!matchesHomeActivationFilter(item.activation, filters.activation)) {
    return false;
  }
  const lastRun = filters.lastRun;
  if (lastRun && lastRun !== "any") {
    if (!item.lastRunKnown) {
      return false;
    }
    if (lastRun === "never" && item.lastRunAt) {
      return false;
    }
    if (lastRun === "running" && item.lastRunStatus !== "running" && item.lastRunStatus !== "queued") {
      return false;
    }
    if (lastRun === "succeeded" && item.lastRunStatus !== "succeeded") {
      return false;
    }
    if (lastRun === "failed" && item.lastRunStatus !== "failed") {
      return false;
    }
    if (lastRun === "24h" && !withinWindow(item.lastRunAt, 24 * 60 * 60 * 1000, now)) {
      return false;
    }
  }
  const modified = filters.lastModified;
  if (modified && modified !== "any") {
    const windowMs =
      modified === "24h"
        ? 24 * 60 * 60 * 1000
        : modified === "7d"
          ? 7 * 24 * 60 * 60 * 1000
          : 30 * 24 * 60 * 60 * 1000;
    if (!withinWindow(item.updatedAt, windowMs, now)) {
      return false;
    }
  }
  return true;
}

export function filterWorkflowHomeItems(
  items: readonly WorkflowHomeItem[],
  filters: WorkflowHomeFilters,
  now = Date.now(),
): WorkflowHomeItem[] {
  return items.filter((item) => matchesWorkflowHomeFilters(item, filters, now));
}

export function sortWorkflowHomeItems(
  items: readonly WorkflowHomeItem[],
): WorkflowHomeItem[] {
  return [...items].sort((left, right) => {
    const leftRun = left.lastRunAt ? 1 : 0;
    const rightRun = right.lastRunAt ? 1 : 0;
    if (leftRun !== rightRun) {
      return rightRun - leftRun;
    }
    return (right.updatedAt || "").localeCompare(left.updatedAt || "");
  });
}

export function uniqueFilterValues(
  items: readonly WorkflowHomeItem[],
): {
  folders: string[];
  tags: string[];
  owners: string[];
  triggers: string[];
  environments: string[];
  statuses: string[];
} {
  const folders = new Set<string>();
  const tags = new Set<string>();
  const owners = new Set<string>();
  const triggers = new Set<string>();
  const environments = new Set<string>();
  const statuses = new Set<string>();
  for (const item of items) {
    if (item.folder) {
      folders.add(item.folder);
    }
    for (const tag of item.tags) {
      tags.add(tag);
    }
    if (item.owner) {
      owners.add(item.owner);
    }
    for (const trigger of item.triggers) {
      triggers.add(trigger);
    }
    if (item.environment) {
      environments.add(item.environment);
    }
    if (item.status) {
      statuses.add(item.status);
    }
  }
  const sort = (values: Set<string>) => [...values].sort((a, b) => a.localeCompare(b));
  return {
    folders: sort(folders),
    tags: sort(tags),
    owners: sort(owners),
    triggers: sort(triggers),
    environments: sort(environments),
    statuses: sort(statuses),
  };
}

export function validationHealthLabel(
  health: WorkflowHomeItem["validationHealth"],
): string {
  if (health === "valid") {
    return "Valid";
  }
  if (health === "invalid") {
    return "Invalid";
  }
  return "Not validated";
}
