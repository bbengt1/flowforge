/**
 * F.2 home folder rail + select (Chloe UI).
 *
 * Relates to #309 / Part of #307. Keep #309 open.
 *
 * Read + select only. Tree comes from GET /workflow-folders.
 * The list uses GET /workflows?folderId=. Unfiled is virtual
 * (folderId == null), not a persisted row. `?folder=` is the
 * deep link. Workspace / tenant+workbench change drops the
 * previous-workspace folder query. Prefix-in-name is no longer
 * the primary organizer. Viewers can select; F.2 ships no
 * create / rename / delete / move verbs.
 *
 * Folders are not in YAML. Drafts never run. No cascade delete.
 * Host ?tenant= / ?workbench= stay display-only (ADV-021).
 * Isolation success is a denial (ADV-024).
 */

import { isResourceId } from "./workflow.ts";
import { WORKFLOW_EDIT_PERMISSION } from "./workspace-nav.ts";

export const F2_STORY = 309;
export const F2_EPIC = 307;
export const F2_KEEP_STORY_OPEN = true;
export const F2_ID = "F.2-home-folder-rail-select" as const;
export const F2_BRIEF = "docs/architecture/flowforge-workflow-folders.md";

export const WORKFLOW_FOLDERS_PATH = "/workflow-folders";
export const FOLDER_QUERY = "folder";
export const UNFILED_FOLDER_ID = "unfiled";
export const UNFILED_FOLDER_LABEL = "Unfiled";
export const FOLDER_RAIL_LABEL = "Workflow folders";
export const FOLDER_CRUMB_LABEL = "Selected folder";
export const FOLDER_EXPAND_STORAGE_PREFIX = "ff.home.folder.expand:";
export const FOLDER_WORKSPACE_MEMORY = "ff.home.folder.workspace";

export const FOLDER_MUTATE_VERBS = [
  "New folder",
  "Rename folder",
  "Delete folder",
  "Move…",
] as const;

export const PREFIX_IN_NAME_PRIMARY_TOKENS = [
  'label="Folder"',
  "Folders use a name prefix",
  "ops/…",
  "ops--name",
] as const;

