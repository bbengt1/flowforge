/**
 * G.3.2 ConfirmDestructive: show what a destructive action will
 * affect before it is confirmed. Undo exists only when it is cheap
 * and real — a short window that cancels the action before the
 * request is sent. Irreversible paths stay explicit and do not
 * offer an undo control.
 *
 * Impact text is secret-free. Vault rows stay display-name + UUID.
 * This does not change drafts-never-run or embed chrome.
 */

import { isSecretFieldName } from "./credential.ts";

export type DestructiveReversibility = "undoable" | "irreversible";

export type DestructiveImpactItem = {
  id: string;
  label: string;
  detail?: string;
};

export type DestructiveUndoTicket = {
  id: string;
  token: number;
  commitAt: number;
};

export const CONFIRM_DESTRUCTIVE_IRREVERSIBLE = "This cannot be undone.";

export const CONFIRM_DESTRUCTIVE_UNDO_HINT =
  "You can undo this for a few seconds after confirming. Undo cancels the change before it is sent.";

export const CONFIRM_DESTRUCTIVE_UNDO_PENDING =
  "Undo cancels this before it is sent.";

export const DESTRUCTIVE_UNDO_LABEL = "Undo";

export const DESTRUCTIVE_UNDO_WINDOW_MS = 8000;

export const FOLDER_DELETE_DESCRIPTION =
  "This removes the empty folder only. Workflows are not deleted, and YAML is unchanged.";

export const SCHEDULE_DELETE_DESCRIPTION =
  "Deleting this schedule stops later fires. Runs that already started are left as they are.";

export const WEBHOOK_DELETE_DESCRIPTION =
  "Deleting this webhook stops ingress on its public path. Signing secrets are not shown.";

export const MEMBER_REMOVE_DESCRIPTION =
  "This removes the member from the current workspace and drops the roles listed below.";

const IMPACT_SECRET_MARKERS = [
  "secret",
  "password",
  "token",
  "kubeconfig",
  "privatekey",
  "passphrase",
  "ciphertext",
] as const;

export function confirmDestructiveConsequence(
  reversibility: DestructiveReversibility,
): { message: string; offersUndo: boolean } {
  if (reversibility === "undoable") {
    return {
      message: CONFIRM_DESTRUCTIVE_UNDO_HINT,
      offersUndo: true,
    };
  }
  return {
    message: CONFIRM_DESTRUCTIVE_IRREVERSIBLE,
    offersUndo: false,
  };
}

export function destructiveImpactIdIsSecret(id: string): boolean {
  if (isSecretFieldName(id)) {
    return true;
  }
  const compact = id.trim().toLowerCase().replace(/[-_\s]/g, "");
  return IMPACT_SECRET_MARKERS.some(
    (marker) => compact === marker || compact.includes(marker),
  );
}

export function sanitizeDestructiveImpact(
  items: readonly DestructiveImpactItem[],
): DestructiveImpactItem[] {
  const clean: DestructiveImpactItem[] = [];
  for (const item of items) {
    if (destructiveImpactIdIsSecret(item.id)) {
      continue;
    }
    const label = item.label.trim();
    if (!label) {
      continue;
    }
    const detail = item.detail?.trim() ?? "";
    clean.push(detail ? { id: item.id, label, detail } : { id: item.id, label });
  }
  return clean;
}

export function summarizeAffected(
  items: readonly string[],
  empty: string,
): string {
  const clean = items.map((item) => item.trim()).filter(Boolean);
  if (clean.length === 0) {
    return empty;
  }
  const shown = clean.slice(0, 8);
  const extra = clean.length - shown.length;
  const text = shown.join(", ");
  return extra > 0 ? `${text}, and ${extra} more` : text;
}

export function openDestructiveUndo(input: {
  id: string;
  now: number;
  token: number;
  windowMs?: number;
}): DestructiveUndoTicket {
  const windowMs = input.windowMs ?? DESTRUCTIVE_UNDO_WINDOW_MS;
  return {
    id: input.id,
    token: input.token,
    commitAt: input.now + windowMs,
  };
}

export function destructiveUndoStillOpen(input: {
  now: number;
  commitAt: number;
}): boolean {
  return input.now < input.commitAt;
}

/**
 * Arm a new undo window. A different in-flight id must be committed
 * by the caller. The same id only resets the window.
 */
export function armDestructiveUndo(input: {
  current: DestructiveUndoTicket | null;
  nextId: string;
  now: number;
  token: number;
  windowMs?: number;
}): { commitId: string | null; ticket: DestructiveUndoTicket } {
  const ticket = openDestructiveUndo({
    id: input.nextId,
    now: input.now,
    token: input.token,
    windowMs: input.windowMs,
  });
  const commitId =
    input.current && input.current.id !== input.nextId
      ? input.current.id
      : null;
  return { commitId, ticket };
}

