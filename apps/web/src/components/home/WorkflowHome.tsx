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
import { workspaceLookupKey, type DevIdentity } from "@/lib/identity-headers";
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
} from "@/lib/workflow-home";
import {
  OVERVIEW_CARD_SURFACE_CLASS,
  OVERVIEW_CREATE_LABEL,
  OVERVIEW_DEFAULT_SORT,
  OVERVIEW_FILTER_LABEL,
  OVERVIEW_HEADING,
  OVERVIEW_HELP,
  OVERVIEW_KEBAB_LABEL,
  OVERVIEW_PUBLISHED_LABEL,
  OVERVIEW_SORT_LABEL,
  OVERVIEW_SORTS,
  overviewCardTimestamps,
  overviewPublishedBadge,
  type OverviewHomeSort,
} from "@/lib/overview-home";
import {
  FF_OVERVIEW_CARD_ROW_CLASS,
  FF_OVERVIEW_CHIP_CLASS,
  FF_OVERVIEW_CONTROL_CLASS,
  FF_OVERVIEW_CREATE_CLASS,
  FF_OVERVIEW_DANGER_CLASS,
  FF_OVERVIEW_DIALOG_CLASS,
  FF_OVERVIEW_GHOST_CLASS,
  FF_OVERVIEW_HEADER_CLASS,
  FF_OVERVIEW_KEBAB_CLASS,
  FF_OVERVIEW_LINK_CLASS,
  FF_OVERVIEW_MENU_CLASS,
  FF_OVERVIEW_MUTED_CLASS,
  FF_OVERVIEW_PILL_CLASS,
  FF_OVERVIEW_RAIL_ACTIVE_CLASS,
  FF_OVERVIEW_RAIL_CLASS,
  FF_OVERVIEW_RAIL_ITEM_CLASS,
  FF_OVERVIEW_ROOT_CLASS,
  FF_OVERVIEW_SCAN_LEAD_CLASS,
  FF_OVERVIEW_SCAN_TRAIL_CLASS,
  FF_OVERVIEW_TITLE_CLASS,
  FF_OVERVIEW_VALUE,
} from "@/lib/overview-visual";
import { overviewAncestryPills } from "@/lib/overview-path-pills";
import {
  EXPLORER_HELP,
  EXPLORER_PANE_LABEL,
  FF_EXPLORER_CRUMB_CLASS,
  FF_EXPLORER_LAYOUT_CLASS,
  FF_EXPLORER_LIST_CLASS,
  FF_EXPLORER_PANE_CLASS,
  FF_EXPLORER_ROW_CLASS,
  FF_EXPLORER_SHELL_CLASS,
  FF_EXPLORER_TREE_CLASS,
} from "@/lib/explorer-shell";
import {
  EXPLORER_MENU_LABEL,
  FF_EXPLORER_MENU_CLASS,
  FF_EXPLORER_MENU_ITEM_CLASS,
  childFoldersForPane,
  explorerEmptyPaneMenuItems,
  explorerFolderMenuItems,
  explorerMenuPosition,
  explorerWorkflowMenuItems,
  visibleExplorerMenuItems,
  type ExplorerContextItem,
  type ExplorerContextTarget,
  type ExplorerContextVerb,
} from "@/lib/explorer-context-menu";
import {
  EXPLORER_SELECT_HELP,
  FF_EXPLORER_ROW_SELECTED_CLASS,
  explorerAdvancePaneSelection,
  explorerExpandIdsForOpenFolder,
  explorerOpenKind,
  explorerPaneRowEquals,
  explorerPaneRowKey,
  explorerPaneRows,
  explorerPaneSelectionStillVisible,
  type ExplorerPaneRow,
} from "@/lib/explorer-select-open";
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
  folderRailReady,
  homeExtrasIdsToLoad,
  homeListMetadataRecords,
  intendedFolderSelectionFromUrl,
  selectedFolderListFolderId,
  matchesWorkflowNameOrSlug,
  parseFolderQuery,
  parseWorkflowMoveDragPayload,
  readExpandedFolderIds,
  renderedFolderSelection,
  resolveFolderSelection,
  selectionAfterFolderDelete,
  shouldDropFolderQueryOnWorkspaceMemory,
  shouldRewriteFolderDeepLink,
  workspaceWideWorkflowsOrScoped,
  workspaceWideWorkflowsResult,
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