export type WorkflowFolder = {
  id: string;
  workspaceId: string;
  parentId: string | null;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowFolderList = {
  items: WorkflowFolder[];
};

export type FolderSelection =
  | { kind: "unfiled" }
  | { kind: "folder"; id: string };

export type FolderTreeNode = WorkflowFolder & {
  children: FolderTreeNode[];
};

export const F2_HOME_FOLDER = {
  yamlIsSourceOfTruth: true,
  foldersNotInYaml: true,
  draftsNeverRun: true,
  vaultDisplayNameUuidOnly: true,
  adv021ChromeFromSessionEmbedOnly: true,
  adv024MembershipIsolationStayGrantGated: true,
  isolationSuccessIsDenial: true,
  noCascadeDelete: true,
  notAnN8nClone: true,
  noKekInBrowser: true,
  selectOnly: true,
  unfiledIsVirtual: true,
  prefixInNameIsNotPrimaryOrganizer: true,
  viewerCanSelect: true,
  noMutateVerbs: true,
  singleMain: true,
  labeledRail: true,
  noNestedMain: true,
  listCardsUnchanged: true,
  homeDrawersUnchanged: true,
  noNewApi: true,
  d6MigrateInPlace: true,
  keep309Open: true,
} as const;

export const F2_HOME_FOLDER_SOURCES = [
  "src/lib/workflow-folder.ts",
  "src/lib/workflow-folder-client.ts",
  "src/lib/workflow-client.ts",
  "src/lib/workflow-types.ts",
  "src/lib/workflow-home.ts",
  "src/components/home/WorkflowHome.tsx",
  "src/app/workflows/page.tsx",
] as const;

export function isWorkflowFolder(value: unknown): value is WorkflowFolder {
  if (!value || typeof value !== "object") {
    return false;
  }
  const body = value as Record<string, unknown>;
  return (
    typeof body.id === "string" &&
    isResourceId(body.id) &&
    typeof body.workspaceId === "string" &&
    typeof body.name === "string" &&
    (body.parentId === null ||
      (typeof body.parentId === "string" && isResourceId(body.parentId))) &&
    typeof body.createdAt === "string" &&
    typeof body.updatedAt === "string"
  );
}

export function parseFolderQuery(
  raw: string | null | undefined,
): FolderSelection {
  const value = (raw ?? "").trim();
  if (!value || value === UNFILED_FOLDER_ID) {
    return { kind: "unfiled" };
  }
  if (isResourceId(value)) {
    return { kind: "folder", id: value };
  }
  return { kind: "unfiled" };
}

export function folderQueryValue(selection: FolderSelection): string {
  return selection.kind === "unfiled" ? UNFILED_FOLDER_ID : selection.id;
}

export function workflowsFolderIdQuery(selection: FolderSelection): string {
  return folderQueryValue(selection);
}

export function listWorkflowsPath(folderId?: string): string {
  const trimmed = folderId?.trim() ?? "";
  if (!trimmed) {
    return "/workflows";
  }
  return `/workflows?folderId=${encodeURIComponent(trimmed)}`;
}

export function folderSelectionsEqual(
  left: FolderSelection,
  right: FolderSelection,
): boolean {
  if (left.kind === "unfiled" && right.kind === "unfiled") {
    return true;
  }
  return (
    left.kind === "folder" &&
    right.kind === "folder" &&
    left.id === right.id
  );
}

export function applyFolderQuery(
  search: string,
  selection: FolderSelection,
  options: { drop?: boolean } = {},
): string {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(raw);
  if (options.drop) {
    params.delete(FOLDER_QUERY);
  } else {
    params.set(FOLDER_QUERY, folderQueryValue(selection));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function buildFolderTree(
  items: readonly WorkflowFolder[],
): FolderTreeNode[] {
  const byParent = new Map<string | null, WorkflowFolder[]>();
  for (const item of items) {
    const key = item.parentId;
    const list = byParent.get(key) ?? [];
    list.push(item);
    byParent.set(key, list);
  }
  const walk = (parentId: string | null): FolderTreeNode[] => {
    const list = [...(byParent.get(parentId) ?? [])].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    return list.map((item) => ({
      ...item,
      children: walk(item.id),
    }));
  };
  return walk(null);
}

export function folderPath(
  items: readonly WorkflowFolder[],
  folderId: string,
): WorkflowFolder[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const path: WorkflowFolder[] = [];
  const seen = new Set<string>();
  let current = byId.get(folderId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
}

export function folderPathLabel(path: readonly WorkflowFolder[]): string {
  return path.map((item) => item.name).join(" / ");
}

export function folderNameMap(
  items: readonly WorkflowFolder[],
): Map<string, string> {
  const names = new Map<string, string>();
  for (const item of items) {
    names.set(item.id, folderPathLabel(folderPath(items, item.id)));
  }
  return names;
}

export function resolveFolderSelection(
  selection: FolderSelection,
  items: readonly WorkflowFolder[],
): FolderSelection {
  if (selection.kind === "unfiled") {
    return selection;
  }
  if (items.some((item) => item.id === selection.id)) {
    return selection;
  }
  return { kind: "unfiled" };
}

export function ancestorIdsForSelection(
  items: readonly WorkflowFolder[],
  selection: FolderSelection,
): string[] {
  if (selection.kind === "unfiled") {
    return [];
  }
  return folderPath(items, selection.id)
    .slice(0, -1)
    .map((item) => item.id);
}

export function breadcrumbSegments(
  items: readonly WorkflowFolder[],
  selection: FolderSelection,
): Array<{ selection: FolderSelection; label: string }> {
  if (selection.kind === "unfiled") {
    return [{ selection: { kind: "unfiled" }, label: UNFILED_FOLDER_LABEL }];
  }
  const path = folderPath(items, selection.id);
  if (path.length === 0) {
    return [{ selection: { kind: "unfiled" }, label: UNFILED_FOLDER_LABEL }];
  }
  return path.map((item) => ({
    selection: { kind: "folder" as const, id: item.id },
    label: item.name,
  }));
}

export function folderExpandStorageKey(workspaceKey: string): string {
  return `${FOLDER_EXPAND_STORAGE_PREFIX}${workspaceKey}`;
}

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    if (typeof sessionStorage === "undefined") {
      return null;
    }
    return sessionStorage;
  } catch {
    return null;
  }
}

export function consumeFolderWorkspaceChange(
  workspaceKey: string,
  storage: Pick<Storage, "getItem" | "setItem"> | null = memoryStorage(),
): boolean {
  const key = workspaceKey.trim();
  if (!storage || !key) {
    return false;
  }
  const previous = storage.getItem(FOLDER_WORKSPACE_MEMORY) ?? "";
  storage.setItem(FOLDER_WORKSPACE_MEMORY, key);
  return Boolean(previous && previous !== key);
}

export function readExpandedFolderIds(
  workspaceKey: string,
  storage: Pick<Storage, "getItem"> | null = memoryStorage(),
): string[] {
  if (!storage) {
    return [];
  }
  try {
    const raw = storage.getItem(folderExpandStorageKey(workspaceKey));
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (item): item is string => typeof item === "string" && isResourceId(item),
    );
  } catch {
    return [];
  }
}

export function writeExpandedFolderIds(
  workspaceKey: string,
  ids: readonly string[],
  storage: Pick<Storage, "setItem"> | null = memoryStorage(),
): void {
  if (!storage) {
    return;
  }
  storage.setItem(
    folderExpandStorageKey(workspaceKey),
    JSON.stringify([...new Set(ids.filter((id) => isResourceId(id)))]),
  );
}

export function canMutateWorkflowFolders(
  permissions: readonly string[] | null | undefined,
): boolean {
  if (permissions == null) {
    return false;
  }
  return permissions.includes(WORKFLOW_EDIT_PERMISSION);
}

export function homeFolderRailHasMutateVerbs(source: string): boolean {
  return FOLDER_MUTATE_VERBS.some((verb) => source.includes(verb));
}

export function homeUsesPrefixInNameAsPrimaryOrganizer(source: string): boolean {
  return PREFIX_IN_NAME_PRIMARY_TOKENS.some((token) => source.includes(token));
}

export function homeFolderRailNestsMain(source: string): boolean {
  return /<main[\s>]/.test(source);
}