export function folderDeleteImpact(input: {
  name: string;
  childFolderCount: number;
  workflowCount: number | null;
}): DestructiveImpactItem[] {
  const workflows =
    input.workflowCount == null
      ? "Not loaded on this pane. Delete fails if the folder is not empty."
      : input.workflowCount === 0
        ? "None in this folder."
        : String(input.workflowCount);
  return sanitizeDestructiveImpact([
    { id: "folder", label: "Folder", detail: input.name },
    {
      id: "child-folders",
      label: "Child folders",
      detail: String(input.childFolderCount),
    },
    { id: "workflows", label: "Workflows", detail: workflows },
  ]);
}

export function scheduleDeleteImpact(input: {
  id: string;
  expression: string;
  timezone: string;
  status: string;
  nextFireAt?: string;
}): DestructiveImpactItem[] {
  const items: DestructiveImpactItem[] = [
    { id: "schedule", label: "Schedule", detail: input.id },
    {
      id: "expression",
      label: "Expression",
      detail: `${input.expression} · ${input.timezone}`,
    },
    { id: "status", label: "Status", detail: input.status },
  ];
  if (input.nextFireAt) {
    items.push({
      id: "next-fire",
      label: "Next fire",
      detail: input.nextFireAt,
    });
  }
  return sanitizeDestructiveImpact(items);
}

export function webhookDeleteImpact(input: {
  id: string;
  publicId: string;
  ingressPath: string;
  status: string;
  secretCredentialId?: string;
}): DestructiveImpactItem[] {
  const items: DestructiveImpactItem[] = [
    {
      id: "webhook",
      label: "Webhook",
      detail: input.publicId || input.id,
    },
    { id: "ingress", label: "Ingress path", detail: input.ingressPath },
    { id: "status", label: "Status", detail: input.status },
  ];
  if (input.secretCredentialId) {
    items.push({
      id: "linked-vault",
      label: "Vault credential",
      detail: input.secretCredentialId,
    });
  }
  return sanitizeDestructiveImpact(items);
}

export function memberRemoveImpact(input: {
  displayName: string;
  subject: string;
  roles: readonly string[];
}): DestructiveImpactItem[] {
  return sanitizeDestructiveImpact([
    {
      id: "member",
      label: "Member",
      detail: input.displayName || input.subject,
    },
    { id: "subject", label: "Subject", detail: input.subject },
    {
      id: "roles",
      label: "Roles removed",
      detail: summarizeAffected(input.roles, "None"),
    },
  ]);
}

export function credentialDeleteImpactItems(input: {
  credentialId: string;
  displayName: string;
  canDelete: boolean;
  blockReason?: string;
  drafts: readonly string[];
  versions: readonly string[];
  activeExecutions: readonly string[];
}): DestructiveImpactItem[] {
  const items: DestructiveImpactItem[] = [
    {
      id: "credential",
      label: "Credential",
      detail: `${input.displayName} (${input.credentialId})`,
    },
    {
      id: "drafts",
      label: "Affected drafts",
      detail: summarizeAffected(input.drafts, "None"),
    },
    {
      id: "versions",
      label: "Affected published versions",
      detail: summarizeAffected(input.versions, "None"),
    },
    {
      id: "active-executions",
      label: "Active executions",
      detail: summarizeAffected(input.activeExecutions, "None"),
    },
  ];
  if (!input.canDelete) {
    items.push({
      id: "block-reason",
      label: "Deletion blocked",
      detail:
        input.blockReason?.trim() || "The control plane blocked deletion.",
    });
  }
  return sanitizeDestructiveImpact(items);
}

export function scriptRevokeImpact(input: {
  id: string;
  digest: string;
  language: string;
  status: string;
}): DestructiveImpactItem[] {
  return sanitizeDestructiveImpact([
    { id: "artifact", label: "Artifact", detail: input.id },
    { id: "digest", label: "Digest", detail: input.digest },
    { id: "language", label: "Language", detail: input.language },
    { id: "status", label: "Status", detail: input.status },
  ]);
}

export function emergencyStopImpact(input: {
  executionId: string;
  stepId?: string;
  status?: string;
}): DestructiveImpactItem[] {
  const items: DestructiveImpactItem[] = [
    { id: "execution", label: "Execution", detail: input.executionId },
  ];
  if (input.stepId) {
    items.push({ id: "step", label: "Step", detail: input.stepId });
  }
  if (input.status) {
    items.push({ id: "status", label: "Status", detail: input.status });
  }
  items.push({
    id: "effect",
    label: "Side effects",
    detail:
      "Work already running may already have happened. This does not offer a retry.",
  });
  return sanitizeDestructiveImpact(items);
}