async function fetchHomeRowExtras(
  identity: DevIdentity,
  records: readonly WorkflowRecord[],
  options: { canSeeExecutions: boolean; canViewActivation: boolean },
): Promise<{
  drafts: Map<string, WorkflowDraft>;
  executions: ExecutionRecord[];
  lastRunKnownIds: Set<string>;
  activations: Map<string, HomeActivationColumn>;
}> {
  const draftEntries = await Promise.all(
    records.map(async (item) => {
      const draft = await getWorkflowDraft(identity, item.id);
      return [item.id, draft.ok ? draft.draft : null] as const;
    }),
  );
  const drafts = new Map<string, WorkflowDraft>();
  for (const [id, draft] of draftEntries) {
    if (draft) {
      drafts.set(id, draft);
    }
  }
  const executions: ExecutionRecord[] = [];
  const lastRunKnownIds = new Set<string>();
  if (options.canSeeExecutions) {
    const runEntries = await Promise.all(
      records.map(async (item) => {
        const runs = await listWorkflowExecutions(identity, item.id, {
          limit: 1,
        });
        return [item.id, runs.ok ? runs.items : null] as const;
      }),
    );
    for (const [id, items] of runEntries) {
      if (!items) {
        continue;
      }
      lastRunKnownIds.add(id);
      executions.push(...items);
    }
  }
  const activations = options.canViewActivation
    ? await loadHomeActivationStates(identity, records, {
        canView: options.canViewActivation,
      })
    : new Map<string, HomeActivationColumn>();
  return { drafts, executions, lastRunKnownIds, activations };
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
  const extrasGate = useRef(createGenerationGate());
  const extrasLoadedIds = useRef(new Set<string>());
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
  const [sort, setSort] = useState<OverviewHomeSort>(OVERVIEW_DEFAULT_SORT);
  const [filterOpen, setFilterOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [createName, setCreateName] = useState("");
  const [createSlug, setCreateSlug] = useState("");

  const [folderDialog, setFolderDialog] = useState<
    | { kind: "create"; parent?: FolderSelection }
    | { kind: "rename"; id: string }
    | null
  >(null);
  const [explorerMenu, setExplorerMenu] = useState<{
    target: ExplorerContextTarget;
    x: number;
    y: number;
  } | null>(null);
  const [paneSelection, setPaneSelection] = useState<ExplorerPaneRow | null>(
    null,
  );
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
  const canMutateFolders =
    ready &&
    (embed
      ? canMutateEmbedWorkflowFolders(permissions, session.embedChrome)
      : canMutateWorkflowFolders(permissions));
  const canCreate =
    ready &&
    (embed
      ? canMutateEmbedWorkflowFolders(permissions, session.embedChrome)
      : canCreateWorkflows(permissions));
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
  const selection = renderedFolderSelection(
    intendedSelection,
    folders,
    foldersReady,
  );
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
    ? workspaceWideWorkflowsOrScoped(workspaceWorkflows, records)
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
      sort,
    );
  }, [items, filters, searchInThisFolder, selection, sort]);
  const workspaceWorkflowCount = workspaceWorkflows?.length ?? records.length;
  const emptyKind = folderHomeEmptyKind({
    selection,
    folderCount: folders.length,
    scopedRecordCount: acrossFolderSearch
      ? workspaceWideWorkflowsOrScoped(workspaceWorkflows, records).length
      : records.length,
    visibleCount: visible.length,
    workspaceWorkflowCount,
  });
  const unfiledShowsHomeVerbs = unfiledEmptyUsesHomeVerbs(workspaceWorkflowCount);
  const paneFolders = useMemo(
    () =>
      childFoldersForPane(folders, selection, {
        acrossSearch: acrossFolderSearch,
      }),
    [acrossFolderSearch, folders, selection],
  );
  const paneHasRows = visible.length > 0 || paneFolders.length > 0;
  const paneRows = useMemo(
    () => explorerPaneRows(paneFolders, visible),
    [paneFolders, visible],
  );
  const folderSelectionKey =
    selection.kind === "folder" ? selection.id : "unfiled";
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
      extrasLoadedIds.current = new Set();
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
      setProblem(folderList.problem);
      setFoldersReady(folderRailReady(false));
    } else {
      setFolders(folderList.items);
      setFoldersReady(folderRailReady(true));
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
    const workspaceItems = all.ok
      ? workspaceWideWorkflowsResult(true, all.items)
      : workspaceWideWorkflowsResult(false, []);
    setWorkspaceWorkflows(workspaceItems);
    extrasGate.current.begin();
    const metadataRecords = homeListMetadataRecords(
      list.items,
      workspaceItems,
      "",
      false,
    );
    extrasLoadedIds.current = new Set(metadataRecords.map((item) => item.id));
    const extras = await fetchHomeRowExtras(identity, metadataRecords, {
      canSeeExecutions: canSeeExecutionsNav(permissions ?? []),
      canViewActivation,
    });
    if (!refreshGate.current.isCurrent(token)) {
      return;
    }
    setDrafts(extras.drafts);
    setExecutions(extras.executions);
    setLastRunKnownIds(extras.lastRunKnownIds);
    setActivations(extras.activations);
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

  function openCreateFolder(parent?: FolderSelection) {
    if (!canMutateFolders) {
      return;
    }
    setFolderDialog({ kind: "create", parent });
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
        ? createFolderParentId(folderDialog.parent ?? selection)
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
    setPaneSelection(null);
  }, [folderSelectionKey]);

  useEffect(() => {
    setPaneSelection((current) =>
      explorerPaneSelectionStillVisible(paneRows, current) ? current : null,
    );
  }, [paneRows]);

  useEffect(() => {
    if (!canView || !acrossFolderSearch) {
      return;
    }
    const needed = homeListMetadataRecords(
      records,
      workspaceWorkflows,
      filters.query,
      searchInThisFolder,
    );
    const missingIds = new Set(
      homeExtrasIdsToLoad(needed, extrasLoadedIds.current),
    );
    if (missingIds.size === 0) {
      return;
    }
    const missing = needed.filter((item) => missingIds.has(item.id));
    for (const id of missingIds) {
      extrasLoadedIds.current.add(id);
    }
    const token = extrasGate.current.begin();
    void (async () => {
      const extras = await fetchHomeRowExtras(identity, missing, {
        canSeeExecutions: canSeeExecutionsNav(permissions ?? []),
        canViewActivation,
      });
      if (!extrasGate.current.isCurrent(token)) {
        return;
      }
      setDrafts((prev) => {
        const next = new Map(prev);
        for (const [id, draft] of extras.drafts) {
          next.set(id, draft);
        }
        return next;
      });
      setExecutions((prev) => {
        const replace = new Set(extras.lastRunKnownIds);
        return [
          ...prev.filter((item) => !replace.has(item.workflowId)),
          ...extras.executions,
        ];
      });
      setLastRunKnownIds((prev) => {
        const next = new Set(prev);
        for (const id of extras.lastRunKnownIds) {
          next.add(id);
        }
        return next;
      });
      setActivations((prev) => {
        const next = new Map(prev);
        for (const [id, column] of extras.activations) {
          next.set(id, column);
        }
        return next;
      });
    })();
  }, [
    acrossFolderSearch,
    canView,
    canViewActivation,
    filters.query,
    identity,
    permissions,
    records,
    searchInThisFolder,
    workspaceWorkflows,
  ]);

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
      <p className={`${FF_OVERVIEW_DIALOG_CLASS} p-4 text-sm ${FF_OVERVIEW_MUTED_CLASS}`}>
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

  const importExistsInHomeChrome = canCreate;

  function folderMenuInput(folderId: string) {
    return explorerFolderMenuItems({
      canMutate: canMutateFolders,
      isUnfiled: false,
      canCreateChild: canCreateChildFolder(folders, folderId),
      deleteBlocked: folderDeleteBlocked({
        childFolderCount: childFolderCount(folders, folderId),
        workflowCount:
          selection.kind === "folder" && selection.id === folderId
            ? records.length
            : null,
      }),
      canExpand: childFolderCount(folders, folderId) > 0,
      expanded: expandedIds.includes(folderId) || visibleExpandedIds.includes(folderId),
    });
  }

  function itemsForExplorerMenu(
    target: ExplorerContextTarget,
  ): ExplorerContextItem[] {
    if (target.kind === "unfiled") {
      return explorerFolderMenuItems({
        canMutate: canMutateFolders,
        isUnfiled: true,
        canCreateChild: canCreateChildFolder(folders, null),
        deleteBlocked: true,
        canExpand: false,
        expanded: false,
      });
    }
    if (target.kind === "folder") {
      return folderMenuInput(target.id);
    }
    if (target.kind === "workflow") {
      return explorerWorkflowMenuItems({ canMutate: canMutateFolders });
    }
    return explorerEmptyPaneMenuItems({
      canMutateFolders,
      canCreate,
      importExistsInHomeChrome,
    });
  }

  function openExplorerMenu(
    target: ExplorerContextTarget,
    event: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void },
  ) {
    event.preventDefault();
    event.stopPropagation();
    const items = visibleExplorerMenuItems(itemsForExplorerMenu(target));
    if (items.length === 0) {
      setExplorerMenu(null);
      return;
    }
    setExplorerMenu({ target, x: event.clientX, y: event.clientY });
  }

  function selectPaneRow(row: ExplorerPaneRow) {
    setPaneSelection(row);
  }

  function openPaneRow(row: ExplorerPaneRow) {
    setPaneSelection(row);
    if (explorerOpenKind(row) === "editor") {
      router.push(workflowEditorHref(row.id));
      return;
    }
    setExpandedIds((current) => {
      const next = [
        ...new Set([
          ...current,
          ...explorerExpandIdsForOpenFolder(folders, row.id),
        ]),
      ];
      writeExpandedFolderIds(workspaceKey, next);
      return next;
    });
    selectFolder({ kind: "folder", id: row.id });
  }

  function runExplorerMenuVerb(
    target: ExplorerContextTarget,
    verb: ExplorerContextVerb,
  ) {
    if (verb === "new-folder") {
      if (target.kind === "folder") {
        openCreateFolder({ kind: "folder", id: target.id });
        return;
      }
      if (target.kind === "unfiled") {
        openCreateFolder({ kind: "unfiled" });
        return;
      }
      openCreateFolder();
      return;
    }
    if (verb === "rename" && target.kind === "folder") {
      openRenameFolder(target.id);
      return;
    }
    if (verb === "delete" && target.kind === "folder") {
      void removeFolder(target.id);
      return;
    }
    if (verb === "expand" && target.kind === "folder") {
      toggleFolderExpanded(target.id);
      return;
    }
    if (verb === "open" && target.kind === "workflow") {
      router.push(workflowEditorHref(target.id));
      return;
    }
    if (verb === "move" && target.kind === "workflow") {
      const item =
        items.find((row) => row.id === target.id) ??
        visible.find((row) => row.id === target.id);
      if (item) {
        openMoveDialog(item);
      }
      return;
    }
    if (verb === "create-workflow") {
      const blank = workflowTemplateById("blank");
      if (blank) {
        void createFromYaml(blank.definitionYaml);
      }
      return;
    }
    if (verb === "import") {
      importRef.current?.click();
    }
  }

  return (
    <div
      data-uxl8="home"
      data-f7={embed ? "embed-home" : "standalone-home"}
      data-f7-tree="api"
      data-o4={embed ? "embed-overview" : "standalone-overview"}
      data-o4-tree="api"
      data-o4-viewer={canMutateFolders ? "editor" : "select-only"}
      data-ff-overview={FF_OVERVIEW_VALUE}
      data-x1="explorer-shell"
      data-x3="select-open"
      className={`${FF_OVERVIEW_ROOT_CLASS} ${FF_EXPLORER_SHELL_CLASS} space-y-4`}
    >
      {!ready ? (
        <SessionSetupHint purpose="before listing workflows." />
      ) : null}
      {problem ? <ProblemBanner problem={problem} /> : null}

      <div
        data-x1="explorer-layout"
        className={`${FF_EXPLORER_LAYOUT_CLASS} grid max-md:grid-cols-1 md:grid-cols-[16.5rem_minmax(0,1fr)]`}
      >
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
        onFolderContextMenu={(folderId, event) =>
          openExplorerMenu({ kind: "folder", id: folderId }, event)
        }
        onUnfiledContextMenu={(event) =>
          openExplorerMenu({ kind: "unfiled" }, event)
        }
      />
      <div
        data-x1="content-pane"
        aria-label={EXPLORER_PANE_LABEL}
        className={`min-w-0 ${FF_EXPLORER_PANE_CLASS}`}
      >
      <FolderBreadcrumb crumbs={crumbs} onSelect={selectFolder} />
      {canMutateFolders && moveIntoOpen && selection.kind === "folder" ? (
        <form
          data-f5="folder-empty-move"
          data-home-folder-empty-move-dialog=""
          className={`${FF_OVERVIEW_DIALOG_CLASS} space-y-3`}
          onSubmit={(event) => {
            event.preventDefault();
            void submitMoveIntoFolder();
          }}
        >
          <p className={`text-sm ${FF_OVERVIEW_MUTED_CLASS}`}>
            Move an existing workflow into this folder. This does not change
            YAML, draft revision, or activation.
          </p>
          {moveIntoCandidates.length === 0 ? (
            <p className={`text-sm ${FF_OVERVIEW_MUTED_CLASS}`}>
              No workflows are available to move. Create a draft here or use
              the folder rail.
            </p>
          ) : (
            <label className="block text-sm">
              <span className={FF_OVERVIEW_MUTED_CLASS}>Workflow</span>
              <select
                data-home-folder-empty-move-target=""
                value={moveIntoWorkflowId}
                onChange={(event) => setMoveIntoWorkflowId(event.target.value)}
                className={`mt-1 ${FF_OVERVIEW_CONTROL_CLASS}`}
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
              className={FF_OVERVIEW_CREATE_CLASS}
            >
              {FOLDER_EMPTY_MOVE_LABEL}
            </button>
            <button
              type="button"
              disabled={pending !== null}
              onClick={closeMoveIntoFolder}
              className={FF_OVERVIEW_GHOST_CLASS}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {canMutateFolders && moveDialog ? (
        <form
          data-home-workflow-move-dialog=""
          className={`${FF_OVERVIEW_DIALOG_CLASS} space-y-3`}
          onSubmit={(event) => {
            event.preventDefault();
            void submitMoveDialog();
          }}
        >
          <p className={`text-sm ${FF_OVERVIEW_MUTED_CLASS}`}>
            Move <span className={`font-medium ${FF_OVERVIEW_TITLE_CLASS}`}>{moveDialog.name}</span>{" "}
            to a folder in this workspace. This does not change YAML, draft
            revision, or activation.
          </p>
          <label className="block text-sm">
            <span className={FF_OVERVIEW_MUTED_CLASS}>Destination</span>
            <select
              data-home-workflow-move-target=""
              value={folderQueryValue(moveTarget)}
              onChange={(event) =>
                setMoveTarget(parseFolderQuery(event.target.value))
              }
              className={`mt-1 ${FF_OVERVIEW_CONTROL_CLASS}`}
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
              className={FF_OVERVIEW_CREATE_CLASS}
            >
              {FOLDER_MOVE_VERB}
            </button>
            <button
              type="button"
              disabled={pending !== null}
              onClick={closeMoveDialog}
              className={FF_OVERVIEW_GHOST_CLASS}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      <section
        data-o1="overview-header"
        className={FF_OVERVIEW_HEADER_CLASS}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className={`text-xl tracking-tight ${FF_OVERVIEW_TITLE_CLASS}`}>
              {OVERVIEW_HEADING}
            </h2>
            <p className={`mt-1 text-sm ${FF_OVERVIEW_MUTED_CLASS}`}>{OVERVIEW_HELP}</p>
            <p className={`mt-1 text-sm ${FF_OVERVIEW_MUTED_CLASS}`} data-x1="explorer-help">
              {EXPLORER_HELP}
            </p>
            <p className={`mt-1 text-sm ${FF_OVERVIEW_MUTED_CLASS}`} data-x3="select-help">
              {EXPLORER_SELECT_HELP}
            </p>
            <p className={`mt-1 text-sm ${FF_OVERVIEW_MUTED_CLASS}`} data-f6="search-help">
              {FOLDER_SEARCH_HELP} Folder membership is not in YAML.
            </p>
            <p
              id={HOME_ACTIVATION_HEADING_ID}
              className="sr-only"
              data-r6-d2={HOME_ACTIVATION.d2ComposeEnablePlusVersionPin}
            >
              {HOME_ACTIVATION_HELP}
            </p>
            <p
              className="sr-only"
              data-home-working-memory="test-run"
            >
              {EDITOR_WORKING_MEMORY_TEST_RUN} {TEST_RUN_HELP}
            </p>
            <p className="sr-only" data-home-row-scan="help">
              {HOME_ROW_SCAN_HELP}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={pending !== null}
              className={FF_OVERVIEW_GHOST_CLASS}
            >
              {pending === "list" ? "Loading…" : "Refresh"}
            </button>
            {canCreate ? (
              <button
                type="button"
                data-o1="create"
                disabled={pending !== null}
                onClick={() => {
                  const blank = workflowTemplateById("blank");
                  if (blank) {
                    void createFromYaml(blank.definitionYaml);
                  }
                }}
                className={FF_OVERVIEW_CREATE_CLASS}
              >
                {OVERVIEW_CREATE_LABEL}
              </button>
            ) : null}
          </div>
        </div>

        <div
          className="mt-4 flex flex-wrap items-end gap-3"
          data-o1="toolbar"
          data-f6="search"
          data-home-folder-search={
            searchInThisFolder ? "folder" : "across"
          }
        >
          <div className="min-w-[12rem] flex-1 space-y-2">
            <FilterInput
              label={FOLDER_SEARCH_ACROSS_LABEL}
              value={filters.query}
              onChange={(value) =>
                setFilters((current) => ({ ...current, query: value }))
              }
            />
            <label className={`flex items-center gap-2 text-sm ${FF_OVERVIEW_MUTED_CLASS}`}>
              <input
                type="checkbox"
                checked={searchInThisFolder}
                data-home-folder-search-scope="in-folder"
                onChange={(event) => setSearchInThisFolder(event.target.checked)}
              />
              {FOLDER_SEARCH_IN_FOLDER_LABEL}
            </label>
          </div>
          <label className="block min-w-[10rem] text-sm">
            <span className={FF_OVERVIEW_MUTED_CLASS}>{OVERVIEW_SORT_LABEL}</span>
            <select
              data-o1="sort"
              value={sort}
              onChange={(event) =>
                setSort(event.target.value as OverviewHomeSort)
              }
              className={`mt-1 ${FF_OVERVIEW_CONTROL_CLASS}`}
            >
              {OVERVIEW_SORTS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            data-o1="filter"
            aria-expanded={filterOpen}
            onClick={() => setFilterOpen((current) => !current)}
            className={
              filterOpen ? FF_OVERVIEW_CREATE_CLASS : FF_OVERVIEW_GHOST_CLASS
            }
          >
            {OVERVIEW_FILTER_LABEL}
          </button>
        </div>

        {filterOpen ? (
          <div
            data-o1="filter-panel"
            className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
          >
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
            <span className={FF_OVERVIEW_MUTED_CLASS}>Activation</span>
            <select
              value={filters.activation}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  activation: event.target.value as HomeActivationFilter,
                }))
              }
              className={`mt-1 ${FF_OVERVIEW_CONTROL_CLASS}`}
            >
              {HOME_ACTIVATION_FILTERS.map((option) => (
                <option key={option.value || "any"} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className={FF_OVERVIEW_MUTED_CLASS}>Last run</span>
            <select
              value={filters.lastRun}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  lastRun: event.target.value as WorkflowHomeFilters["lastRun"],
                }))
              }
              className={`mt-1 ${FF_OVERVIEW_CONTROL_CLASS}`}
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
            <span className={FF_OVERVIEW_MUTED_CLASS}>Last modified</span>
            <select
              value={filters.lastModified}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  lastModified: event.target.value as WorkflowHomeFilters["lastModified"],
                }))
              }
              className={`mt-1 ${FF_OVERVIEW_CONTROL_CLASS}`}
            >
              <option value="">Any</option>
              <option value="24h">Last 24 hours</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
            </select>
          </label>
          </div>
        ) : null}

        {canCreate ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
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
              <label className={FF_OVERVIEW_GHOST_CLASS}>
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

      <div
        data-x2="pane-surface"
        className="min-h-[12rem]"
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            setPaneSelection(null);
          }
        }}
        onContextMenu={(event) => {
          if (event.defaultPrevented) {
            return;
          }
          setPaneSelection(null);
          openExplorerMenu({ kind: "empty-pane" }, event);
        }}
      >
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
            onNewFolder={() => openCreateFolder()}
          />
          <TemplateGrid
            canCreate={canCreate}
            pending={pending !== null}
            onSelect={(template) => void createFromTemplate(template)}
          />
        </>
      ) : emptyKind === "unfiled" && !paneHasRows ? (
        <UnfiledEmptyFiled
          folders={folders}
          onSelectFolder={selectFolder}
        />
      ) : paneHasRows ? (
        <WorkflowHomeCards
          items={visible}
          folderRows={paneFolders}
          paneRows={paneRows}
          paneSelection={paneSelection}
          pending={pending !== null}
          canCreate={canCreate}
          canMove={canMutateFolders}
          canExecute={canExecute}
          canPublish={canPublish}
          canViewWebhooks={canViewWebhooks}
          canViewSchedules={canViewSchedules}
          canSeeLastRun={canSeeLastRun}
          showFolderPath
          folders={folders}
          onStart={(item) => openHomeOverlay("start", item.id)}
          onTestRun={(item) => void testRunItem(item)}
          onWebhooks={(item) => openHomeOverlay("webhooks", item.id)}
          onSchedules={(item) => openHomeOverlay("schedules", item.id)}
          onDuplicate={(item) => void duplicateItem(item)}
          onExport={(item) => void exportItem(item)}
          onMove={openMoveDialog}
          onSelectFolder={selectFolder}
          onSelectRow={selectPaneRow}
          onOpenRow={openPaneRow}
          onDragStart={setDragging}
          onDragEnd={() => setDragging(null)}
          onWorkflowContextMenu={(item, event) => {
            selectPaneRow({ kind: "workflow", id: item.id });
            openExplorerMenu({ kind: "workflow", id: item.id }, event);
          }}
          onFolderContextMenu={(folder, event) => {
            selectPaneRow({ kind: "folder", id: folder.id });
            openExplorerMenu({ kind: "folder", id: folder.id }, event);
          }}
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
      ) : (
        <WorkflowHomeCards
          items={visible}
          folderRows={paneFolders}
          paneRows={paneRows}
          paneSelection={paneSelection}
          pending={pending !== null}
          canCreate={canCreate}
          canMove={canMutateFolders}
          canExecute={canExecute}
          canPublish={canPublish}
          canViewWebhooks={canViewWebhooks}
          canViewSchedules={canViewSchedules}
          canSeeLastRun={canSeeLastRun}
          showFolderPath
          folders={folders}
          onStart={(item) => openHomeOverlay("start", item.id)}
          onTestRun={(item) => void testRunItem(item)}
          onWebhooks={(item) => openHomeOverlay("webhooks", item.id)}
          onSchedules={(item) => openHomeOverlay("schedules", item.id)}
          onDuplicate={(item) => void duplicateItem(item)}
          onExport={(item) => void exportItem(item)}
          onMove={openMoveDialog}
          onSelectFolder={selectFolder}
          onSelectRow={selectPaneRow}
          onOpenRow={openPaneRow}
          onDragStart={setDragging}
          onDragEnd={() => setDragging(null)}
          onWorkflowContextMenu={(item, event) => {
            selectPaneRow({ kind: "workflow", id: item.id });
            openExplorerMenu({ kind: "workflow", id: item.id }, event);
          }}
          onFolderContextMenu={(folder, event) => {
            selectPaneRow({ kind: "folder", id: folder.id });
            openExplorerMenu({ kind: "folder", id: folder.id }, event);
          }}
        />
      )}
      </div>
      </div>
      </div>
      {explorerMenu ? (
        <ExplorerContextMenu
          items={itemsForExplorerMenu(explorerMenu.target)}
          x={explorerMenu.x}
          y={explorerMenu.y}
          onClose={() => setExplorerMenu(null)}
          onAction={(verb) => {
            const target = explorerMenu.target;
            setExplorerMenu(null);
            runExplorerMenuVerb(target, verb);
          }}
        />
      ) : null}
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

function FinderDisclosureIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      viewBox="0 0 12 12"
      width="12"
      height="12"
      aria-hidden="true"
      className={expanded ? "rotate-90" : undefined}
    >
      <path
        d="M4.2 2.2 9 6 4.2 9.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FinderFolderIcon() {
  return (
    <svg
      data-o2="folder-icon"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden="true"
      className="shrink-0"
    >
      <path
        d="M2 4.5h4.2l1.2 1.3H14V12.2A1.3 1.3 0 0 1 12.7 13.5H3.3A1.3 1.3 0 0 1 2 12.2Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FinderUnfiledIcon() {
  return (
    <svg
      data-o2="unfiled-icon"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden="true"
      className="shrink-0"
    >
      <path
        d="M2.5 6.5 4 3.5h8l1.5 3v6.2A1.3 1.3 0 0 1 12.2 13H3.8A1.3 1.3 0 0 1 2.5 12.7Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M2.5 6.5h11"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
    </svg>
  );
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
  onFolderContextMenu,
  onUnfiledContextMenu,
}: {
  tree: FolderTreeNode[];
  folders: readonly WorkflowFolder[];
  selection: FolderSelection;
  expandedIds: readonly string[];
  canMutate: boolean;
  pending: boolean;
  selectedWorkflowCount: number | null;
  dialog:
    | { kind: "create"; parent?: FolderSelection }
    | { kind: "rename"; id: string }
    | null;
  nameDraft: string;
  nameError: string | null;
  chrome: FolderMutateChrome;
  dragging: WorkflowMoveDragPayload | null;
  railFilter: string;
  onRailFilter: (value: string) => void;
  onSelect: (next: FolderSelection) => void;
  onToggle: (folderId: string) => void;
  onNameDraft: (value: string) => void;
  onCreate: (parent?: FolderSelection) => void;
  onRename: (folderId: string) => void;
  onDelete: (folderId: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onDropWorkflow: (workflowId: string, target: FolderSelection) => void;
  onFolderContextMenu: (
    folderId: string,
    event: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void },
  ) => void;
  onUnfiledContextMenu: (event: {
    clientX: number;
    clientY: number;
    preventDefault(): void;
    stopPropagation(): void;
  }) => void;
}) {
  const unfiledCurrent = selection.kind === "unfiled";
  const createParentId = createFolderParentId(
    dialog?.kind === "create" && dialog.parent ? dialog.parent : selection,
  );
  const canCreateHere = canCreateChildFolder(folders, createParentId);
  const mutateLabel = folderMutateLabel(chrome);
  return (
    <nav
      aria-label={FOLDER_RAIL_LABEL}
      data-home-folder-rail="nav"
      data-o2="finder-rail"
      data-x1="folder-tree"
      data-x2="folder-tree"
      className={`h-full ${FF_OVERVIEW_RAIL_CLASS} ${FF_EXPLORER_TREE_CLASS}`}
    >
      <div className="flex items-start justify-between gap-2 px-2">
        <p className={`text-xs font-medium tracking-wide uppercase ${FF_OVERVIEW_MUTED_CLASS}`}>
          {FOLDER_RAIL_LABEL}
        </p>
        {canMutate ? (
          <button
            type="button"
            data-home-folder-verb="new"
            disabled={pending || !canCreateHere}
            title={!canCreateHere ? FOLDER_DEPTH_HELP : undefined}
            onClick={() => onCreate()}
            className={`shrink-0 ${FF_OVERVIEW_GHOST_CLASS} px-2 py-1 text-xs`}
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
          className={`mt-3 space-y-2 ${FF_OVERVIEW_DIALOG_CLASS} p-2`}
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <label className="block text-sm">
            <span className={FF_OVERVIEW_MUTED_CLASS}>
              {dialog.kind === "create" ? NEW_FOLDER_LABEL : RENAME_FOLDER_LABEL}
            </span>
            <input
              value={nameDraft}
              onChange={(event) => onNameDraft(event.target.value)}
              className={`mt-1 ${FF_OVERVIEW_CONTROL_CLASS}`}
              autoComplete="off"
              maxLength={256}
              aria-invalid={nameError ? true : undefined}
              aria-describedby={
                nameError ? "home-folder-name-error" : "home-folder-name-help"
              }
            />
          </label>
          <p id="home-folder-name-help" className={`text-xs ${FF_OVERVIEW_MUTED_CLASS}`}>
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
              className={`text-xs ${FF_OVERVIEW_DANGER_CLASS}`}
            >
              {nameError}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={pending}
              className={`${FF_OVERVIEW_CREATE_CLASS} px-2 py-1 text-xs`}
            >
              {dialog.kind === "create" ? "Create" : "Save"}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={onCancel}
              className={`${FF_OVERVIEW_GHOST_CLASS} px-2 py-1 text-xs`}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      <label className="mt-3 block px-2 text-sm">
        <span className={FF_OVERVIEW_MUTED_CLASS}>{FOLDER_RAIL_FILTER_LABEL}</span>
        <input
          value={railFilter}
          onChange={(event) => onRailFilter(event.target.value)}
          data-home-folder-rail-filter=""
          className={`mt-1 ${FF_OVERVIEW_CONTROL_CLASS}`}
          autoComplete="off"
        />
      </label>
      <ul className="mt-2 space-y-1">
        <li>
          <button
            type="button"
            data-home-folder-rail="unfiled"
            aria-current={unfiledCurrent ? "true" : undefined}
            onContextMenu={(event) => onUnfiledContextMenu(event)}
            onClick={() => onSelect({ kind: "unfiled" })}
            className={
              (unfiledCurrent
                ? `w-full ${FF_OVERVIEW_RAIL_ACTIVE_CLASS}`
                : `w-full ${FF_OVERVIEW_RAIL_ITEM_CLASS}`) +
              (canMutate &&
              dragging &&
              canDropWorkflowOnFolder(true, dragging.folderId, {
                kind: "unfiled",
              })
                ? " ring-2 ring-[var(--ff-focus-ring)] ring-offset-1 ring-offset-[var(--ff-canvas)]"
                : "")
            }
            {...folderDropHandlers(
              canMutate,
              { kind: "unfiled" },
              dragging,
              onDropWorkflow,
            )}
          >
            <FinderUnfiledIcon />
            <span className="truncate">{UNFILED_FOLDER_LABEL}</span>
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
            onFolderContextMenu={onFolderContextMenu}
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
  onFolderContextMenu,
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
  onFolderContextMenu: (
    folderId: string,
    event: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void },
  ) => void;
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
        className="flex flex-col gap-0.5"
        style={{ paddingLeft: `${(Math.min(depth, 4) - 1) * 0.75}rem` }}
      >
        <div className="flex items-center gap-0.5">
        {hasChildren ? (
          <button
            type="button"
            data-o2="disclosure"
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${node.name}`}
            onClick={() => onToggle(node.id)}
            className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded ${FF_OVERVIEW_MUTED_CLASS}`}
          >
            <FinderDisclosureIcon expanded={expanded} />
          </button>
        ) : (
          <span className="inline-block h-6 w-6 shrink-0" aria-hidden="true" />
        )}
        <button
          type="button"
          data-home-folder-rail="folder"
          data-folder-id={node.id}
          aria-current={selected ? "true" : undefined}
          onContextMenu={(event) => onFolderContextMenu(node.id, event)}
          onClick={() => onSelect({ kind: "folder", id: node.id })}
          className={
            (selected
              ? FF_OVERVIEW_RAIL_ACTIVE_CLASS
              : FF_OVERVIEW_RAIL_ITEM_CLASS) +
            (canMutate &&
            dragging &&
            canDropWorkflowOnFolder(true, dragging.folderId, {
              kind: "folder",
              id: node.id,
            })
              ? " ring-2 ring-[var(--ff-focus-ring)] ring-offset-1 ring-offset-[var(--ff-canvas)]"
              : "")
          }
          {...folderDropHandlers(
            canMutate,
            { kind: "folder", id: node.id },
            dragging,
            onDropWorkflow,
          )}
        >
          <FinderFolderIcon />
          <span className="truncate">{node.name}</span>
        </button>
        </div>
        {canMutate ? (
          <div className="flex flex-wrap gap-1 pl-6">
            <button
              type="button"
              data-home-folder-verb="rename"
              data-folder-id={node.id}
              disabled={pending}
              onClick={() => onRename(node.id)}
              className={`shrink-0 ${FF_OVERVIEW_GHOST_CLASS} px-1.5 py-0.5 text-xs`}
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
              className={`shrink-0 ${FF_OVERVIEW_GHOST_CLASS} px-1.5 py-0.5 text-xs`}
            >
              {DELETE_FOLDER_LABEL}
            </button>
          </div>
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
              onFolderContextMenu={onFolderContextMenu}
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
      data-x1="breadcrumb"
      className={`${FF_EXPLORER_CRUMB_CLASS} flex flex-wrap items-center gap-1 text-sm ${FF_OVERVIEW_MUTED_CLASS}`}
    >
      {crumbs.map((crumb, index) => (
        <span key={`${crumb.label}-${index}`} className="flex items-center gap-1">
          {index > 0 ? <span aria-hidden="true">/</span> : null}
          <button
            type="button"
            onClick={() => onSelect(crumb.selection)}
            className={`font-medium ${FF_OVERVIEW_LINK_CLASS}`}
          >
            {crumb.label}
          </button>
        </span>
      ))}
    </nav>
  );
}

function ExplorerContextMenu({
  items,
  x,
  y,
  onClose,
  onAction,
}: {
  items: ExplorerContextItem[];
  x: number;
  y: number;
  onClose: () => void;
  onAction: (verb: ExplorerContextVerb) => void;
}) {
  const visible = visibleExplorerMenuItems(items);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useEffect(() => {
    const el = menuRef.current;
    if (!el) {
      return;
    }
    setPos(
      explorerMenuPosition(
        x,
        y,
        { width: el.offsetWidth, height: el.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [x, y, visible.length]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (event.defaultPrevented) {
          return;
        }
        event.preventDefault();
        onClose();
      }
    }
    function onPointerDown(event: PointerEvent) {
      if (menuRef.current?.contains(event.target as Node)) {
        return;
      }
      onClose();
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [onClose]);

  if (visible.length === 0) {
    return null;
  }

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={EXPLORER_MENU_LABEL}
      data-x2="context-menu"
      className={`${FF_OVERVIEW_MENU_CLASS} ${FF_EXPLORER_MENU_CLASS}`}
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {visible.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          data-x2-verb={item.id}
          data-x2-mutate={item.mutate ? "true" : undefined}
          disabled={item.disabled}
          title={item.reason}
          className={FF_EXPLORER_MENU_ITEM_CLASS}
          onClick={() => {
            if (item.disabled) {
              return;
            }
            onAction(item.id);
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
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
      <span className={FF_OVERVIEW_MUTED_CLASS}>{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`mt-1 ${FF_OVERVIEW_CONTROL_CLASS}`}
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
      <span className={FF_OVERVIEW_MUTED_CLASS}>{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`mt-1 ${FF_OVERVIEW_CONTROL_CLASS}`}
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
    <p className={`text-xs ${FF_OVERVIEW_MUTED_CLASS}`}>
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
          className={`text-sm font-medium ${FF_OVERVIEW_LINK_CLASS} disabled:opacity-60`}
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
            className={`text-sm font-medium ${FF_OVERVIEW_LINK_CLASS} disabled:opacity-60`}
          >
            Start published
          </button>
        ) : (
          <span className={`text-sm ${FF_OVERVIEW_MUTED_CLASS}`} title="workflow.execute required">
            Start locked
          </span>
        )
      ) : (
        <span
          className={`text-sm ${FF_OVERVIEW_MUTED_CLASS}`}
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
          className={`text-sm font-medium ${FF_OVERVIEW_LINK_CLASS} disabled:opacity-60`}
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
          className={`text-sm font-medium ${FF_OVERVIEW_LINK_CLASS} disabled:opacity-60`}
        >
          Schedules
        </button>
      ) : null}
      <Link
        href={`/workflows/${item.id}`}
        className={`text-sm font-medium ${FF_OVERVIEW_LINK_CLASS}`}
      >
        Open editor
      </Link>
      {canSeeLastRun ? (
        <Link
          href={workflowHomeLastRunHref({
            workflowId: item.id,
            lastRunId: item.lastRunId,
          })}
          className={`text-sm ${FF_OVERVIEW_LINK_CLASS}`}
        >
          Last run
        </Link>
      ) : null}
      {canCreate ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => onDuplicate(item)}
          className={`text-sm ${FF_OVERVIEW_LINK_CLASS} disabled:opacity-60`}
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
          className={`text-sm ${FF_OVERVIEW_LINK_CLASS} disabled:opacity-60`}
        >
          {FOLDER_MOVE_VERB}
        </button>
      ) : null}
      {item.latestVersionId ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => onExport(item)}
          className={`text-sm ${FF_OVERVIEW_LINK_CLASS} disabled:opacity-60`}
        >
          Export
        </button>
      ) : null}
    </div>
  );
}

