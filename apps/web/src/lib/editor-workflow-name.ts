/**
 * In-editor workflow display name (#526).
 *
 * The sticky heading is the chrome. Commit writes YAML `metadata.name`
 * (Summary.Name, the definition SoT) and persists through the existing
 * normalize + draft PUT. That PUT already refreshes `record.Name` from
 * Summary.Name. Slug stays put. No name PATCH and no new embed route.
 *
 * Empty and invalid names fail closed. Escape keeps the prior name.
 * Drafts never run.
 */

import { canCreateWorkflows } from "./workspace-nav.ts";

/** Same rule as jonny's metadata.name: DNS label, 63 characters max. */
export const WORKFLOW_DNS_NAME =
  /^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

export const WORKFLOW_NAME_EMPTY = "Enter a workflow name.";
export const WORKFLOW_NAME_INVALID =
  "Workflow name must be a DNS label: lowercase letters, numbers, and hyphens, starting with a letter (63 characters max).";
export const WORKFLOW_NAME_YAML_FAILED =
  "Could not update the workflow name in YAML. The previous name is unchanged.";
export const WORKFLOW_NAME_NOT_READY =
  "Fix the draft before renaming. Invalid YAML is not saved.";
export const WORKFLOW_NAME_SAVE_FAILED =
  "The name was not saved. The previous name is unchanged.";

export const EDITOR_WORKFLOW_NAME = {
  story: 526,
  yamlIsSourceOfTruth: true,
  draftsNeverRun: true,
  noNewNamePatch: true,
  slugRenameOutOfScope: true,
  inlineOnStickyHeading: true,
  enterCommits: true,
  escapeKeepsPriorName: true,
  emptyAndInvalidFailClosed: true,
  sameChromeOnEmbed: true,
  noNewEmbedRoutes: true,
  vaultDisplayNameUuidOnly: true,
  adv021ChromeFromSessionEmbedOnly: true,
  adv024MembershipIsolationStayGrantGated: true,
  notAnN8nClone: true,
  noSecretsInBrowser: true,
  jonnyNotRequired: true,
} as const;

const SAVE_DETAIL_SECRET =
  /password|secret|token|authorization|bearer\s/i;

export type WorkflowNameDecision =
  | { action: "keep" }
  | { action: "commit"; name: string }
  | { action: "invalid"; error: string };

export type WorkflowNameRenameResult =
  | { ok: true }
  | { ok: false; error: string };

export function isWorkflowDnsName(name: string): boolean {
  return WORKFLOW_DNS_NAME.test(name);
}

/**
 * Enter and blur share one fail-closed decision. Unchanged text keeps
 * the prior name, including a display name that is not itself a DNS
 * label, so opening the field and leaving it does not rewrite YAML.
 */
export function workflowNameCommitDecision(
  draft: string,
  currentName: string,
): WorkflowNameDecision {
  const trimmed = draft.trim();
  if (!trimmed) {
    return { action: "invalid", error: WORKFLOW_NAME_EMPTY };
  }
  if (trimmed === currentName.trim()) {
    return { action: "keep" };
  }
  if (!isWorkflowDnsName(trimmed)) {
    return { action: "invalid", error: WORKFLOW_NAME_INVALID };
  }
  return { action: "commit", name: trimmed };
}

export function workflowNameSaveError(
  detail: string | null | undefined,
): string {
  const trimmed = detail?.trim() ?? "";
  if (!trimmed || trimmed.length > 280 || SAVE_DETAIL_SECRET.test(trimmed)) {
    return WORKFLOW_NAME_SAVE_FAILED;
  }
  return trimmed;
}

export function editorWorkflowRenameAllowed(input: {
  canCall: boolean;
  hasWorkflow: boolean;
  revision: number | null;
  pending: string | null;
  canSave: boolean;
  permissions: readonly string[] | null | undefined;
}): boolean {
  return (
    input.canCall &&
    input.hasWorkflow &&
    input.revision !== null &&
    input.pending === null &&
    input.canSave &&
    canCreateWorkflows(input.permissions)
  );
}

