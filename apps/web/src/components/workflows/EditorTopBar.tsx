"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useEmbedMode } from "@/components/embed/EmbedMode";
import {
  EDITOR_WORKFLOWS_HREF,
  editorDirtyLabel,
  editorRevisionLabel,
  editorStickyContext,
} from "@/lib/editor-chrome";
import {
  EDITOR_DRAWER_PANEL_IDS,
  editorDrawerTriggerId,
  editorTopBarControlLabel,
} from "@/lib/e12-accessibility-contract";
import { TYPE_CAPTION_CLASS } from "@/lib/aesthetic-usability-density";
import {
  EDITOR_TOPBAR_GROUP_LABELS,
  EDITOR_TOPBAR_PRIMARY_CONTROL_CLASS,
} from "@/lib/editor-topbar-chunking";
import {
  editorWorkingMemoryChrome,
} from "@/lib/editor-working-memory";
import type { DohertyChrome } from "@/lib/doherty-pending-chrome";
import { DohertyStatus } from "@/components/chrome/DohertyStatus";
import { satelliteOverlayTriggerId } from "@/lib/rewrite-satellite-a11y";
import {
  EDITOR_CANVAS_REDO_LABEL,
  EDITOR_CANVAS_UNDO_LABEL,
} from "@/lib/editor-canvas-history";
import { embedDeepLink } from "@/lib/embed-tenancy-contract";
import { EditorActivationChrome } from "@/components/workflows/EditorActivationChrome";
import type { DevIdentity } from "@/lib/identity-headers";
import type { WorkflowRecord } from "@/lib/workflow-types";
import {
  FF_EDITOR_CONTROL_CLASS,
  FF_EDITOR_DANGER_CLASS,
  FF_EDITOR_DIVIDER_CLASS,
  FF_EDITOR_GHOST_CLASS,
  FF_EDITOR_MUTED_CLASS,
  FF_EDITOR_PRIMARY_CLASS,
  FF_EDITOR_TOPBAR_CLASS,
} from "@/lib/editor-visual";
import {
  WORKFLOW_NAME_NOT_READY,
  WORKFLOW_NAME_SAVE_FAILED,
  workflowNameCommitDecision,
  type WorkflowNameRenameResult,
} from "@/lib/editor-workflow-name";

type EditorTopBarProps = {
  workflow: WorkflowRecord | null;
  loaded?: boolean;
  revision: number | null;
  dirty: boolean;
  canCall: boolean;
  pending: string | null;
  doherty?: DohertyChrome;
  canSave: boolean;
  canPublish: boolean;
  canTestRun: boolean;
  canStartPublished: boolean;
  yamlOpen: boolean;
  libraryOpen: boolean;
  runsOpen: boolean;
  inspectorOpen: boolean;
  publishNote: string;
  identity: DevIdentity;
  permissions: string[] | null;
  onPublishNote: (value: string) => void;
  onSave: () => void;
  onPublish: () => void;
  onStart: () => void;
  onTestRun: () => void;
  onOpenActivation: () => void;
  onToggleYaml: () => void;
  onToggleLibrary: () => void;
  onToggleRuns: () => void;
  onToggleInspector: () => void;
  onAddAction: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  canRename?: boolean;
  onRenameWorkflow?: (name: string) => Promise<WorkflowNameRenameResult>;
};

const SATELLITE_CONTROL = `${FF_EDITOR_GHOST_CLASS} px-2 py-1 text-sm`;
const HISTORY_CONTROL = `${FF_EDITOR_GHOST_CLASS} px-2 py-1 text-sm disabled:opacity-60`;
const GROUP = "flex shrink-0 items-center gap-1.5";
const GROUP_DIVIDER = `${GROUP} ${FF_EDITOR_DIVIDER_CLASS} ps-3`;
/** Secondary labels yield before the workflow name. Save and Publish stay labeled. */
const NARROW_SECONDARY_LABEL = "max-[1680px]:sr-only";