function WorkflowFolderPath({
  item,
  folders,
  onSelect,
}: {
  item: WorkflowHomeItem;
  folders: readonly WorkflowFolder[];
  onSelect: (next: FolderSelection) => void;
}) {
  const pills = overviewAncestryPills(folders, item.folderId);
  const pathLabel = workflowFolderPathLabel(item);
  if (item.folderId == null) {
    return (
      <span
        data-home-folder-path=""
        data-o2="unfiled"
        className={`text-xs ${FF_OVERVIEW_MUTED_CLASS}`}
      >
        {UNFILED_FOLDER_LABEL}
      </span>
    );
  }
  if (pills.length === 0) {
    return (
      <span
        data-home-folder-path=""
        data-o2="path-pills"
        aria-label={pathLabel}
        className={`text-xs ${FF_OVERVIEW_MUTED_CLASS}`}
      />
    );
  }
  return (
    <nav
      data-home-folder-path=""
      data-o2="path-pills"
      aria-label={pathLabel}
      className="mt-1 flex flex-wrap items-center gap-1"
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {pills.map((pill, index) => (
        <span key={pill.id} className="flex items-center gap-1">
          {index > 0 ? (
            <span aria-hidden="true" className={FF_OVERVIEW_MUTED_CLASS}>
              /
            </span>
          ) : null}
          <button
            type="button"
            data-o2="path-pill"
            data-folder-id={pill.id}
            title={FOLDER_PATH_REVEAL_LABEL}
            onClick={() => onSelect({ kind: "folder", id: pill.id })}
            className={FF_OVERVIEW_PILL_CLASS}
          >
            {pill.name}
          </button>
        </span>
      ))}
    </nav>
  );
}

