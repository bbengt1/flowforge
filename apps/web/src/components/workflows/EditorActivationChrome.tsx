"use client";

import { useEffect, useMemo, useState } from "react";
import { ProblemBanner } from "@/components/ProblemBanner";
import {
  EDITOR_ACTIVATION_COMPOSE,
  EDITOR_ACTIVATION_HEADING_ID,
  EDITOR_ACTIVATION_MANUAL_HELP,
  EDITOR_ACTIVATION_PANEL_ID,
  R6_CONFIRMATION,
  canManageEditorActivation,
  canViewEditorActivation,
  composeEditorActivation,
  editorActivationLooksLive,
  editorActivationTopBarLabel,
  publishedActivationVersions,
  subscribeEditorActivationChanged,
  type EditorActivationPin,
  type EditorActivationState,
} from "@/lib/editor-activation";
import {
  applyEditorActivationToggle,
  loadEditorActivation,
} from "@/lib/editor-activation-client";
import { editorTopBarControlLabel } from "@/lib/e12-accessibility-contract";
import type { DevIdentity } from "@/lib/identity-headers";
import type { ProblemDetails } from "@/lib/problem";
import type { WorkflowVersion } from "@/lib/workflow-types";

type EditorActivationChromeProps = {
  identity: DevIdentity;
  workflowId?: string;
  permissions: string[] | null;
  variant: "compact" | "panel";
  onOpenTriggers?: () => void;
};

