"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { ProblemBanner } from "@/components/ProblemBanner";
import { callIdentityProxy } from "@/lib/identity-client";
import {
  emptyStoredIdentity,
  loadDevIdentity,
  subscribeDevIdentity,
} from "@/lib/dev-identity";
import { loadHeaderFallback, subscribeHeaderFallback } from "@/lib/header-fallback";
import {
  hasOperatorCaller,
  hasWorkspaceLookup,
} from "@/lib/identity-headers";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";
import {
  classifyIsolationResult,
  emptyIsolationTargets,
  EXAMPLE_MISMATCH_WORKSPACE_ID,
  isolationExercises,
  type IsolationExerciseDef,
  type IsolationTargetIds,
} from "@/lib/isolation-exercises";
import { ISOLATION_KINDS, type IsolationKind, type IsolationRecord } from "@/lib/isolation-types";
import type { ItemList } from "@/lib/identity-types";
import type { ProblemDetails } from "@/lib/problem";

type ExerciseResult = {
  exercise: IsolationExerciseDef;
  statusCode: number;
  requestId: string;
  held: boolean;
  label: string;
  problem: ProblemDetails | null;
  data: unknown;
};

export function IsolationExercise() {
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
  const [targets, setTargets] = useState<IsolationTargetIds>(emptyIsolationTargets);
  const [sendMismatch, setSendMismatch] = useState(false);
  const [mismatchWorkspaceId, setMismatchWorkspaceId] = useState(
    EXAMPLE_MISMATCH_WORKSPACE_ID,
  );
  const [seedKind, setSeedKind] = useState<IsolationKind>("credential");
  const [seedName, setSeedName] = useState("isolation-seed");
  const [seeded, setSeeded] = useState<IsolationRecord[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [results, setResults] = useState<ExerciseResult[]>([]);

  const exercises = useMemo(() => isolationExercises(targets), [targets]);
  const mismatchId = sendMismatch ? mismatchWorkspaceId.trim() : undefined;

  function setTarget(field: keyof IsolationTargetIds, value: string) {
    setTargets((current) => ({ ...current, [field]: value }));
  }

  async function runExercise(exercise: IsolationExerciseDef): Promise<ExerciseResult> {
    const result = await callIdentityProxy<unknown>(exercise.path, identity, {
      method: exercise.method,
      body: exercise.body,
      mismatchWorkspaceId: mismatchId,
    });
    const statusCode = result.statusCode;
    const classified = classifyIsolationResult(statusCode, exercise.expectedOutcome);
    if (result.ok) {
      return {
        exercise,
        statusCode,
        requestId: result.requestId,
        held: classified.held,
        label: classified.label,
        problem: null,
        data: result.data,
      };
    }
    return {
      exercise,
      statusCode,
      requestId: result.requestId,
      held: classified.held,
      label: classified.label,
      problem: result.problem,
      data: null,
    };
  }

  async function runOne(exercise: IsolationExerciseDef) {
    setPending(exercise.id);
    const next = await runExercise(exercise);
    setResults((current) => [
      next,
      ...current.filter((item) => item.exercise.id !== exercise.id),
    ]);
    setPending(null);
  }

  async function runFailClosed() {
    setPending("all");
    const next: ExerciseResult[] = [];
    for (const exercise of exercises.filter((item) => item.expectedOutcome === "fail-closed")) {
      next.push(await runExercise(exercise));
    }
    setResults(next);
    setPending(null);
  }

  async function seedRecord() {
    setPending("seed");
    const result = await callIdentityProxy<IsolationRecord>(
      "/workspace/records",
      identity,
      {
        method: "POST",
        body: { kind: seedKind, name: seedName.trim() },
        mismatchWorkspaceId: mismatchId,
      },
    );
    if (result.ok) {
      setSeeded((current) => [result.data, ...current]);
      if (seedKind === "credential") {
        setTarget("credentialId", result.data.id);
        setTarget("recordId", result.data.id);
      } else if (seedKind === "artifact") {
        setTarget("artifactId", result.data.id);
        setTarget("recordId", result.data.id);
      } else if (seedKind === "realtime") {
        setTarget("channelId", result.data.id);
        setTarget("recordId", result.data.id);
      } else {
        setTarget("recordId", result.data.id);
      }
    } else {
      setResults((current) => [
        {
          exercise: {
            id: "seed-record",
            label: "Create scoped record in the current workspace",
            method: "POST",
            path: "/workspace/records",
            expectedOutcome: "fail-closed",
            surface: "record",
            detail: "Seed helper — not a negative exercise.",
          },
          statusCode: result.statusCode,
          requestId: result.requestId,
          held: false,
          label: "Seed failed",
          problem: result.problem,
          data: null,
        },
        ...current,
      ]);
    }
    setPending(null);
  }

  async function listCurrent(kind: IsolationKind) {
    setPending(`list-${kind}`);
    const result = await callIdentityProxy<ItemList<IsolationRecord>>(
      `/workspace/records?kind=${encodeURIComponent(kind)}`,
      identity,
      { mismatchWorkspaceId: mismatchId },
    );
    if (result.ok) {
      setSeeded(result.data.items ?? []);
    } else {
      setResults((current) => [
        {
          exercise: {
            id: `list-${kind}`,
            label: `List ${kind} records`,
            method: "GET",
            path: `/workspace/records?kind=${kind}`,
            expectedOutcome: "scoped-list",
            surface: "record",
            detail: "Current-workspace list helper.",
          },
          statusCode: result.statusCode,
          requestId: result.requestId,
          held: classifyIsolationResult(result.statusCode, "scoped-list").held,
          label: classifyIsolationResult(result.statusCode, "scoped-list").label,
          problem: result.problem,
          data: null,
        },
        ...current,
      ]);
    }
    setPending(null);
  }

  const ready =
    hasOperatorCaller(session.active, identity, headerFallback) &&
    hasWorkspaceLookup(identity);

  return (
    <section
      aria-labelledby="isolation-heading"
      className="space-y-6 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm"
    >
      <div>
        <p className="text-sm font-medium tracking-wide text-zinc-500 uppercase">
          Negative check
        </p>
        <h2 id="isolation-heading" className="mt-1 text-lg font-semibold">
          Isolation check
        </h2>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-zinc-600">
          Same cookie session (or temporary header fallback) and tenant +
          workbench lookup as members admin. These calls hit isolation hook
          routes. <strong>Success is a denial</strong> — cross-workspace
          access must fail closed and problem+json (
          <code className="font-mono text-xs">code</code>,{" "}
          <code className="font-mono text-xs">request_id</code>) stay visible.
          Host-supplied{" "}
          <code className="font-mono text-xs">X-FlowForge-Workspace-ID</code>{" "}
          is never the workspace selector. This is not a product surface.
        </p>
      </div>

      {!ready ? (
        <p className="rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-700">
          Establish a cookie session (or enable the temporary header
          fallback) and set tenant + workbench key. Workspace UUID is not a
          lookup field.
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <h3 className="font-medium">Current-workspace seed</h3>
          <p className="mt-1 text-sm text-zinc-600">
            Optional. Create a record in the <em>current</em> workspace, copy
            its id, then switch workbench key and replay the foreign-id
            exercises. Body{" "}
            <code className="font-mono text-xs">id</code> /{" "}
            <code className="font-mono text-xs">workspace_id</code> are not
            sent.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              <span className="font-medium">Kind</span>
              <select
                value={seedKind}
                onChange={(event) =>
                  setSeedKind(event.target.value as IsolationKind)
                }
                className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
              >
                {ISOLATION_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="font-medium">Name</span>
              <input
                value={seedName}
                onChange={(event) => setSeedName(event.target.value)}
                className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-mono text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
              />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void seedRecord()}
              disabled={pending !== null || !ready || !seedName.trim()}
              className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
            >
              {pending === "seed" ? "Creating…" : "Create scoped record"}
            </button>
            <button
              type="button"
              onClick={() => void listCurrent(seedKind)}
              disabled={pending !== null || !ready}
              className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-60"
            >
              List current {seedKind}
            </button>
          </div>
          {seeded.length > 0 ? (
            <ul className="mt-3 divide-y divide-zinc-100 text-sm">
              {seeded.map((record) => (
                <li key={record.id} className="py-2">
                  <p className="font-medium">
                    {record.kind} · {record.name}
                  </p>
                  <p className="font-mono text-xs break-all text-zinc-500">
                    {record.id}
                  </p>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div>
          <h3 className="font-medium">Foreign identifiers</h3>
          <p className="mt-1 text-sm text-zinc-600">
            IDs and cache keys treated as belonging to another workspace.
            They are not a workspace selector.
          </p>
          <div className="mt-3 grid gap-3">
            <IdField
              id="foreign-credential"
              label="Credential id"
              value={targets.credentialId}
              onChange={(value) => setTarget("credentialId", value)}
            />
            <IdField
              id="foreign-artifact"
              label="Artifact id"
              value={targets.artifactId}
              onChange={(value) => setTarget("artifactId", value)}
            />
            <IdField
              id="foreign-cache"
              label="Cache key"
              value={targets.cacheKey}
              onChange={(value) => setTarget("cacheKey", value)}
            />
            <IdField
              id="foreign-channel"
              label="Realtime channel id"
              value={targets.channelId}
              onChange={(value) => setTarget("channelId", value)}
            />
            <IdField
              id="foreign-record"
              label="Record id"
              value={targets.recordId}
              onChange={(value) => setTarget("recordId", value)}
            />
          </div>
        </div>
      </div>

      <fieldset className="rounded-xl border border-dashed border-zinc-300 bg-zinc-50 px-4 py-3">
        <legend className="px-1 text-sm font-medium">
          Deliberate Workspace-ID mismatch (fail demo)
        </legend>
        <p className="text-sm text-zinc-600">
          Optional. Sends{" "}
          <code className="font-mono text-xs">X-FlowForge-Workspace-ID</code>{" "}
          <em>in addition to</em> tenant + workbench so the API can reject
          the mismatch (403). This is not how you select a workspace.
          Workspace-ID-only remains rejected and is not offered here.
        </p>
        <label className="mt-3 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={sendMismatch}
            onChange={(event) => setSendMismatch(event.target.checked)}
            className="mt-1"
          />
          <span>Also send a mismatched Workspace-ID header</span>
        </label>
        {sendMismatch ? (
          <label className="mt-3 block text-sm">
            <span className="font-medium">Mismatched workspace UUID</span>
            <input
              value={mismatchWorkspaceId}
              onChange={(event) => setMismatchWorkspaceId(event.target.value)}
              className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
            />
          </label>
        ) : null}
      </fieldset>

      <div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-medium">Hook routes</h3>
          <button
            type="button"
            onClick={() => void runFailClosed()}
            disabled={pending !== null || !ready}
            className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
          >
            {pending === "all" ? "Running…" : "Run fail-closed checks"}
          </button>
        </div>
        <ul className="mt-3 grid gap-2">
          {exercises.map((exercise) => (
            <li
              key={exercise.id}
              className="flex flex-col gap-2 rounded-xl border border-zinc-100 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <p className="text-sm font-medium">{exercise.label}</p>
                <p className="font-mono text-xs text-zinc-500">
                  {exercise.method} {exercise.path}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void runOne(exercise)}
                disabled={pending !== null || !ready}
                className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50 disabled:opacity-60"
              >
                {pending === exercise.id ? "Calling…" : "Check"}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div aria-live="polite">
        <h3 className="font-medium">Results</h3>
        <p className="mt-1 text-sm text-zinc-600">
          Fail-closed (403/404/400 with problem details) is a denial —
          the expected success for foreign-id and host-supplied identity
          attempts. A 2xx on a fail-closed check did not hold.
        </p>
        {results.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-600">No exercises run yet.</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {results.map((item) => (
              <li key={`${item.exercise.id}-${item.requestId}`}>
                <article
                  className={
                    item.held
                      ? "rounded-xl border border-teal-200 bg-teal-50 px-4 py-3 text-sm text-teal-950"
                      : "rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-950"
                  }
                >
                  <p className="font-medium">
                    {item.label}
                    {item.statusCode ? ` (${item.statusCode})` : null}
                  </p>
                  <p className="mt-1 font-mono text-xs">
                    {item.exercise.method} {item.exercise.path}
                  </p>
                  {item.problem ? (
                    <div className="mt-3">
                      <ProblemBanner
                        problem={item.problem}
                        className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950"
                      />
                    </div>
                  ) : item.data !== null ? (
                    <pre className="mt-2 overflow-x-auto font-mono text-xs">
                      {JSON.stringify(item.data, null, 2)}
                    </pre>
                  ) : null}
                  <p className="mt-2 font-mono text-xs opacity-80">
                    request_id {item.requestId}
                  </p>
                </article>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function IdField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label htmlFor={id} className="block text-sm">
      <span className="font-medium text-zinc-800">{label}</span>
      <input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        autoComplete="off"
        className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
      />
    </label>
  );
}
