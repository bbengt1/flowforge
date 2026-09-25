/**
 * Hands the create response to the editor for this navigation.
 * The stored slug is the server's, never the form preview.
 * In memory only. Taken once. Not written to storage.
 */

import type { WorkflowDraft, WorkflowRecord } from "./workflow-types.ts";

export type CreatedWorkflowHandoff = {
  workflow: WorkflowRecord;
  draft: WorkflowDraft;
};

let pending: CreatedWorkflowHandoff | null = null;

export function rememberCreatedWorkflow(created: CreatedWorkflowHandoff): void {
  const slug = created.workflow.slug.trim();
  const id = created.workflow.id.trim();
  if (!id || !slug || created.draft.workflowId !== created.workflow.id) {
    pending = null;
    return;
  }
  pending = created;
}

export function takeCreatedWorkflow(workflowId: string): CreatedWorkflowHandoff | null {
  if (!pending || pending.workflow.id !== workflowId) {
    return null;
  }
  const found = pending;
  pending = null;
  return found;
}