export function EditorTopBar({
  workflow,
  loaded = false,
  revision,
  dirty,
  canCall,
  pending,
  doherty,
  canSave,
  canPublish,
  canTestRun,
  canStartPublished,
  yamlOpen,
  libraryOpen,
  runsOpen,
  inspectorOpen,
  publishNote,
  identity,
  permissions,
  onPublishNote,
  onSave,
  onPublish,
  onStart,
  onTestRun,
  onOpenActivation,
  onToggleYaml,
  onToggleLibrary,
  onToggleRuns,
  onToggleInspector,
  onAddAction,
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
  canRename = false,
  onRenameWorkflow,
}: EditorTopBarProps) {
  const embed = useEmbedMode();
  const backHref = embed ? embedDeepLink(EDITOR_WORKFLOWS_HREF) : EDITOR_WORKFLOWS_HREF;
  const context = editorStickyContext(workflow, { loaded });
  const dirtyLabel = editorDirtyLabel(dirty);
  const memory = editorWorkingMemoryChrome({
    dirty,
    hasWorkflow: Boolean(workflow),
    revision,
    hasPublishedVersion: canStartPublished,
    permissions,
  });

  return (
    <header
      data-editor-context="sticky"
      className={`sticky top-0 z-10 flex w-full min-w-0 shrink-0 flex-wrap items-center gap-3 px-3 py-2 ${FF_EDITOR_TOPBAR_CLASS}`}
    >
      <div
        data-editor-topbar="identity"
        className="flex max-w-full min-w-[12rem] grow items-center gap-3 max-[1680px]:basis-full"
      >
        <Link
          href={backHref}
          className={`${FF_EDITOR_GHOST_CLASS} shrink-0 px-2 py-1 text-sm`}
        >
          {editorTopBarControlLabel("back")}
        </Link>
        <div className="min-w-[12rem] grow basis-[12rem] overflow-hidden">
          <EditorWorkflowName
            key={workflow?.id ?? "none"}
            heading={context.heading}
            seed={workflow?.name ?? ""}
            canRename={canRename && context.loaded && Boolean(workflow)}
            pending={pending}
            onRenameWorkflow={onRenameWorkflow}
          />
          {context.slug ? (
            <p
              className={`truncate font-mono text-xs ${FF_EDITOR_MUTED_CLASS}`}
              title={context.slug}
            >
              {context.slug}
            </p>
          ) : (
            <p className={`text-xs ${FF_EDITOR_MUTED_CLASS}`}>
              {context.loaded
                ? "This workflow could not be loaded."
                : "Loading this workflow…"}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <p className={`text-xs ${FF_EDITOR_MUTED_CLASS}`} role="status">
            {workflow ? (
              <>
                <span data-editor-working-memory="draft">{memory.draft}</span>
                {" · "}
                {editorRevisionLabel(revision)}
                {" · "}
                <span className={dirty ? "font-medium text-fg" : FF_EDITOR_MUTED_CLASS}>
                  {dirtyLabel}
                </span>
              </>
            ) : (
              context.status
            )}
          </p>
          {doherty ? <DohertyStatus chrome={doherty} /> : null}
        </div>
      </div>
      <div
        role="group"
        aria-label={EDITOR_TOPBAR_GROUP_LABELS.authoring}
        data-editor-topbar="authoring"
        className={GROUP}
      >
        <label className="hidden text-xs sm:block">
          <span className="sr-only">{editorTopBarControlLabel("publish-note")}</span>
          <input
            value={publishNote}
            onChange={(event) => onPublishNote(event.target.value)}
            placeholder={editorTopBarControlLabel("publish-note")}
            className={`w-40 px-2 py-1 text-sm ${FF_EDITOR_CONTROL_CLASS}`}
          />
        </label>
        <button
          type="button"
          onClick={onSave}
          disabled={!canCall || pending !== null || !workflow || revision === null || !canSave}
          aria-busy={pending === "save"}
          className={`${FF_EDITOR_PRIMARY_CLASS} ${EDITOR_TOPBAR_PRIMARY_CONTROL_CLASS} disabled:opacity-60`}
        >
          {pending === "save" ? "Saving…" : editorTopBarControlLabel("save")}
        </button>
        <button
          type="button"
          onClick={onPublish}
          disabled={!canCall || pending !== null || !canPublish}
          aria-busy={pending === "publish"}
          className={`${FF_EDITOR_GHOST_CLASS} ${EDITOR_TOPBAR_PRIMARY_CONTROL_CLASS} disabled:opacity-60`}
        >
          {pending === "publish" ? "Publishing…" : editorTopBarControlLabel("publish")}
        </button>
      </div>
      <div data-editor-topbar="history" className={GROUP_DIVIDER}>
        <button
          type="button"
          id={satelliteOverlayTriggerId("action-wizard")}
          onClick={onAddAction}
          className={`${FF_EDITOR_PRIMARY_CLASS} ${EDITOR_TOPBAR_PRIMARY_CONTROL_CLASS}`}
        >
          {editorTopBarControlLabel("add-action")}
        </button>
        <button
          type="button"
          data-editor-history="undo"
          title={EDITOR_CANVAS_UNDO_LABEL}
          aria-label={editorTopBarControlLabel("undo")}
          aria-keyshortcuts="Control+Z Meta+Z"
          onClick={onUndo}
          disabled={!onUndo || !canUndo}
          className={`${HISTORY_CONTROL} inline-flex items-center gap-1.5`}
        >
          <TopBarMark kind="undo" />
          <span className={NARROW_SECONDARY_LABEL}>{editorTopBarControlLabel("undo")}</span>
        </button>
        <button
          type="button"
          data-editor-history="redo"
          title={EDITOR_CANVAS_REDO_LABEL}
          aria-label={editorTopBarControlLabel("redo")}
          aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z"
          onClick={onRedo}
          disabled={!onRedo || !canRedo}
          className={`${HISTORY_CONTROL} inline-flex items-center gap-1.5`}
        >
          <TopBarMark kind="redo" />
          <span className={NARROW_SECONDARY_LABEL}>{editorTopBarControlLabel("redo")}</span>
        </button>
      </div>
      <div
        role="group"
        aria-label={EDITOR_TOPBAR_GROUP_LABELS.satellites}
        data-editor-topbar="satellites"
        className={GROUP_DIVIDER}
      >
        <SatelliteToggle id="library" open={libraryOpen} onClick={onToggleLibrary} />
        <SatelliteToggle id="inspector" open={inspectorOpen} onClick={onToggleInspector} />
        <SatelliteToggle id="yaml" open={yamlOpen} onClick={onToggleYaml} />
        <SatelliteToggle
          id="runs"
          open={runsOpen}
          disabled={!workflow}
          onClick={onToggleRuns}
        />
      </div>
      <div data-editor-topbar="activation" className={`shrink-0 ${FF_EDITOR_DIVIDER_CLASS} ps-3`}>
        <EditorActivationChrome
          variant="compact"
          identity={identity}
          workflowId={workflow?.id}
          permissions={permissions}
          onOpenTriggers={onOpenActivation}
        />
      </div>
      <div
        role="group"
        aria-label={EDITOR_TOPBAR_GROUP_LABELS.run}
        data-editor-topbar="run"
        className={GROUP_DIVIDER}
      >
        <div className="flex flex-col gap-1">
          <div className={GROUP}>
            <button
              type="button"
              id={satelliteOverlayTriggerId("start-published")}
              onClick={onStart}
              disabled={!workflow || !memory.canStartPublished}
              aria-busy={pending === "run"}
              title={memory.startHelp}
              className={`${FF_EDITOR_GHOST_CLASS} ${EDITOR_TOPBAR_PRIMARY_CONTROL_CLASS} disabled:opacity-60`}
            >
              {pending === "run"
                ? "Starting…"
                : editorTopBarControlLabel("start")}
            </button>
            <button
              type="button"
              onClick={onTestRun}
              disabled={!canCall || pending !== null || !canTestRun}
              aria-busy={pending === "test-run"}
              title={memory.testRunHelp}
              className={`${FF_EDITOR_PRIMARY_CLASS} ${EDITOR_TOPBAR_PRIMARY_CONTROL_CLASS} disabled:opacity-60`}
            >
              {pending === "test-run"
                ? "Test run…"
                : editorTopBarControlLabel("test-run")}
            </button>
          </div>
          <p
            data-editor-working-memory="test-run"
            className={`max-w-[16rem] max-[1680px]:max-w-[12rem] ${TYPE_CAPTION_CLASS} ${FF_EDITOR_MUTED_CLASS} leading-snug`}
          >
            {memory.testRunCopy}
            {memory.canTestRun ? null : ` ${memory.testRunHelp}`}
            {memory.canStartPublished ? null : ` ${memory.startHelp}`}
          </p>
        </div>
      </div>
    </header>
  );
}

function EditorWorkflowName({
  heading,
  seed,
  canRename,
  pending,
  onRenameWorkflow,
}: {
  heading: string;
  seed: string;
  canRename: boolean;
  pending: string | null;
  onRenameWorkflow?: (name: string) => Promise<WorkflowNameRenameResult>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const ignoreBlur = useRef(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(seed);
  const [error, setError] = useState<string | null>(null);
  const busy = pending !== null;

  useEffect(() => {
    if (!renaming) {
      return;
    }
    const el = inputRef.current;
    if (!el) {
      return;
    }
    el.focus();
    el.select();
  }, [renaming]);

  function finishRename(nextError: string | null) {
    ignoreBlur.current = true;
    setRenaming(false);
    setDraft(seed);
    setError(nextError);
  }

  function startRename() {
    if (!canRename || busy) {
      return;
    }
    ignoreBlur.current = false;
    setDraft(seed);
    setError(null);
    setRenaming(true);
  }

  async function commitRename(fromBlur: boolean) {
    if (!renaming || ignoreBlur.current) {
      return;
    }
    const decision = workflowNameCommitDecision(draft, seed);
    if (decision.action === "keep") {
      finishRename(null);
      return;
    }
    if (decision.action === "invalid") {
      if (fromBlur) {
        finishRename(decision.error);
        return;
      }
      setError(decision.error);
      return;
    }
    if (!onRenameWorkflow) {
      finishRename(WORKFLOW_NAME_NOT_READY);
      return;
    }
    ignoreBlur.current = true;
    setError(null);
    let result: WorkflowNameRenameResult;
    try {
      result = await onRenameWorkflow(decision.name);
    } catch {
      result = { ok: false, error: WORKFLOW_NAME_SAVE_FAILED };
    }
    if (!result.ok) {
      ignoreBlur.current = false;
      setRenaming(true);
      setDraft(decision.name);
      setError(result.error);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
      return;
    }
    finishRename(null);
  }

  return (
    <>
      {renaming ? (
        <h1 className="min-w-[12rem]">
          <input
            ref={inputRef}
            data-editor-workflow-name="rename"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                void commitRename(false);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                if (busy) {
                  return;
                }
                finishRename(null);
              }
            }}
            onBlur={() => {
              if (busy) {
                return;
              }
              void commitRename(true);
            }}
            disabled={busy}
            aria-label="Workflow name"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "editor-workflow-name-error" : undefined}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            className={`w-full min-w-[12rem] text-base font-semibold tracking-tight ${FF_EDITOR_CONTROL_CLASS}`}
          />
        </h1>
      ) : canRename ? (
        <h1 className="truncate text-base font-semibold tracking-tight">
          <button
            type="button"
            data-editor-workflow-name="heading"
            title={heading}
            onClick={startRename}
            className="block w-full min-w-0 truncate border-0 bg-transparent p-0 text-start text-base font-semibold tracking-tight text-inherit"
          >
            <span className="sr-only">Rename workflow: </span>
            {heading}
          </button>
        </h1>
      ) : (
        <h1 className="truncate text-base font-semibold tracking-tight" title={heading}>
          {heading}
        </h1>
      )}
      {error ? (
        <p
          id="editor-workflow-name-error"
          role="alert"
          data-editor-workflow-name="error"
          className={`text-xs ${FF_EDITOR_DANGER_CLASS}`}
        >
          {error}
        </p>
      ) : null}
    </>
  );
}

