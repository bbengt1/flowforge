"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { IsolationIdentityPanel } from "@/components/isolation/IsolationIdentityPanel";
import { ProblemBanner } from "@/components/ProblemBanner";
import { evaluatePolicyForRun, listExecutionApprovals } from "@/lib/approval-client";
import type { ApprovalRequest, PolicyEvaluation } from "@/lib/approval-types";
import { shouldBlockRun } from "@/lib/approval";
import { ActionLibrary } from "@/components/workflows/ActionLibrary";
import { ActionWizard } from "@/components/workflows/ActionWizard";
import { DraftConflictBanner } from "@/components/workflows/DraftConflictBanner";
import { EditorChrome } from "@/components/workflows/EditorChrome";
import { EditorInspector } from "@/components/workflows/EditorInspector";
import { EditorStartDialog } from "@/components/workflows/EditorStartDialog";
import { EditorRunsDrawer } from "@/components/workflows/EditorRunsDrawer";
import { EditorTopBar } from "@/components/workflows/EditorTopBar";
import { EditorYamlDrawer } from "@/components/workflows/EditorYamlDrawer";
import { EditorYamlTools } from "@/components/workflows/EditorYamlTools";
import { RunControl } from "@/components/workflows/RunControl";
import { ValidationPanel } from "@/components/workflows/ValidationPanel";
import { WorkflowCanvas, type EditorSelection } from "@/components/workflows/WorkflowCanvas";
import { YamlEditor } from "@/components/workflows/YamlEditor";
import { ScriptPublishStatus } from "@/components/workflows/ScriptPublishStatus";
import {
  EDITOR_INSPECTOR_FIRST_MEDIA,
  editorDrawerAfterEscape,
  editorDrawerToClose,
  editorInspectorIsDrawer,
  editorRestoreDrawerFocus,
  editorSelectionAnnouncement,
  type EditorDrawerId,
} from "@/lib/e12-accessibility-contract";
import {
  EDITOR_YAML_OPEN_ON_FIRST_PAINT,
  canPublishLastSavedDraft,
  editorCommandAppliesToRoute,
  editorWorkspaceSessionKey,
} from "@/lib/editor-chrome";
import {
  EDITOR_LIBRARY_DEFAULT_OPEN,
  readLibraryOpenPreference,
  rememberLibraryOpen,
  subscribeLibraryOpenPreference,
} from "@/lib/editor-library";
import {
  EDITOR_NDV_DEFAULT_OPEN,
  readInspectorOpenPreference,
  rememberInspectorFocus,
  rememberInspectorOpen,
  subscribeInspectorOpenPreference,
} from "@/lib/editor-ndv";
import {
  canRedoCanvasHistory,
  canUndoCanvasHistory,
  emptyCanvasHistory,
  isCanvasRedoShortcut,
  isCanvasUndoShortcut,
  pruneCanvasLayout,
  pushCanvasHistory,
  redoCanvasHistory,
  replaceCanvasHistoryPresent,
  shortcutTargetIsEditable,
  undoCanvasHistory,
  type CanvasLayout,
  type CanvasPoint,
} from "@/lib/editor-canvas-history";
import { EDITOR_RUNS_OPEN_ON_FIRST_PAINT } from "@/lib/editor-runs";
import {
  EDITOR_RUN_OVERLAY_HELP,
  editorRunCurrentNodeId,
  editorRunOverlayAnnouncement,
  editorRunOverlayGraph,
  editorRunIoForNode,
  editorRunShouldPoll,
  editorRunWaitingNodeIds,
} from "@/lib/editor-run-io";
import {
  getExecutionStepLogs,
  loadExecutionHistory,
  pollExecutionStatus,
} from "@/lib/execution-client";
import { EXECUTION_STATUS_POLL_MS } from "@/lib/execution-contract";
import type { ExecutionDetail, ExecutionLogSlice } from "@/lib/execution-types";
import { getKubernetesCatalog } from "@/lib/kubernetes-client";
import type { KubernetesEngineCatalog } from "@/lib/kubernetes-types";
import { getSshCatalog } from "@/lib/ssh-client";
import type { SshNodeCatalog } from "@/lib/ssh-node-contract";
import { getHttpNotificationCatalog } from "@/lib/core-http-notification-client";
import type { HttpNotificationCatalog } from "@/lib/core-http-notification-contract";
import { getScriptArtifact, getScriptCatalog, listWorkflowScriptArtifacts } from "@/lib/script-client";
import {
  scriptArtifactStatus,
  yamlHasScriptNodes,
  type ScriptArtifact,
  type ScriptNodeCatalog,
  type ScriptVersionPin,
} from "@/lib/script-contract";
import {
  SCRIPT_REVOKED_RUN_BLOCK_HELP,
  hasRevokedScriptPin,
} from "@/lib/script-ops-contract";
import {
  adaptActionLibrary,
  rejectDisabledActionType,
  type ActionLibraryEntry,
} from "@/lib/workflow-action-library";
import {
  canSaveWorkflowEditor,
  connectGraphEdge,
  disconnectGraphEdge,
  editorHasLocalInvalidations,
  projectCanvasGraph,
  removeGraphNode,
} from "@/lib/workflow-graph";
import {
  applyCoreNodeConfig,
  insertCatalogNode,
  listYamlNodes,
  updateYamlNode,
  type CoreNodeWith,
} from "@/lib/workflow-yaml-nodes";
import { sanitizeInspectorWithPatch } from "@/lib/editor-inspector";
import { CredentialWizardDialog } from "@/components/credentials/CredentialWizardDialog";
import {
  SELECT_CREDENTIAL_PARAM,
  createdCredentialSelectable,
  inspectorCreatedCredentialPatch,
  parseInspectorCreatedCredential,
  stripInspectorCredentialQuery,
  type InspectorAddCredentialRequest,
  type InspectorPendingCredential,
} from "@/lib/editor-credential";
import { loadDevIdentity, emptyStoredIdentity, subscribeDevIdentity } from "@/lib/dev-identity";
import { loadHeaderFallback, subscribeHeaderFallback } from "@/lib/header-fallback";
import { hasOperatorCaller, hasWorkspaceLookup } from "@/lib/identity-headers";
import { listWorkflowVersionPins } from "@/lib/ops-config-client";
import type { OpsConfigPin } from "@/lib/ops-config-types";
import type { ProblemDetails } from "@/lib/problem";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";
import { loadDeveloperYaml } from "@/lib/editor-developer";
import {
  draftCompareRef,
  STARTER_WORKFLOW_YAML,
  VALIDATE_DEBOUNCE_MS,
  versionCompareRef,
} from "@/lib/workflow";
import {
  canStartPublishedRun,
  publishedRunVersions,
} from "@/lib/execution-replay";
import { PRE_RUN_PUBLISHED_ONLY_HELP } from "@/lib/execution-contract";
import {
  MANUAL_START_FORBIDDEN_MESSAGE,
  buildManualStartRequest,
  generateManualStartIdempotencyKey,
  isManualStartAuthFailure,
  manualStartAuthFailureMessage,
} from "@/lib/manual-start-contract";
import { canExecuteWorkflows } from "@/lib/workspace-nav";
import {
  compareWorkflow,
  exportWorkflowVersion,
  fetchWorkflowCatalog,
  getWorkflow,
  getWorkflowDraft,
  getWorkflowExecution,
  getWorkflowVersion,
  listWorkflows,
  listWorkflowVersions,
  normalizeWorkflowYaml,
  publishWorkflow,
  restoreWorkflowVersion,
  saveCanonicalWorkflowDraft,
  startWorkflowExecution,
  validateWorkflowYaml,
} from "@/lib/workflow-client";
import type {
  CompareWorkflowResult,
  WorkflowCatalog,
  WorkflowDraft,
  WorkflowExecution,
  WorkflowFieldError,
  WorkflowRecord,
  WorkflowSummary,
  WorkflowVersion,
} from "@/lib/workflow-types";
import { useWorkspace } from "@/components/shell/WorkspaceProvider";
import { subscribeWorkspaceCommands } from "@/lib/workspace-commands";
import { pushNotification } from "@/lib/workspace-notifications";
import type { WizardFeedback } from "@/lib/workflow-action-wizard";

