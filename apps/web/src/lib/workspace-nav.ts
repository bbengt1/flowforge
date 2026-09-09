/**
 * E6.1 workspace shell navigation. Items appear only when
 * GET /workspace permissions include the required capability.
 * Fail closed once permissions are known; while unknown (null)
 * gated items stay hidden so inaccessible surfaces never flash.
 */

import { canSeeAlertsNav, canSeeAuditNav } from "./alert.ts";
import { canSeeApprovalsNav } from "./approval.ts";
import { canSeeExecutionsNav } from "./execution.ts";
import { canSeeOpsConfigNav } from "./ops-config.ts";

export const WORKFLOW_VIEW_PERMISSION = "workflow.view";
export const WORKFLOW_EDIT_PERMISSION = "workflow.edit";
export const WORKFLOW_PUBLISH_PERMISSION = "workflow.publish";
export const WORKFLOW_EXECUTE_PERMISSION = "workflow.execute";
export const CREDENTIAL_VIEW_PERMISSION = "credential.view";
export const WORKSPACE_ADMIN_PERMISSION = "workspace.administer";

export type WorkspaceNavId =
  | "workflows"
  | "actions"
  | "credentials"
  | "targets"
  | "profiles"
  | "config"
  | "executions"
  | "templates"
  | "approvals"
  | "alerts"
  | "audit"
  | "settings"
  | "membership"
  | "isolation";

export type WorkspaceNavItem = {
  id: WorkspaceNavId;
  label: string;
  href: string;
  permission: string | null;
  placeholder?: boolean;
  group: "primary" | "ops" | "foundation";
};

export const WORKSPACE_NAV_ITEMS: readonly WorkspaceNavItem[] = [
  {
    id: "workflows",
    label: "Workflows",
    href: "/workflows",
    permission: WORKFLOW_VIEW_PERMISSION,
    group: "primary",
  },
  {
    id: "actions",
    label: "Actions",
    href: "/actions",
    permission: WORKFLOW_VIEW_PERMISSION,
    placeholder: true,
    group: "primary",
  },
  {
    id: "credentials",
    label: "Credentials",
    href: "/credentials",
    permission: CREDENTIAL_VIEW_PERMISSION,
    group: "primary",
  },
  {
    id: "targets",
    label: "Targets",
    href: "/config?group=targets",
    permission: "opsconfig.view",
    group: "primary",
  },
  {
    id: "profiles",
    label: "Profiles",
    href: "/config?group=profiles",
    permission: "opsconfig.view",
    group: "primary",
  },
  {
    id: "config",
    label: "Config",
    href: "/config?group=config",
    permission: "opsconfig.view",
    group: "primary",
  },
  {
    id: "executions",
    label: "Executions",
    href: "/executions",
    permission: "execution.view",
    group: "ops",
  },
  {
    id: "templates",
    label: "Templates",
    href: "/templates",
    permission: WORKFLOW_VIEW_PERMISSION,
    group: "ops",
  },
  {
    id: "approvals",
    label: "Approvals",
    href: "/approvals",
    permission: "approval.view",
    group: "ops",
  },
  {
    id: "alerts",
    label: "Alerts",
    href: "/alerts",
    permission: "alert.view",
    group: "ops",
  },
  {
    id: "audit",
    label: "Audit",
    href: "/audit",
    permission: "alert.view",
    group: "ops",
  },
  {
    id: "settings",
    label: "Settings",
    href: "/settings",
    permission: null,
    group: "foundation",
  },
  {
    id: "membership",
    label: "Membership",
    href: "/membership",
    permission: null,
    group: "foundation",
  },
  {
    id: "isolation",
    label: "Isolation",
    href: "/isolation",
    permission: null,
    group: "foundation",
  },
];

export function canSeeWorkflowsNav(
  permissions: readonly string[] | null | undefined,
): boolean {
  if (permissions == null) {
    return false;
  }
  return permissions.includes(WORKFLOW_VIEW_PERMISSION);
}

export function canSeeCredentialsNav(
  permissions: readonly string[] | null | undefined,
): boolean {
  if (permissions == null) {
    return false;
  }
  return permissions.includes(CREDENTIAL_VIEW_PERMISSION);
}

export function canSeeTemplatesNav(
  permissions: readonly string[] | null | undefined,
): boolean {
  return canSeeWorkflowsNav(permissions);
}

export function canCreateWorkflows(
  permissions: readonly string[] | null | undefined,
): boolean {
  if (permissions == null) {
    return false;
  }
  return permissions.includes(WORKFLOW_EDIT_PERMISSION);
}

export function canPublishWorkflows(
  permissions: readonly string[] | null | undefined,
): boolean {
  if (permissions == null) {
    return false;
  }
  return permissions.includes(WORKFLOW_PUBLISH_PERMISSION);
}

export function canExecuteWorkflows(
  permissions: readonly string[] | null | undefined,
): boolean {
  if (permissions == null) {
    return false;
  }
  return permissions.includes(WORKFLOW_EXECUTE_PERMISSION);
}

function itemVisible(
  item: WorkspaceNavItem,
  permissions: readonly string[] | null | undefined,
): boolean {
  if (item.permission == null) {
    return true;
  }
  if (item.id === "workflows" || item.id === "actions" || item.id === "templates") {
    return canSeeWorkflowsNav(permissions);
  }
  if (item.id === "credentials") {
    return canSeeCredentialsNav(permissions);
  }
  if (item.id === "targets" || item.id === "profiles" || item.id === "config") {
    return canSeeOpsConfigNav(permissions ?? []);
  }
  if (item.id === "executions") {
    return canSeeExecutionsNav(permissions ?? []);
  }
  if (item.id === "approvals") {
    return canSeeApprovalsNav(permissions ?? []);
  }
  if (item.id === "alerts") {
    return canSeeAlertsNav(permissions ?? []);
  }
  if (item.id === "audit") {
    return canSeeAuditNav(permissions ?? []);
  }
  return false;
}

/** Product-shell visibility: unknown permissions hide gated items. */
export function visibleWorkspaceNav(
  permissions: readonly string[] | null | undefined,
): WorkspaceNavItem[] {
  return WORKSPACE_NAV_ITEMS.filter((item) => itemVisible(item, permissions));
}

export function navItemIsActive(href: string, pathname: string): boolean {
  if (href === "/workflows") {
    return pathname === "/workflows" || pathname.startsWith("/workflows/");
  }
  if (href.startsWith("/config")) {
    return pathname === "/config" || pathname.startsWith("/config/");
  }
  if (href === "/executions") {
    return pathname === "/executions" || pathname.startsWith("/executions/");
  }
  if (href === "/credentials") {
    return pathname === "/credentials" || pathname.startsWith("/credentials/");
  }
  if (href === "/approvals") {
    return pathname === "/approvals" || pathname.startsWith("/approvals/");
  }
  if (href === "/alerts") {
    return pathname === "/alerts" || pathname.startsWith("/alerts/");
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}
