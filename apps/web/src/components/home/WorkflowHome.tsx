"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
} from "react";
import { ProblemBanner } from "@/components/ProblemBanner";
import { SessionSetupHint } from "@/components/session/SessionSetupHint";
import { useEmbedMode } from "@/components/embed/EmbedMode";
import { useWorkspace } from "@/components/shell/WorkspaceProvider";
import { listApprovals } from "@/lib/approval-client";
import type { ApprovalRequest } from "@/lib/approval-types";
import { canSeeApprovalsNav } from "@/lib/approval";
import { canSeeExecutionsNav } from "@/lib/execution";
import { listWorkflowExecutions } from "@/lib/execution-client";
import type { ExecutionRecord } from "@/lib/execution-types";
import {
  productHomeCapabilities,
  templateCreatedEditorHref,
  workflowEditorHref,
  workflowHomeLastRunHref,
} from "@/lib/product-home";
import { rememberPeakEndOverlay } from "@/lib/peak-end-operate-endings";
import { workspaceLookupKey } from "@/lib/identity-headers";
import type { ProblemDetails } from "@/lib/problem";
import { createGenerationGate } from "@/lib/request-generation";
import { optionalCreateFields, shortDigest } from "@/lib/workflow";
import {
  createWorkflow,
  exportWorkflowVersion,
  getWorkflowDraft,
  importValidatedWorkflow,
  listWorkflows,
  moveWorkflowToFolder,
} from "@/lib/workflow-client";
import type { WorkflowDraft, WorkflowRecord } from "@/lib/workflow-types";
import { subscribeWorkspaceCommands } from "@/lib/workspace-commands";
import { HomeActivationStatus } from "@/components/home/HomeActivationStatus";
import { HomeLastRunStatus } from "@/components/home/HomeLastRunStatus";
import {
  EDITOR_ACTIVATION_CHANGED_EVENT,
  canViewEditorActivation,
} from "@/lib/editor-activation";
import {
  HOME_ACTIVATION,
  HOME_ACTIVATION_FILTERS,
  HOME_ACTIVATION_HEADING_ID,
  HOME_ACTIVATION_HELP,
  WORKFLOW_HOME_LIST_COLUMNS,
  type HomeActivationColumn,
  type HomeActivationFilter,
} from "@/lib/home-activation";
import { HOME_ROW_SCAN_HELP } from "@/lib/home-row-scan";
import {
  HOME_EMPTY_CREATE_LABEL,
  HOME_EMPTY_HEADING,
  HOME_EMPTY_HELP,
  HOME_EMPTY_IMPORT_LABEL,
  HOME_EMPTY_TEMPLATE_HELP,
  HOME_EMPTY_TEMPLATE_LABEL,
  HOME_FILTERED_EMPTY_HEADING,
  HOME_FILTERED_EMPTY_HELP,
} from "@/lib/empty-states-teach-model";
import { loadHomeActivationStates } from "@/lib/home-activation-client";
import {
  EMPTY_WORKFLOW_HOME_FILTERS,
  buildWorkflowHomeItems,
  filterWorkflowHomeItems,
  sortWorkflowHomeItems,
  uniqueFilterValues,
  validationHealthLabel,
  type WorkflowHomeFilters,
  type WorkflowHomeItem,
  type WorkflowHomeView,
} from "@/lib/workflow-home";
import {
  WORKFLOW_TEMPLATES,
  duplicateWorkflowName,
  workflowTemplateById,
  type WorkflowTemplate,
} from "@/lib/workflow-templates";
import { ManualStartPanel } from "@/components/workflows/ManualStartPanel";
import { WebhookTriggerPanel } from "@/components/workflows/WebhookTriggerPanel";
import { ScheduleTriggerPanel } from "@/components/workflows/ScheduleTriggerPanel";
import {
  MANUAL_START_QUERY,
  canOfferManualStart,
} from "@/lib/manual-start-contract";
import {
  WEBHOOK_TRIGGER_QUERY,
  canViewWebhookTriggers,
} from "@/lib/webhook-trigger-contract";
import {
  SCHEDULE_TRIGGER_QUERY,
  canViewScheduleTriggers,
} from "@/lib/schedule-trigger-contract";
import {
  TEST_RUN_HELP,
  canOfferHomeTestRun,
  testRunVersionHints,
} from "@/lib/editor-test-run";
import {
  EDITOR_WORKING_MEMORY_START_NEEDS_PUBLISHED,
  EDITOR_WORKING_MEMORY_START_USES_PUBLISHED,
  EDITOR_WORKING_MEMORY_TEST_RUN,
} from "@/lib/editor-working-memory";
import { runPublishedTestVersion } from "@/lib/editor-test-run-client";
import { dohertyStatusClassName } from "@/lib/doherty-pending-chrome";
import {
  DELETE_FOLDER_LABEL,
  FOLDER_CRUMB_LABEL,
  FOLDER_DEPTH_HELP,
  FOLDER_EMPTY_CREATE_LABEL,
  FOLDER_EMPTY_HEADING,
  FOLDER_EMPTY_HELP,
  FOLDER_EMPTY_MOVE_LABEL,
  FOLDER_EMPTY_VIEWER_HELP,
  FOLDER_MOVE_VERB,
  FOLDER_MUTATE_IDLE,
  FOLDER_NAME_RULES_HELP,
  FOLDER_NOT_EMPTY_HELP,
  FOLDER_PATH_REVEAL_LABEL,
  FOLDER_QUERY,
  FOLDER_RAIL_FILTER_LABEL,
  FOLDER_RAIL_LABEL,
  FOLDER_SEARCH_ACROSS_LABEL,
  FOLDER_SEARCH_HELP,
  FOLDER_SEARCH_IN_FOLDER_LABEL,
  NEW_FOLDER_LABEL,
  RENAME_FOLDER_LABEL,
  UNFILED_EMPTY_FILED_HELP,
  UNFILED_EMPTY_HEADING,
  UNFILED_EMPTY_NONE_HELP,
  UNFILED_EMPTY_TREE_LABEL,
  UNFILED_FOLDER_LABEL,
  WORKFLOW_MOVE_DRAG_TYPE,
  ancestorIdsForSelection,
  applyFolderQuery,
  breadcrumbSegments,
  buildFolderTree,
  canCreateChildFolder,
  canDropWorkflowOnFolder,
  canMutateEmbedWorkflowFolders,
  canMutateWorkflowFolders,
  childFolderCount,
  consumeFolderWorkspaceChange,
  constrainItemsToFolderSelection,
  createFolderParentId,
  defaultWorkflowMoveTarget,
  emptyFolderDeleteAllowed,
  filterFolderTreeByName,
  folderAllowsRenameOrDelete,
  folderDeleteBlocked,
  folderHomeEmptyKind,
  folderIdForMove,
  folderIdsToExpandForFilter,
  folderMutateBegin,
  folderMutateFinish,
  folderMutateLabel,
  folderNameSubmitError,
  folderNotEmptyDetail,
  folderQueryValue,
  folderHomeListMode,
  intendedFolderSelectionFromUrl,
  selectedFolderListFolderId,
  matchesWorkflowNameOrSlug,
  parseFolderQuery,
  parseWorkflowMoveDragPayload,
  readExpandedFolderIds,
  resolveFolderSelection,
  selectionAfterFolderDelete,
  selectionForWorkflowFolder,
  shouldDropFolderQueryOnWorkspaceMemory,
  shouldRewriteFolderDeepLink,
  unfiledEmptyUsesHomeVerbs,
  workflowAlreadyInFolder,
  workflowFolderPathLabel,
  workflowMoveDragPayload,
  workflowMoveTargets,
  workflowsMovableIntoSelection,
  writeExpandedFolderIds,
  type FolderMutateChrome,
  type FolderSelection,
  type FolderTreeNode,
  type WorkflowFolder,
  type WorkflowMoveDragPayload,
} from "@/lib/workflow-folder";
import {
  createWorkflowFolder,
  deleteWorkflowFolder,
  listWorkflowFolders,
  renameWorkflowFolder,
} from "@/lib/workflow-folder-client";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";
import { canCreateWorkflows, canSeeWorkflowsNav } from "@/lib/workspace-nav";
import { pushNotification } from "@/lib/workspace-notifications";
import {
  homeSatelliteOverlayTriggerId,
  restoreSatelliteOverlayFocus,
  satelliteOverlayAfterEscape,
  type HomeSatelliteOverlayId,
} from "@/lib/rewrite-satellite-a11y";

export function WorkflowHome() {
  const { identity } = useWorkspace();
  return <WorkflowHomeSession key={workspaceLookupKey(identity)} />;
}

