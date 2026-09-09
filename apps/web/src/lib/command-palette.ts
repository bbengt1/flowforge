/**
 * Keyboard command palette. Commands that need a capability are
 * omitted when GET /workspace permissions do not include it.
 */

import { canSeeAlertsNav } from "./alert.ts";
import { canSeeApprovalsNav } from "./approval.ts";
import { canSeeExecutionsNav } from "./execution.ts";
import { canSeeOpsConfigNav } from "./ops-config.ts";
import { webhookTriggersHref } from "./webhook-trigger-contract.ts";
import { scheduleTriggersHref } from "./schedule-trigger-contract.ts";
import {
  canCreateWorkflows,
  canExecuteWorkflows,
  canPublishWorkflows,
  canSeeCredentialsNav,
  canSeeWorkflowsNav,
} from "./workspace-nav.ts";

export type CommandAction =
  | { type: "navigate"; href: string }
  | { type: "new-workflow" }
  | { type: "import-yaml" }
  | { type: "open-editor"; workflowId?: string }
  | { type: "validate" }
  | { type: "publish" }
  | { type: "run-published" }
  | { type: "open-execution"; executionId?: string };

export type PaletteCommand = {
  id: string;
  label: string;
  hint: string;
  keywords: string[];
  action: CommandAction;
};

function allowed(
  permissions: readonly string[] | null | undefined,
  check: (permissions: readonly string[] | null | undefined) => boolean,
): boolean {
  return check(permissions);
}

