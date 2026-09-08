"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { IsolationIdentityPanel } from "@/components/isolation/IsolationIdentityPanel";
import { ProblemBanner } from "@/components/ProblemBanner";
import { CatalogPanel } from "@/components/workflows/CatalogPanel";
import { ValidationPanel } from "@/components/workflows/ValidationPanel";
import { YamlEditor } from "@/components/workflows/YamlEditor";
import { loadDevIdentity, emptyStoredIdentity, subscribeDevIdentity } from "@/lib/dev-identity";
import { loadHeaderFallback, subscribeHeaderFallback } from "@/lib/header-fallback";
import { hasOperatorCaller, hasWorkspaceLookup } from "@/lib/identity-headers";
import type { ProblemDetails } from "@/lib/problem";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";
import {
  INVALID_WORKFLOW_YAML,
  STARTER_WORKFLOW_YAML,
  VALIDATE_DEBOUNCE_MS,
} from "@/lib/workflow";
import {
  fetchWorkflowCatalog,
  normalizeWorkflowYaml,
  validateWorkflowYaml,
} from "@/lib/workflow-client";
import type {
  WorkflowCatalog,
  WorkflowFieldError,
  WorkflowSummary,
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
  const validateSeq = useRef(0);
  const skipDebounce = useRef(false);

  const canCall = hasOperatorCaller(
    session.active,
    identity,
    headerFallback,
  ) && hasWorkspaceLookup(identity);

  const clearGraph = useCallback(() => {
    setSummary(null);
    setDigest(null);
    setWarnings([]);
  }, []);

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
    skipDebounce.current = true;
    validateSeq.current += 1;
    setYaml(result.applied.yaml);
    setDigest(result.applied.digest);
    setSummary(result.applied.summary);
    setWarnings(result.applied.warnings);
    setErrors([]);
    setStatus("valid");
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

      {problem && errors.length === 0 ? <ProblemBanner problem={problem} /> : null}
      {lastRequestId && !problem ? (
        <p className="font-mono text-xs text-zinc-500">
          last request_id {lastRequestId}
        </p>
      ) : null}

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
          className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
        >
          {pending === "normalize" ? "Normalizing…" : "Normalize"}
        </button>
      </div>
      <p className="text-sm text-zinc-600">
        Normalize replaces the editor with{" "}
        <code className="font-mono text-xs">definitionYaml</code> and shows the
        API digest. Draft save is E3.2 — this surface does not{" "}
        <code className="font-mono text-xs">PUT</code> a draft.
      </p>

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
    </div>
  );
}