function WorkflowHomeSession() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { identity, ready, permissions, environment } = useWorkspace();
  const embed = useEmbedMode();
  const session = useSyncExternalStore(
    subscribeSession,
    getSessionSnapshot,
    getSessionSnapshot,
  );
  const workspaceKey = workspaceLookupKey(identity);
  const importRef = useRef<HTMLInputElement>(null);
  const consumedQuery = useRef(false);
  const refreshGate = useRef(createGenerationGate());
  const [folders, setFolders] = useState<WorkflowFolder[]>([]);
  const [foldersReady, setFoldersReady] = useState(false);
  const [dropPreviousFolder, setDropPreviousFolder] = useState(() =>
    consumeFolderWorkspaceChange(workspaceKey),
  );
  const [expandedIds, setExpandedIds] = useState<string[]>(() =>
    dropPreviousFolder ? [] : readExpandedFolderIds(workspaceKey),
  );
  const [records, setRecords] = useState<WorkflowRecord[]>([]);
  const [workspaceWorkflows, setWorkspaceWorkflows] = useState<
    WorkflowRecord[] | null
  >(null);
  const [drafts, setDrafts] = useState<Map<string, WorkflowDraft>>(new Map());
  const [executions, setExecutions] = useState<ExecutionRecord[]>([]);
  const [lastRunKnownIds, setLastRunKnownIds] = useState<Set<string>>(new Set());
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [activations, setActivations] = useState<
    Map<string, HomeActivationColumn>
  >(new Map());
  const [filters, setFilters] = useState<WorkflowHomeFilters>(EMPTY_WORKFLOW_HOME_FILTERS);
  const [searchInThisFolder, setSearchInThisFolder] = useState(false);
  const [railFilter, setRailFilter] = useState("");
  const [view, setView] = useState<WorkflowHomeView>("list");
  const [pending, setPending] = useState<string | null>(null);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [createName, setCreateName] = useState("");
  const [createSlug, setCreateSlug] = useState("");

  const [folderDialog, setFolderDialog] = useState<
    { kind: "create" } | { kind: "rename"; id: string } | null
  >(null);
  const [folderNameDraft, setFolderNameDraft] = useState("");
  const [folderNameError, setFolderNameError] = useState<string | null>(null);
  const [folderChrome, setFolderChrome] =
    useState<FolderMutateChrome>(FOLDER_MUTATE_IDLE);
  const [moveDialog, setMoveDialog] = useState<{
    id: string;
    name: string;
    folderId: string | null;
  } | null>(null);
  const [moveTarget, setMoveTarget] = useState<FolderSelection>({
    kind: "unfiled",
  });
  const [dragging, setDragging] = useState<WorkflowMoveDragPayload | null>(
    null,
  );
  const [moveIntoOpen, setMoveIntoOpen] = useState(false);
  const [moveIntoWorkflowId, setMoveIntoWorkflowId] = useState("");

  const canView = ready && canSeeWorkflowsNav(permissions);
  const canCreate = ready && canCreateWorkflows(permissions);
  const canMutateFolders =
    ready &&
    (embed
      ? canMutateEmbedWorkflowFolders(permissions, session.embedChrome)
      : canMutateWorkflowFolders(permissions));
  const rowCapabilities = productHomeCapabilities(ready ? permissions : null);
  const canExecute =
    ready && canOfferManualStart(permissions) && rowCapabilities.canExecute;
  const canPublish = ready && rowCapabilities.canPublish;
  const canViewWebhooks =
    ready && canViewWebhookTriggers(permissions) && rowCapabilities.canViewWebhooks;
  const canViewSchedules =
    ready &&
    canViewScheduleTriggers(permissions) &&
    rowCapabilities.canViewSchedules;
  const canSeeLastRun = ready && rowCapabilities.canSeeLastRun;
  const canViewActivation = ready && canViewEditorActivation(permissions);
  const denied = ready && permissions != null && !canSeeWorkflowsNav(permissions);
  const [startWorkflowId, setStartWorkflowId] = useState("");
  const [webhookWorkflowId, setWebhookWorkflowId] = useState("");
  const [scheduleWorkflowId, setScheduleWorkflowId] = useState("");
  const lastHomeOverlay = useRef<{
    kind: HomeSatelliteOverlayId;
    id: string;
  } | null>(null);

  const folderParam = searchParams.get(FOLDER_QUERY);
  const intendedSelection = useMemo<FolderSelection>(
    () =>
      intendedFolderSelectionFromUrl(folderParam, {
        dropPreviousFolder,
      }),
    [dropPreviousFolder, folderParam],
  );
  const selection = foldersReady
    ? resolveFolderSelection(intendedSelection, folders)
    : intendedSelection;
  const listMode = folderHomeListMode(filters.query, searchInThisFolder);
  const acrossFolderSearch = listMode === "across-search";
  const folderTree = useMemo(() => buildFolderTree(folders), [folders]);
  const visibleFolderTree = useMemo(
    () => filterFolderTreeByName(folderTree, railFilter),
    [folderTree, railFilter],
  );
  const visibleExpandedIds = useMemo(
    () => [
      ...new Set([
        ...expandedIds,
        ...ancestorIdsForSelection(folders, selection),
        ...(railFilter.trim()
          ? folderIdsToExpandForFilter(visibleFolderTree)
          : []),
      ]),
    ],
    [expandedIds, folders, railFilter, selection, visibleFolderTree],
  );
  const folderNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const folder of folders) {
      const path = breadcrumbSegments(folders, { kind: "folder", id: folder.id })
        .map((item) => item.label)
        .join(" / ");
      names.set(folder.id, path);
    }
    return names;
  }, [folders]);
  const crumbs = useMemo(
    () => breadcrumbSegments(folders, selection),
    [folders, selection],
  );

  const displayRecords = acrossFolderSearch
    ? (workspaceWorkflows ?? records)
    : records;
  const items = useMemo(
    () =>
      buildWorkflowHomeItems(displayRecords, {
        environment,
        drafts,
        executions,
        approvals,
        lastRunKnownIds,
        activations,
        folderNames,
      }),
    [
      displayRecords,
      environment,
      drafts,
      executions,
      approvals,
      lastRunKnownIds,
      activations,
      folderNames,
    ],
  );
  const visible = useMemo(() => {
    const named = items.filter((item) =>
      matchesWorkflowNameOrSlug(item, filters.query),
    );
    const scoped = searchInThisFolder
      ? constrainItemsToFolderSelection(named, selection)
      : named;
    return sortWorkflowHomeItems(
      filterWorkflowHomeItems(scoped, { ...filters, query: "" }),
    );
  }, [items, filters, searchInThisFolder, selection]);
  const workspaceWorkflowCount = workspaceWorkflows?.length ?? records.length;
  const emptyKind = folderHomeEmptyKind({
    selection,
    folderCount: folders.length,
    scopedRecordCount: acrossFolderSearch
      ? (workspaceWorkflows?.length ?? 0)
      : records.length,
    visibleCount: visible.length,
    workspaceWorkflowCount,
  });
  const unfiledShowsHomeVerbs = unfiledEmptyUsesHomeVerbs(workspaceWorkflowCount);
  const selectedChildFolderCount =
    selection.kind === "folder" ? childFolderCount(folders, selection.id) : 0;
  const folderEmptyDeleteAllowed =
    selection.kind === "folder" &&
    emptyFolderDeleteAllowed({
      childFolderCount: selectedChildFolderCount,
      workflowCount: records.length,
    });
  const moveIntoCandidates = useMemo(
    () =>
      workflowsMovableIntoSelection(workspaceWorkflows ?? [], selection),
    [workspaceWorkflows, selection],
  );
  const options = useMemo(() => uniqueFilterValues(items), [items]);
  const resolvedStartId =
    startWorkflowId === "1"
      ? (items.find((item) => item.latestVersionId)?.id ?? "")
      : startWorkflowId;
  const startItem = useMemo(() => {
    if (!resolvedStartId) {
      return null;
    }
    return (
      items.find((item) => item.id === resolvedStartId) ?? {
        id: resolvedStartId,
        name: undefined,
      }
    );
  }, [items, resolvedStartId]);
  const resolvedWebhookId =
    webhookWorkflowId === "1"
      ? (items[0]?.id ?? "")
      : webhookWorkflowId;
  const webhookItem = useMemo(() => {
    if (!resolvedWebhookId) {
      return null;
    }
    return (
      items.find((item) => item.id === resolvedWebhookId) ?? {
        id: resolvedWebhookId,
        name: undefined,
      }
    );
  }, [items, resolvedWebhookId]);
  const resolvedScheduleId =
    scheduleWorkflowId === "1"
      ? (items[0]?.id ?? "")
      : scheduleWorkflowId;
  const scheduleItem = useMemo(() => {
    if (!resolvedScheduleId) {
      return null;
    }
    return (
      items.find((item) => item.id === resolvedScheduleId) ?? {
        id: resolvedScheduleId,
        name: undefined,
      }
    );
  }, [items, resolvedScheduleId]);

  const replaceFolderQuery = useCallback(
    (next: FolderSelection, options: { drop?: boolean } = {}) => {
      const query = applyFolderQuery(searchParams.toString(), next, options);
      const current = searchParams.toString();
      const nextSearch = query.startsWith("?") ? query.slice(1) : query;
      if (current === nextSearch) {
        return;
      }
      router.replace(`${pathname}${query}`, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const selectFolder = useCallback(
    (next: FolderSelection) => {
      setDropPreviousFolder(false);
      replaceFolderQuery(next);
    },
    [replaceFolderQuery],
  );

  const refresh = useCallback(async (selectionOverride?: FolderSelection) => {
    const token = refreshGate.current.begin();
    if (!canView) {
      setFolders([]);
      if (ready) {
        setFoldersReady(true);
      }
      setRecords([]);
      setWorkspaceWorkflows(null);
      setDrafts(new Map());
      setExecutions([]);
      setLastRunKnownIds(new Set());
      setApprovals([]);
      setActivations(new Map());
      setPending(null);
      return;
    }
    setPending("list");
    setProblem(null);
    const folderList = await listWorkflowFolders(identity);
    if (!refreshGate.current.isCurrent(token)) {
      return;
    }
    if (!folderList.ok) {
      setFolders([]);
      setFoldersReady(true);
      setProblem(folderList.problem);
    } else {
      setFolders(folderList.items);
      setFoldersReady(true);
    }
    const intended = selectionOverride ?? intendedSelection;
    const resolved = resolveFolderSelection(
      intended,
      folderList.ok ? folderList.items : [],
    );
    if (
      shouldRewriteFolderDeepLink({
        intended,
        resolved,
        folderListOk: folderList.ok,
      })
    ) {
      replaceFolderQuery(resolved, {
        drop: resolved.kind === "unfiled",
      });
    }
    const listSelection = folderList.ok ? resolved : intended;
    let list = await listWorkflows(identity, {
      folderId: selectedFolderListFolderId(listSelection),
    });
    if (!refreshGate.current.isCurrent(token)) {
      return;
    }
    if (!list.ok && list.statusCode === 404 && resolved.kind === "folder") {
      replaceFolderQuery({ kind: "unfiled" }, { drop: true });
      list = await listWorkflows(identity, { folderId: "unfiled" });
      if (!refreshGate.current.isCurrent(token)) {
        return;
      }
    }
    if (!list.ok) {
      setPending(null);
      setWorkspaceWorkflows(null);
      setProblem(list.problem);
      return;
    }
    setRecords(list.items);
    const all = await listWorkflows(identity);
    if (!refreshGate.current.isCurrent(token)) {
      return;
    }
    setWorkspaceWorkflows(all.ok ? all.items : []);
    const draftEntries = await Promise.all(
      list.items.map(async (item) => {
        const draft = await getWorkflowDraft(identity, item.id);
        return [item.id, draft.ok ? draft.draft : null] as const;
      }),
    );
    if (!refreshGate.current.isCurrent(token)) {
      return;
    }
    const nextDrafts = new Map<string, WorkflowDraft>();
    for (const [id, draft] of draftEntries) {
      if (draft) {
        nextDrafts.set(id, draft);
      }
    }
    setDrafts(nextDrafts);
    if (canSeeExecutionsNav(permissions ?? [])) {
      const runEntries = await Promise.all(
        list.items.map(async (item) => {
          const runs = await listWorkflowExecutions(identity, item.id, {
            limit: 1,
          });
          return [item.id, runs.ok ? runs.items : null] as const;
        }),
      );
      if (!refreshGate.current.isCurrent(token)) {
        return;
      }
      const nextRuns: ExecutionRecord[] = [];
      const known = new Set<string>();
      for (const [id, items] of runEntries) {
        if (!items) {
          continue;
        }
        known.add(id);
        nextRuns.push(...items);
      }
      setExecutions(nextRuns);
      setLastRunKnownIds(known);
    } else {
      setExecutions([]);
      setLastRunKnownIds(new Set());
    }
    if (canSeeApprovalsNav(permissions ?? [])) {
      const inbox = await listApprovals(identity, { status: "pending" });
      if (!refreshGate.current.isCurrent(token)) {
        return;
      }
      if (inbox.ok) {
        setApprovals(inbox.items);
      }
    } else {
      setApprovals([]);
    }
    if (canViewActivation) {
      const nextActivations = await loadHomeActivationStates(
        identity,
        list.items,
        { canView: canViewActivation },
      );
      if (!refreshGate.current.isCurrent(token)) {
        return;
      }
      setActivations(nextActivations);
    } else {
      setActivations(new Map());
    }
    if (refreshGate.current.isCurrent(token)) {
      setPending(null);
    }
  }, [
    canView,
    canViewActivation,
    identity,
    intendedSelection,
    permissions,
    ready,
    replaceFolderQuery,
  ]);

  const selectedWorkflowCount =
    selection.kind === "folder" ? records.length : null;

  function openCreateFolder() {
    if (!canMutateFolders) {
      return;
    }
    setFolderDialog({ kind: "create" });
    setFolderNameDraft("");
    setFolderNameError(null);
    setProblem(null);
  }

  function openRenameFolder(folderId: string) {
    if (!canMutateFolders) {
      return;
    }
    const current = folders.find((item) => item.id === folderId);
    if (!current) {
      return;
    }
    setFolderDialog({ kind: "rename", id: folderId });
    setFolderNameDraft(current.name);
    setFolderNameError(null);
    setProblem(null);
  }

  function closeFolderDialog() {
    setFolderDialog(null);
    setFolderNameDraft("");
    setFolderNameError(null);
  }

  async function submitFolderDialog() {
    if (!canMutateFolders || !folderDialog) {
      return;
    }
    const parentId =
      folderDialog.kind === "create"
        ? createFolderParentId(selection)
        : (folders.find((item) => item.id === folderDialog.id)?.parentId ??
          null);
    const nameError = folderNameSubmitError(
      folders,
      folderNameDraft,
      parentId,
      folderDialog.kind === "rename" ? folderDialog.id : undefined,
    );
    if (nameError) {
      setFolderNameError(nameError);
      return;
    }
    const name = folderNameDraft.trim();
    const gesture = folderDialog.kind === "create" ? "create" : "rename";
    setFolderChrome(folderMutateBegin(gesture));
    setPending(gesture === "create" ? "folder-create" : "folder-rename");
    setProblem(null);
    const result =
      folderDialog.kind === "create"
        ? await createWorkflowFolder(identity, {
            name,
            parentId,
          })
        : await renameWorkflowFolder(identity, folderDialog.id, name);
    if (!result.ok) {
      setPending(null);
      setFolderChrome(folderMutateFinish(gesture, false));
      setFolderNameError(result.problem.detail || nameError);
      setProblem(result.problem);
      return;
    }
    closeFolderDialog();
    if (result.folder && folderDialog.kind === "create") {
      const created = result.folder;
      const parentId = created.parentId;
      if (parentId) {
        setExpandedIds((current) => {
          const next = current.includes(parentId)
            ? current
            : [...current, parentId];
          writeExpandedFolderIds(workspaceKey, next);
          return next;
        });
      }
      selectFolder({ kind: "folder", id: created.id });
      await refresh({ kind: "folder", id: created.id });
    } else {
      await refresh();
    }
    setFolderChrome(folderMutateFinish(gesture, true));
    setPending(null);
  }

  async function removeFolder(folderId: string) {
    if (!canMutateFolders || !folderAllowsRenameOrDelete({ kind: "folder", id: folderId })) {
      return;
    }
    const next = selectionAfterFolderDelete(folderId, folders, selection);
    setFolderChrome(folderMutateBegin("delete"));
    setPending("folder-delete");
    setProblem(null);
    const result = await deleteWorkflowFolder(identity, folderId);
    if (!result.ok) {
      setPending(null);
      setFolderChrome(folderMutateFinish("delete", false));
      const detail = result.notEmpty
        ? folderNotEmptyDetail(result.notEmpty)
        : result.problem.detail;
      setProblem({
        ...result.problem,
        detail,
      });
      return;
    }
    selectFolder(next);
    await refresh(next);
    setFolderChrome(folderMutateFinish("delete", true));
    setPending(null);
  }

  function closeMoveDialog() {
    setMoveDialog(null);
    setMoveTarget({ kind: "unfiled" });
  }

  function openMoveIntoFolder() {
    if (!canMutateFolders || selection.kind !== "folder") {
      return;
    }
    const first = moveIntoCandidates[0];
    setMoveIntoWorkflowId(first?.id ?? "");
    setMoveIntoOpen(true);
  }

  function closeMoveIntoFolder() {
    setMoveIntoOpen(false);
    setMoveIntoWorkflowId("");
  }

  async function submitMoveIntoFolder() {
    if (!moveIntoWorkflowId) {
      return;
    }
    await moveItem(moveIntoWorkflowId, selection);
    closeMoveIntoFolder();
  }

  function openMoveDialog(item: WorkflowHomeItem) {
    if (!canMutateFolders) {
      return;
    }
    setMoveDialog({
      id: item.id,
      name: item.name,
      folderId: item.folderId,
    });
    setMoveTarget(defaultWorkflowMoveTarget(item.folderId, folders));
    setProblem(null);
  }

  async function moveItem(workflowId: string, target: FolderSelection) {
    if (!canMutateFolders) {
      return;
    }
    const current =
      items.find((item) => item.id === workflowId)?.folderId ??
      workspaceWorkflows?.find((item) => item.id === workflowId)?.folderId ??
      (moveDialog?.id === workflowId ? moveDialog.folderId : undefined);
    if (workflowAlreadyInFolder(current, target)) {
      return;
    }
    setFolderChrome(folderMutateBegin("move"));
    setPending("workflow-move");
    setProblem(null);
    const result = await moveWorkflowToFolder(
      identity,
      workflowId,
      folderIdForMove(target),
    );
    if (!result.ok) {
      setPending(null);
      setFolderChrome(folderMutateFinish("move", false));
      setProblem(result.problem);
      return;
    }
    closeMoveDialog();
    await refresh();
    setFolderChrome(folderMutateFinish("move", true));
    setPending(null);
  }

  async function submitMoveDialog() {
    if (!moveDialog) {
      return;
    }
    await moveItem(moveDialog.id, moveTarget);
  }

  useEffect(() => {
    if (
      !shouldDropFolderQueryOnWorkspaceMemory(folderParam, dropPreviousFolder)
    ) {
      return;
    }
    replaceFolderQuery({ kind: "unfiled" }, { drop: true });
  }, [dropPreviousFolder, folderParam, replaceFolderQuery]);

  useEffect(() => {
    const gate = refreshGate.current;
    const timer = window.setTimeout(() => {
      void refresh();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      gate.begin();
    };
  }, [refresh]);

  useEffect(() => {
    function onActivationChanged() {
      void refresh();
    }
    window.addEventListener(EDITOR_ACTIVATION_CHANGED_EVENT, onActivationChanged);
    return () => {
      window.removeEventListener(
        EDITOR_ACTIVATION_CHANGED_EVENT,
        onActivationChanged,
      );
    };
  }, [refresh]);

  const createFromYaml = useCallback(
    async (yaml: string, name?: string, slug?: string) => {
      if (!canCreate) {
        return;
      }
      setPending("create");
      setProblem(null);
      const result = await createWorkflow(identity, {
        definitionYaml: yaml,
        ...optionalCreateFields(slug ?? createSlug, name ?? createName),
        ...(selection.kind === "folder" ? { folderId: selection.id } : {}),
      });
      setPending(null);
      if (!result.ok) {
        setProblem(result.problem);
        return;
      }
      const created = result.workflow;
      pushNotification({
        kind: "info",
        title: "Draft created",
        detail: created?.name || "Editable draft ready",
        href: templateCreatedEditorHref(created?.id),
      });
      if (created) {
        router.push(templateCreatedEditorHref(created.id));
      }
    },
    [canCreate, identity, createSlug, createName, router, selection],
  );

  useEffect(() => {
    return subscribeWorkspaceCommands((name) => {
      if (name === "new-workflow") {
        const blank = workflowTemplateById("blank");
        if (blank) {
          void createFromYaml(blank.definitionYaml, createName || blank.name, createSlug);
        }
      }
      if (name === "import-yaml") {
        importRef.current?.click();
      }
    });
  }, [createFromYaml, createName, createSlug]);

  useEffect(() => {
    if (consumedQuery.current) {
      return;
    }
    const shouldCreate = searchParams.get("create") === "1";
    const shouldImport = searchParams.get("import") === "1";
    const startParam = searchParams.get(MANUAL_START_QUERY);
    const webhookParam = searchParams.get(WEBHOOK_TRIGGER_QUERY);
    const scheduleParam = searchParams.get(SCHEDULE_TRIGGER_QUERY);
    if (
      !shouldCreate &&
      !shouldImport &&
      !startParam &&
      !webhookParam &&
      !scheduleParam
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      if (consumedQuery.current) {
        return;
      }
      if (shouldCreate) {
        consumedQuery.current = true;
        const blank = workflowTemplateById("blank");
        if (blank) {
          void createFromYaml(
            blank.definitionYaml,
            createName || blank.name,
            createSlug,
          );
        }
      }
      if (shouldImport) {
        consumedQuery.current = true;
        importRef.current?.click();
      }
      if (startParam) {
        consumedQuery.current = true;
        lastHomeOverlay.current = { kind: "start", id: startParam };
        setStartWorkflowId(startParam);
      }
      if (webhookParam) {
        consumedQuery.current = true;
        lastHomeOverlay.current = { kind: "webhooks", id: webhookParam };
        setWebhookWorkflowId(webhookParam);
      }
      if (scheduleParam) {
        consumedQuery.current = true;
        lastHomeOverlay.current = { kind: "schedules", id: scheduleParam };
        setScheduleWorkflowId(scheduleParam);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [searchParams, createFromYaml, createName, createSlug]);

  function openHomeOverlay(kind: HomeSatelliteOverlayId, workflowId: string) {
    lastHomeOverlay.current = { kind, id: workflowId };
    if (kind === "start") {
      setStartWorkflowId(workflowId);
      return;
    }
    if (kind === "webhooks") {
      setWebhookWorkflowId(workflowId);
      return;
    }
    setScheduleWorkflowId(workflowId);
  }

  useEffect(() => {
    const open =
      Boolean(startWorkflowId) ||
      Boolean(webhookWorkflowId) ||
      Boolean(scheduleWorkflowId);
    if (!open) {
      return;
    }
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      const last = lastHomeOverlay.current;
      const kind: HomeSatelliteOverlayId | null =
        last?.kind ??
        (scheduleWorkflowId
          ? "schedules"
          : webhookWorkflowId
            ? "webhooks"
            : startWorkflowId
              ? "start"
              : null);
      if (!kind) {
        return;
      }
      event.preventDefault();
      const id =
        last?.id ??
        (kind === "start"
          ? startWorkflowId
          : kind === "webhooks"
            ? webhookWorkflowId
            : scheduleWorkflowId);
      const next = satelliteOverlayAfterEscape();
      if (kind === "start") {
        setStartWorkflowId("");
      } else if (kind === "webhooks") {
        setWebhookWorkflowId("");
      } else {
        setScheduleWorkflowId("");
      }
      if (next.restoreFocus) {
        restoreSatelliteOverlayFocus(homeSatelliteOverlayTriggerId(kind, id));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scheduleWorkflowId, startWorkflowId, webhookWorkflowId]);

  async function createFromTemplate(template: WorkflowTemplate) {
    await createFromYaml(template.definitionYaml, template.name, template.slugHint);
  }

  function importFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      if (!text.trim()) {
        return;
      }
      void (async () => {
        if (!canCreate) {
          return;
        }
        setPending("import");
        setProblem(null);
        const result = await importValidatedWorkflow(identity, text, {
          ...optionalCreateFields(createSlug, createName || file.name.replace(/\.ya?ml$/i, "")),
          ...(selection.kind === "folder" ? { folderId: selection.id } : {}),
        });
        setPending(null);
        if (!result.ok) {
          setProblem(result.problem);
          return;
        }
        const created = result.workflow;
        pushNotification({
          kind: "info",
          title: "Draft imported",
          detail: created?.name || "Validated YAML created a draft",
          href: templateCreatedEditorHref(created?.id),
        });
        if (created) {
          router.push(templateCreatedEditorHref(created.id));
        }
      })();
    };
    reader.readAsText(file);
  }

  async function duplicateItem(item: WorkflowHomeItem) {
    const draft = drafts.get(item.id);
    if (!draft) {
      setProblem({
        type: "urn:flowforge:problem:invalid-request",
        title: "Cannot duplicate",
        status: 400,
        detail: "Draft YAML is not available for this workflow.",
        instance: `/workflows/${item.id}`,
        code: "invalid-request",
        request_id: "",
      });
      return;
    }
    await createFromYaml(
      draft.definitionYaml,
      duplicateWorkflowName(item.name),
      `${item.slug}-copy`,
    );
  }

  async function testRunItem(item: WorkflowHomeItem) {
    const gate = canOfferHomeTestRun({
      draftRevision: item.draftRevision,
      permissions,
    });
    if (!gate.ok) {
      setProblem({
        type: "urn:flowforge:problem:invalid-request",
        title: "Cannot test-run",
        status: gate.reason === "forbidden" ? 403 : 400,
        detail: gate.help,
        instance: `/workflows/${item.id}`,
        code: gate.reason === "forbidden" ? "forbidden" : "invalid-request",
        request_id: "local-home-test-run-16",
      });
      return;
    }
    setPending("test-run");
    setProblem(null);
    // D5 hard line: last saved draftRevision only — not editor YAML.
    // Same compose as editor: identical digest starts latest published.
    const result = await runPublishedTestVersion(identity, {
      workflowId: item.id,
      revision: item.draftRevision,
      dirty: false,
      permissions,
      ...testRunVersionHints({
        draftDigest: item.draftDigest,
        latestVersionDigest: item.latestVersionDigest,
        latestVersionId: item.latestVersionId,
      }),
    });
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    rememberPeakEndOverlay({
      workflowId: item.id,
      executionId: result.execution.id,
    });
    pushNotification({
      kind: "execution",
      title: result.execution.replayed
        ? "Test run replayed"
        : "Test run started",
      detail: `Published test v${result.version.versionNumber} · ${result.execution.status}`,
      href: `/executions/${result.execution.id}`,
    });
    router.push(workflowEditorHref(item.id));
  }

  async function exportItem(item: WorkflowHomeItem) {
    if (!item.latestVersionId) {
      return;
    }
    setPending("export");
    const result = await exportWorkflowVersion(
      identity,
      item.id,
      item.latestVersionId,
    );
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    const blob = new Blob([result.exported.definitionYaml], {
      type: "application/yaml",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = result.exported.filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  if (denied) {
    return (
      <p className="rounded-xl border border-zinc-200 bg-white p-4 text-sm text-zinc-600">
        Workflows are hidden. This workspace role does not include{" "}
        <code className="font-mono text-xs">workflow.view</code>.
      </p>
    );
  }

  function toggleFolderExpanded(folderId: string) {
    setExpandedIds((current) => {
      const next = current.includes(folderId)
        ? current.filter((id) => id !== folderId)
        : [...current, folderId];
      writeExpandedFolderIds(workspaceKey, next);
      return next;
    });
  }

  return (
    <div
      data-uxl8="home"
      data-f7={embed ? "embed-home" : "standalone-home"}
      data-f7-tree="api"
      className="space-y-6"
    >
      {!ready ? (
        <SessionSetupHint purpose="before listing workflows." />
      ) : null}
      {problem ? <ProblemBanner problem={problem} /> : null}

      <div className="grid gap-4 max-md:grid-cols-1 md:grid-cols-[16rem_minmax(0,1fr)]">
      <FolderRail
        tree={visibleFolderTree}
        folders={folders}
        selection={selection}
        expandedIds={visibleExpandedIds}
        canMutate={canMutateFolders}
        pending={pending !== null}
        selectedWorkflowCount={selectedWorkflowCount}
        dialog={folderDialog}
        nameDraft={folderNameDraft}
        nameError={folderNameError}
        chrome={folderChrome}
        dragging={dragging}
        railFilter={railFilter}
        onRailFilter={setRailFilter}
        onSelect={selectFolder}
        onToggle={toggleFolderExpanded}
        onNameDraft={setFolderNameDraft}
        onCreate={openCreateFolder}
        onRename={openRenameFolder}
        onDelete={(folderId) => void removeFolder(folderId)}
        onSubmit={() => void submitFolderDialog()}
        onCancel={closeFolderDialog}
        onDropWorkflow={(workflowId, target) => void moveItem(workflowId, target)}
      />
      <div className="min-w-0 space-y-6">
      <FolderBreadcrumb crumbs={crumbs} onSelect={selectFolder} />
      {canMutateFolders && moveIntoOpen && selection.kind === "folder" ? (
        <form
          data-f5="folder-empty-move"
          data-home-folder-empty-move-dialog=""
          className="space-y-3 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm"
          onSubmit={(event) => {
            event.preventDefault();
            void submitMoveIntoFolder();
          }}
        >
          <p className="text-sm text-zinc-700">
            Move an existing workflow into this folder. This does not change
            YAML, draft revision, or activation.
          </p>
          {moveIntoCandidates.length === 0 ? (
            <p className="text-sm text-zinc-600">
              No workflows are available to move. Create a draft here or use
              the folder rail.
            </p>
          ) : (
            <label className="block text-sm">
              <span className="text-zinc-600">Workflow</span>
              <select
                data-home-folder-empty-move-target=""
                value={moveIntoWorkflowId}
                onChange={(event) => setMoveIntoWorkflowId(event.target.value)}
                className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-1.5 text-sm"
              >
                {moveIntoCandidates.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name || item.slug}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={pending !== null || !moveIntoWorkflowId}
              className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
            >
              {FOLDER_EMPTY_MOVE_LABEL}
            </button>
            <button
              type="button"
              disabled={pending !== null}
              onClick={closeMoveIntoFolder}
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-800 hover:bg-zinc-50 disabled:opacity-60"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {canMutateFolders && moveDialog ? (
        <form
          data-home-workflow-move-dialog=""
          className="space-y-3 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm"
          onSubmit={(event) => {
            event.preventDefault();
            void submitMoveDialog();
          }}
        >
          <p className="text-sm text-zinc-700">
            Move <span className="font-medium text-zinc-900">{moveDialog.name}</span>{" "}
            to a folder in this workspace. This does not change YAML, draft
            revision, or activation.
          </p>
          <label className="block text-sm">
            <span className="text-zinc-600">Destination</span>
            <select
              data-home-workflow-move-target=""
              value={folderQueryValue(moveTarget)}
              onChange={(event) =>
                setMoveTarget(parseFolderQuery(event.target.value))
              }
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-1.5 text-sm"
            >
              {workflowMoveTargets(folders).map((option) => (
                <option
                  key={folderQueryValue(option.selection)}
                  value={folderQueryValue(option.selection)}
                >
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={
                pending !== null ||
                workflowAlreadyInFolder(moveDialog.folderId, moveTarget)
              }
              className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
            >
              {FOLDER_MOVE_VERB}
            </button>
            <button
              type="button"
              disabled={pending !== null}
              onClick={closeMoveDialog}
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-800 hover:bg-zinc-50 disabled:opacity-60"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Workflow home</h2>
            <p className="mt-1 text-sm text-zinc-600" data-f6="search-help">
              {FOLDER_SEARCH_HELP} Folder membership is not in YAML.
            </p>
            <p
              id={HOME_ACTIVATION_HEADING_ID}
              className="mt-2 text-sm text-zinc-600"
              data-r6-d2={HOME_ACTIVATION.d2ComposeEnablePlusVersionPin}
            >
              {HOME_ACTIVATION_HELP}
            </p>
            <p
              className="mt-2 text-sm text-zinc-600"
              data-home-working-memory="test-run"
            >
              {EDITOR_WORKING_MEMORY_TEST_RUN} {TEST_RUN_HELP}
            </p>
            <p className="mt-2 text-sm text-zinc-600" data-home-row-scan="help">
              {HOME_ROW_SCAN_HELP}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={pending !== null}
              className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-60"
            >
              {pending === "list" ? "Loading…" : "Refresh"}
            </button>
            <div role="group" aria-label="Workflow home view" className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setView("list")}
              aria-pressed={view === "list"}
              className={
                view === "list"
                  ? "rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm text-white"
                  : "rounded-lg border border-zinc-300 px-3 py-1.5 text-sm"
              }
            >
              List
            </button>
            <button
              type="button"
              onClick={() => setView("card")}
              aria-pressed={view === "card"}
              className={
                view === "card"
                  ? "rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm text-white"
                  : "rounded-lg border border-zinc-300 px-3 py-1.5 text-sm"
              }
            >
              Cards
            </button>
            </div>
          </div>
        </div>

        <div
          className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
          data-f6="search"
          data-home-folder-search={
            searchInThisFolder ? "folder" : "across"
          }
        >
          <div className="space-y-2">
            <FilterInput
              label={FOLDER_SEARCH_ACROSS_LABEL}
              value={filters.query}
              onChange={(value) =>
                setFilters((current) => ({ ...current, query: value }))
              }
            />
            <label className="flex items-center gap-2 text-sm text-zinc-700">
              <input
                type="checkbox"
                checked={searchInThisFolder}
                data-home-folder-search-scope="in-folder"
                onChange={(event) => setSearchInThisFolder(event.target.checked)}
              />
              {FOLDER_SEARCH_IN_FOLDER_LABEL}
            </label>
          </div>
          <FilterSelect
            label="Tag"
            value={filters.tag}
            options={options.tags}
            onChange={(value) => setFilters((current) => ({ ...current, tag: value }))}
          />
          <FilterSelect
            label="Owner"
            value={filters.owner}
            options={options.owners}
            onChange={(value) => setFilters((current) => ({ ...current, owner: value }))}
          />
          <FilterSelect
            label="Trigger"
            value={filters.trigger}
            options={options.triggers}
            onChange={(value) => setFilters((current) => ({ ...current, trigger: value }))}
          />
          <FilterSelect
            label="Environment"
            value={filters.environment}
            options={options.environments}
            onChange={(value) =>
              setFilters((current) => ({ ...current, environment: value }))
            }
          />
          <FilterSelect
            label="Status"
            value={filters.status}
            options={options.statuses}
            onChange={(value) => setFilters((current) => ({ ...current, status: value }))}
          />
          <label className="block text-sm">
            <span className="text-zinc-600">Activation</span>
            <select
              value={filters.activation}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  activation: event.target.value as HomeActivationFilter,
                }))
              }
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-1.5 text-sm"
            >
              {HOME_ACTIVATION_FILTERS.map((option) => (
                <option key={option.value || "any"} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-zinc-600">Last run</span>
            <select
              value={filters.lastRun}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  lastRun: event.target.value as WorkflowHomeFilters["lastRun"],
                }))
              }
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-1.5 text-sm"
            >
              <option value="">Any</option>
              <option value="never">Never</option>
              <option value="running">Running / queued</option>
              <option value="waiting">Waiting</option>
              <option value="indeterminate">Indeterminate</option>
              <option value="succeeded">Succeeded</option>
              <option value="failed">Failed</option>
              <option value="24h">Last 24 hours</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-zinc-600">Last modified</span>
            <select
              value={filters.lastModified}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  lastModified: event.target.value as WorkflowHomeFilters["lastModified"],
                }))
              }
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-1.5 text-sm"
            >
              <option value="">Any</option>
              <option value="24h">Last 24 hours</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
            </select>
          </label>
        </div>

        {canCreate ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto]">
            <FilterInput
              label="Name (optional)"
              value={createName}
              onChange={setCreateName}
            />
            <FilterInput
              label="Slug (optional)"
              value={createSlug}
              onChange={setCreateSlug}
            />
            <div className="flex items-end">
              <button
                type="button"
                disabled={pending !== null}
                onClick={() => {
                  const blank = workflowTemplateById("blank");
                  if (blank) {
                    void createFromYaml(blank.definitionYaml);
                  }
                }}
                className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
              >
                Create workflow
              </button>
            </div>
            <div className="flex items-end">
              <label className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50">
                Import YAML
                <input
                  ref={importRef}
                  type="file"
                  accept=".yaml,.yml,text/yaml,application/yaml,text/plain"
                  className="sr-only"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) {
                      importFile(file);
                    }
                    event.target.value = "";
                  }}
                />
              </label>
            </div>
          </div>
        ) : null}
      </section>

      {startItem ? (
        <ManualStartPanel
          identity={identity}
          workflowId={startItem.id}
          workflowName={startItem.name}
          permissions={permissions}
          onClose={() => setStartWorkflowId("")}
          onStarted={(execution) => {
            rememberPeakEndOverlay({
              workflowId: startItem.id,
              executionId: execution.id,
            });
            router.push(workflowEditorHref(startItem.id));
          }}
        />
      ) : null}

      {webhookItem && canViewWebhooks ? (
        <WebhookTriggerPanel
          identity={identity}
          workflowId={webhookItem.id}
          workflowName={webhookItem.name}
          permissions={permissions}
          onClose={() => setWebhookWorkflowId("")}
        />
      ) : null}

      {scheduleItem && canViewSchedules ? (
        <ScheduleTriggerPanel
          identity={identity}
          workflowId={scheduleItem.id}
          workflowName={scheduleItem.name}
          permissions={permissions}
          onClose={() => setScheduleWorkflowId("")}
        />
      ) : null}

      {emptyKind === "teach" ||
      (emptyKind === "unfiled" && unfiledShowsHomeVerbs) ? (
        <>
          <HomeEmptyTeach
            canCreate={canCreate}
            canCreateFolder={canMutateFolders}
            pending={pending !== null}
            unfiledEmpty={emptyKind === "unfiled"}
            onCreate={() => {
              const blank = workflowTemplateById("blank");
              if (blank) {
                void createFromYaml(blank.definitionYaml);
              }
            }}
            onImport={() => importRef.current?.click()}
            onNewFolder={openCreateFolder}
          />
          <TemplateGrid
            canCreate={canCreate}
            pending={pending !== null}
            onSelect={(template) => void createFromTemplate(template)}
          />
        </>
      ) : emptyKind === "unfiled" ? (
        <UnfiledEmptyFiled
          folders={folders}
          onSelectFolder={selectFolder}
        />
      ) : emptyKind === "folder" ? (
        <FolderEmpty
          canCreate={canCreate}
          canMutate={canMutateFolders}
          pending={pending !== null}
          deleteAllowed={folderEmptyDeleteAllowed}
          moveAvailable={moveIntoCandidates.length > 0}
          onCreate={() => {
            const blank = workflowTemplateById("blank");
            if (blank) {
              void createFromYaml(blank.definitionYaml);
            }
          }}
          onImport={() => importRef.current?.click()}
          onMove={openMoveIntoFolder}
          onDelete={() => {
            if (selection.kind === "folder") {
              void removeFolder(selection.id);
            }
          }}
        />
      ) : emptyKind === "filtered" ? (
        <HomeFilteredEmpty
          onClear={() => {
            setFilters(EMPTY_WORKFLOW_HOME_FILTERS);
            setSearchInThisFolder(false);
          }}
        />
      ) : view === "list" ? (
        <WorkflowHomeList
          items={visible}
          pending={pending !== null}
          canCreate={canCreate}
          canMove={canMutateFolders}
          canExecute={canExecute}
          canPublish={canPublish}
          canViewWebhooks={canViewWebhooks}
          canViewSchedules={canViewSchedules}
          canSeeLastRun={canSeeLastRun}
          onStart={(item) => openHomeOverlay("start", item.id)}
          onTestRun={(item) => void testRunItem(item)}
          onWebhooks={(item) => openHomeOverlay("webhooks", item.id)}
          onSchedules={(item) => openHomeOverlay("schedules", item.id)}
          onDuplicate={(item) => void duplicateItem(item)}
          onExport={(item) => void exportItem(item)}
          onMove={openMoveDialog}
          onRevealFolder={(item) =>
            selectFolder(selectionForWorkflowFolder(item.folderId))
          }
          onDragStart={setDragging}
          onDragEnd={() => setDragging(null)}
        />
      ) : (
        <WorkflowHomeCards
          items={visible}
          pending={pending !== null}
          canCreate={canCreate}
          canMove={canMutateFolders}
          canExecute={canExecute}
          canPublish={canPublish}
          canViewWebhooks={canViewWebhooks}
          canViewSchedules={canViewSchedules}
          canSeeLastRun={canSeeLastRun}
          onStart={(item) => openHomeOverlay("start", item.id)}
          onTestRun={(item) => void testRunItem(item)}
          onWebhooks={(item) => openHomeOverlay("webhooks", item.id)}
          onSchedules={(item) => openHomeOverlay("schedules", item.id)}
          onDuplicate={(item) => void duplicateItem(item)}
          onExport={(item) => void exportItem(item)}
          onMove={openMoveDialog}
          onRevealFolder={(item) =>
            selectFolder(selectionForWorkflowFolder(item.folderId))
          }
          onDragStart={setDragging}
          onDragEnd={() => setDragging(null)}
        />
      )}
      </div>
      </div>
    </div>
  );
}

