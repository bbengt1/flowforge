/**
 * In-tab command bus so the palette can trigger editor actions
 * (validate / normalize / publish / run) without inventing API routes.
 *
 * UX.5: validate / publish / run-published carry the route workflow
 * id so they apply to this editor, not a home list selection.
 */

export type WorkspaceCommandName =
  | "validate"
  | "normalize"
  | "publish"
  | "run-published"
  | "new-workflow"
  | "import-yaml";

export type WorkspaceCommandDetail = {
  workflowId?: string;
};

const listeners = new Set<
  (name: WorkspaceCommandName, detail?: WorkspaceCommandDetail) => void
>();

export function subscribeWorkspaceCommands(
  listener: (name: WorkspaceCommandName, detail?: WorkspaceCommandDetail) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function dispatchWorkspaceCommand(
  name: WorkspaceCommandName,
  detail?: WorkspaceCommandDetail,
): void {
  for (const listener of listeners) {
    listener(name, detail);
  }
}