function WorkflowHomeCards({
  items,
  folderRows = [],
  paneRows,
  paneSelection,
  pending,
  canCreate,
  canMove,
  canExecute,
  canPublish,
  canViewWebhooks,
  canViewSchedules,
  canSeeLastRun,
  showFolderPath,
  folders,
  onStart,
  onTestRun,
  onWebhooks,
  onSchedules,
  onDuplicate,
  onExport,
  onMove,
  onSelectFolder,
  onSelectRow,
  onOpenRow,
  onDragStart,
  onDragEnd,
  onWorkflowContextMenu,
  onFolderContextMenu,
}: {
  items: WorkflowHomeItem[];
  folderRows?: readonly WorkflowFolder[];
  paneRows: readonly ExplorerPaneRow[];
  paneSelection: ExplorerPaneRow | null;
  pending: boolean;
  canCreate: boolean;
  canMove: boolean;
  canExecute: boolean;
  canPublish: boolean;
  canViewWebhooks: boolean;
  canViewSchedules: boolean;
  canSeeLastRun: boolean;
  showFolderPath: boolean;
  folders: readonly WorkflowFolder[];
  onStart: (item: WorkflowHomeItem) => void;
  onTestRun: (item: WorkflowHomeItem) => void;
  onWebhooks: (item: WorkflowHomeItem) => void;
  onSchedules: (item: WorkflowHomeItem) => void;
  onDuplicate: (item: WorkflowHomeItem) => void;
  onExport: (item: WorkflowHomeItem) => void;
  onMove: (item: WorkflowHomeItem) => void;
  onSelectFolder: (next: FolderSelection) => void;
  onSelectRow: (row: ExplorerPaneRow) => void;
  onOpenRow: (row: ExplorerPaneRow) => void;
  onDragStart: (payload: WorkflowMoveDragPayload) => void;
  onDragEnd: () => void;
  onWorkflowContextMenu: (
    item: WorkflowHomeItem,
    event: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void },
  ) => void;
  onFolderContextMenu: (
    folder: WorkflowFolder,
    event: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void },
  ) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);

  function focusPaneList() {
    listRef.current?.focus();
  }

  return (
    <div data-o1="card-list" data-x1="content-list">
      <div
        className="sr-only"
        aria-hidden="true"
        data-home-row-scan="columns"
      >
        {WORKFLOW_HOME_LIST_COLUMNS.map((column) => (
          <span key={column.id} data-home-row-scan-column={column.id}>
            {column.label}
          </span>
        ))}
      </div>
      <ul
        ref={listRef}
        role="listbox"
        tabIndex={0}
        aria-label={EXPLORER_PANE_LABEL}
        aria-activedescendant={
          paneSelection
            ? `explorer-row-${explorerPaneRowKey(paneSelection)}`
            : undefined
        }
        data-x3="pane-list"
        className={FF_EXPLORER_LIST_CLASS}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            if (!paneSelection) {
              return;
            }
            event.preventDefault();
            onOpenRow(paneSelection);
            return;
          }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const next = explorerAdvancePaneSelection(
              paneRows,
              paneSelection,
              event.key === "ArrowDown" ? "next" : "prev",
            );
            if (next) {
              onSelectRow(next);
            }
          }
        }}
      >
        {folderRows.map((folder) => {
          const row: ExplorerPaneRow = { kind: "folder", id: folder.id };
          const selected = explorerPaneRowEquals(row, paneSelection);
          return (
          <li
            key={`folder-${folder.id}`}
            id={`explorer-row-${explorerPaneRowKey(row)}`}
            role="option"
            aria-selected={selected}
            className={`${OVERVIEW_CARD_SURFACE_CLASS} ${FF_EXPLORER_ROW_CLASS}${
              selected ? ` ${FF_EXPLORER_ROW_SELECTED_CLASS}` : ""
            }`}
            data-x1="content-row"
            data-x2="folder-row"
            data-x3="pane-row"
            data-x3-kind="folder"
            data-x3-selected={selected ? "true" : undefined}
            data-folder-id={folder.id}
            onClick={(event) => {
              event.stopPropagation();
              onSelectRow(row);
              focusPaneList();
            }}
            onDoubleClick={(event) => {
              event.stopPropagation();
              onOpenRow(row);
            }}
            onContextMenu={(event) => onFolderContextMenu(folder, event)}
          >
            <div className={FF_OVERVIEW_CARD_ROW_CLASS}>
              <div
                className={`${FF_OVERVIEW_TITLE_CLASS} flex min-w-0 flex-1 items-center gap-2 text-sm`}
              >
                <FinderFolderIcon />
                <span className="truncate">{folder.name}</span>
              </div>
            </div>
          </li>
          );
        })}
        {items.map((item) => {
          const dates = overviewCardTimestamps(item);
          const published = overviewPublishedBadge(item.status);
          const row: ExplorerPaneRow = { kind: "workflow", id: item.id };
          const selected = explorerPaneRowEquals(row, paneSelection);
          return (
            <li
              key={item.id}
              id={`explorer-row-${explorerPaneRowKey(row)}`}
              role="option"
              aria-selected={selected}
              className={`${OVERVIEW_CARD_SURFACE_CLASS} ${FF_EXPLORER_ROW_CLASS}${
                selected ? ` ${FF_EXPLORER_ROW_SELECTED_CLASS}` : ""
              }`}
              data-o1="card"
              data-x1="content-row"
              data-x2="content-row"
              data-x3="pane-row"
              data-x3-kind="workflow"
              data-x3-selected={selected ? "true" : undefined}
              data-home-row-scan="card"
              onClick={(event) => {
                event.stopPropagation();
                onSelectRow(row);
                focusPaneList();
              }}
              onDoubleClick={(event) => {
                event.stopPropagation();
                onOpenRow(row);
              }}
              onContextMenu={(event) => onWorkflowContextMenu(item, event)}
              {...workflowRowDragProps(canMove, item, onDragStart, onDragEnd)}
            >
              <div className={FF_OVERVIEW_CARD_ROW_CLASS}>
                <div
                  data-home-row-scan-cell="activation"
                  className={FF_OVERVIEW_SCAN_LEAD_CLASS}
                >
                  <HomeActivationStatus column={item.activation} />
                </div>
                <div className="min-w-0 flex-1">
                  <span
                    data-o1="card-name"
                    className={`${FF_OVERVIEW_TITLE_CLASS} text-sm`}
                  >
                    {item.name}
                  </span>
                  {showFolderPath ? (
                    <WorkflowFolderPath
                      item={item}
                      folders={folders}
                      onSelect={onSelectFolder}
                    />
                  ) : null}
                </div>
                <p
                  className={`text-sm ${FF_OVERVIEW_MUTED_CLASS}`}
                  data-o1="card-dates"
                >
                  {dates.line}
                </p>
                {published.shown ? (
                  <span
                    data-o1="published"
                    className={FF_OVERVIEW_CHIP_CLASS}
                  >
                    {OVERVIEW_PUBLISHED_LABEL}
                  </span>
                ) : null}
                <div
                  data-home-row-scan-cell="lastRun"
                  className={FF_OVERVIEW_SCAN_TRAIL_CLASS}
                >
                  <HomeLastRunStatus
                    item={item}
                    canSeeLastRun={canSeeLastRun}
                  />
                </div>
                <details
                  data-o1="kebab"
                  className="relative"
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelectRow(row);
                  }}
                  onDoubleClick={(event) => event.stopPropagation()}
                >
                  <summary
                    aria-label={OVERVIEW_KEBAB_LABEL}
                    className={`${FF_OVERVIEW_KEBAB_CLASS} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}
                  >
                    ⋮
                  </summary>
                  <div className={`absolute right-0 z-10 mt-1 w-64 space-y-3 ${FF_OVERVIEW_MENU_CLASS}`}>
                    <WorkflowMeta item={item} />
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
                </details>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
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
    <div
      data-o1="card-list"
      data-o3={unfiledEmpty ? "unfiled-empty" : "empty-home"}
    >
      <ul className="space-y-2">
        <li
          className={OVERVIEW_CARD_SURFACE_CLASS}
          data-o1="card"
          data-o3="empty-card"
          data-uxl6="home-empty"
          data-f5={unfiledEmpty ? "unfiled-empty-none" : "home-empty"}
        >
          <h2 className={`text-base ${FF_OVERVIEW_TITLE_CLASS}`}>
            {unfiledEmpty ? UNFILED_EMPTY_HEADING : HOME_EMPTY_HEADING}
          </h2>
          <p className={`mt-1 text-sm ${FF_OVERVIEW_MUTED_CLASS}`}>
            {unfiledEmpty ? UNFILED_EMPTY_NONE_HELP : HOME_EMPTY_HELP}
          </p>
          {canCreate || canCreateFolder ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {canCreate ? (
                <>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={onCreate}
                    className={FF_OVERVIEW_CREATE_CLASS}
                  >
                    {HOME_EMPTY_CREATE_LABEL}
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={onImport}
                    className={FF_OVERVIEW_GHOST_CLASS}
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
                  className={FF_OVERVIEW_GHOST_CLASS}
                >
                  {NEW_FOLDER_LABEL}
                </button>
              ) : null}
            </div>
          ) : (
            <p className={`mt-3 text-xs ${FF_OVERVIEW_MUTED_CLASS}`}>
              Creating a draft requires <code className="font-mono">workflow.edit</code>.
            </p>
          )}
        </li>
      </ul>
    </div>
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
    <div data-o1="card-list" data-o3="empty-folder">
      <ul className="space-y-2">
        <li
          className={OVERVIEW_CARD_SURFACE_CLASS}
          data-o1="card"
          data-o3="empty-card"
          data-f5="folder-empty"
        >
          <h2 className={`text-base ${FF_OVERVIEW_TITLE_CLASS}`}>
            {FOLDER_EMPTY_HEADING}
          </h2>
          <p className={`mt-1 text-sm ${FF_OVERVIEW_MUTED_CLASS}`}>{FOLDER_EMPTY_HELP}</p>
          {canCreate || canMutate ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {canCreate ? (
                <>
                  <button
                    type="button"
                    data-home-folder-empty-verb="create"
                    disabled={pending}
                    onClick={onCreate}
                    className={FF_OVERVIEW_CREATE_CLASS}
                  >
                    {FOLDER_EMPTY_CREATE_LABEL}
                  </button>
                  <button
                    type="button"
                    data-home-folder-empty-verb="import"
                    disabled={pending}
                    onClick={onImport}
                    className={FF_OVERVIEW_GHOST_CLASS}
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
                    className={FF_OVERVIEW_GHOST_CLASS}
                  >
                    {FOLDER_EMPTY_MOVE_LABEL}
                  </button>
                  <button
                    type="button"
                    data-home-folder-empty-verb="delete"
                    disabled={pending || !deleteAllowed}
                    title={deleteAllowed ? undefined : FOLDER_NOT_EMPTY_HELP}
                    onClick={onDelete}
                    className={FF_OVERVIEW_GHOST_CLASS}
                  >
                    {DELETE_FOLDER_LABEL}
                  </button>
                </>
              ) : null}
            </div>
          ) : (
            <p className={`mt-3 text-xs ${FF_OVERVIEW_MUTED_CLASS}`}>{FOLDER_EMPTY_VIEWER_HELP}</p>
          )}
        </li>
      </ul>
    </div>
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
    <div data-o1="card-list" data-o3="unfiled-empty">
      <ul className="space-y-2">
        <li
          className={OVERVIEW_CARD_SURFACE_CLASS}
          data-o1="card"
          data-o3="empty-card"
          data-f5="unfiled-empty-filed"
        >
          <h2 className={`text-base ${FF_OVERVIEW_TITLE_CLASS}`}>
            {UNFILED_EMPTY_HEADING}
          </h2>
          <p className={`mt-1 text-sm ${FF_OVERVIEW_MUTED_CLASS}`}>{UNFILED_EMPTY_FILED_HELP}</p>
          <p className={`mt-1 text-sm ${FF_OVERVIEW_MUTED_CLASS}`}>{UNFILED_EMPTY_TREE_LABEL}.</p>
          {tree.length > 0 ? (
            <ul className="mt-3 flex flex-wrap gap-1">
              {tree.map((node) => (
                <li key={node.id}>
                  <button
                    type="button"
                    data-f5="unfiled-empty-tree"
                    data-folder-id={node.id}
                    onClick={() => onSelectFolder({ kind: "folder", id: node.id })}
                    className={FF_OVERVIEW_PILL_CLASS}
                  >
                    {node.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      </ul>
    </div>
  );
}

function HomeFilteredEmpty({ onClear }: { onClear: () => void }) {
  return (
    <div data-o1="card-list" data-o3="filtered-empty">
      <ul className="space-y-2">
        <li
          className={OVERVIEW_CARD_SURFACE_CLASS}
          data-o1="card"
          data-o3="empty-card"
          data-uxl6="home-filtered"
        >
          <h2 className={`text-base ${FF_OVERVIEW_TITLE_CLASS}`}>
            {HOME_FILTERED_EMPTY_HEADING}
          </h2>
          <p className={`mt-1 text-sm ${FF_OVERVIEW_MUTED_CLASS}`}>{HOME_FILTERED_EMPTY_HELP}</p>
          <button
            type="button"
            onClick={onClear}
            className={`mt-3 text-sm font-medium ${FF_OVERVIEW_LINK_CLASS}`}
          >
            Clear filters
          </button>
        </li>
      </ul>
    </div>
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
    <div data-o1="card-list" data-o3="template-cards">
      <h2 className={`text-base ${FF_OVERVIEW_TITLE_CLASS}`}>Reviewed templates</h2>
      <p className={`mt-1 text-sm ${FF_OVERVIEW_MUTED_CLASS}`}>{HOME_EMPTY_TEMPLATE_HELP}</p>
      <ul className="mt-3 space-y-2">
        {WORKFLOW_TEMPLATES.map((template) => (
          <li
            key={template.id}
            className={OVERVIEW_CARD_SURFACE_CLASS}
            data-o1="card"
            data-o3="template-card"
          >
            <h3 className={`text-base ${FF_OVERVIEW_TITLE_CLASS}`}>{template.title}</h3>
            <p className={`mt-1 text-sm ${FF_OVERVIEW_MUTED_CLASS}`}>{template.description}</p>
            {canCreate ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => onSelect(template)}
                className={`mt-3 ${FF_OVERVIEW_CREATE_CLASS}`}
              >
                {HOME_EMPTY_TEMPLATE_LABEL}
              </button>
            ) : (
              <p className={`mt-3 text-xs ${FF_OVERVIEW_MUTED_CLASS}`}>
                Requires <code className="font-mono">workflow.edit</code>
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
