/**
 * In-tab command bus so the palette can trigger editor actions
 * (validate / normalize / publish / run) without inventing API routes.
 */

export type WorkspaceCommandName =
  | "validate"
  | "normalize"
  | "publish"
  | "run-published"
  | "new-workflow"
  | "import-yaml";

const listeners = new Set<(name: WorkspaceCommandName) => void>();

export function subscribeWorkspaceCommands(
  listener: (name: WorkspaceCommandName) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function dispatchWorkspaceCommand(name: WorkspaceCommandName): void {
  for (const listener of listeners) {
    listener(name);
  }
}
