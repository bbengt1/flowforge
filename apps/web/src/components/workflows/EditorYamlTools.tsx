"use client";

import Link from "next/link";
import { useEmbedMode } from "@/components/embed/EmbedMode";
import {
  EDITOR_YAML_DEVELOPER_DISCLOSURE,
  EDITOR_YAML_FILE_MENU,
  WORKFLOWS_IMPORT_HREF,
} from "@/lib/editor-developer";
import { embedDeepLink } from "@/lib/embed-tenancy-contract";

type EditorYamlToolsProps = {
  canCall: boolean;
  pending: string | null;
  onValidate: () => void;
  onNormalize: () => void;
  onLoadStarter: () => void;
  onLoadInvalid: () => void;
};

const toolClass =
  "rounded-md border border-zinc-300 bg-zinc-50 px-2 py-1 text-xs font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-60";
const sampleClass =
  "rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs hover:bg-zinc-50";

export function EditorYamlTools({
  canCall,
  pending,
  onValidate,
  onNormalize,
  onLoadStarter,
  onLoadInvalid,
}: EditorYamlToolsProps) {
  const embed = useEmbedMode();
  const importHref = embed
    ? embedDeepLink(WORKFLOWS_IMPORT_HREF)
    : WORKFLOWS_IMPORT_HREF;

  return (
    <>
      <button
        type="button"
        onClick={onValidate}
        disabled={!canCall || pending !== null}
        className={toolClass}
      >
        Validate now
      </button>
      <button
        type="button"
        onClick={onNormalize}
        disabled={!canCall || pending !== null}
        className={toolClass}
      >
        {pending === "normalize" ? "Normalizing…" : "Normalize"}
      </button>
      <details className="rounded-md border border-zinc-200 bg-white px-2 py-1">
        <summary className="cursor-pointer text-xs font-medium text-zinc-700">
          {EDITOR_YAML_FILE_MENU}
        </summary>
        <p className="mt-2 max-w-xs text-xs text-zinc-600">
          Import still validates before create on Workflows home.
        </p>
        <Link
          href={importHref}
          className="mt-2 inline-block text-xs font-medium text-teal-800 underline"
        >
          Import YAML…
        </Link>
      </details>
      <details className="rounded-md border border-zinc-200 bg-white px-2 py-1">
        <summary className="cursor-pointer text-xs font-medium text-zinc-700">
          {EDITOR_YAML_DEVELOPER_DISCLOSURE}
        </summary>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" onClick={onLoadStarter} className={sampleClass}>
            Load starter YAML
          </button>
          <button
            type="button"
            id="load-invalid-yaml"
            onClick={onLoadInvalid}
            className={sampleClass}
          >
            Load invalid YAML
          </button>
        </div>
      </details>
    </>
  );
}