export function EditorActivationChrome({
  identity,
  workflowId,
  permissions,
  variant,
  onOpenTriggers,
}: EditorActivationChromeProps) {
  const canView = canViewEditorActivation(permissions);
  const canManage = canManageEditorActivation(permissions);
  const [versions, setVersions] = useState<WorkflowVersion[]>([]);
  const [pins, setPins] = useState<EditorActivationPin[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [message, setMessage] = useState("");

  const published = useMemo(
    () => publishedActivationVersions(versions),
    [versions],
  );
  const state = useMemo(
    () =>
      composeEditorActivation({
        versions,
        pins,
        selectedVersionId: selectedVersionId || null,
      }),
    [pins, selectedVersionId, versions],
  );

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!workflowId || !canView) {
        setVersions([]);
        setPins([]);
        return;
      }
      setPending((current) => current ?? "list");
      const result = await loadEditorActivation(identity, workflowId, {
        canView,
      });
      if (cancelled) {
        return;
      }
      setVersions(result.versions);
      setPins(result.pins);
      setSelectedVersionId((current) =>
        current || result.state.publishedVersionId || "",
      );
      setProblem(result.ok ? null : result.problem);
      setPending(null);
    }
    void load();
    const unsubscribe = subscribeEditorActivationChanged(() => {
      void load();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [canView, identity, workflowId]);

  async function onToggle(intent: "enable" | "disable") {
    if (!canManage || !workflowId) {
      return;
    }
    setPending(intent);
    setProblem(null);
    setMessage("");
    const result = await applyEditorActivationToggle(
      identity,
      workflowId,
      pins,
      state.publishedVersionId,
      intent,
    );
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setMessage(result.message);
    const next = await loadEditorActivation(identity, workflowId, {
      selectedVersionId: state.publishedVersionId,
      canView,
    });
    setVersions(next.versions);
    setPins(next.pins);
    if (!next.ok) {
      setProblem(next.problem);
    }
  }

  if (variant === "compact") {
    return (
      <CompactActivation
        state={state}
        loading={pending === "list" && versions.length === 0}
        disabled={!workflowId}
        onOpenTriggers={onOpenTriggers}
      />
    );
  }

  return (
    <section
      id={EDITOR_ACTIVATION_PANEL_ID}
      aria-labelledby={EDITOR_ACTIVATION_HEADING_ID}
      data-editor-activation="panel"
      data-r6-d2={R6_CONFIRMATION.d2ComposeEnablePlusVersionPin}
      data-r6-d3={R6_CONFIRMATION.d3TriggersStayWorkflowLevel}
      data-r6-draft-live={R6_CONFIRMATION.draftsNeverLookLive}
      className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
            R6.1 · Activation · D2 compose
          </p>
          <h2
            id={EDITOR_ACTIVATION_HEADING_ID}
            className="text-base font-semibold"
          >
            This published version is active
          </h2>
          <p className="mt-1 text-sm text-zinc-600">{EDITOR_ACTIVATION_COMPOSE}</p>
        </div>
        <ActivationStatus state={state} />
      </div>

      {!workflowId ? (
        <p className="mt-4 text-sm text-zinc-600">
          Open a workflow to compose webhook and schedule enable + version pin.
        </p>
      ) : null}

      {published.length > 0 ? (
        <label className="mt-4 block text-sm">
          <span className="text-xs font-medium text-zinc-600">
            Published version pin
          </span>
          <select
            value={selectedVersionId}
            onChange={(event) => setSelectedVersionId(event.target.value)}
            className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm"
          >
            {published.map((item) => (
              <option key={item.id} value={item.id}>
                v{item.versionNumber}
                {item.publishNote ? ` · ${item.publishNote}` : ""}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <p
        role="status"
        data-editor-activation-live={editorActivationLooksLive(state) ? "true" : "false"}
        data-editor-activation-draft-live={state.draftLooksLive ? "true" : "false"}
        className="mt-3 text-sm font-medium text-zinc-900"
      >
        {state.label}
      </p>
      <p className="mt-1 text-sm text-zinc-600">{state.help}</p>
      <p className="mt-2 text-xs text-zinc-500">{EDITOR_ACTIVATION_MANUAL_HELP}</p>

      {problem ? (
        <div className="mt-4">
          <ProblemBanner problem={problem} />
        </div>
      ) : null}

      {message ? (
        <p role="status" className="mt-3 text-sm text-teal-900">
          {message}
        </p>
      ) : null}

      {!canView ? (
        <p role="status" className="mt-3 text-sm font-medium text-rose-950">
          Viewing activation requires workflow.view.
        </p>
      ) : null}

      {!canManage && canView ? (
        <p role="status" className="mt-3 text-sm text-amber-950">
          Enabling or disabling pins requires workflow.edit.
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={
            !canManage || pending !== null || !state.canActivate || !workflowId
          }
          onClick={() => void onToggle("enable")}
          className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
        >
          {pending === "enable" ? "Activating…" : "Activate published version"}
        </button>
        <button
          type="button"
          disabled={
            !canManage || pending !== null || !state.canDeactivate || !workflowId
          }
          onClick={() => void onToggle("disable")}
          className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-zinc-50 disabled:opacity-60"
        >
          {pending === "disable" ? "Deactivating…" : "Deactivate"}
        </button>
      </div>

      <ul className="mt-4 space-y-2">
        {state.enabledPins.concat(state.disabledPins).map((pin) => (
          <li
            key={`${pin.kind}:${pin.id}`}
            className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700"
          >
            <span className="font-medium capitalize">{pin.kind}</span>
            {" · "}
            <span className="font-mono text-xs">{pin.label}</span>
            {" · "}
            <span className="capitalize">{pin.status}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function CompactActivation({
  state,
  loading,
  disabled,
  onOpenTriggers,
}: {
  state: EditorActivationState;
  loading: boolean;
  disabled: boolean;
  onOpenTriggers?: () => void;
}) {
  const live = editorActivationLooksLive(state);
  return (
    <div
      data-editor-activation="compact"
      data-r6-d2={R6_CONFIRMATION.d2ComposeEnablePlusVersionPin}
      data-r6-d3={R6_CONFIRMATION.d3TriggersStayWorkflowLevel}
      data-r6-draft-live={R6_CONFIRMATION.draftsNeverLookLive}
      className="flex items-center gap-2"
    >
      <p
        role="status"
        data-editor-activation-live={live ? "true" : "false"}
        data-editor-activation-draft-live={state.draftLooksLive ? "true" : "false"}
        className={`text-xs ${live ? "font-medium text-teal-900" : "text-zinc-600"}`}
      >
        {loading ? "Activation…" : editorActivationTopBarLabel(state)}
      </p>
      <button
        type="button"
        data-editor-activation="open"
        onClick={onOpenTriggers}
        disabled={disabled || !onOpenTriggers}
        className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm hover:bg-zinc-50 disabled:opacity-60"
      >
        {editorTopBarControlLabel("activation")}
      </button>
    </div>
  );
}

function ActivationStatus({ state }: { state: EditorActivationState }) {
  const live = editorActivationLooksLive(state);
  return (
    <p
      className={`rounded-full px-2.5 py-1 text-xs font-medium ${
        live
          ? "bg-teal-50 text-teal-900"
          : "bg-zinc-100 text-zinc-700"
      }`}
    >
      {live ? "Active" : "Not live"}
    </p>
  );
}
