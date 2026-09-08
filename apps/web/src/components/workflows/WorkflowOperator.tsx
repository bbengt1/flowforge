"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { IsolationIdentityPanel } from "@/components/isolation/IsolationIdentityPanel";
import { ProblemBanner } from "@/components/ProblemBanner";
import { CatalogPanel } from "@/components/workflows/CatalogPanel";
import { DraftConflictBanner } from "@/components/workflows/DraftConflictBanner";
import { RunControl } from "@/components/workflows/RunControl";
import { ValidationPanel } from "@/components/workflows/ValidationPanel";
import { VersionHistory } from "@/components/workflows/VersionHistory";
import { WorkflowList } from "@/components/workflows/WorkflowList";
import { YamlEditor } from "@/components/workflows/YamlEditor";
import { loadDevIdentity, emptyStoredIdentity, subscribeDevIdentity } from "@/lib/dev-identity";
import { loadHeaderFallback, subscribeHeaderFallback } from "@/lib/header-fallback";
import { hasOperatorCaller, hasWorkspaceLookup } from "@/lib/identity-headers";
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
  getWorkflowDraft,
  getWorkflowExecution,
  listWorkflows,
  listWorkflowVersions,
  normalizeWorkflowYaml,
  publishWorkflow,
  restoreWorkflowVersion,
  saveWorkflowDraft,
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

export function WorkflowOperator() {
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
  const [execution, setExecution] = useState<WorkflowExecution | null>(null);

  const validateSeq = useRef(0);
  const skipDebounce = useRef(false);

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

  async function refreshVersions(workflowId: string) {
    const result = await listWorkflowVersions(identity, workflowId);
    setLastRequestId(result.requestId);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setVersions(result.items);
    setRunVersionId((current) => {
      if (current && result.items.some((item) => item.id === current)) {
        return current;
      }
      return result.items[0]?.id ?? "";
    });
  }

  async function openWorkflow(record: WorkflowRecord) {
    setPending("open");
    setProblem(null);
    setConflictDraft(null);
    setConflictProblem(null);
    setCompare(null);
    setPublishedVersion(null);
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
    const created = result.workflow;
    if (created) {
      setWorkflow(created);
      setItems((current) => [
        created,
        ...current.filter((item) => item.id !== created.id),
      ]);
    }
    applyEditor({ ...result.applied, revision: result.applied.revision });
    setVersions([]);
    setRunVersionId("");
    setExecution(null);
    setPublishedVersion(null);
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
    const result = await saveWorkflowDraft(identity, workflow.id, yaml, revision);
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
    if (!workflow || revision === null) {
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

  async function runPublished() {
    if (!workflow || !runVersionId) {
      return;
    }
    setPending("run");
    setProblem(null);
    const result = await startWorkflowExecution(identity, workflow.id, runVersionId);
    setLastRequestId(result.requestId);
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setExecution(result.execution);
  }

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
  }

  function importFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      skipDebounce.current = false;
      setDigest(null);
      setYaml(text);
    };
    reader.readAsText(file);
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
        pending={pending === "list" || pending === "create"}
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
            setDigest(null);
            setYaml(STARTER_WORKFLOW_YAML);
          }}
          className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50"
        >
          Load starter YAML
        </button>
        <button
          type="button"
          onClick={() => {
            setDigest(null);
            setYaml(INVALID_WORKFLOW_YAML);
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
        <button
          type="button"
          onClick={() => void runValidate(yaml)}
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
          disabled={!canCall || pending !== null || !workflow || revision === null}
          className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
        >
          {pending === "save" ? "Saving…" : "Save draft"}
        </button>
      </div>

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
        <CatalogPanel
          catalog={catalog}
          pending={pending === "catalog"}
          onRefresh={() => void loadCatalog()}
        />
        <YamlEditor
          value={yaml}
          onChange={(next) => {
            setDigest(null);
            setYaml(next);
          }}
          focusLine={focusLine}
          focusToken={focusToken}
          errorLines={errorLines}
        />
        <ValidationPanel
          status={status}
          errors={errors}
          warnings={warnings}
          summary={summary}
          digest={digest}
          problem={problem}
          onJump={(line) => {
            setFocusLine(line);
            setFocusToken((token) => token + 1);
          }}
        />
      </div>

      {workflow ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <VersionHistory
            versions={versions}
            pending={pending}
            compareLeft={compareLeft}
            compareRight={compareRight}
            compare={compare}
            onCompareLeft={setCompareLeft}
            onCompareRight={setCompareRight}
            onCompare={() => void runCompare()}
            onExport={(version) => void exportVersion(version)}
            onRestore={(version) => void restoreVersion(version)}
          />
          <RunControl
            versions={versions}
            selectedVersionId={runVersionId}
            execution={execution}
            pending={pending === "run" || pending === "pin"}
            dirty={dirty}
            onSelectVersion={setRunVersionId}
            onRun={() => void runPublished()}
            onRefreshPin={() => void refreshPin()}
          />
        </div>
      ) : null}
    </div>
  );
}