type SatelliteId = "library" | "inspector" | "yaml" | "runs";
type TopBarMarkKind = SatelliteId | "undo" | "redo";

function SatelliteToggle({
  id,
  open,
  disabled = false,
  onClick,
}: {
  id: SatelliteId;
  open: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const label = editorTopBarControlLabel(id, open);
  return (
    <button
      type="button"
      id={editorDrawerTriggerId(id)}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={open}
      aria-expanded={open}
      aria-controls={EDITOR_DRAWER_PANEL_IDS[id]}
      aria-label={label}
      title={label}
      className={`${SATELLITE_CONTROL} inline-flex items-center gap-1.5 disabled:opacity-60`}
    >
      <TopBarMark kind={id} />
      <span className={NARROW_SECONDARY_LABEL}>{label}</span>
    </button>
  );
}

function TopBarMark({ kind }: { kind: TopBarMarkKind }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
      className="shrink-0"
    >
      <path
        d={TOP_BAR_MARK_PATHS[kind]}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const TOP_BAR_MARK_PATHS: Record<TopBarMarkKind, string> = {
  undo: "M6.2 3.5 3 6.7l3.2 3.2M3.4 6.7h6.2a3 3 0 1 1 0 6H8",
  redo: "M9.8 3.5 13 6.7l-3.2 3.2M12.6 6.7H6.4a3 3 0 1 0 0 6H8",
  library: "M3 3.2h3.1v9.6H3zM6.6 3.2H9.7v9.6H6.6zM10.2 4.2H13v8.6h-2.8z",
  inspector: "M3 4.5h10M3 8h10M3 11.5h10M6 3.2v2.6M10 6.7v2.6M7.5 10.2v2.6",
  yaml: "M4.2 4.5 2.2 8l2 3.5M11.8 4.5 13.8 8l-2 3.5M9.2 3.8 6.8 12.2",
  runs: "M3.2 3.5h9.6v2.2H3.2zM3.2 6.9h9.6v2.2H3.2zM3.2 10.3h9.6v2.2H3.2z",
};
