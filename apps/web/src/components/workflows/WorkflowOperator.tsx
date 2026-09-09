"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { IsolationIdentityPanel } from "@/components/isolation/IsolationIdentityPanel";
import { ProblemBanner } from "@/components/ProblemBanner";
import { evaluatePolicyForRun, listExecutionApprovals } from "@/lib/approval-client";
import type { ApprovalRequest, PolicyEvaluation } from "@/lib/approval-types";
import { shouldBlockRun } from "@/lib/approval";
import { WorkflowConfigPins } from "@/components/workflows/WorkflowConfigPins";
import { ActionLibrary } from "@/components/workflows/ActionLibrary";
import { DraftConflictBanner } from "@/components/workflows/DraftConflictBanner";
import { EditorInspector } from "@/components/workflows/EditorInspector";
import { RunControl } from "@/components/workflows/RunControl";
import { ValidationPanel } from "@/components/workflows/ValidationPanel";
import { VersionHistory } from "@/components/workflows/VersionHistory";
import { WorkflowCanvas, type EditorSelection } from "@/components/workflows/WorkflowCanvas";
import { WorkflowList } from "@/components/workflows/WorkflowList";
import { YamlEditor } from "@/components/workflows/YamlEditor";
import {
  adaptActionLibrary,
  rejectDisabledActionType,
  type ActionLibraryEntry,
} from "@/lib/workflow-action-library";
import {
  canSaveWorkflowEditor,
  connectGraphEdge,
  editorHasLocalInvalidations,
  projectCanvasGraph,
} from "@/lib/workflow-graph";
import {
  applyCoreNodeConfig,
  insertCatalogNode,
  listYamlNodes,
  type CoreNodeWith,
} from "@/lib/workflow-yaml-nodes";
import { loadDevIdentity, emptyStoredIdentity, subscribeDevIdentity } from "@/lib/dev-identity";
import { loadHeaderFallback, subscribeHeaderFallback } from "@/lib/header-fallback";
import { hasOperatorCaller, hasWorkspaceLookup } from "@/lib/identity-headers";
import { listWorkflowVersionPins } from "@/lib/ops-config-client";
import type { OpsConfigPin } from "@/lib/ops-config-types";
import type { ProblemDetails } from "@/lib/problem";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";
import {
  draftCompareRef,
  INVALID_WORKFLOW_YAML,
  optionalCreateFields,
  STARTER_WORKFLOW_YAML,
  VALIDATE_DEBOUNCE_MS,
  versionCompareRef,
} from "@/lib/workflow";
import {
  compareWorkflow,
  createWorkflow,
  exportWorkflowVersion,
  fetchWorkflowCatalog,
  getWorkflow,
  getWorkflowDraft,
  getWorkflowExecution,
  listWorkflows,
  listWorkflowVersions,
  importValidatedWorkflow,
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
import { subscribeWorkspaceCommands } from "@/lib/workspace-commands";
import { pushNotification } from "@/lib/workspace-notifications";

type WorkflowOperatorProps = {
  workflowId?: string;
};

export function WorkflowOperator({ workflowId }: WorkflowOperatorProps = {}) {
  const router = useRouter();
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
  const [savedYaml, setSavedYaml] = useState("");
  const [catalog, setCatalog] = useState<WorkflowCatalog | null>(null);
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

  const [items, setItems] = useState<WorkflowRecord[]>([]);
  const [workflow, setWorkflow] = useState<WorkflowRecord | null>(null);
  const [revision, setRevision] = useState<number | null>(null);
  const [createSlug, setCreateSlug] = useState("");
  const [createName, setCreateName] = useState("");
  const [publishNote, setPublishNote] = useState("");
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
  const [runIdempotencyKey, setRunIdempotencyKey] = useState("");
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

  const validateSeq = useRef(0);
  const skipDebounce = useRef(false);
  const yamlRef = useRef(yaml);
  yamlRef.current = yaml;

  const yamlNodes = listYamlNodes(yaml);
  const library = adaptActionLibrary(catalog);
  const localErrors = editorHasLocalInvalidations(yaml, catalog, library);
  const graph = projectCanvasGraph({
    errors,
    summary,
    yaml,
    catalog,
    palette: library,
    warnings,
  });
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
    const result = await fetchWorkflowCatalog(identity);
    setLastRequestId(result.requestId);
    setPending(null);
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

  async function refreshList() {
    if (pending !== null) {
      return;
    }
    setPending("list");
    setProblem(null);
    const result = await listWorkflows(identity);
    setLastRequestId(result.requestId);
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setItems(result.items);
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
    setVersions([]);
    setVersionPins({});
  }

  async function refreshVersions(workflowId: string) {
    const result = await listWorkflowVersions(identity, workflowId);
    setLastRequestId(result.requestId);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setVersions(result.items);
    setRunVersionId(result.items[0]?.id ?? "");
    const pinEntries = await Promise.all(
      result.items.map(async (version) => {
        const pins = await listWorkflowVersionPins(identity, workflowId, version.id);
        return [version.id, pins.ok ? pins.items : []] as const;
      }),
    );
    setVersionPins(Object.fromEntries(pinEntries));
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
        setItems(listed.items);
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

  const runValidateRef = useRef(runValidate);
  runValidateRef.current = runValidate;

  useEffect(() => {
    return subscribeWorkspaceCommands((name) => {
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

  async function createFromEditor() {
    if (pending !== null) {
      return;
    }
    setPending("create");
    setProblem(null);
    const result = await createWorkflow(identity, {
      definitionYaml: yaml,
      ...optionalCreateFields(createSlug, createName),
    });
    setLastRequestId(result.requestId);
    if (!result.ok) {
      setPending(null);
      setStatus("invalid");
      setErrors(result.errors);
      if (result.errors.length > 0) {
        clearGraph();
      }
      setProblem(result.problem);
      return;
    }
    resetWorkflowScopedState();
    const created = result.workflow;
    if (created) {
      setWorkflow(created);
      setItems((current) => [
        created,
        ...current.filter((item) => item.id !== created.id),
      ]);
      router.replace(`/workflows/${created.id}`);
    }
    applyEditor({ ...result.applied, revision: result.applied.revision });
    setPending(null);
    pushNotification({
      kind: "info",
      title: "Draft created",
      detail: created?.name || "Editable draft ready",
      href: created ? `/workflows/${created.id}` : undefined,
    });
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

  async function evaluateSelectedVersion(versionId: string) {
    if (!versionId) {
      setPolicyEval(null);
      setPolicyEvalProblem(null);
      return;
    }
    setPolicyEvalPending(true);
    setPolicyEvalProblem(null);
    if (!workflow) {
      setPolicyEval(null);
      setPolicyEvalProblem(null);
      return;
    }
    const result = await evaluatePolicyForRun(identity, {
      workflowId: workflow.id,
      workflowVersionId: versionId,
    });
    setPolicyEvalPending(false);
    setLastRequestId(result.requestId);
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
    setPending("run");
    setProblem(null);
    const evaluation = await evaluatePolicyForRun(identity, {
      workflowId: workflow.id,
      workflowVersionId: runVersionId,
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
    const extras = runIdempotencyKey.trim()
      ? { idempotencyKey: runIdempotencyKey.trim() }
      : {};
    const result = await startWorkflowExecution(
      identity,
      workflow.id,
      runVersionId,
      extras,
    );
    setLastRequestId(result.requestId);
    setLastStartStatus(result.statusCode);
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
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
    return subscribeWorkspaceCommands((name) => {
      if (name === "publish") {
        void publishDraftRef.current();
      }
      if (name === "run-published") {
        void runPublishedRef.current();
      }
    });
  }, []);

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

  function insertLibraryNode(entry: ActionLibraryEntry) {
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
    setDigest(null);
    setYaml(inserted.yaml);
    setSelection({ kind: "node", id: inserted.node.id });
  }

  function connectPorts(from: string, to: string): string[] {
    const result = connectGraphEdge(yaml, from, to, catalog, library);
    if (result.errors.length === 0) {
      setDigest(null);
      setYaml(result.yaml);
    }
    return result.errors;
  }

  function applyNodeConfig(id: string, name: string, config: CoreNodeWith) {
    const result = applyCoreNodeConfig(yaml, id, name, config);
    if (result.yaml) {
      setDigest(null);
      setYaml(result.yaml);
    }
    return result.errors;
  }

  function importFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      void (async () => {
        setPending("import");
        setProblem(null);
        const result = await importValidatedWorkflow(identity, text, {
          ...optionalCreateFields(createSlug, createName || file.name.replace(/\.ya?ml$/i, "")),
        });
        setLastRequestId(result.requestId);
        setPending(null);
        if (!result.ok) {
          setStatus("invalid");
          setErrors(result.errors);
          clearGraph();
          setProblem(result.problem);
          skipDebounce.current = false;
          setDigest(null);
          setYaml(text);
          return;
        }
        resetWorkflowScopedState();
        const created = result.workflow;
        if (created) {
          setWorkflow(created);
          setItems((current) => [
            created,
            ...current.filter((item) => item.id !== created.id),
          ]);
          router.replace(`/workflows/${created.id}`);
        }
        applyEditor({ ...result.applied, revision: result.applied.revision });
      })();
    };
    reader.readAsText(file);
  }

  async function exportPublished() {
    const version = publishedVersion ?? versions[0];
    if (!workflow || !version) {
      return;
    }
    await exportVersion(version);
  }

  const errorLines = errors
    .map((error) => error.line)
    .filter((line): line is number => typeof line === "number");

  return (
    <div className="space-y-6">
      <IsolationIdentityPanel />

      {conflictDraft || conflictProblem ? (
        <DraftConflictBanner
          problem={conflictProblem}
          serverDraft={conflictDraft}
          onReload={reloadConflictDraft}
        />
      ) : null}
      {problem && errors.length === 0 && !conflictDraft ? (
        <ProblemBanner problem={problem} />
      ) : null}
      {lastRequestId && !problem ? (
        <p className="font-mono text-xs text-zinc-500">
          last request_id {lastRequestId}
        </p>
      ) : null}

      <WorkflowList
        items={items}
        selectedId={workflow?.id ?? null}
        pending={pending !== null}
        slug={createSlug}
        name={createName}
        onSlug={setCreateSlug}
        onName={setCreateName}
        onRefresh={() => void refreshList()}
        onCreate={() => void createFromEditor()}
        onSelect={(record) => void openWorkflow(record)}
      />

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => {
            skipDebounce.current = false;
            setDigest(null);
            setStatus("idle");
            setErrors([]);
            setYaml(STARTER_WORKFLOW_YAML);
          }}
          className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50"
        >
          Load starter YAML
        </button>
        <button
          type="button"
          id="load-invalid-yaml"
          onClick={() => {
            skipDebounce.current = false;
            setDigest(null);
            setYaml(INVALID_WORKFLOW_YAML);
            setStatus("invalid");
            setErrors([
              {
                path: "spec.nodes[0].id",
                line: 9,
                column: 7,
                code: "invalid-id",
                message: "Node IDs must be DNS labels.",
              },
              {
                path: "spec.nodes[0].type",
                line: 10,
                column: 7,
                code: "unsupported-node",
                message: "workflow.call is not enabled.",
              },
            ]);
            clearGraph();
          }}
          className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50"
        >
          Load invalid YAML
        </button>
        <label className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50">
          Import YAML
          <input
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
        <Link
          href="/workflows"
          className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50"
        >
          Workflow home
        </Link>
        <button
          type="button"
          onClick={() => {
            void runValidate(yaml).then(() => {
              pushNotification({
                kind: "validation",
                title: "Validation requested",
                detail: "See the validation panel for safe status.",
                href: workflow ? `/workflows/${workflow.id}` : "/workflows",
              });
            });
          }}
          disabled={!canCall || pending !== null}
          className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-60"
        >
          Validate now
        </button>
        <button
          type="button"
          onClick={() => void runNormalize()}
          disabled={!canCall || pending !== null}
          className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-60"
        >
          {pending === "normalize" ? "Normalizing…" : "Normalize"}
        </button>
        <button
          type="button"
          onClick={() => void saveDraft()}
          disabled={
            !canCall ||
            pending !== null ||
            !workflow ||
            revision === null ||
            !canSave
          }
          className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
        >
          {pending === "save" ? "Saving…" : "Save draft"}
        </button>
        <button
          type="button"
          onClick={() => void exportPublished()}
          disabled={!canCall || pending !== null || !workflow || versions.length === 0}
          className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50 disabled:opacity-60"
        >
          {pending === "export" ? "Exporting…" : "Export published"}
        </button>
      </div>
      {!canSave ? (
        <p className="text-sm text-zinc-600">
          Save is disabled until YAML, graph ports, policy, and required
          configuration are valid.
        </p>
      ) : null}

      <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-end gap-3">
          <p className="text-sm text-zinc-700">
            {workflow ? (
              <>
                <span className="font-medium">{workflow.name}</span>
                {" · "}
                <span className="font-mono text-xs">{workflow.slug}</span>
                {" · "}
                {workflow.status}
                {" · revision "}
                {revision ?? "—"}
                {dirty ? " · unsaved" : " · saved"}
              </>
            ) : (
              "No persisted workflow selected. Validate/normalize still work (E3.1)."
            )}
          </p>
          <label className="ml-auto block text-sm">
            <span className="text-zinc-600">Publish note</span>
            <input
              value={publishNote}
              onChange={(event) => setPublishNote(event.target.value)}
              className="mt-1 w-64 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm"
            />
          </label>
          <button
            type="button"
            onClick={() => void publishDraft()}
            disabled={
              !canCall ||
              pending !== null ||
              !workflow ||
              revision === null ||
              dirty
            }
            className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
          >
            {pending === "publish" ? "Publishing…" : "Publish"}
          </button>
        </div>
        {dirty ? (
          <p className="mt-2 text-sm text-zinc-600">
            Publish uses the last saved draft. Save before publishing.
          </p>
        ) : null}
        {publishedVersion ? (
          <p className="mt-3 text-sm">
            Published v{publishedVersion.versionNumber}{" "}
            <code className="break-all font-mono text-xs">
              {publishedVersion.digest}
            </code>
          </p>
        ) : null}
      </div>

      <div className="grid gap-6 xl:grid-cols-[18rem_minmax(0,1fr)_20rem]">
        <ActionLibrary
          catalog={catalog}
          entries={library}
          query={paletteQuery}
          pending={pending === "catalog"}
          onQuery={setPaletteQuery}
          onRefresh={() => void loadCatalog()}
          onInsert={insertLibraryNode}
        />
        <div className="space-y-4">
          <WorkflowCanvas
            graph={graph}
            invalid={status === "invalid" || errors.length > 0}
            pending={status === "pending"}
            selection={selection}
            entries={library}
            onSelect={setSelection}
            onInsertType={(type) => {
              const entry = library.find((item) => item.type === type);
              if (entry) {
                insertLibraryNode(entry);
              }
            }}
            onConnect={connectPorts}
          />
          <YamlEditor
            value={yaml}
            onChange={(next) => {
              setDigest(null);
              setYaml(next);
            }}
            focusLine={focusLine}
            focusColumn={focusColumn}
            focusToken={focusToken}
            errorLines={errorLines}
          />
        </div>
        <div className="space-y-6">
          <EditorInspector
            yaml={yaml}
            graph={graph}
            nodes={yamlNodes}
            entries={library}
            selection={selection}
            pending={pending !== null}
            identity={identity}
            canCall={canCall}
            onSelectNode={(id) => setSelection({ kind: "node", id })}
            onApply={applyNodeConfig}
          />
          <ValidationPanel
            status={status}
            errors={errors}
            warnings={warnings}
            summary={summary}
            digest={digest}
            problem={problem}
            onJump={(line, column) => {
              setFocusLine(line);
              setFocusColumn(column ?? null);
              setFocusToken((token) => token + 1);
            }}
            onSelectNode={(id) => setSelection({ kind: "node", id })}
            onSelectEdge={(from, to) => setSelection({ kind: "edge", from, to })}
          />
        </div>
      </div>

      {workflow ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <VersionHistory
            versions={versions}
            pending={pending}
            dirty={dirty}
            compareLeft={compareLeft}
            compareRight={compareRight}
            compare={compare}
            onCompareLeft={setCompareLeft}
            onCompareRight={setCompareRight}
            onCompare={() => void runCompare()}
            onExport={(version) => void exportVersion(version)}
            onRestore={(version) => void restoreVersion(version)}
            versionPins={versionPins}
          />
          <RunControl
            versions={versions}
            selectedVersionId={runVersionId}
            execution={execution}
            pending={pending === "run" || pending === "pin"}
            dirty={dirty}
            runBlocked={shouldBlockRun({
              evaluation: policyEval,
              evaluationProblem: policyEvalProblem,
              staleLocalApproved: true,
            })}
            evaluation={policyEval}
            evaluationPending={policyEvalPending}
            evaluationProblem={policyEvalProblem}
            executionApprovals={executionApprovals}
            lastStartStatus={lastStartStatus}
            runProblem={problem}
            idempotencyKey={runIdempotencyKey}
            onIdempotencyKey={setRunIdempotencyKey}
            onSelectVersion={(versionId) => {
              setRunVersionId(versionId);
              void evaluateSelectedVersion(versionId);
            }}
            onRun={() => void runPublished()}
            onRefreshPin={() => void refreshPin()}
          />
        </div>
      ) : null}

      <WorkflowConfigPins identity={identity} ready={canCall} />
    </div>
  );
}
