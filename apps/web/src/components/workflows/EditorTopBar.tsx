"use client";

import Link from "next/link";
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
};

const SATELLITE_CONTROL =
  "rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm hover:bg-zinc-50";
const HISTORY_CONTROL =
  "rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm hover:bg-zinc-50 disabled:opacity-60";
const GROUP =
  "flex shrink-0 items-center gap-1.5";
const GROUP_DIVIDER = `${GROUP} border-l border-zinc-200 pl-3`;

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
      className="sticky top-0 z-10 flex shrink-0 flex-wrap items-center gap-3 border-b border-zinc-200 bg-white px-3 py-2"
    >
      <div
        data-editor-topbar="identity"
        className="flex min-w-0 flex-1 items-center gap-3"
      >
        <Link
          href={backHref}
          className="rounded-md border border-zinc-300 px-2 py-1 text-sm text-zinc-800 hover:bg-zinc-50"
        >
          {editorTopBarControlLabel("back")}
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold tracking-tight">{context.heading}</h1>
          {context.slug ? (
            <p className="truncate font-mono text-xs text-zinc-500">{context.slug}</p>
          ) : (
            <p className="text-xs text-zinc-500">
              {context.loaded
                ? "This workflow could not be loaded."
                : "Loading this workflow…"}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <p className="text-xs text-zinc-600" role="status">
            {workflow ? (
              <>
                <span data-editor-working-memory="draft">{memory.draft}</span>
                {" · "}
                {editorRevisionLabel(revision)}
                {" · "}
                <span className={dirty ? "font-medium text-amber-900" : "text-zinc-600"}>
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
            className="w-40 rounded-md border border-zinc-300 px-2 py-1 text-sm"
          />
        </label>
        <button
          type="button"
          onClick={onSave}
          disabled={!canCall || pending !== null || !workflow || revision === null || !canSave}
          aria-busy={pending === "save"}
          className={`rounded-md border border-teal-800 bg-teal-800 ${EDITOR_TOPBAR_PRIMARY_CONTROL_CLASS} text-white hover:bg-teal-900 disabled:opacity-60`}
        >
          {pending === "save" ? "Saving…" : editorTopBarControlLabel("save")}
        </button>
        <button
          type="button"
          onClick={onPublish}
          disabled={!canCall || pending !== null || !canPublish}
          aria-busy={pending === "publish"}
          className={`rounded-md border border-zinc-300 bg-white ${EDITOR_TOPBAR_PRIMARY_CONTROL_CLASS} text-zinc-900 hover:bg-zinc-50 disabled:opacity-60`}
        >
          {pending === "publish" ? "Publishing…" : editorTopBarControlLabel("publish")}
        </button>
      </div>
      <div data-editor-topbar="history" className={GROUP_DIVIDER}>
        <button
          type="button"
          id={satelliteOverlayTriggerId("action-wizard")}
          onClick={onAddAction}
          className={`rounded-md border border-teal-800 bg-teal-800 ${EDITOR_TOPBAR_PRIMARY_CONTROL_CLASS} text-white hover:bg-teal-900`}
        >
          {editorTopBarControlLabel("add-action")}
        </button>
        <button
          type="button"
          data-editor-history="undo"
          title={EDITOR_CANVAS_UNDO_LABEL}
          aria-keyshortcuts="Control+Z Meta+Z"
          onClick={onUndo}
          disabled={!onUndo || !canUndo}
          className={HISTORY_CONTROL}
        >
          {editorTopBarControlLabel("undo")}
        </button>
        <button
          type="button"
          data-editor-history="redo"
          title={EDITOR_CANVAS_REDO_LABEL}
          aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z"
          onClick={onRedo}
          disabled={!onRedo || !canRedo}
          className={HISTORY_CONTROL}
        >
          {editorTopBarControlLabel("redo")}
        </button>
      </div>
      <div
        role="group"
        aria-label={EDITOR_TOPBAR_GROUP_LABELS.satellites}
        data-editor-topbar="satellites"
        className={GROUP_DIVIDER}
      >
        <button
          type="button"
          id={editorDrawerTriggerId("library")}
          onClick={onToggleLibrary}
          aria-pressed={libraryOpen}
          aria-expanded={libraryOpen}
          aria-controls={EDITOR_DRAWER_PANEL_IDS.library}
          className={SATELLITE_CONTROL}
        >
          {editorTopBarControlLabel("library", libraryOpen)}
        </button>
        <button
          type="button"
          id={editorDrawerTriggerId("inspector")}
          onClick={onToggleInspector}
          aria-pressed={inspectorOpen}
          aria-expanded={inspectorOpen}
          aria-controls={EDITOR_DRAWER_PANEL_IDS.inspector}
          className={SATELLITE_CONTROL}
        >
          {editorTopBarControlLabel("inspector", inspectorOpen)}
        </button>
        <button
          type="button"
          id={editorDrawerTriggerId("yaml")}
          onClick={onToggleYaml}
          aria-pressed={yamlOpen}
          aria-expanded={yamlOpen}
          aria-controls={EDITOR_DRAWER_PANEL_IDS.yaml}
          className={SATELLITE_CONTROL}
        >
          {editorTopBarControlLabel("yaml", yamlOpen)}
        </button>
        <button
          type="button"
          id={editorDrawerTriggerId("runs")}
          onClick={onToggleRuns}
          disabled={!workflow}
          aria-pressed={runsOpen}
          aria-expanded={runsOpen}
          aria-controls={EDITOR_DRAWER_PANEL_IDS.runs}
          className={`${SATELLITE_CONTROL} disabled:opacity-60`}
        >
          {editorTopBarControlLabel("runs", runsOpen)}
        </button>
      </div>
      <div data-editor-topbar="activation" className="shrink-0 border-l border-zinc-200 pl-3">
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
              className={`rounded-md border border-zinc-300 bg-white ${EDITOR_TOPBAR_PRIMARY_CONTROL_CLASS} text-zinc-900 hover:bg-zinc-50 disabled:opacity-60`}
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
              className={`rounded-md border border-teal-800 bg-white ${EDITOR_TOPBAR_PRIMARY_CONTROL_CLASS} text-teal-900 hover:bg-teal-50 disabled:opacity-60`}
            >
              {pending === "test-run"
                ? "Test run…"
                : editorTopBarControlLabel("test-run")}
            </button>
          </div>
          <p
            data-editor-working-memory="test-run"
            className="max-w-[16rem] text-[11px] leading-snug text-zinc-500"
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
