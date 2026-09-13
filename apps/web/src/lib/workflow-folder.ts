/**
 * F.2 home folder rail + select, F.3 create / rename / delete,
 * F.4 move workflows, F.5 empty states + Unfiled (Chloe UI).
 *
 * Relates to #309 / #310 / #311 / #312 / Part of #307. Keep #309,
 * #310, #311, and #312 open.
 *
 * Tree comes from GET /workflow-folders. The list uses
 * GET /workflows?folderId=. Unfiled is virtual (folderId == null),
 * not a persisted row — always in the rail. `?folder=` is the deep
 * link. Workspace / tenant+workbench change drops the
 * previous-workspace folder query. Prefix-in-name is no longer the
 * primary organizer. Viewers can select; they do not get New folder
 * / Rename folder / Delete folder / Move. Editors mutate folders
 * through POST / PATCH / DELETE /workflow-folders. Workflow move is
 * PATCH /workflows/{id}/folder (drag onto a folder or Unfiled, and
 * row-menu Move…). Folder re-parent drag is not this story.
 *
 * F.5 empty chrome: empty home keeps UXL.6 Create / Import YAML /
 * reviewed template (+ optional New folder). Empty folder is create
 * here / move / delete (delete only when no workflows and no child
 * folders). Unfiled-empty points at the tree or empty-home verbs.
 * F.6 search across folders is out of scope.
 *
 * Folders are not in YAML. Drafts never run. Move does not bump
 * draftRevision, YAML, or activation. No cascade delete.
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
export const F3_STORY = 310;
export const F3_EPIC = 307;
export const F3_KEEP_STORY_OPEN = true;
export const F3_ID = "F.3-create-rename-delete-folders" as const;
export const F3_BRIEF = "docs/architecture/flowforge-workflow-folders.md";
export const F4_STORY = 311;
export const F4_EPIC = 307;
export const F4_KEEP_STORY_OPEN = true;
export const F4_ID = "F.4-move-workflows-drag-menu" as const;
export const F4_BRIEF = "docs/architecture/flowforge-workflow-folders.md";
export const F5_STORY = 312;
export const F5_EPIC = 307;
export const F5_KEEP_STORY_OPEN = true;
export const F5_ID = "F.5-empty-states-unfiled" as const;
export const F5_BRIEF = "docs/architecture/flowforge-workflow-folders.md";
export const MAX_FOLDER_DEPTH = 4;
export const MAX_FOLDER_NAME_GRAPHEMES = 64;
export const FOLDER_NAME_RULES_HELP =
  "Folder name must be 1-64 graphemes with no '/' or control characters.";
export const FOLDER_SIBLING_HELP =
  "A folder with this name already exists among siblings.";
export const FOLDER_DEPTH_HELP =
  "Folders cannot be nested more than 4 levels.";
export const FOLDER_NOT_EMPTY_HELP = "Move or delete contents first.";
export const FOLDER_UNFILED_LOCKED_HELP =
  "Unfiled is virtual and cannot be renamed or deleted.";
export const NEW_FOLDER_LABEL = "New folder";
export const RENAME_FOLDER_LABEL = "Rename folder";
export const DELETE_FOLDER_LABEL = "Delete folder";

export const WORKFLOW_FOLDERS_PATH = "/workflow-folders";
export const FOLDER_QUERY = "folder";
export const UNFILED_FOLDER_ID = "unfiled";
export const UNFILED_FOLDER_LABEL = "Unfiled";
export const FOLDER_RAIL_LABEL = "Workflow folders";
export const FOLDER_CRUMB_LABEL = "Selected folder";
export const FOLDER_EXPAND_STORAGE_PREFIX = "ff.home.folder.expand:";
export const FOLDER_WORKSPACE_MEMORY = "ff.home.folder.workspace";

export const FOLDER_ORGANIZE_VERBS = [
  NEW_FOLDER_LABEL,
  RENAME_FOLDER_LABEL,
  DELETE_FOLDER_LABEL,
] as const;

export const FOLDER_MOVE_VERB = "Move…" as const;
export const FOLDER_EMPTY_HEADING = "Nothing in this folder.";
export const FOLDER_EMPTY_HELP =
  "Create a draft here or move an existing workflow into this folder. Drafts do not run — publish, then start a published version.";
export const FOLDER_EMPTY_CREATE_LABEL = "Create here";
export const FOLDER_EMPTY_MOVE_LABEL = "Move existing";
export const FOLDER_EMPTY_VIEWER_HELP =
  "This folder has no workflows. Creating, moving, or deleting requires workflow.edit.";
export const UNFILED_EMPTY_HEADING = "Nothing in Unfiled.";
export const UNFILED_EMPTY_FILED_HELP =
  "Workflows in this workspace are filed in the folder tree. Select a folder in the rail to open them.";
export const UNFILED_EMPTY_NONE_HELP =
  "Create, Import YAML, or pick a reviewed template. Each creates a draft. Drafts do not run — publish, then start a published version.";
export const UNFILED_EMPTY_TREE_LABEL = "Open the folder rail";

export const FOLDER_MUTATE_VERBS = [
  ...FOLDER_ORGANIZE_VERBS,
  FOLDER_MOVE_VERB,
] as const;

export type FolderMutateGesture = "create" | "rename" | "delete" | "move";

export type FolderMutatePhase = "idle" | "pending" | "success" | "error";

export type FolderMutateChrome = {
  gesture: FolderMutateGesture | null;
  phase: FolderMutatePhase;
};

export const FOLDER_MUTATE_IDLE: FolderMutateChrome = {
  gesture: null,
  phase: "idle",
};

export const FOLDER_MUTATE_LABELS = {
  create: {
    pending: "Creating folder…",
    success: "Folder created.",
    error: "Folder was not created.",
  },
  rename: {
    pending: "Renaming folder…",
    success: "Folder renamed.",
    error: "Folder was not renamed.",
  },
  delete: {
    pending: "Deleting folder…",
    success: "Folder deleted.",
    error: "Folder was not deleted.",
  },
  move: {
    pending: "Moving workflow…",
    success: "Workflow moved.",
    error: "Workflow was not moved.",
  },
} as const satisfies Record<
  FolderMutateGesture,
  { pending: string; success: string; error: string }
>;

export type FolderNotEmptyCounts = {
  workflowCount: number;
  childFolderCount: number;
};

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
  f3OrganizeVerbsEditGated: true,
  singleMain: true,
  labeledRail: true,
  noNestedMain: true,
  listCardsUnchanged: true,
  homeDrawersUnchanged: true,
  noNewApi: true,
  d6MigrateInPlace: true,
  keep309Open: true,
  keep310Open: true,
} as const;

export const F3_HOME_FOLDER = {
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
  unfiledIsVirtual: true,
  unfiledCannotRenameOrDelete: true,
  organizeVerbsOnRail: true,
  renameOnlyNoReparent: true,
  noWorkflowMove: true,
  viewersHaveNoOrganizeVerbs: true,
  pendingThenSuccessOrError: true,
  csrfOnWrites: true,
  noActionsDetour: true,
  noYamlOrSlugRewrite: true,
  noNewApi: true,
  d6MigrateInPlace: true,
  keep310Open: true,
} as const;

export const F4_HOME_FOLDER = {
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
  dragAndMenuCallSamePatch: true,
  unfiledTargetSendsNullFolderId: true,
  moveDoesNotBumpDraftRevision: true,
  moveDoesNotChangeYaml: true,
  moveDoesNotChangeActivation: true,
  viewerCannotDrop: true,
  viewerHasNoMoveMenu: true,
  crossFolderInsideWorkspaceOnly: true,
  noFolderReparentDrag: true,
  singleRowIsEnough: true,
  pendingThenSuccessOrError: true,
  csrfOnWrites: true,
  noNewApi: true,
  d6MigrateInPlace: true,
  keep311Open: true,
} as const;

export const F5_HOME_FOLDER = {
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
  emptyHomeKeepsUxl6Verbs: true,
  emptyHomeOptionalNewFolder: true,
  emptyHomeCopySaysDraftsDoNotRun: true,
  noDeveloperFixtures: true,
  emptyFolderCreateHereMoveDelete: true,
  deleteOnlyWhenNoWorkflowsAndNoChildFolders: true,
  refuseIfNonemptyStays: true,
  unfiledEmptyPointsAtTreeOrHomeVerbs: true,
  unfiledAlwaysInRail: true,
  unfiledIsNotPersisted: true,
  noF6Search: true,
  noNewApi: true,
  d6MigrateInPlace: true,
  keep312Open: true,
} as const;

export const F2_HOME_FOLDER_SOURCES = [
  "src/lib/workflow-folder.ts",
  "src/lib/workflow-folder-client.ts",
  "src/lib/workflow-client.ts",
  "src/lib/workflow-types.ts",
  "src/lib/workflow-home.ts",
  "src/lib/identity-proxy.ts",
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

export function homeFolderRailHasOrganizeVerbs(source: string): boolean {
  const labeled = FOLDER_ORGANIZE_VERBS.every((verb) => source.includes(verb));
  const tokens =
    source.includes("NEW_FOLDER_LABEL") &&
    source.includes("RENAME_FOLDER_LABEL") &&
    source.includes("DELETE_FOLDER_LABEL");
  return labeled || tokens;
}

export function homeFolderRailHasMoveVerb(source: string): boolean {
  return source.includes('data-home-folder-verb="move"');
}

export function homeWorkflowRowHasMoveVerb(source: string): boolean {
  return (
    source.includes("FOLDER_MOVE_VERB") &&
    source.includes('data-home-workflow-verb="move"')
  );
}

export function homeWorkflowRowHasDragMove(source: string): boolean {
  return (
    source.includes("data-home-workflow-drag") &&
    source.includes("onDragStart") &&
    source.includes("onDrop") &&
    source.includes("data-home-folder-drop") &&
    source.includes("WORKFLOW_MOVE_DRAG_TYPE")
  );
}

export function workflowFolderPath(folderId: string): string {
  return `${WORKFLOW_FOLDERS_PATH}/${folderId}`;
}

export function workflowMoveFolderPath(workflowId: string): string {
  return `/workflows/${workflowId}/folder`;
}

export const WORKFLOW_MOVE_DRAG_TYPE = "application/x-flowforge-workflow";

export type WorkflowMoveDragPayload = {
  workflowId: string;
  folderId: string | null;
};

export function folderIdForMove(target: FolderSelection): string | null {
  return target.kind === "unfiled" ? null : target.id;
}

export function workflowMoveBody(
  folderId: string | null,
): { folderId: string | null } {
  return { folderId };
}

export function workflowAlreadyInFolder(
  currentFolderId: string | null | undefined,
  target: FolderSelection,
): boolean {
  const current = currentFolderId?.trim() ? currentFolderId : null;
  if (target.kind === "unfiled") {
    return current == null;
  }
  return current === target.id;
}

export function canDropWorkflowOnFolder(
  canMutate: boolean,
  currentFolderId: string | null | undefined,
  target: FolderSelection,
): boolean {
  return canMutate && !workflowAlreadyInFolder(currentFolderId, target);
}

export function workflowMoveTargets(
  items: readonly WorkflowFolder[],
): Array<{ selection: FolderSelection; label: string }> {
  const folders = items
    .map((item) => ({
      selection: { kind: "folder" as const, id: item.id },
      label: folderPathLabel(folderPath(items, item.id)),
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
  return [
    { selection: { kind: "unfiled" }, label: UNFILED_FOLDER_LABEL },
    ...folders,
  ];
}

export function defaultWorkflowMoveTarget(
  currentFolderId: string | null | undefined,
  items: readonly WorkflowFolder[],
): FolderSelection {
  if (currentFolderId?.trim()) {
    return { kind: "unfiled" };
  }
  const first = workflowMoveTargets(items).find(
    (item) => item.selection.kind === "folder",
  );
  return first?.selection ?? { kind: "unfiled" };
}

export function workflowMoveDragPayload(
  workflowId: string,
  folderId: string | null,
): string {
  const body: WorkflowMoveDragPayload = { workflowId, folderId };
  return JSON.stringify(body);
}

export function parseWorkflowMoveDragPayload(
  raw: string | null | undefined,
): WorkflowMoveDragPayload | null {
  const value = (raw ?? "").trim();
  if (!value) {
    return null;
  }
  if (isResourceId(value)) {
    return { workflowId: value, folderId: null };
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const body = parsed as Record<string, unknown>;
    if (typeof body.workflowId !== "string" || !isResourceId(body.workflowId)) {
      return null;
    }
    const folderId =
      body.folderId == null || body.folderId === ""
        ? null
        : typeof body.folderId === "string" && isResourceId(body.folderId)
          ? body.folderId
          : null;
    if (body.folderId != null && body.folderId !== "" && folderId == null) {
      return null;
    }
    return { workflowId: body.workflowId, folderId };
  } catch {
    return null;
  }
}

export function folderNameGraphemes(name: string): number {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter(undefined, {
      granularity: "grapheme",
    });
    return [...segmenter.segment(name)].length;
  }
  return [...name].length;
}

function hasForbiddenFolderChar(name: string): boolean {
  for (const char of name) {
    if (char === "/") {
      return true;
    }
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

export function folderNameRuleError(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) {
    return "Enter a folder name.";
  }
  if (hasForbiddenFolderChar(trimmed)) {
    return FOLDER_NAME_RULES_HELP;
  }
  if (folderNameGraphemes(trimmed) > MAX_FOLDER_NAME_GRAPHEMES) {
    return FOLDER_NAME_RULES_HELP;
  }
  return null;
}

export function normalizeFolderName(
  name: string,
): { ok: true; name: string } | { ok: false; error: string } {
  const trimmed = name.trim();
  const error = folderNameRuleError(trimmed);
  if (error) {
    return { ok: false, error };
  }
  return { ok: true, name: trimmed };
}

export function siblingFolderNameTaken(
  items: readonly WorkflowFolder[],
  name: string,
  parentId: string | null,
  exceptId?: string,
): boolean {
  const needle = name.trim().toLowerCase();
  if (!needle) {
    return false;
  }
  return items.some((item) => {
    if (exceptId && item.id === exceptId) {
      return false;
    }
    if ((item.parentId ?? null) !== parentId) {
      return false;
    }
    return item.name.trim().toLowerCase() === needle;
  });
}

export function folderNameSubmitError(
  items: readonly WorkflowFolder[],
  name: string,
  parentId: string | null,
  exceptId?: string,
): string | null {
  const normalized = normalizeFolderName(name);
  if (!normalized.ok) {
    return normalized.error;
  }
  if (siblingFolderNameTaken(items, normalized.name, parentId, exceptId)) {
    return FOLDER_SIBLING_HELP;
  }
  return null;
}

export function createFolderParentId(selection: FolderSelection): string | null {
  return selection.kind === "folder" ? selection.id : null;
}

export function folderDepth(
  items: readonly WorkflowFolder[],
  folderId: string,
): number {
  return folderPath(items, folderId).length;
}

export function canCreateChildFolder(
  items: readonly WorkflowFolder[],
  parentId: string | null,
): boolean {
  if (!parentId) {
    return true;
  }
  return folderDepth(items, parentId) < MAX_FOLDER_DEPTH;
}

export function childFolderCount(
  items: readonly WorkflowFolder[],
  folderId: string,
): number {
  return items.filter((item) => item.parentId === folderId).length;
}

export function folderAllowsRenameOrDelete(selection: FolderSelection): boolean {
  return selection.kind === "folder";
}

export function selectionAfterFolderDelete(
  deletedId: string,
  items: readonly WorkflowFolder[],
  current: FolderSelection,
): FolderSelection {
  if (current.kind === "unfiled" || current.id !== deletedId) {
    return current;
  }
  const deleted = items.find((item) => item.id === deletedId);
  if (deleted?.parentId) {
    return { kind: "folder", id: deleted.parentId };
  }
  return { kind: "unfiled" };
}

export function folderDeleteBlocked(options: {
  childFolderCount: number;
  workflowCount: number | null;
}): boolean {
  if (options.childFolderCount > 0) {
    return true;
  }
  return options.workflowCount != null && options.workflowCount > 0;
}

export type FolderHomeEmptyKind =
  | "teach"
  | "folder"
  | "unfiled"
  | "filtered"
  | "populated";

export function folderHomeEmptyKind(input: {
  selection: FolderSelection;
  folderCount: number;
  scopedRecordCount: number;
  visibleCount: number;
  workspaceWorkflowCount: number;
}): FolderHomeEmptyKind {
  if (input.visibleCount > 0) {
    return "populated";
  }
  if (input.scopedRecordCount > 0) {
    return "filtered";
  }
  if (input.selection.kind === "folder") {
    return "folder";
  }
  if (input.folderCount === 0 && input.workspaceWorkflowCount <= 0) {
    return "teach";
  }
  return "unfiled";
}

export function unfiledEmptyUsesHomeVerbs(
  workspaceWorkflowCount: number,
): boolean {
  return workspaceWorkflowCount <= 0;
}

export function emptyFolderDeleteAllowed(options: {
  childFolderCount: number;
  workflowCount: number;
}): boolean {
  return !folderDeleteBlocked({
    childFolderCount: options.childFolderCount,
    workflowCount: options.workflowCount,
  });
}

export function workflowsMovableIntoSelection<
  T extends { folderId?: string | null },
>(items: readonly T[], target: FolderSelection): T[] {
  return items.filter((item) => !workflowAlreadyInFolder(item.folderId, target));
}

export function isUnfiledFolderId(id: string): boolean {
  return id.trim().toLowerCase() === UNFILED_FOLDER_ID;
}

export function persistedFoldersIncludeUnfiledRow(
  items: readonly WorkflowFolder[],
): boolean {
  return items.some(
    (item) =>
      isUnfiledFolderId(item.id) ||
      !isWorkflowFolder(item),
  );
}

export function unfiledIsAlwaysPresentAndNotPersisted(options: {
  railSource: string;
  items: readonly WorkflowFolder[];
}): boolean {
  const railHasUnfiled =
    options.railSource.includes('data-home-folder-rail="unfiled"') &&
    options.railSource.includes("UNFILED_FOLDER_LABEL");
  const treeHasUnfiledId = buildFolderTree(options.items).some((node) =>
    isUnfiledFolderId(node.id),
  );
  return (
    railHasUnfiled &&
    !treeHasUnfiledId &&
    !persistedFoldersIncludeUnfiledRow(options.items) &&
    !isWorkflowFolder({
      id: UNFILED_FOLDER_ID,
      workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      parentId: null,
      name: UNFILED_FOLDER_LABEL,
      createdAt: "2026-09-13T00:00:00Z",
      updatedAt: "2026-09-13T00:00:00Z",
    })
  );
}

export function folderNotEmptyCounts(
  value: unknown,
): FolderNotEmptyCounts | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const body = value as Record<string, unknown>;
  if (
    typeof body.workflowCount !== "number" ||
    typeof body.childFolderCount !== "number" ||
    !Number.isFinite(body.workflowCount) ||
    !Number.isFinite(body.childFolderCount)
  ) {
    return null;
  }
  return {
    workflowCount: body.workflowCount,
    childFolderCount: body.childFolderCount,
  };
}

export function folderNotEmptyDetail(counts: FolderNotEmptyCounts): string {
  const parts: string[] = [];
  if (counts.workflowCount > 0) {
    parts.push(
      `${counts.workflowCount} workflow${counts.workflowCount === 1 ? "" : "s"}`,
    );
  }
  if (counts.childFolderCount > 0) {
    parts.push(
      `${counts.childFolderCount} child folder${counts.childFolderCount === 1 ? "" : "s"}`,
    );
  }
  if (parts.length === 0) {
    return FOLDER_NOT_EMPTY_HELP;
  }
  return `${FOLDER_NOT_EMPTY_HELP} This folder still has ${parts.join(" and ")}.`;
}

export function folderMutateBegin(
  gesture: FolderMutateGesture,
): FolderMutateChrome {
  return { gesture, phase: "pending" };
}

export function folderMutateFinish(
  gesture: FolderMutateGesture,
  ok: boolean,
): FolderMutateChrome {
  return { gesture, phase: ok ? "success" : "error" };
}

export function folderMutateLabel(chrome: FolderMutateChrome): string {
  if (!chrome.gesture || chrome.phase === "idle") {
    return "";
  }
  return FOLDER_MUTATE_LABELS[chrome.gesture][chrome.phase];
}

export function homeUsesPrefixInNameAsPrimaryOrganizer(source: string): boolean {
  return PREFIX_IN_NAME_PRIMARY_TOKENS.some((token) => source.includes(token));
}

export function homeFolderRailNestsMain(source: string): boolean {
  return /<main[\s>]/.test(source);
}

export type WorkflowFolderProxyRoute = {
  methods: readonly string[];
  match: (segments: string[]) => boolean;
};

/**
 * F.1 folder routes through the same-origin identity proxy.
 * F.2 only GETs the collection; POST/PATCH/DELETE stay allowlisted
 * so F.3/F.4 do not 404 the proxy. Paths live here so a retarget
 * only edits this adapter.
 */
export const WORKFLOW_FOLDER_PROXY_ROUTES: readonly WorkflowFolderProxyRoute[] =
  [
    {
      methods: ["GET", "POST"],
      match: (s) => eqSegments(s, ["workflow-folders"]),
    },
    {
      methods: ["GET", "PATCH", "DELETE"],
      match: (s) =>
        s.length === 2 &&
        s[0] === "workflow-folders" &&
        isResourceId(s[1]),
    },
    {
      methods: ["PATCH"],
      match: (s) =>
        s.length === 3 &&
        s[0] === "workflows" &&
        isResourceId(s[1]) &&
        s[2] === "folder",
    },
  ];

function eqSegments(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function isWorkflowFolderProxySegments(segments: string[]): boolean {
  return WORKFLOW_FOLDER_PROXY_ROUTES.some((route) => route.match(segments));
}
