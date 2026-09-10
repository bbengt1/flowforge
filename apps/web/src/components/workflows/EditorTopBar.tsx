"use client";

import Link from "next/link";
import { useEmbedMode } from "@/components/embed/EmbedMode";
import {
  EDITOR_WORKFLOWS_HREF,
  editorDirtyLabel,
  editorRevisionLabel,
  editorStickyContext,
} from "@/lib/editor-chrome";
import { EDITOR_LIBRARY_PANEL_ID } from "@/lib/editor-library";
import { embedDeepLink } from "@/lib/embed-tenancy-contract";
import type { WorkflowRecord } from "@/lib/workflow-types";

type EditorTopBarProps = {
  workflow: WorkflowRecord | null;
  loaded?: boolean;
  revision: number | null;
  dirty: boolean;
  canCall: boolean;
  pending: string | null;
  canSave: boolean;
  canPublish: boolean;
  yamlOpen: boolean;
  libraryOpen: boolean;
  publishNote: string;
  onPublishNote: (value: string) => void;
  onSave: () => void;
  onPublish: () => void;
  onStart: () => void;
  onToggleYaml: () => void;
  onToggleLibrary: () => void;
  onAddAction: () => void;
};

export function EditorTopBar({
  workflow,
  loaded = false,
  revision,
  dirty,
  canCall,
  pending,
  canSave,
  canPublish,
  yamlOpen,
  libraryOpen,
  publishNote,
  onPublishNote,
  onSave,
  onPublish,
  onStart,
  onToggleYaml,
  onToggleLibrary,
  onAddAction,
}: EditorTopBarProps) {
  const embed = useEmbedMode();
  const backHref = embed ? embedDeepLink(EDITOR_WORKFLOWS_HREF) : EDITOR_WORKFLOWS_HREF;
  const context = editorStickyContext(workflow, { loaded });
  const dirtyLabel = editorDirtyLabel(dirty);

  return (
    <header
      data-editor-context="sticky"
      className="sticky top-0 z-10 flex shrink-0 flex-wrap items-center gap-3 border-b border-zinc-200 bg-white px-3 py-2"
    >
      <Link
        href={backHref}
        className="rounded-md border border-zinc-300 px-2 py-1 text-sm text-zinc-800 hover:bg-zinc-50"
      >
        ← Workflows
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
      <p className="text-xs text-zinc-600" role="status">
        {workflow ? (
          <>
            <span className="capitalize">{context.status}</span>
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
      <label className="hidden text-xs sm:block">
        <span className="sr-only">Publish note</span>
        <input
          value={publishNote}
          onChange={(event) => onPublishNote(event.target.value)}
          placeholder="Publish note"
          className="w-40 rounded-md border border-zinc-300 px-2 py-1 text-sm"
        />
      </label>
      <button
        type="button"
        onClick={onAddAction}
        className="rounded-md border border-teal-800 bg-teal-800 px-2.5 py-1 text-sm font-medium text-white hover:bg-teal-900"
      >
        Add action
      </button>
      <button
        type="button"
        onClick={onToggleLibrary}
        aria-pressed={libraryOpen}
        aria-expanded={libraryOpen}
        aria-controls={EDITOR_LIBRARY_PANEL_ID}
        className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm hover:bg-zinc-50"
      >
        {libraryOpen ? "Hide library" : "Library"}
      </button>
      <button
        type="button"
        onClick={onToggleYaml}
        aria-pressed={yamlOpen}
        aria-expanded={yamlOpen}
        aria-controls="editor-yaml-drawer"
        className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm hover:bg-zinc-50"
      >
        {yamlOpen ? "Hide YAML" : "YAML"}
      </button>
      <button
        type="button"
        onClick={onSave}
        disabled={!canCall || pending !== null || !workflow || revision === null || !canSave}
        className="rounded-md border border-teal-800 bg-teal-800 px-2.5 py-1 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
      >
        {pending === "save" ? "Saving…" : "Save draft"}
      </button>
      <button
        type="button"
        onClick={onPublish}
        disabled={!canCall || pending !== null || !canPublish}
        className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-sm font-medium text-zinc-900 hover:bg-zinc-50 disabled:opacity-60"
      >
        {pending === "publish" ? "Publishing…" : "Publish"}
      </button>
      <button
        type="button"
        onClick={onStart}
        disabled={!workflow}
        className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-sm font-medium text-zinc-900 hover:bg-zinc-50 disabled:opacity-60"
      >
        Start published
      </button>
    </header>
  );
}