function folderDropHandlers(
  canMutate: boolean,
  target: FolderSelection,
  dragging: WorkflowMoveDragPayload | null,
  onDropWorkflow: (workflowId: string, target: FolderSelection) => void,
) {
  if (!canMutate) {
    return {};
  }
  const accepts =
    dragging != null &&
    canDropWorkflowOnFolder(true, dragging.folderId, target);
  return {
    "data-home-folder-drop":
      target.kind === "unfiled" ? "unfiled" : "folder",
    "data-home-folder-drop-active": accepts ? "true" : undefined,
    onDragOver: (event: DragEvent) => {
      if (!canDropWorkflowOnFolder(true, dragging?.folderId, target)) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    },
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      const payload =
        parseWorkflowMoveDragPayload(
          event.dataTransfer.getData(WORKFLOW_MOVE_DRAG_TYPE) ||
            event.dataTransfer.getData("text/plain"),
        ) ?? dragging;
      if (!payload) {
        return;
      }
      if (!canDropWorkflowOnFolder(true, payload.folderId, target)) {
        return;
      }
      onDropWorkflow(payload.workflowId, target);
    },
  };
}

function FolderRail({
  tree,
  folders,
  selection,
  expandedIds,
  canMutate,
  pending,
  selectedWorkflowCount,
  dialog,
  nameDraft,
  nameError,
  chrome,
  dragging,
  railFilter,
  onRailFilter,
  onSelect,
  onToggle,
  onNameDraft,
  onCreate,
  onRename,
  onDelete,
  onSubmit,
  onCancel,
  onDropWorkflow,
}: {
  tree: FolderTreeNode[];
  folders: readonly WorkflowFolder[];
  selection: FolderSelection;
  expandedIds: readonly string[];
  canMutate: boolean;
  pending: boolean;
  selectedWorkflowCount: number | null;
  dialog: { kind: "create" } | { kind: "rename"; id: string } | null;
  nameDraft: string;
  nameError: string | null;
  chrome: FolderMutateChrome;
  dragging: WorkflowMoveDragPayload | null;
  railFilter: string;
  onRailFilter: (value: string) => void;
  onSelect: (next: FolderSelection) => void;
  onToggle: (folderId: string) => void;
  onNameDraft: (value: string) => void;
  onCreate: () => void;
  onRename: (folderId: string) => void;
  onDelete: (folderId: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onDropWorkflow: (workflowId: string, target: FolderSelection) => void;
}) {
  const unfiledCurrent = selection.kind === "unfiled";
  const createParentId = createFolderParentId(selection);
  const canCreateHere = canCreateChildFolder(folders, createParentId);
  const mutateLabel = folderMutateLabel(chrome);
  return (
    <nav
      aria-label={FOLDER_RAIL_LABEL}
      data-home-folder-rail="nav"
      className="h-fit rounded-2xl border border-zinc-200 bg-white p-3 shadow-sm"
    >
      <div className="flex items-start justify-between gap-2 px-2">
        <p className="text-xs font-medium tracking-wide text-zinc-500 uppercase">
          {FOLDER_RAIL_LABEL}
        </p>
        {canMutate ? (
          <button
            type="button"
            data-home-folder-verb="new"
            disabled={pending || !canCreateHere}
            title={!canCreateHere ? FOLDER_DEPTH_HELP : undefined}
            onClick={onCreate}
            className="shrink-0 rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-800 hover:bg-zinc-50 disabled:opacity-60"
          >
            {NEW_FOLDER_LABEL}
          </button>
        ) : null}
      </div>
      {canMutate && mutateLabel ? (
        <p
          role={chrome.phase === "error" ? "alert" : "status"}
          data-home-folder-mutate={chrome.gesture ?? undefined}
          data-doherty-phase={chrome.phase}
          aria-busy={chrome.phase === "pending" ? true : undefined}
          className={`mt-2 px-2 ${dohertyStatusClassName(chrome.phase)}`}
        >
          {mutateLabel}
        </p>
      ) : null}
      {canMutate && dialog ? (
        <form
          data-home-folder-dialog={dialog.kind}
          className="mt-3 space-y-2 rounded-lg border border-zinc-200 bg-zinc-50 p-2"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <label className="block text-sm">
            <span className="text-zinc-600">
              {dialog.kind === "create" ? NEW_FOLDER_LABEL : RENAME_FOLDER_LABEL}
            </span>
            <input
              value={nameDraft}
              onChange={(event) => onNameDraft(event.target.value)}
              className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
              autoComplete="off"
              maxLength={256}
              aria-invalid={nameError ? true : undefined}
              aria-describedby={
                nameError ? "home-folder-name-error" : "home-folder-name-help"
              }
            />
          </label>
          <p id="home-folder-name-help" className="text-xs text-zinc-500">
            {dialog.kind === "create"
              ? createParentId
                ? "Creates a folder under the selection. Unfiled is not a parent."
                : "Creates a top-level folder."
              : FOLDER_NAME_RULES_HELP}
          </p>
          {nameError ? (
            <p
              id="home-folder-name-error"
              role="alert"
              data-home-folder-name-error=""
              className="text-xs text-rose-900"
            >
              {nameError}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={pending}
              className="rounded-md border border-teal-800 bg-teal-800 px-2 py-1 text-xs text-white hover:bg-teal-900 disabled:opacity-60"
            >
              {dialog.kind === "create" ? "Create" : "Save"}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={onCancel}
              className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-800 hover:bg-white disabled:opacity-60"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      <label className="mt-3 block px-2 text-sm">
        <span className="text-zinc-600">{FOLDER_RAIL_FILTER_LABEL}</span>
        <input
          value={railFilter}
          onChange={(event) => onRailFilter(event.target.value)}
          data-home-folder-rail-filter=""
          className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
          autoComplete="off"
        />
      </label>
      <ul className="mt-2 space-y-1">
        <li>
          <button
            type="button"
            data-home-folder-rail="unfiled"
            aria-current={unfiledCurrent ? "true" : undefined}
            onClick={() => onSelect({ kind: "unfiled" })}
            className={
              (unfiledCurrent
                ? "w-full rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-left text-sm text-white"
                : "w-full rounded-lg border border-transparent px-3 py-1.5 text-left text-sm text-zinc-800 hover:bg-zinc-50") +
              (canMutate &&
              dragging &&
              canDropWorkflowOnFolder(true, dragging.folderId, {
                kind: "unfiled",
              })
                ? " ring-2 ring-teal-600 ring-offset-1"
                : "")
            }
            {...folderDropHandlers(
              canMutate,
              { kind: "unfiled" },
              dragging,
              onDropWorkflow,
            )}
          >
            {UNFILED_FOLDER_LABEL}
          </button>
        </li>
        {tree.map((node) => (
          <FolderRailNode
            key={node.id}
            node={node}
            depth={1}
            folders={folders}
            selection={selection}
            expandedIds={expandedIds}
            canMutate={canMutate}
            pending={pending}
            selectedWorkflowCount={selectedWorkflowCount}
            dragging={dragging}
            onSelect={onSelect}
            onToggle={onToggle}
            onRename={onRename}
            onDelete={onDelete}
            onDropWorkflow={onDropWorkflow}
          />
        ))}
      </ul>
    </nav>
  );
}

function FolderRailNode({
  node,
  depth,
  folders,
  selection,
  expandedIds,
  canMutate,
  pending,
  selectedWorkflowCount,
  dragging,
  onSelect,
  onToggle,
  onRename,
  onDelete,
  onDropWorkflow,
}: {
  node: FolderTreeNode;
  depth: number;
  folders: readonly WorkflowFolder[];
  selection: FolderSelection;
  expandedIds: readonly string[];
  canMutate: boolean;
  pending: boolean;
  selectedWorkflowCount: number | null;
  dragging: WorkflowMoveDragPayload | null;
  onSelect: (next: FolderSelection) => void;
  onToggle: (folderId: string) => void;
  onRename: (folderId: string) => void;
  onDelete: (folderId: string) => void;
  onDropWorkflow: (workflowId: string, target: FolderSelection) => void;
}) {
  const selected = selection.kind === "folder" && selection.id === node.id;
  const hasChildren = node.children.length > 0;
  const expanded = expandedIds.includes(node.id);
  const deleteBlocked = folderDeleteBlocked({
    childFolderCount: childFolderCount(folders, node.id),
    workflowCount: selected ? selectedWorkflowCount : null,
  });
  return (
    <li>
      <div
        className="flex flex-wrap items-center gap-1"
        style={{ paddingLeft: `${Math.min(depth, 4) * 0.5}rem` }}
      >
        {hasChildren ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${node.name}`}
            onClick={() => onToggle(node.id)}
            className="shrink-0 rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50"
          >
            {expanded ? "Collapse" : "Expand"}
          </button>
        ) : null}
        <button
          type="button"
          data-home-folder-rail="folder"
          data-folder-id={node.id}
          aria-current={selected ? "true" : undefined}
          onClick={() => onSelect({ kind: "folder", id: node.id })}
          className={
            (selected
              ? "min-w-0 flex-1 rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-left text-sm text-white"
              : "min-w-0 flex-1 rounded-lg border border-transparent px-3 py-1.5 text-left text-sm text-zinc-800 hover:bg-zinc-50") +
            (canMutate &&
            dragging &&
            canDropWorkflowOnFolder(true, dragging.folderId, {
              kind: "folder",
              id: node.id,
            })
              ? " ring-2 ring-teal-600 ring-offset-1"
              : "")
          }
          {...folderDropHandlers(
            canMutate,
            { kind: "folder", id: node.id },
            dragging,
            onDropWorkflow,
          )}
        >
          {node.name}
        </button>
        {canMutate ? (
          <>
            <button
              type="button"
              data-home-folder-verb="rename"
              data-folder-id={node.id}
              disabled={pending}
              onClick={() => onRename(node.id)}
              className="shrink-0 rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-800 hover:bg-zinc-50 disabled:opacity-60"
            >
              {RENAME_FOLDER_LABEL}
            </button>
            <button
              type="button"
              data-home-folder-verb="delete"
              data-folder-id={node.id}
              disabled={pending || deleteBlocked}
              title={deleteBlocked ? FOLDER_NOT_EMPTY_HELP : undefined}
              onClick={() => onDelete(node.id)}
              className="shrink-0 rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-800 hover:bg-zinc-50 disabled:opacity-60"
            >
              {DELETE_FOLDER_LABEL}
            </button>
          </>
        ) : null}
      </div>
      {hasChildren && expanded ? (
        <ul className="mt-1 space-y-1">
          {node.children.map((child) => (
            <FolderRailNode
              key={child.id}
              node={child}
              depth={depth + 1}
              folders={folders}
              selection={selection}
              expandedIds={expandedIds}
              canMutate={canMutate}
              pending={pending}
              selectedWorkflowCount={selectedWorkflowCount}
              dragging={dragging}
              onSelect={onSelect}
              onToggle={onToggle}
              onRename={onRename}
              onDelete={onDelete}
              onDropWorkflow={onDropWorkflow}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function FolderBreadcrumb({
  crumbs,
  onSelect,
}: {
  crumbs: ReturnType<typeof breadcrumbSegments>;
  onSelect: (next: FolderSelection) => void;
}) {
  return (
    <nav
      aria-label={FOLDER_CRUMB_LABEL}
      data-home-folder-crumb=""
      className="flex flex-wrap items-center gap-1 text-sm text-zinc-600"
    >
      {crumbs.map((crumb, index) => (
        <span key={`${crumb.label}-${index}`} className="flex items-center gap-1">
          {index > 0 ? <span aria-hidden="true">/</span> : null}
          <button
            type="button"
            onClick={() => onSelect(crumb.selection)}
            className="font-medium text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
          >
            {crumb.label}
          </button>
        </span>
      ))}
    </nav>
  );
}

function FilterInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block text-sm">
      <span className="text-zinc-600">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-1.5 text-sm"
        autoComplete="off"
      />
    </label>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="block text-sm">
      <span className="text-zinc-600">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-1.5 text-sm"
      >
        <option value="">Any</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function WorkflowMeta({ item }: { item: WorkflowHomeItem }) {
  return (
    <p className="text-xs text-zinc-500">
      {item.status}
      {item.latestVersionNumber ? ` · v${item.latestVersionNumber}` : " · unpublished"}
      {" · "}
      {validationHealthLabel(item.validationHealth)}
      {item.pendingApprovals
        ? ` · ${item.pendingApprovals} approval${item.pendingApprovals === 1 ? "" : "s"}`
        : ""}
      {item.latestVersionDigest
        ? ` · ${shortDigest(item.latestVersionDigest)}`
        : ""}
    </p>
  );
}

function workflowRowDragProps(
  canMove: boolean,
  item: WorkflowHomeItem,
  beginDrag: (payload: WorkflowMoveDragPayload) => void,
  endDrag: () => void,
) {
  if (!canMove) {
    return { draggable: false as const };
  }
  return {
    draggable: true,
    "data-home-workflow-drag": "",
    onDragStart: (event: DragEvent) => {
      const payload = {
        workflowId: item.id,
        folderId: item.folderId,
      };
      event.dataTransfer.setData(
        WORKFLOW_MOVE_DRAG_TYPE,
        workflowMoveDragPayload(item.id, item.folderId),
      );
      event.dataTransfer.setData("text/plain", item.id);
      event.dataTransfer.effectAllowed = "move";
      beginDrag(payload);
    },
    onDragEnd: () => {
      endDrag();
    },
  };
}

function WorkflowActions({
  item,
  pending,
  canCreate,
  canMove,
  canExecute,
  canPublish,
  canViewWebhooks,
  canViewSchedules,
  canSeeLastRun,
  onStart,
  onTestRun,
  onWebhooks,
  onSchedules,
  onDuplicate,
  onExport,
  onMove,
}: {
  item: WorkflowHomeItem;
  pending: boolean;
  canCreate: boolean;
  canMove: boolean;
  canExecute: boolean;
  canPublish: boolean;
  canViewWebhooks: boolean;
  canViewSchedules: boolean;
  canSeeLastRun: boolean;
  onStart: (item: WorkflowHomeItem) => void;
  onTestRun: (item: WorkflowHomeItem) => void;
  onWebhooks: (item: WorkflowHomeItem) => void;
  onSchedules: (item: WorkflowHomeItem) => void;
  onDuplicate: (item: WorkflowHomeItem) => void;
  onExport: (item: WorkflowHomeItem) => void;
  onMove: (item: WorkflowHomeItem) => void;
}) {
  const showTestRun = canPublish && canExecute;
  return (
    <div className="flex flex-wrap gap-2">
      {showTestRun ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => onTestRun(item)}
          title={EDITOR_WORKING_MEMORY_TEST_RUN}
          className="text-sm font-medium text-teal-800 underline disabled:opacity-60"
        >
          Test run
        </button>
      ) : null}
      {item.latestVersionId ? (
        canExecute ? (
          <button
            type="button"
            id={homeSatelliteOverlayTriggerId("start", item.id)}
            disabled={pending}
            onClick={() => onStart(item)}
            title={EDITOR_WORKING_MEMORY_START_USES_PUBLISHED}
            className="text-sm font-medium text-teal-800 underline disabled:opacity-60"
          >
            Start published
          </button>
        ) : (
          <span className="text-sm text-zinc-500" title="workflow.execute required">
            Start locked
          </span>
        )
      ) : (
        <span
          className="text-sm text-zinc-500"
          title={EDITOR_WORKING_MEMORY_START_NEEDS_PUBLISHED}
        >
          Start published
        </span>
      )}
      {canViewWebhooks ? (
        <button
          type="button"
          id={homeSatelliteOverlayTriggerId("webhooks", item.id)}
          disabled={pending}
          onClick={() => onWebhooks(item)}
          className="text-sm font-medium text-teal-800 underline disabled:opacity-60"
        >
          Webhooks
        </button>
      ) : null}
      {canViewSchedules ? (
        <button
          type="button"
          id={homeSatelliteOverlayTriggerId("schedules", item.id)}
          disabled={pending}
          onClick={() => onSchedules(item)}
          className="text-sm font-medium text-teal-800 underline disabled:opacity-60"
        >
          Schedules
        </button>
      ) : null}
      <Link
        href={`/workflows/${item.id}`}
        className="text-sm font-medium text-teal-800 underline"
      >
        Open editor
      </Link>
      {canSeeLastRun ? (
        <Link
          href={workflowHomeLastRunHref({
            workflowId: item.id,
            lastRunId: item.lastRunId,
          })}
          className="text-sm text-zinc-700 underline"
        >
          Last run
        </Link>
      ) : null}
      {canCreate ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => onDuplicate(item)}
          className="text-sm text-zinc-700 underline disabled:opacity-60"
        >
          Duplicate
        </button>
      ) : null}
      {canMove ? (
        <button
          type="button"
          data-home-workflow-verb="move"
          disabled={pending}
          onClick={() => onMove(item)}
          className="text-sm text-zinc-700 underline disabled:opacity-60"
        >
          {FOLDER_MOVE_VERB}
        </button>
      ) : null}
      {item.latestVersionId ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => onExport(item)}
          className="text-sm text-zinc-700 underline disabled:opacity-60"
        >
          Export
        </button>
      ) : null}
    </div>
  );
}

function WorkflowFolderPath({
  item,
  onReveal,
}: {
  item: WorkflowHomeItem;
  onReveal: (item: WorkflowHomeItem) => void;
}) {
  return (
    <button
      type="button"
      data-home-folder-path=""
      title={FOLDER_PATH_REVEAL_LABEL}
      onClick={() => onReveal(item)}
      className="text-left text-xs font-medium text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
    >
      {workflowFolderPathLabel(item)}
    </button>
  );
}

function WorkflowHomeList({
  items,
  pending,
  canCreate,
  canMove,
  canExecute,
  canPublish,
  canViewWebhooks,
  canViewSchedules,
  canSeeLastRun,
  onStart,
  onTestRun,
  onWebhooks,
  onSchedules,
  onDuplicate,
  onExport,
  onMove,
  onRevealFolder,
  onDragStart,
  onDragEnd,
}: {
  items: WorkflowHomeItem[];
  pending: boolean;
  canCreate: boolean;
  canMove: boolean;
  canExecute: boolean;
  canPublish: boolean;
  canViewWebhooks: boolean;
  canViewSchedules: boolean;
  canSeeLastRun: boolean;
  onStart: (item: WorkflowHomeItem) => void;
  onTestRun: (item: WorkflowHomeItem) => void;
  onWebhooks: (item: WorkflowHomeItem) => void;
  onSchedules: (item: WorkflowHomeItem) => void;
  onDuplicate: (item: WorkflowHomeItem) => void;
  onExport: (item: WorkflowHomeItem) => void;
  onMove: (item: WorkflowHomeItem) => void;
  onRevealFolder: (item: WorkflowHomeItem) => void;
  onDragStart: (payload: WorkflowMoveDragPayload) => void;
  onDragEnd: () => void;
}) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-zinc-200 bg-white shadow-sm">
      <div
        className="mb-0 hidden min-w-[52rem] gap-3 border-b border-zinc-100 px-5 py-3 text-xs font-medium tracking-wide text-zinc-500 uppercase sm:grid sm:grid-cols-[minmax(10rem,1.1fr)_minmax(12rem,1.5fr)_minmax(8rem,0.9fr)_minmax(12rem,1.3fr)_minmax(9rem,1fr)]"
        aria-hidden="true"
        data-home-row-scan="columns"
      >
        {WORKFLOW_HOME_LIST_COLUMNS.map((column) => (
          <span key={column.id} data-home-row-scan-column={column.id}>
            {column.label}
          </span>
        ))}
      </div>
      <ul className="min-w-0 divide-y divide-zinc-100">
        {items.map((item) => (
          <li
            key={item.id}
            className="grid gap-3 px-5 py-4 sm:grid-cols-[minmax(10rem,1.1fr)_minmax(12rem,1.5fr)_minmax(8rem,0.9fr)_minmax(12rem,1.3fr)_minmax(9rem,1fr)] sm:items-start"
            data-home-row-scan="row"
            {...workflowRowDragProps(canMove, item, onDragStart, onDragEnd)}
          >
            {WORKFLOW_HOME_LIST_COLUMNS.map((column) => (
              <div key={column.id} className="min-w-0" data-home-row-scan-cell={column.id}>
                <p className="text-xs font-medium tracking-wide text-zinc-500 uppercase sm:hidden">
                  {column.label}
                </p>
                {column.id === "activation" ? (
                  <HomeActivationStatus column={item.activation} />
                ) : null}
                {column.id === "workflow" ? (
                  <>
                    <Link
                      href={`/workflows/${item.id}`}
                      className="text-base font-medium text-zinc-900 hover:underline"
                    >
                      {item.name}
                    </Link>
                    <p className="font-mono text-xs text-zinc-500">
                      {item.slug}
                      {item.owner ? ` · ${item.owner}` : ""}
                    </p>
                    <p className="mt-1">
                      <WorkflowFolderPath
                        item={item}
                        onReveal={onRevealFolder}
                      />
                    </p>
                  </>
                ) : null}
                {column.id === "status" ? <WorkflowMeta item={item} /> : null}
                {column.id === "actions" ? (
                  <WorkflowActions
                    item={item}
                    pending={pending}
                    canCreate={canCreate}
                    canMove={canMove}
                    canExecute={canExecute}
                    canPublish={canPublish}
                    canViewWebhooks={canViewWebhooks}
                    canViewSchedules={canViewSchedules}
                    canSeeLastRun={canSeeLastRun}
                    onStart={onStart}
                    onTestRun={onTestRun}
                    onWebhooks={onWebhooks}
                    onSchedules={onSchedules}
                    onDuplicate={onDuplicate}
                    onExport={onExport}
                    onMove={onMove}
                  />
                ) : null}
                {column.id === "lastRun" ? (
                  <HomeLastRunStatus item={item} canSeeLastRun={canSeeLastRun} />
                ) : null}
              </div>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}

function WorkflowHomeCards({
  items,
  pending,
  canCreate,
  canMove,
  canExecute,
  canPublish,
  canViewWebhooks,
  canViewSchedules,
  canSeeLastRun,
  onStart,
  onTestRun,
  onWebhooks,
  onSchedules,
  onDuplicate,
  onExport,
  onMove,
  onRevealFolder,
  onDragStart,
  onDragEnd,
}: {
  items: WorkflowHomeItem[];
  pending: boolean;
  canCreate: boolean;
  canMove: boolean;
  canExecute: boolean;
  canPublish: boolean;
  canViewWebhooks: boolean;
  canViewSchedules: boolean;
  canSeeLastRun: boolean;
  onStart: (item: WorkflowHomeItem) => void;
  onTestRun: (item: WorkflowHomeItem) => void;
  onWebhooks: (item: WorkflowHomeItem) => void;
  onSchedules: (item: WorkflowHomeItem) => void;
  onDuplicate: (item: WorkflowHomeItem) => void;
  onExport: (item: WorkflowHomeItem) => void;
  onMove: (item: WorkflowHomeItem) => void;
  onRevealFolder: (item: WorkflowHomeItem) => void;
  onDragStart: (payload: WorkflowMoveDragPayload) => void;
  onDragEnd: () => void;
}) {
  return (
    <ul className="grid gap-4 sm:grid-cols-2">
      {items.map((item) => (
        <li
          key={item.id}
          className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm"
          data-home-row-scan="card"
          {...workflowRowDragProps(canMove, item, onDragStart, onDragEnd)}
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <HomeActivationStatus column={item.activation} />
          </div>
          <Link
            href={`/workflows/${item.id}`}
            className="mt-2 block text-lg font-semibold text-zinc-900 hover:underline"
          >
            {item.name}
          </Link>
          <p className="mt-1 font-mono text-xs text-zinc-500">{item.slug}</p>
          <p className="mt-2">
            <WorkflowFolderPath item={item} onReveal={onRevealFolder} />
          </p>
          <div className="mt-3">
            <WorkflowMeta item={item} />
          </div>
          <div className="mt-4">
            <WorkflowActions
              item={item}
              pending={pending}
              canCreate={canCreate}
              canMove={canMove}
              canExecute={canExecute}
              canPublish={canPublish}
              canViewWebhooks={canViewWebhooks}
              canViewSchedules={canViewSchedules}
              canSeeLastRun={canSeeLastRun}
              onStart={onStart}
              onTestRun={onTestRun}
              onWebhooks={onWebhooks}
              onSchedules={onSchedules}
              onDuplicate={onDuplicate}
              onExport={onExport}
              onMove={onMove}
            />
          </div>
          <div className="mt-4 border-t border-zinc-100 pt-3">
            <p className="text-xs font-medium tracking-wide text-zinc-500 uppercase">
              Last run
            </p>
            <div className="mt-1">
              <HomeLastRunStatus item={item} canSeeLastRun={canSeeLastRun} />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function HomeEmptyTeach({
  canCreate,
  canCreateFolder,
  pending,
  unfiledEmpty,
  onCreate,
  onImport,
  onNewFolder,
}: {
  canCreate: boolean;
  canCreateFolder: boolean;
  pending: boolean;
  unfiledEmpty?: boolean;
  onCreate: () => void;
  onImport: () => void;
  onNewFolder: () => void;
}) {
  return (
    <section
      data-uxl6="home-empty"
      data-f5={unfiledEmpty ? "unfiled-empty-none" : "home-empty"}
      className="rounded-2xl border border-dashed border-zinc-300 bg-white p-6 shadow-sm"
    >
      <h2 className="text-base font-semibold">
        {unfiledEmpty ? UNFILED_EMPTY_HEADING : HOME_EMPTY_HEADING}
      </h2>
      <p className="mt-2 max-w-3xl text-sm text-zinc-600">
        {unfiledEmpty ? UNFILED_EMPTY_NONE_HELP : HOME_EMPTY_HELP}
      </p>
      {canCreate || canCreateFolder ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {canCreate ? (
            <>
              <button
                type="button"
                disabled={pending}
                onClick={onCreate}
                className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
              >
                {HOME_EMPTY_CREATE_LABEL}
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={onImport}
                className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-60"
              >
                {HOME_EMPTY_IMPORT_LABEL}
              </button>
            </>
          ) : null}
          {canCreateFolder ? (
            <button
              type="button"
              data-home-empty-verb="new-folder"
              disabled={pending}
              onClick={onNewFolder}
              className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-60"
            >
              {NEW_FOLDER_LABEL}
            </button>
          ) : null}
        </div>
      ) : (
        <p className="mt-3 text-xs text-zinc-500">
          Creating a draft requires <code className="font-mono">workflow.edit</code>.
        </p>
      )}
    </section>
  );
}

function FolderEmpty({
  canCreate,
  canMutate,
  pending,
  deleteAllowed,
  moveAvailable,
  onCreate,
  onImport,
  onMove,
  onDelete,
}: {
  canCreate: boolean;
  canMutate: boolean;
  pending: boolean;
  deleteAllowed: boolean;
  moveAvailable: boolean;
  onCreate: () => void;
  onImport: () => void;
  onMove: () => void;
  onDelete: () => void;
}) {
  return (
    <section
      data-f5="folder-empty"
      className="rounded-2xl border border-dashed border-zinc-300 bg-white p-6 shadow-sm"
    >
      <h2 className="text-base font-semibold">{FOLDER_EMPTY_HEADING}</h2>
      <p className="mt-2 max-w-3xl text-sm text-zinc-600">{FOLDER_EMPTY_HELP}</p>
      {canCreate || canMutate ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {canCreate ? (
            <>
              <button
                type="button"
                data-home-folder-empty-verb="create"
                disabled={pending}
                onClick={onCreate}
                className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
              >
                {FOLDER_EMPTY_CREATE_LABEL}
              </button>
              <button
                type="button"
                data-home-folder-empty-verb="import"
                disabled={pending}
                onClick={onImport}
                className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-60"
              >
                {HOME_EMPTY_IMPORT_LABEL}
              </button>
            </>
          ) : null}
          {canMutate ? (
            <>
              <button
                type="button"
                data-home-folder-empty-verb="move"
                disabled={pending || !moveAvailable}
                title={
                  moveAvailable
                    ? undefined
                    : "No workflows are available to move."
                }
                onClick={onMove}
                className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-60"
              >
                {FOLDER_EMPTY_MOVE_LABEL}
              </button>
              <button
                type="button"
                data-home-folder-empty-verb="delete"
                disabled={pending || !deleteAllowed}
                title={deleteAllowed ? undefined : FOLDER_NOT_EMPTY_HELP}
                onClick={onDelete}
                className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-60"
              >
                {DELETE_FOLDER_LABEL}
              </button>
            </>
          ) : null}
        </div>
      ) : (
        <p className="mt-3 text-xs text-zinc-500">{FOLDER_EMPTY_VIEWER_HELP}</p>
      )}
    </section>
  );
}

function UnfiledEmptyFiled({
  folders,
  onSelectFolder,
}: {
  folders: readonly WorkflowFolder[];
  onSelectFolder: (next: FolderSelection) => void;
}) {
  const tree = buildFolderTree(folders);
  return (
    <section
      data-f5="unfiled-empty-filed"
      className="rounded-2xl border border-dashed border-zinc-300 bg-white p-6 shadow-sm"
    >
      <h2 className="text-base font-semibold">{UNFILED_EMPTY_HEADING}</h2>
      <p className="mt-2 max-w-3xl text-sm text-zinc-600">
        {UNFILED_EMPTY_FILED_HELP}
      </p>
      <p className="mt-2 text-sm text-zinc-600">{UNFILED_EMPTY_TREE_LABEL}.</p>
      {tree.length > 0 ? (
        <ul className="mt-4 flex flex-wrap gap-2">
          {tree.map((node) => (
            <li key={node.id}>
              <button
                type="button"
                data-f5="unfiled-empty-tree"
                data-folder-id={node.id}
                onClick={() => onSelectFolder({ kind: "folder", id: node.id })}
                className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50"
              >
                {node.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function HomeFilteredEmpty({ onClear }: { onClear: () => void }) {
  return (
    <section
      data-uxl6="home-filtered"
      className="rounded-2xl border border-dashed border-zinc-300 bg-white/60 p-8 text-center"
    >
      <h2 className="text-lg font-semibold">{HOME_FILTERED_EMPTY_HEADING}</h2>
      <p className="mt-2 text-sm text-zinc-600">{HOME_FILTERED_EMPTY_HELP}</p>
      <button
        type="button"
        onClick={onClear}
        className="mt-4 text-sm font-medium text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
      >
        Clear filters
      </button>
    </section>
  );
}

export function TemplateGrid({
  canCreate,
  pending,
  onSelect,
}: {
  canCreate: boolean;
  pending: boolean;
  onSelect: (template: WorkflowTemplate) => void;
}) {
  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
      <h2 className="text-base font-semibold">Reviewed templates</h2>
      <p className="mt-1 text-sm text-zinc-600">{HOME_EMPTY_TEMPLATE_HELP}</p>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2">
        {WORKFLOW_TEMPLATES.map((template) => (
          <li
            key={template.id}
            className="rounded-xl border border-zinc-200 p-4"
          >
            <h3 className="font-medium text-zinc-900">{template.title}</h3>
            <p className="mt-1 text-sm text-zinc-600">{template.description}</p>
            {canCreate ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => onSelect(template)}
                className="mt-3 rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm text-white hover:bg-teal-900 disabled:opacity-60"
              >
                {HOME_EMPTY_TEMPLATE_LABEL}
              </button>
            ) : (
              <p className="mt-3 text-xs text-zinc-500">
                Requires <code className="font-mono">workflow.edit</code>
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