export function paletteCommands(
  permissions: readonly string[] | null | undefined,
  context: { workflowId?: string | null; executionId?: string | null } = {},
): PaletteCommand[] {
  const commands: PaletteCommand[] = [];
  if (allowed(permissions, canCreateWorkflows)) {
    commands.push({
      id: "new-workflow",
      label: "New workflow",
      hint: "Create an editable draft",
      keywords: ["new", "create", "workflow", "draft"],
      action: { type: "new-workflow" },
    });
    commands.push({
      id: "import-yaml",
      label: "Import YAML",
      hint: "Create a draft from a file",
      keywords: ["import", "yaml", "upload"],
      action: { type: "import-yaml" },
    });
  }
  if (allowed(permissions, canSeeWorkflowsNav)) {
    commands.push({
      id: "open-editor",
      label: "Open YAML / editor",
      hint: context.workflowId
        ? "Open the current workflow editor"
        : "Go to workflow home",
      keywords: ["open", "yaml", "editor", "draft"],
      action: {
        type: "open-editor",
        workflowId: context.workflowId ?? undefined,
      },
    });
    if (context.workflowId) {
      commands.push({
        id: "validate",
        label: "Validate",
        hint: "Validate the current draft YAML",
        keywords: ["validate", "lint", "yaml"],
        action: { type: "validate" },
      });
    }
    commands.push({
      id: "nav-workflows",
      label: "Go to Workflows",
      hint: "Workflow home",
      keywords: ["workflows", "home", "list"],
      action: { type: "navigate", href: "/workflows" },
    });
    commands.push({
      id: "nav-templates",
      label: "Go to Templates",
      hint: "Starter drafts",
      keywords: ["templates", "starter"],
      action: { type: "navigate", href: "/templates" },
    });
    commands.push({
      id: "nav-actions",
      label: "Go to Actions",
      hint: "Action catalog (placeholder)",
      keywords: ["actions", "catalog", "nodes"],
      action: { type: "navigate", href: "/actions" },
    });
  }
  if (context.workflowId && allowed(permissions, canPublishWorkflows)) {
    commands.push({
      id: "publish",
      label: "Publish",
      hint: "Publish the last saved draft",
      keywords: ["publish", "version"],
      action: { type: "publish" },
    });
  }
  if (context.workflowId && allowed(permissions, canExecuteWorkflows)) {
    commands.push({
      id: "run-published",
      label: "Run published version",
      hint: "Start a published version only",
      keywords: ["run", "execute", "start"],
      action: { type: "run-published" },
    });
  }
  if (!context.workflowId && allowed(permissions, canExecuteWorkflows)) {
    commands.push({
      id: "manual-start",
      label: "Start published version",
      hint: "Authenticated manual start from workflow home",
      keywords: ["start", "run", "execute", "manual"],
      action: { type: "navigate", href: "/workflows?start=1" },
    });
  }
  if (allowed(permissions, canSeeWorkflowsNav)) {
    commands.push({
      id: "webhook-triggers",
      label: "Configure webhook triggers",
      hint: context.workflowId
        ? "Replay-safe webhook config for this workflow (#113)"
        : "Replay-safe webhook trigger config (#113)",
      keywords: ["webhook", "trigger", "secret", "replay", "signature", "hmac"],
      action: {
        type: "navigate",
        href: context.workflowId
          ? `/workflows/${context.workflowId}#webhook-triggers`
          : webhookTriggersHref(),
      },
    });
    commands.push({
      id: "schedule-triggers",
      label: "Configure schedule triggers",
      hint: context.workflowId
        ? "Timezone-explicit schedule config for this workflow (E10.3)"
        : "Timezone-explicit schedule trigger config (E10.3)",
      keywords: ["schedule", "cron", "timezone", "catch-up", "overlap", "trigger"],
      action: {
        type: "navigate",
        href: context.workflowId
          ? `/workflows/${context.workflowId}#schedule-triggers`
          : scheduleTriggersHref(),
      },
    });
  }
  if (allowed(permissions, (perms) => canSeeExecutionsNav(perms ?? []))) {
    commands.push({
      id: "open-execution",
      label: "Open execution",
      hint: context.executionId
        ? "Open the current execution"
        : "Execution history",
      keywords: ["execution", "run", "history"],
      action: {
        type: "open-execution",
        executionId: context.executionId ?? undefined,
      },
    });
    commands.push({
      id: "nav-executions",
      label: "Go to Executions",
      hint: "Workspace history",
      keywords: ["executions", "history"],
      action: { type: "navigate", href: "/executions" },
    });
  }
  if (allowed(permissions, canSeeCredentialsNav)) {
    commands.push({
      id: "nav-vault",
      label: "Open credential vault",
      hint: "Metadata only",
      keywords: ["vault", "credentials", "secrets"],
      action: { type: "navigate", href: "/credentials" },
    });
  }
  if (allowed(permissions, (perms) => canSeeOpsConfigNav(perms ?? []))) {
    commands.push({
      id: "nav-config",
      label: "Open config",
      hint: "Targets, profiles, and policies",
      keywords: ["config", "targets", "profiles"],
      action: { type: "navigate", href: "/config" },
    });
  }
  if (allowed(permissions, (perms) => canSeeApprovalsNav(perms ?? []))) {
    commands.push({
      id: "nav-approvals",
      label: "Open approvals",
      hint: "Policy-bound inbox",
      keywords: ["approvals", "policy"],
      action: { type: "navigate", href: "/approvals" },
    });
  }
  if (allowed(permissions, (perms) => canSeeAlertsNav(perms ?? []))) {
    commands.push({
      id: "nav-alerts",
      label: "Open alerts",
      hint: "Operational signals",
      keywords: ["alerts", "signals"],
      action: { type: "navigate", href: "/alerts" },
    });
  }
  commands.push({
    id: "nav-settings",
    label: "Open settings",
    hint: "Session and workspace",
    keywords: ["settings", "session", "membership"],
    action: { type: "navigate", href: "/settings" },
  });
  commands.push({
    id: "nav-portal",
    label: "Open CP Ops Portal host",
    hint: "E11.3 embed host wiring",
    keywords: ["portal", "embed", "host", "e11"],
    action: { type: "navigate", href: "/portal/workflows" },
  });
  return commands;
}

export function filterPaletteCommands(
  commands: readonly PaletteCommand[],
  query: string,
): PaletteCommand[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [...commands];
  }
  return commands.filter((command) => {
    const haystack = [command.label, command.hint, ...command.keywords]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
}

/** Home already handles the command bus; do not also push ?create=1. */
export function isWorkflowHomePath(pathname: string): boolean {
  return pathname === "/workflows";
}

export function commandHref(action: CommandAction): string | null {
  if (action.type === "navigate") {
    return action.href;
  }
  if (action.type === "open-editor") {
    return action.workflowId ? `/workflows/${action.workflowId}` : "/workflows";
  }
  if (action.type === "open-execution") {
    return action.executionId
      ? `/executions/${action.executionId}`
      : "/executions";
  }
  if (action.type === "new-workflow") {
    return "/workflows?create=1";
  }
  if (action.type === "import-yaml") {
    return "/workflows?import=1";
  }
  if (
    action.type === "validate" ||
    action.type === "publish" ||
    action.type === "run-published"
  ) {
    return null;
  }
  return null;
}