/**
 * Replace the workflow `metadata.name` scalar. Does not touch node
 * names, slug, or any other field. Returns null when the name is not
 * a DNS label or the metadata block cannot be updated safely.
 */
export function writeYamlWorkflowName(
  yaml: string,
  name: string,
): string | null {
  if (!isWorkflowDnsName(name)) {
    return null;
  }
  const lines = yaml.split("\n");
  let metadataAt = -1;
  let specAt = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = (lines[index] ?? "").trim();
    if (!trimmed || trimmed.startsWith("#") || leadingSpaces(lines[index] ?? "") !== 0) {
      continue;
    }
    if (trimmed.startsWith("metadata:")) {
      if (!/^metadata:\s*(#.*)?$/.test(trimmed)) {
        return null;
      }
      metadataAt = index;
      continue;
    }
    if (/^spec:\s*(#.*)?$/.test(trimmed)) {
      specAt = index;
      if (metadataAt >= 0) {
        break;
      }
    }
  }
  if (metadataAt < 0) {
    const insertAt = specAt >= 0 ? specAt : lines.length;
    lines.splice(insertAt, 0, "metadata:", `  name: ${name}`);
    return lines.join("\n");
  }

  const limit = specAt > metadataAt ? specAt : lines.length;
  let childIndent = -1;
  let nameAt = -1;
  for (let index = metadataAt + 1; index < limit; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const indent = leadingSpaces(line);
    if (indent === 0) {
      break;
    }
    if (childIndent < 0) {
      childIndent = indent;
    }
    if (indent < childIndent) {
      break;
    }
    if (indent !== childIndent) {
      continue;
    }
    const parsed = metadataNameLine(trimmed);
    if (parsed === "unsafe") {
      return null;
    }
    if (parsed === "name" && nameAt < 0) {
      nameAt = index;
    }
  }
  if (nameAt >= 0) {
    const indent = " ".repeat(leadingSpaces(lines[nameAt] ?? ""));
    lines[nameAt] = `${indent}name: ${name}`;
    return lines.join("\n");
  }
  const pad = " ".repeat(childIndent > 0 ? childIndent : 2);
  lines.splice(metadataAt + 1, 0, `${pad}name: ${name}`);
  return lines.join("\n");
}

export function editorHeadingRenamesInline(source: string): boolean {
  return (
    source.includes('data-editor-workflow-name="rename"') &&
    source.includes('data-editor-workflow-name="heading"') &&
    source.includes('event.key === "Enter"') &&
    source.includes('event.key === "Escape"') &&
    source.includes("workflowNameCommitDecision") &&
    source.includes("onRenameWorkflow") &&
    source.includes("{context.slug}") &&
    source.includes("{context.heading}") &&
    !source.includes("window.prompt") &&
    !source.includes("data-home-folder-dialog") &&
    !source.includes("EmbedEditorTopBar")
  );
}

export function editorRenameUsesDraftSave(source: string): boolean {
  const body = source.match(
    /async function renameWorkflowName[\s\S]*?(?=\n  async function |\n  function )/,
  );
  if (!body) {
    return false;
  }
  const fn = body[0];
  return (
    fn.includes("writeYamlWorkflowName") &&
    fn.includes("saveDraft(") &&
    fn.includes("workflowNameCommitDecision") &&
    !fn.includes("slug") &&
    !fn.includes("PATCH") &&
    source.includes("saveCanonicalWorkflowDraft")
  );
}

function metadataNameLine(trimmed: string): "name" | "unsafe" | "other" {
  const match = /^name:(.*)$/.exec(trimmed);
  if (!match) {
    return "other";
  }
  const raw = (match[1] ?? "").trim();
  if (raw === "" || raw.startsWith("|") || raw.startsWith(">")) {
    return "unsafe";
  }
  return "name";
}

function leadingSpaces(line: string): number {
  const match = /^( *)/.exec(line);
  return match?.[1]?.length ?? 0;
}