type WorkflowOperatorProps = {
  workflowId?: string;
};

export function WorkflowOperator({ workflowId }: WorkflowOperatorProps = {}) {
  const identity = useSyncExternalStore(
    subscribeDevIdentity,
    loadDevIdentity,
    emptyStoredIdentity,
  );
  return (
    <WorkflowOperatorSession
      key={editorWorkspaceSessionKey(identity, workflowId)}
      workflowId={workflowId}
    />
  );
}

function WorkflowOperatorSession({ workflowId }: WorkflowOperatorProps) {
  const identity = useSyncExternalStore(
    subscribeDevIdentity,
    loadDevIdentity,
    emptyStoredIdentity,
  );
  const session = useSyncExternalStore(
    subscribeSession,
    getSessionSnapshot,
    getSessionSnapshot,
  );
  const headerFallback = useSyncExternalStore(
    subscribeHeaderFallback,
    loadHeaderFallback,
    () => false,
  );

  const [yaml, setYaml] = useState(STARTER_WORKFLOW_YAML);
  const [history, setHistory] = useState(() => emptyCanvasHistory(STARTER_WORKFLOW_YAML));
  const [savedYaml, setSavedYaml] = useState("");
  const [catalog, setCatalog] = useState<WorkflowCatalog | null>(null);
  const [engineCatalog, setEngineCatalog] = useState<KubernetesEngineCatalog | null>(
    null,
  );
  const [sshCatalog, setSshCatalog] = useState<SshNodeCatalog | null>(null);
  const [scriptCatalog, setScriptCatalog] = useState<ScriptNodeCatalog | null>(
    null,
  );
  const [httpCatalog, setHttpCatalog] = useState<HttpNotificationCatalog | null>(
    null,
  );
  const [scriptArtifacts, setScriptArtifacts] = useState<
    Record<string, ScriptVersionPin[]>
  >({});
  const [scriptArtifactRecords, setScriptArtifactRecords] = useState<
    Record<string, ScriptArtifact>
  >({});
  const [status, setStatus] = useState<"idle" | "pending" | "valid" | "invalid">(
    "idle",
  );
  const [errors, setErrors] = useState<WorkflowFieldError[]>([]);
  const [warnings, setWarnings] = useState<WorkflowFieldError[]>([]);
  const [summary, setSummary] = useState<WorkflowSummary | null>(null);
  const [digest, setDigest] = useState<string | null>(null);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [focusLine, setFocusLine] = useState<number | null>(null);
  const [focusToken, setFocusToken] = useState(0);
  const [lastRequestId, setLastRequestId] = useState<string | null>(null);

  const [workflow, setWorkflow] = useState<WorkflowRecord | null>(null);
  const [revision, setRevision] = useState<number | null>(null);
  const [publishNote, setPublishNote] = useState("");
  const libraryOpen = useSyncExternalStore(
    subscribeLibraryOpenPreference,
    readLibraryOpenPreference,
    () => EDITOR_LIBRARY_DEFAULT_OPEN,
  );
  const [yamlOpen, setYamlOpen] = useState(EDITOR_YAML_OPEN_ON_FIRST_PAINT);
  const [runsOpen, setRunsOpen] = useState(EDITOR_RUNS_OPEN_ON_FIRST_PAINT);
  const inspectorOpen = useSyncExternalStore(
    subscribeInspectorOpenPreference,
    readInspectorOpenPreference,
    () => EDITOR_NDV_DEFAULT_OPEN,
  );
  const [lastOpenedDrawer, setLastOpenedDrawer] = useState<EditorDrawerId | null>(
    null,
  );
  const [selectionAnnouncement, setSelectionAnnouncement] = useState("");
  const [startOpen, setStartOpen] = useState(false);
  const [publishedVersion, setPublishedVersion] = useState<WorkflowVersion | null>(
    null,
  );
  const [conflictDraft, setConflictDraft] = useState<WorkflowDraft | null>(null);
  const [conflictProblem, setConflictProblem] = useState<ProblemDetails | null>(
    null,
  );
  const [versions, setVersions] = useState<WorkflowVersion[]>([]);
  const [compareLeft, setCompareLeft] = useState<string>("draft");
  const [compareRight, setCompareRight] = useState("");
  const [compare, setCompare] = useState<CompareWorkflowResult | null>(null);
  const [runVersionId, setRunVersionId] = useState("");
  const [runVersion, setRunVersion] = useState<WorkflowVersion | null>(null);
  const [runIdempotencyKey, setRunIdempotencyKey] = useState(
    generateManualStartIdempotencyKey,
  );
  const [runTriggerInput, setRunTriggerInput] = useState("");
  const [runFieldValues, setRunFieldValues] = useState<Record<string, string>>(
    {},
  );
  const [lastStartStatus, setLastStartStatus] = useState<number | null>(null);
  const [execution, setExecution] = useState<WorkflowExecution | null>(null);
  const [policyEval, setPolicyEval] = useState<PolicyEvaluation | null>(null);
  const [policyEvalProblem, setPolicyEvalProblem] =
    useState<ProblemDetails | null>(null);
  const [policyEvalPending, setPolicyEvalPending] = useState(false);
  const [executionApprovals, setExecutionApprovals] = useState<
    ApprovalRequest[]
  >([]);
  const [versionPins, setVersionPins] = useState<Record<string, OpsConfigPin[]>>(
    {},
  );
  const [paletteQuery, setPaletteQuery] = useState("");
  const [selection, setSelection] = useState<EditorSelection>({ kind: "workflow" });
  const [focusColumn, setFocusColumn] = useState<number | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardType, setWizardType] = useState<string | undefined>();
  const [wizardFeedback, setWizardFeedback] = useState<WizardFeedback>("idle");
  const [addCredential, setAddCredential] =
    useState<InspectorAddCredentialRequest | null>(null);
  const [credentialRefreshNonce, setCredentialRefreshNonce] = useState(0);
  const [pendingCredentials, setPendingCredentials] = useState<
    Record<string, InspectorPendingCredential>
  >({});
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<ExecutionDetail | null>(null);
  const [selectedRunLogs, setSelectedRunLogs] = useState<
    Record<string, ExecutionLogSlice>
  >({});
  const [selectedRunPending, setSelectedRunPending] = useState(false);
  const [selectedRunProblem, setSelectedRunProblem] =
    useState<ProblemDetails | null>(null);
  const [selectedRunStrippedKeys, setSelectedRunStrippedKeys] = useState<
    string[]
  >([]);
  const [selectedRunApprovals, setSelectedRunApprovals] = useState<
    ApprovalRequest[]
  >([]);
  const { permissions } = useWorkspace();
  const inspectorFirst = useSyncExternalStore(
    subscribeInspectorFirstBreakpoint,
    readInspectorFirstBreakpoint,
    () => false,
  );

  const validateSeq = useRef(0);
  const skipDebounce = useRef(false);
  const yamlRef = useRef(yaml);
  yamlRef.current = yaml;
  const historyRef = useRef(history);
  historyRef.current = history;
  const createdCredentialReturn = useRef<
    ReturnType<typeof parseInspectorCreatedCredential> | undefined
  >(undefined);

  const yamlNodes = listYamlNodes(yaml);

  function announceSelection(next: EditorSelection) {
    if (next.kind === "node") {
      const node = yamlNodes.find((item) => item.id === next.id);
      if (selectedRun) {
        setSelectionAnnouncement(
          editorRunOverlayAnnouncement({
            nodeId: next.id,
            nodeName: node?.name,
            nodeType: node?.type,
            io: editorRunIoForNode(selectedRun, next.id),
          }),
        );
      } else {
        setSelectionAnnouncement(
          editorSelectionAnnouncement({
            kind: "node",
            id: next.id,
            name: node?.name,
            type: node?.type,
          }),
        );
      }
      rememberInspectorFocus(next);
      return;
    }
    if (next.kind === "edge") {
      setSelectionAnnouncement(
        editorSelectionAnnouncement({
          kind: "edge",
          from: next.from,
          to: next.to,
        }),
      );
      rememberInspectorFocus(next);
      return;
    }
    setSelectionAnnouncement(editorSelectionAnnouncement({ kind: "workflow" }));
  }

  function applySelection(next: EditorSelection) {
    setSelection(next);
    announceSelection(next);
  }

  function layoutForYaml(nextYaml: string, layout: CanvasLayout): CanvasLayout {
    return pruneCanvasLayout(
      layout,
      listYamlNodes(nextYaml).map((node) => node.id),
    );
  }

  function writeGraphYaml(nextYaml: string, layout?: CanvasLayout) {
    setHistory((current) =>
      pushCanvasHistory(current, {
        yaml: nextYaml,
        layout: layoutForYaml(nextYaml, layout ?? current.present.layout),
      }),
    );
    if (nextYaml !== yamlRef.current) {
      setDigest(null);
      setYaml(nextYaml);
    }
  }

  function syncHistoryYaml(nextYaml: string) {
    setHistory((current) =>
      replaceCanvasHistoryPresent(current, {
        yaml: nextYaml,
        layout: current.present.layout,
      }),
    );
    setYaml(nextYaml);
  }

  function applyHistorySnapshot(nextYaml: string) {
    if (nextYaml !== yamlRef.current) {
      setDigest(null);
      setYaml(nextYaml);
    }
  }

  function undoGraph() {
    const result = undoCanvasHistory(historyRef.current);
    if (!result) {
      return;
    }
    setHistory(result.state);
    applyHistorySnapshot(result.applied.yaml);
  }

  function redoGraph() {
    const result = redoCanvasHistory(historyRef.current);
    if (!result) {
      return;
    }
    setHistory(result.state);
    applyHistorySnapshot(result.applied.yaml);
  }

  function moveCanvasNode(id: string, position: CanvasPoint) {
    writeGraphYaml(yamlRef.current, {
      ...historyRef.current.present.layout,
      [id]: position,
    });
  }

  function removeCanvasSelection() {
    if (selection.kind === "node") {
      writeGraphYaml(removeGraphNode(yamlRef.current, selection.id));
      applySelection({ kind: "workflow" });
      return;
    }
    if (selection.kind === "edge") {
      writeGraphYaml(
        disconnectGraphEdge(yamlRef.current, selection.from, selection.to),
      );
      applySelection({ kind: "workflow" });
    }
  }

  function clearSelectedRun() {
    setSelectedRunId(null);
    setSelectedRun(null);
    setSelectedRunLogs({});
    setSelectedRunProblem(null);
    setSelectedRunStrippedKeys([]);
    setSelectedRunApprovals([]);
    setSelectedRunPending(false);
  }

  async function loadSelectedRunLogs(
    executionId: string,
    steps: ExecutionDetail["steps"],
  ) {
    const next: Record<string, ExecutionLogSlice> = {};
    await Promise.all(
      steps.map(async (step) => {
        const logs = await getExecutionStepLogs(identity, executionId, step.id);
        if (logs.ok) {
          next[step.id] = logs.logs;
        }
      }),
    );
    if (Object.keys(next).length > 0) {
      setSelectedRunLogs((current) => ({ ...current, ...next }));
    }
  }

  async function selectRun(executionId: string) {
    const scopedId = workflow?.id ?? workflowId ?? "";
    setSelectedRunId(executionId);
    setSelectedRunPending(true);
    setSelectedRunProblem(null);
    const result = await loadExecutionHistory(identity, executionId, scopedId);
    setSelectedRunPending(false);
    if (!result.ok) {
      setSelectedRunProblem(result.problem);
      if (result.forbidden) {
        setSelectedRun(null);
        setSelectedRunLogs({});
        setSelectedRunApprovals([]);
      }
      return;
    }
    setSelectedRun(result.execution);
    setSelectedRunStrippedKeys(result.strippedKeys);
    void loadSelectedRunLogs(result.execution.id, result.execution.steps);
    let waitingIds: string[] = [];
    if (scopedId) {
      const approvals = await listExecutionApprovals(
        identity,
        scopedId,
        result.execution.id,
      );
      if (approvals.ok) {
        setSelectedRunApprovals(approvals.items);
        waitingIds = editorRunWaitingNodeIds(approvals.items);
      }
    }
    const currentId = editorRunCurrentNodeId(
      result.execution.steps,
      waitingIds,
    );
    if (currentId && yamlNodes.some((node) => node.id === currentId)) {
      const node = yamlNodes.find((item) => item.id === currentId);
      setSelection({ kind: "node", id: currentId });
      setSelectionAnnouncement(
        editorRunOverlayAnnouncement({
          nodeId: currentId,
          nodeName: node?.name,
          nodeType: node?.type,
          io: editorRunIoForNode(result.execution, currentId),
        }),
      );
      rememberInspectorOpen(true);
    } else {
      rememberInspectorOpen(true);
    }
  }

  function setDrawerOpen(id: EditorDrawerId, open: boolean) {
    if (id === "library") {
      rememberLibraryOpen(open);
    }
    if (id === "yaml") {
      setYamlOpen(open);
    }
    if (id === "runs") {
      setRunsOpen(open);
    }
    if (id === "inspector") {
      rememberInspectorOpen(open);
    }
    if (open) {
      setLastOpenedDrawer(id);
    }
  }

  function toggleDrawer(id: EditorDrawerId) {
    const current =
      id === "library"
        ? libraryOpen
        : id === "yaml"
          ? yamlOpen
          : id === "runs"
            ? runsOpen
            : inspectorOpen;
    setDrawerOpen(id, !current);
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      if (wizardOpen || startOpen || addCredential) {
        return;
      }
      const closer = editorDrawerToClose(
        {
          library: libraryOpen,
          yaml: yamlOpen,
          runs: runsOpen,
          inspector: inspectorOpen,
        },
        lastOpenedDrawer,
        { inspectorIsDrawer: editorInspectorIsDrawer(inspectorFirst) },
      );
      if (!closer) {
        return;
      }
      event.preventDefault();
      const next = editorDrawerAfterEscape();
      setDrawerOpen(closer, next.open);
      if (next.restoreFocus) {
        editorRestoreDrawerFocus(closer);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    addCredential,
    inspectorFirst,
    inspectorOpen,
    lastOpenedDrawer,
    libraryOpen,
    runsOpen,
    startOpen,
    wizardOpen,
    yamlOpen,
  ]);

  useEffect(() => {
    if (!selectedRunId || !editorRunShouldPoll(selectedRun?.status)) {
      return;
    }
    const scopedId = workflow?.id ?? workflowId ?? "";
    const timer = window.setInterval(() => {
      void (async () => {
        const result = await pollExecutionStatus(
          identity,
          selectedRunId,
          scopedId,
        );
        if (!result.ok) {
          return;
        }
        setSelectedRun(result.execution);
        setSelectedRunStrippedKeys(result.strippedKeys);
        void loadSelectedRunLogs(result.execution.id, result.execution.steps);
      })();
    }, EXECUTION_STATUS_POLL_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- poll closes over identity
  }, [selectedRunId, selectedRun?.status, identity, workflow?.id, workflowId]);

  if (
    createdCredentialReturn.current === undefined &&
    typeof window !== "undefined"
  ) {
    createdCredentialReturn.current = parseInspectorCreatedCredential(
      window.location.search,
    );
  }
  const pendingCreated = createdCredentialReturn.current;
  if (pendingCreated) {
    const returnedNode = yamlNodes.find((item) => item.id === pendingCreated.nodeId);
    if (returnedNode) {
      const returnedPatch = inspectorCreatedCredentialPatch(
        pendingCreated.field,
        pendingCreated.credentialId,
      );
      createdCredentialReturn.current = null;
      if (Object.keys(returnedPatch).length > 0) {
        const nextYaml = updateYamlNode(yaml, {
          id: returnedNode.id,
          type: returnedNode.type,
          name: returnedNode.name,
          with: { ...returnedNode.with, ...sanitizeInspectorWithPatch(returnedPatch) },
        });
        if (nextYaml) {
          setDigest(null);
          syncHistoryYaml(nextYaml);
          setCredentialRefreshNonce((current) => current + 1);
          applySelection({ kind: "node", id: pendingCreated.nodeId });
        }
      }
    }
  }
  const library = adaptActionLibrary(
    catalog,
    engineCatalog,
    sshCatalog,
    scriptCatalog,
    httpCatalog,
  );
  const localErrors = editorHasLocalInvalidations(yaml, catalog, library);
  const graph = projectCanvasGraph({
    errors,
    summary,
    yaml,
    catalog,
    palette: library,
    warnings,
  });
  const runWaitingIds = editorRunWaitingNodeIds(selectedRunApprovals);
  const canvasGraph =
    graph && selectedRun
      ? editorRunOverlayGraph(graph, selectedRun.steps, runWaitingIds)
      : graph;
  const runCurrentNodeId = selectedRun
    ? editorRunCurrentNodeId(selectedRun.steps, runWaitingIds) ?? undefined
    : undefined;
  const canSave = canSaveWorkflowEditor({ status, errors, localErrors });

  const canCall = hasOperatorCaller(
    session.active,
    identity,
    headerFallback,
  ) && hasWorkspaceLookup(identity);
  const dirty = Boolean(workflow && yaml !== savedYaml);

  const clearGraph = useCallback(() => {
    setSummary(null);
    setDigest(null);
    setWarnings([]);
  }, []);

  const applyEditor = useCallback(
    (next: {
      yaml: string;
      digest: string;
      summary: WorkflowSummary;
      warnings: WorkflowFieldError[];
      revision?: number;
    }) => {
      skipDebounce.current = true;
      validateSeq.current += 1;
      setYaml(next.yaml);
      setHistory(emptyCanvasHistory(next.yaml));
      setDigest(next.digest);
      setSummary(next.summary);
      setWarnings(next.warnings);
      setErrors([]);
      setStatus("valid");
      if (typeof next.revision === "number") {
        setRevision(next.revision);
        setSavedYaml(next.yaml);
      }
    },
    [],
  );

  const runValidate = useCallback(
    async (source: string) => {
      const seq = ++validateSeq.current;
      if (!source.trim()) {
        setStatus("idle");
        setErrors([]);
        clearGraph();
        setProblem(null);
        return;
      }
      setStatus("pending");
      setProblem(null);
      const result = await validateWorkflowYaml(identity, source);
      if (seq !== validateSeq.current) {
        return;
      }
      setLastRequestId(result.requestId);
      if (result.ok) {
        setStatus("valid");
        setErrors([]);
        setWarnings(result.warnings);
        setSummary(result.summary);
        return;
      }
      setStatus("invalid");
      setErrors(result.errors);
      clearGraph();
      setProblem(result.problem);
    },
    [clearGraph, identity],
  );

  useEffect(() => {
    if (skipDebounce.current) {
      skipDebounce.current = false;
      return;
    }
    if (!canCall) {
      return;
    }
    const timer = window.setTimeout(() => {
      void runValidate(yaml);
    }, VALIDATE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [canCall, runValidate, yaml]);

  useEffect(() => {
    if (!canCall || catalog) {
      return;
    }
    const timer = window.setTimeout(() => {
      void loadCatalog();
    }, 0);
    return () => window.clearTimeout(timer);
    // loadCatalog is recreated each render; catalog presence is the latch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canCall]);

  async function loadCatalog() {
    setPending("catalog");
    setProblem(null);
    const [result, engine, ssh, script, http] = await Promise.all([
      fetchWorkflowCatalog(identity),
      getKubernetesCatalog(identity).catch(() => null),
      getSshCatalog(identity).catch(() => null),
      getScriptCatalog(identity).catch(() => null),
      getHttpNotificationCatalog(identity).catch(() => null),
    ]);
    setLastRequestId(result.requestId);
    setPending(null);
    setEngineCatalog(engine && engine.ok ? engine.catalog : null);
    setSshCatalog(ssh && ssh.ok ? ssh.nodeCatalog : null);
    setScriptCatalog(script && script.ok ? script.catalog : null);
    setHttpCatalog(http && http.ok ? http.catalog : null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setCatalog(result.catalog);
  }

  async function runNormalize() {
    setPending("normalize");
    setProblem(null);
    const result = await normalizeWorkflowYaml(identity, yaml);
    setLastRequestId(result.requestId);
    setPending(null);
    if (!result.ok) {
      setStatus("invalid");
      setErrors(result.errors);
      clearGraph();
      setProblem(result.problem);
      return;
    }
    applyEditor(result.applied);
  }

  function applyDeveloperYaml(kind: "starter" | "invalid") {
    const fixture = loadDeveloperYaml(kind);
    skipDebounce.current = false;
    setDigest(fixture.digest);
    setYaml(fixture.yaml);
    setHistory(emptyCanvasHistory(fixture.yaml));
    setStatus(fixture.status);
    setErrors(fixture.errors);
    if (fixture.clearGraph) {
      clearGraph();
    }
  }

  function resetWorkflowScopedState() {
    setConflictDraft(null);
    setConflictProblem(null);
    setCompare(null);
    setCompareLeft("draft");
    setCompareRight("");
    setPublishedVersion(null);
    setExecution(null);
    setRunVersionId("");
    setRunVersion(null);
    setRunTriggerInput("");
    setPolicyEval(null);
    setPolicyEvalProblem(null);
    setExecutionApprovals([]);
    setVersions([]);
    setVersionPins({});
    setScriptArtifacts({});
  }

  async function refreshVersions(workflowId: string) {
    const result = await listWorkflowVersions(identity, workflowId);
    setLastRequestId(result.requestId);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setVersions(result.items);
    const firstPublished = publishedRunVersions(result.items)[0]?.id ?? "";
    setRunVersionId(firstPublished);
    const pinEntries = await Promise.all(
      result.items.map(async (version) => {
        const pins = await listWorkflowVersionPins(identity, workflowId, version.id);
        return [version.id, pins.ok ? pins.items : []] as const;
      }),
    );
    setVersionPins(Object.fromEntries(pinEntries));
    const artifactEntries = await Promise.all(
      result.items.map(async (version) => {
        const artifacts = await listWorkflowScriptArtifacts(
          identity,
          workflowId,
          version.id,
        );
        return [version.id, artifacts.ok ? artifacts.items : []] as const;
      }),
    );
    setScriptArtifacts(Object.fromEntries(artifactEntries));
    const uniqueIds = [
      ...new Set(
        artifactEntries.flatMap(([, pins]) => pins.map((pin) => pin.artifactId)),
      ),
    ];
    const records = await Promise.all(
      uniqueIds.map(async (artifactId) => {
        const result = await getScriptArtifact(identity, artifactId);
        return result.ok ? result.artifact : null;
      }),
    );
    setScriptArtifactRecords((current) => {
      const next = { ...current };
      for (const artifact of records) {
        if (artifact) {
          next[artifact.id] = artifact;
        }
      }
      return next;
    });
    if (firstPublished) {
      await evaluateSelectedVersion(firstPublished, workflowId);
    }
  }

  const openedRoute = useRef<string | null>(null);

  useEffect(() => {
    if (!canCall || !workflowId || openedRoute.current === workflowId) {
      return;
    }
    openedRoute.current = workflowId;
    void (async () => {
      const listed = await listWorkflows(identity);
      if (listed.ok) {
        const match = listed.items.find((item) => item.id === workflowId);
        if (match) {
          await openWorkflow(match);
          return;
        }
      }
      const summary = await getWorkflow(identity, workflowId);
      if (summary.ok) {
        await openWorkflow(summary.workflow);
      } else {
        setProblem(summary.problem);
      }
    })();
    // openWorkflow is recreated each render; the route ref prevents repeats.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canCall, identity, workflowId]);

  useEffect(() => {
    if (typeof window === "undefined" || createdCredentialReturn.current) {
      return;
    }
    if (!window.location.search.includes(`${SELECT_CREDENTIAL_PARAM}=`)) {
      return;
    }
    window.history.replaceState(
      null,
      "",
      stripInspectorCredentialQuery(
        `${window.location.pathname}${window.location.search}${window.location.hash}`,
      ),
    );
  });

  const runValidateRef = useRef(runValidate);
  runValidateRef.current = runValidate;
  const runNormalizeRef = useRef(runNormalize);
  runNormalizeRef.current = runNormalize;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (shortcutTargetIsEditable(event.target as HTMLElement | null)) {
        return;
      }
      if (isCanvasUndoShortcut(event)) {
        event.preventDefault();
        undoGraph();
        return;
      }
      if (isCanvasRedoShortcut(event)) {
        event.preventDefault();
        redoGraph();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    return subscribeWorkspaceCommands((name, detail) => {
      if (
        !editorCommandAppliesToRoute(workflowId, detail?.workflowId ?? workflowId)
      ) {
        return;
      }
      if (name === "validate") {
        void runValidateRef.current(yamlRef.current).then(() => {
          pushNotification({
            kind: "validation",
            title: "Validation requested",
            detail: "See the validation panel for safe status.",
            href: workflowId ? `/workflows/${workflowId}` : "/workflows",
          });
        });
      }
      if (name === "normalize") {
        void runNormalizeRef.current();
      }
    });
  }, [workflowId]);

  async function openWorkflow(record: WorkflowRecord) {
    if (pending !== null) {
      return;
    }
    setPending("open");
    setProblem(null);
    resetWorkflowScopedState();
    const draft = await getWorkflowDraft(identity, record.id);
    setLastRequestId(draft.requestId);
    if (!draft.ok) {
      setPending(null);
      setProblem(draft.problem);
      return;
    }
    setWorkflow(record);
    applyEditor({ ...draft.applied, revision: draft.applied.revision });
    await refreshVersions(record.id);
    setPending(null);
  }

  async function handleConflict(workflowId: string, problemDetails: ProblemDetails) {
    setConflictProblem(problemDetails);
    const latest = await getWorkflowDraft(identity, workflowId);
    setLastRequestId(latest.requestId);
    if (latest.ok) {
      setConflictDraft(latest.draft);
      return;
    }
    setProblem(latest.problem);
  }

  async function saveDraft() {
    if (!workflow || revision === null) {
      return;
    }
    setPending("save");
    setProblem(null);
    setConflictDraft(null);
    setConflictProblem(null);
    const result = await saveCanonicalWorkflowDraft(identity, workflow.id, yaml, revision);
    setLastRequestId(result.requestId);
    setPending(null);
    if (!result.ok) {
      if (result.conflict) {
        await handleConflict(workflow.id, result.problem);
        return;
      }
      setStatus("invalid");
      setErrors(result.errors);
      if (result.errors.length > 0) {
        clearGraph();
      }
      setProblem(result.problem);
      return;
    }
    if (result.workflow) {
      setWorkflow(result.workflow);
    }
    applyEditor({ ...result.applied, revision: result.applied.revision });
  }

  function reloadConflictDraft() {
    if (!conflictDraft) {
      return;
    }
    const applied = {
      yaml: conflictDraft.definitionYaml,
      digest: conflictDraft.digest,
      summary: conflictDraft.summary,
      warnings: conflictDraft.warnings ?? [],
      revision: conflictDraft.revision,
    };
    applyEditor(applied);
    setConflictDraft(null);
    setConflictProblem(null);
    setProblem(null);
  }

  async function publishDraft() {
    if (!workflow || revision === null || dirty) {
      return;
    }
    if (!editorCommandAppliesToRoute(workflowId, workflow.id)) {
      return;
    }
    setPending("publish");
    setProblem(null);
    const result = await publishWorkflow(identity, workflow.id, {
      revision,
      ...(publishNote.trim() ? { note: publishNote.trim() } : {}),
    });
    setLastRequestId(result.requestId);
    setPending(null);
    if (!result.ok) {
      if (result.conflict) {
        await handleConflict(workflow.id, result.problem);
        setProblem(result.problem);
        return;
      }
      setProblem(result.problem);
      return;
    }
    setWorkflow(result.workflow);
    setPublishedVersion(result.version);
    setPublishNote("");
    pushNotification({
      kind: "publish",
      title: `Published v${result.version.versionNumber}`,
      detail: result.version.digest,
      href: `/workflows/${workflow.id}`,
    });
    if (result.pins.length) {
      setVersionPins((current) => ({
        ...current,
        [result.version.id]: result.pins,
      }));
    }
    if (result.scriptArtifacts.length) {
      setScriptArtifacts((current) => ({
        ...current,
        [result.version.id]: result.scriptArtifacts,
      }));
    }
    await refreshVersions(workflow.id);
  }

  async function exportVersion(version: WorkflowVersion) {
    if (!workflow) {
      return;
    }
    setPending("export");
    setProblem(null);
    const result = await exportWorkflowVersion(identity, workflow.id, version.id);
    setLastRequestId(result.requestId);
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

  function compareRefFromChoice(choice: string) {
    if (choice === "draft") {
      return draftCompareRef();
    }
    return versionCompareRef(choice);
  }

  async function runCompare() {
    if (!workflow) {
      return;
    }
    const left = compareRefFromChoice(compareLeft);
    const right = compareRefFromChoice(compareRight);
    if (!left || !right) {
      return;
    }
    setPending("compare");
    setProblem(null);
    const result = await compareWorkflow(identity, workflow.id, { left, right });
    setLastRequestId(result.requestId);
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setCompare(result.compare);
  }

  async function restoreVersion(version: WorkflowVersion) {
    if (!workflow || revision === null || dirty) {
      return;
    }
    setPending("restore");
    setProblem(null);
    const result = await restoreWorkflowVersion(identity, workflow.id, version.id, {
      expectedRevision: revision,
    });
    setLastRequestId(result.requestId);
    setPending(null);
    if (!result.ok) {
      if (result.conflict) {
        await handleConflict(workflow.id, result.problem);
        return;
      }
      setProblem(result.problem);
      return;
    }
    if (result.workflow) {
      setWorkflow(result.workflow);
    }
    applyEditor({ ...result.applied, revision: result.applied.revision });
  }

  async function loadExecutionApprovals(
    workflowId: string,
    next: WorkflowExecution,
  ) {
    if (!next.id) {
      setExecutionApprovals([]);
      return;
    }
    const waiting = await listExecutionApprovals(
      identity,
      workflowId,
      next.id,
    );
    if (waiting.ok) {
      setExecutionApprovals(waiting.items);
      return;
    }
    setExecutionApprovals([]);
  }

  async function evaluateSelectedVersion(
    versionId: string,
    workflowId = workflow?.id,
  ) {
    if (!versionId) {
      setPolicyEval(null);
      setPolicyEvalProblem(null);
      setRunVersion(null);
      return;
    }
    setPolicyEvalPending(true);
    setPolicyEvalProblem(null);
    if (!workflowId) {
      setPolicyEvalPending(false);
      setPolicyEval(null);
      setPolicyEvalProblem(null);
      return;
    }
    const [result, version] = await Promise.all([
      evaluatePolicyForRun(identity, {
        workflowId,
        workflowVersionId: versionId,
      }),
      getWorkflowVersion(identity, workflowId, versionId),
    ]);
    setPolicyEvalPending(false);
    setLastRequestId(result.requestId);
    if (version.ok) {
      setRunVersion(version.version);
    }
    if (!result.ok) {
      setPolicyEval(null);
      setPolicyEvalProblem(result.problem);
      return;
    }
    setPolicyEval(result.evaluation);
  }

  async function runPublished() {
    if (!workflow || !runVersionId) {
      return;
    }
    if (!editorCommandAppliesToRoute(workflowId, workflow.id)) {
      return;
    }
    if (!canExecuteWorkflows(permissions)) {
      setProblem({
        type: "urn:flowforge:problem:forbidden",
        title: "Start forbidden",
        status: 403,
        detail: MANUAL_START_FORBIDDEN_MESSAGE,
        instance: "/workflows",
        code: "forbidden",
        request_id: "local-run-published-16",
      });
      return;
    }
    const prepared = buildManualStartRequest({
      versions,
      selectedVersionId: runVersionId,
      yaml: runVersion?.definitionYaml,
      fieldValues: runFieldValues,
      jsonText: runTriggerInput,
      idempotencyKey: runIdempotencyKey,
      permissions,
      catalog,
    });
    if (!prepared.ok || !prepared.body) {
      setProblem({
        type: "urn:flowforge:problem:invalid-request",
        title: "Cannot start",
        status: 400,
        detail: prepared.reason || PRE_RUN_PUBLISHED_ONLY_HELP,
        instance: "/workflows",
        code: "invalid-request",
        request_id: "local-run-published-16",
      });
      return;
    }
    setRunIdempotencyKey(prepared.idempotencyKey);
    const start = canStartPublishedRun({
      versions,
      selectedVersionId: prepared.body.workflowVersionId,
    });
    if (!start.ok) {
      setProblem({
        type: "urn:flowforge:problem:invalid-request",
        title: "Published version required",
        status: 400,
        detail: start.reason || PRE_RUN_PUBLISHED_ONLY_HELP,
        instance: "/workflows",
        code: "invalid-request",
        request_id: "local-run-published-16",
      });
      return;
    }
    setPending("run");
    setProblem(null);
    const evaluation = await evaluatePolicyForRun(identity, {
      workflowId: workflow.id,
      workflowVersionId: prepared.body.workflowVersionId,
    });
    setLastRequestId(evaluation.requestId);
    if (!evaluation.ok) {
      setPolicyEval(null);
      setPolicyEvalProblem(evaluation.problem);
      if (shouldBlockRun({
        evaluation: null,
        evaluationProblem: evaluation.problem,
        staleLocalApproved: true,
      })) {
        setPending(null);
        return;
      }
    } else {
      setPolicyEval(evaluation.evaluation);
      setPolicyEvalProblem(null);
      if (
        shouldBlockRun({
          evaluation: evaluation.evaluation,
          staleLocalApproved: true,
        })
      ) {
        setPending(null);
        return;
      }
    }
    const result = await startWorkflowExecution(
      identity,
      workflow.id,
      prepared.body.workflowVersionId,
      {
        idempotencyKey: prepared.body.idempotencyKey,
        input: prepared.body.input,
      },
    );
    setLastRequestId(result.requestId);
    setLastStartStatus(result.statusCode);
    setPending(null);
    if (!result.ok) {
      setProblem(
        isManualStartAuthFailure(result.problem)
          ? {
              ...result.problem,
              detail:
                manualStartAuthFailureMessage(result.problem) ||
                result.problem.detail,
            }
          : result.problem,
      );
      return;
    }
    setProblem(null);
    setExecution(result.execution);
    pushNotification({
      kind: "execution",
      title: result.execution.replayed ? "Execution replayed" : "Execution started",
      detail: result.execution.status,
      href: `/executions/${result.execution.id}`,
    });
    await loadExecutionApprovals(workflow.id, result.execution);
  }

  const publishDraftRef = useRef(publishDraft);
  publishDraftRef.current = publishDraft;
  const runPublishedRef = useRef(runPublished);
  runPublishedRef.current = runPublished;

  useEffect(() => {
    return subscribeWorkspaceCommands((name, detail) => {
      if (
        !editorCommandAppliesToRoute(workflowId, detail?.workflowId ?? workflow?.id)
      ) {
        return;
      }
      if (name === "publish") {
        void publishDraftRef.current();
      }
      if (name === "run-published") {
        void runPublishedRef.current();
      }
    });
  }, [workflowId, workflow?.id]);

  async function refreshPin() {
    if (!workflow || !execution) {
      return;
    }
    setPending("pin");
    setProblem(null);
    const result = await getWorkflowExecution(identity, workflow.id, execution.id);
    setLastRequestId(result.requestId);
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setExecution(result.execution);
    await loadExecutionApprovals(workflow.id, result.execution);
  }

  function openWizard(entry?: ActionLibraryEntry) {
    setWizardType(entry?.type);
    setWizardFeedback("idle");
    setWizardOpen(true);
  }

  function addFromWizard(nextYaml: string, nodeId: string) {
    setWizardFeedback("pending");
    try {
      setDigest(null);
      writeGraphYaml(nextYaml);
      applySelection({ kind: "node", id: nodeId });
      setWizardFeedback("success");
      setWizardOpen(false);
      pushNotification({
        kind: "info",
        title: "Action added",
        detail: "The action was written into the draft YAML.",
        href: workflowId ? `/workflows/${workflowId}` : "/workflows",
      });
    } catch {
      setWizardFeedback("error");
    }
  }

  function insertLibraryNode(entry: ActionLibraryEntry, position?: CanvasPoint) {
    const rejected = rejectDisabledActionType(entry.type, catalog);
    if (!rejected.ok) {
      setStatus("invalid");
      setErrors([
        {
          path: "spec.nodes",
          code: "unsupported-node",
          message: rejected.reason,
        },
      ]);
      clearGraph();
      return;
    }
    const inserted = insertCatalogNode(yaml, entry.type, { name: entry.name });
    writeGraphYaml(
      inserted.yaml,
      position
        ? { ...historyRef.current.present.layout, [inserted.node.id]: position }
        : undefined,
    );
    applySelection({ kind: "node", id: inserted.node.id });
  }

  function connectPorts(from: string, to: string): string[] {
    const result = connectGraphEdge(yaml, from, to, catalog, library);
    if (result.errors.length === 0) {
      writeGraphYaml(result.yaml);
    }
    return result.errors;
  }

  function applyNodeConfig(id: string, name: string, config: CoreNodeWith) {
    const result = applyCoreNodeConfig(yaml, id, name, config);
    if (result.yaml) {
      setDigest(null);
      syncHistoryYaml(result.yaml);
    }
    return result.errors;
  }

  function patchNodeWith(id: string, patch: Record<string, unknown>) {
    const node = listYamlNodes(yaml).find((item) => item.id === id);
    if (!node) {
      return;
    }
    const next = updateYamlNode(yaml, {
      id: node.id,
      type: node.type,
      name: node.name,
      with: { ...node.with, ...sanitizeInspectorWithPatch(patch) },
    });
    if (next) {
      setDigest(null);
      syncHistoryYaml(next);
    }
  }

  function applyCreatedVaultCredential(
    request: { nodeId: string; field: string },
    credential: InspectorPendingCredential,
  ) {
    if (!createdCredentialSelectable(credential)) {
      return;
    }
    const patch = inspectorCreatedCredentialPatch(request.field, credential.id);
    if (Object.keys(patch).length === 0) {
      return;
    }
    patchNodeWith(request.nodeId, patch);
    setPendingCredentials((current) => ({
      ...current,
      [`${request.nodeId}:${request.field}`]: credential,
    }));
    setCredentialRefreshNonce((current) => current + 1);
    applySelection({ kind: "node", id: request.nodeId });
  }

  function applyNodeName(id: string, name: string) {
    const node = listYamlNodes(yaml).find((item) => item.id === id);
    if (!node) {
      return;
    }
    const next = updateYamlNode(yaml, {
      id: node.id,
      type: node.type,
      name: name.trim() || node.name,
      with: node.with,
    });
    if (next) {
      setDigest(null);
      syncHistoryYaml(next);
    }
  }

  const errorLines = errors
    .map((error) => error.line)
    .filter((line): line is number => typeof line === "number");

  const canPublish = canPublishLastSavedDraft({
    dirty,
    hasWorkflow: Boolean(workflow),
    revision,
  });

  function jumpToYaml(line: number, column?: number) {
    setDrawerOpen("yaml", true);
    setFocusLine(line);
    setFocusColumn(column ?? null);
    setFocusToken((token) => token + 1);
  }

  const bannerConflict = conflictDraft || conflictProblem;
  const bannerProblem = problem && errors.length === 0 && !conflictDraft;
  const hasBanners = Boolean(
    bannerConflict ||
      bannerProblem ||
      (dirty && workflow) ||
      publishedVersion ||
      wizardFeedback !== "idle",
  );

  const runControl = workflow ? (
    <RunControl
      versions={versions}
      selectedVersionId={runVersionId}
      selectedVersion={runVersion}
      catalog={catalog}
      versionPins={versionPins[runVersionId]}
      triggerInput={runTriggerInput}
      onTriggerInput={setRunTriggerInput}
      execution={execution}
      pending={pending === "run" || pending === "pin"}
      dirty={dirty}
      runBlocked={
        shouldBlockRun({
          evaluation: policyEval,
          evaluationProblem: policyEvalProblem,
          staleLocalApproved: true,
        }) ||
        hasRevokedScriptPin({
          pins: scriptArtifacts[runVersionId] ?? [],
          artifacts: Object.values(scriptArtifactRecords),
        })
      }
      runBlockReason={
        hasRevokedScriptPin({
          pins: scriptArtifacts[runVersionId] ?? [],
          artifacts: Object.values(scriptArtifactRecords),
        })
          ? SCRIPT_REVOKED_RUN_BLOCK_HELP
          : undefined
      }
      evaluation={policyEval}
      evaluationPending={policyEvalPending}
      evaluationProblem={policyEvalProblem}
      executionApprovals={executionApprovals}
      lastStartStatus={lastStartStatus}
      runProblem={problem}
      idempotencyKey={runIdempotencyKey}
      onIdempotencyKey={setRunIdempotencyKey}
      fieldValues={runFieldValues}
      onFieldValues={setRunFieldValues}
      permissions={permissions}
      identity={identity}
      onSelectVersion={(versionId) => {
        setRunVersionId(versionId);
        setRunFieldValues({});
        void evaluateSelectedVersion(versionId);
      }}
      onRun={() => void runPublished()}
      onRefreshPin={() => void refreshPin()}
    />
  ) : null;

  return (
    <EditorChrome
      identityGate={
        !canCall ? (
          <details className="shrink-0 border-b border-zinc-200 bg-white px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium text-zinc-800">
              Set workspace identity to load this workflow
            </summary>
            <div className="mt-3">
              <IsolationIdentityPanel />
            </div>
          </details>
        ) : null
      }
      topBar={
        <EditorTopBar
          workflow={workflow}
          loaded={workflow !== null || (problem !== null && pending !== "open")}
          revision={revision}
          dirty={dirty}
          canCall={canCall}
          pending={pending}
          canSave={canSave}
          canPublish={canPublish}
          yamlOpen={yamlOpen}
          libraryOpen={libraryOpen}
          runsOpen={runsOpen}
          inspectorOpen={inspectorOpen}
          publishNote={publishNote}
          onPublishNote={setPublishNote}
          onSave={() => void saveDraft()}
          onPublish={() => void publishDraft()}
          onStart={() => setStartOpen(true)}
          onToggleYaml={() => toggleDrawer("yaml")}
          onToggleLibrary={() => toggleDrawer("library")}
          onToggleRuns={() => toggleDrawer("runs")}
          onToggleInspector={() => toggleDrawer("inspector")}
          onAddAction={() => openWizard()}
          canUndo={canUndoCanvasHistory(history)}
          canRedo={canRedoCanvasHistory(history)}
          onUndo={undoGraph}
          onRedo={redoGraph}
        />
      }
      banners={
        hasBanners ? (
          <>
            {bannerConflict ? (
              <DraftConflictBanner
                problem={conflictProblem}
                serverDraft={conflictDraft}
                onReload={reloadConflictDraft}
              />
            ) : null}
            {bannerProblem ? <ProblemBanner problem={problem} /> : null}
            {dirty && workflow ? (
              <p className="text-xs text-zinc-600">
                Publish uses the last saved draft. Save before publishing.
              </p>
            ) : null}
            {publishedVersion ? (
              <p className="text-xs text-zinc-700">
                Published v{publishedVersion.versionNumber}{" "}
                <code className="break-all font-mono">
                  {publishedVersion.digest}
                </code>
              </p>
            ) : null}
            {wizardFeedback !== "idle" ? (
              <p
                role="status"
                className={`text-xs ${wizardFeedback === "error" ? "text-rose-900" : "text-teal-900"}`}
              >
                {wizardFeedback === "pending"
                  ? "Adding action…"
                  : wizardFeedback === "success"
                    ? "Action added to the canvas and YAML."
                    : "Action was not added."}
              </p>
            ) : null}
          </>
        ) : null
      }
      libraryOpen={libraryOpen}
      inspectorOpen={inspectorOpen}
      selectionAnnouncement={selectionAnnouncement}
      onToggleLibrary={() => toggleDrawer("library")}
      onToggleInspector={() => toggleDrawer("inspector")}
      library={
        <ActionLibrary
          compact
          catalog={catalog}
          entries={library}
          query={paletteQuery}
          pending={pending === "catalog"}
          onQuery={setPaletteQuery}
          onRefresh={() => void loadCatalog()}
          onInsert={insertLibraryNode}
          onOpenWizard={openWizard}
        />
      }
      canvas={
        <WorkflowCanvas
          fill
          graph={canvasGraph}
          invalid={status === "invalid" && errors.length > 0}
          pending={status === "pending"}
          selection={selection}
          entries={library}
          currentNodeId={runCurrentNodeId}
          heading={selectedRun ? "Canvas · last run" : undefined}
          help={selectedRun ? EDITOR_RUN_OVERLAY_HELP : undefined}
          onSelect={applySelection}
          layout={history.present.layout}
          canUndo={canUndoCanvasHistory(history)}
          canRedo={canRedoCanvasHistory(history)}
          onUndo={undoGraph}
          onRedo={redoGraph}
          onMove={moveCanvasNode}
          onRemove={removeCanvasSelection}
          onInsertType={(type, position) => {
            const entry = library.find((item) => item.type === type);
            if (entry) {
              insertLibraryNode(entry, position);
            }
          }}
          onOpenLibrary={() => setDrawerOpen("library", true)}
          onAddAction={() => openWizard()}
          onConnect={connectPorts}
        />
      }
      yaml={
        <EditorYamlDrawer
          open={yamlOpen}
          tools={
            <EditorYamlTools
              canCall={canCall}
              pending={pending}
              onValidate={() => {
                void runValidate(yaml).then(() => {
                  pushNotification({
                    kind: "validation",
                    title: "Validation requested",
                    detail: "See the validation panel for safe status.",
                    href: workflow ? `/workflows/${workflow.id}` : "/workflows",
                  });
                });
              }}
              onNormalize={() => void runNormalize()}
              onLoadStarter={() => applyDeveloperYaml("starter")}
              onLoadInvalid={() => applyDeveloperYaml("invalid")}
            />
          }
        >
          <YamlEditor
            value={yaml}
            onChange={(next) => {
              setDigest(null);
              syncHistoryYaml(next);
            }}
            focusLine={focusLine}
            focusColumn={focusColumn}
            focusToken={focusToken}
            errorLines={errorLines}
          />
        </EditorYamlDrawer>
      }
      inspector={
        <div className="space-y-4 p-3">
          <EditorInspector
            yaml={yaml}
            graph={canvasGraph}
            nodes={yamlNodes}
            entries={library}
            selection={selection}
            pending={pending !== null}
            identity={identity}
            canCall={canCall}
            dirty={dirty}
            hasPublishedVersion={Boolean(publishedVersion || versions[0])}
            scriptCatalog={scriptCatalog}
            engineCatalog={engineCatalog}
            sshCatalog={sshCatalog}
            httpCatalog={httpCatalog}
            scriptArtifacts={
              scriptArtifacts[publishedVersion?.id ?? versions[0]?.id ?? ""] ??
              []
            }
            scriptArtifactRecords={Object.values(scriptArtifactRecords)}
            permissions={permissions}
            onScriptArtifactChange={(artifact) =>
              setScriptArtifactRecords((current) => ({
                ...current,
                [artifact.id]: artifact,
              }))
            }
            onSelectNode={(id) => applySelection({ kind: "node", id })}
            onApply={applyNodeConfig}
            onRename={applyNodeName}
            onPatchNodeWith={patchNodeWith}
            workflowId={workflow?.id ?? workflowId}
            credentialRefreshNonce={credentialRefreshNonce}
            pendingCredentials={pendingCredentials}
            onAddCredential={setAddCredential}
            lastRun={
              selectedRunId
                ? {
                    detail: selectedRun,
                    logsByStepId: selectedRunLogs,
                    pending: selectedRunPending,
                    problem: selectedRunProblem,
                    strippedKeys: selectedRunStrippedKeys,
                    onClear: clearSelectedRun,
                  }
                : null
            }
            workflowAdmin={{
              workflowId: workflow?.id ?? workflowId,
              workflowName: workflow?.name,
              permissions,
              versions,
              pending,
              dirty,
              compareLeft,
              compareRight,
              compare,
              onCompareLeft: setCompareLeft,
              onCompareRight: setCompareRight,
              onCompare: () => void runCompare(),
              onExport: (version) => void exportVersion(version),
              onRestore: (version) => void restoreVersion(version),
              versionPins,
            }}
          />
          <ValidationPanel
            status={status}
            errors={errors}
            warnings={warnings}
            summary={summary}
            digest={digest}
            problem={problem}
            onJump={jumpToYaml}
            onSelectNode={(id) => applySelection({ kind: "node", id })}
            onSelectEdge={(from, to) => applySelection({ kind: "edge", from, to })}
          />
          {yamlHasScriptNodes(yaml) ? (
            <ScriptPublishStatus
              status={scriptArtifactStatus({
                dirty,
                hasPublishedVersion: Boolean(publishedVersion || versions[0]),
                version: publishedVersion ?? versions[0] ?? null,
                scriptArtifacts:
                  scriptArtifacts[
                    publishedVersion?.id ?? versions[0]?.id ?? ""
                  ] ?? [],
                artifacts: Object.values(scriptArtifactRecords),
              })}
              pins={
                scriptArtifacts[publishedVersion?.id ?? versions[0]?.id ?? ""] ??
                []
              }
              artifacts={Object.values(scriptArtifactRecords)}
              identity={identity}
              permissions={permissions}
              scriptCatalog={scriptCatalog}
              onArtifactChange={(artifact) =>
                setScriptArtifactRecords((current) => ({
                  ...current,
                  [artifact.id]: artifact,
                }))
              }
            />
          ) : null}
          {lastRequestId && !problem ? (
            <p className="font-mono text-[11px] text-zinc-400">
              last request_id {lastRequestId}
            </p>
          ) : null}
        </div>
      }
      runs={
        <EditorRunsDrawer
          open={runsOpen}
          workflowId={workflow?.id ?? workflowId}
          workflowName={workflow?.name}
          identity={identity}
          permissions={permissions}
          canCall={canCall}
          selectedExecutionId={selectedRunId ?? undefined}
          onClose={() => setDrawerOpen("runs", false)}
          onStart={() => setStartOpen(true)}
          onSelectRun={(executionId) => void selectRun(executionId)}
        />
      }
      overlays={
        <>
          <EditorStartDialog open={startOpen} onClose={() => setStartOpen(false)}>
            {runControl}
          </EditorStartDialog>
          <CredentialWizardDialog
            open={Boolean(addCredential)}
            allowedTypes={addCredential?.allowedTypes}
            onClose={() => setAddCredential(null)}
            onCreated={(credential) => {
              if (addCredential) {
                applyCreatedVaultCredential(addCredential, credential);
              }
              setAddCredential(null);
            }}
          />
          <ActionWizard
            key={`${wizardOpen ? "open" : "closed"}:${wizardType ?? "any"}`}
            open={wizardOpen}
            identity={identity}
            ready={canCall}
            catalog={catalog}
            scriptCatalog={scriptCatalog}
            entries={library}
            yaml={yaml}
            nodes={yamlNodes}
            initialType={wizardType}
            upstream={wizardUpstream(selection, yamlNodes, library)}
            permissions={permissions}
            evaluation={policyEval}
            evaluationPending={policyEvalPending}
            evaluationProblem={policyEvalProblem}
            feedback={wizardFeedback}
            onClose={() => {
              setWizardOpen(false);
              setWizardFeedback("idle");
            }}
            onAdd={addFromWizard}
          />
        </>
      }
    />
  );
}

function subscribeInspectorFirstBreakpoint(onChange: () => void) {
  const media = window.matchMedia(EDITOR_INSPECTOR_FIRST_MEDIA);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function readInspectorFirstBreakpoint(): boolean {
  return window.matchMedia(EDITOR_INSPECTOR_FIRST_MEDIA).matches;
}

function wizardUpstream(
  selection: EditorSelection,
  nodes: ReturnType<typeof listYamlNodes>,
  library: ActionLibraryEntry[],
): { type: string; port: { name: string; kind: string } } | null {
  if (selection.kind !== "node") {
    return null;
  }
  const node = nodes.find((item) => item.id === selection.id);
  if (!node) {
    return null;
  }
  const entry = library.find((item) => item.type === node.type);
  const port = entry?.outputs?.[0];
  if (!port) {
    return null;
  }
  return { type: node.type, port };
}
