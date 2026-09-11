/**
 * Product routes keep lists and wizards primary. Operator session,
 * workspace-context, CSRF-exercise, and session-audit chrome lives
 * on Settings, membership, and isolation — not stacked above every
 * product surface.
 *
 * Addresses Terry QA smoke finding #2 (session chrome buries product).
 * Relates to #224.
 *
 * Chloe UI only. Cookie session + CSRF, tenant + workbench headers,
 * embed ADV-021/024, and local seed Example context are unchanged.
 * RBAC stays fail-closed. No apps/api changes.
 */

export const SETTINGS_SESSION_HREF = "/settings#session";
export const SETTINGS_HREF = "/settings";
export const MEMBERSHIP_HREF = "/membership";
export const ISOLATION_HREF = "/isolation";

export const PRODUCT_SESSION_CHROME = {
  productPrimary: true,
  fullIsolationIdentityPanelOnProductRoutes: false,
  sessionReachableViaChip: true,
  exampleContextOnSettingsOrMembership: true,
  editorCollapsedIdentityGateWhenNotReady: true,
  rbacFailClosed: true,
  noAppsApiChanges: true,
} as const;

/** Foundation surfaces that keep the full session + workspace stack. */
export const FOUNDATION_IDENTITY_SOURCES = [
  "src/app/settings/page.tsx",
  "src/app/isolation/page.tsx",
  "src/components/membership/MembershipOperator.tsx",
  "src/components/isolation/IsolationIdentityPanel.tsx",
  "src/components/session/SessionPanel.tsx",
  "src/components/membership/IdentityBootstrap.tsx",
] as const;

/**
 * Product lists / wizards / ops inboxes. These must not mount
 * IsolationIdentityPanel. SessionStatusChip + Settings remain the
 * path to establish or debug a session.
 */
export const PRODUCT_SURFACES_WITHOUT_IDENTITY_PANEL = [
  "src/components/home/WorkflowHome.tsx",
  "src/components/workflows/ActionCatalogPage.tsx",
  "src/app/templates/page.tsx",
  "src/components/credentials/CredentialVault.tsx",
  "src/components/credentials/CredentialWizard.tsx",
  "src/components/credentials/CredentialDetail.tsx",
  "src/components/executions/ExecutionHistory.tsx",
  "src/components/executions/ExecutionDetail.tsx",
  "src/components/approvals/ApprovalList.tsx",
  "src/components/approvals/ApprovalDetail.tsx",
  "src/components/alerts/AlertList.tsx",
  "src/components/alerts/AlertDetail.tsx",
  "src/components/audit/AuditBrowser.tsx",
  "src/components/config/ConfigHub.tsx",
  "src/components/config/ConfigKindList.tsx",
  "src/components/config/ConfigDraftEditor.tsx",
  "src/components/config/ConfigPublishedDetail.tsx",
] as const;

export const EDITOR_IDENTITY_GATE_SOURCE =
  "src/components/workflows/WorkflowOperator.tsx" as const;

export const SESSION_CHIP_SOURCE =
  "src/components/session/SessionStatusChip.tsx" as const;

export const SESSION_SETUP_HINT_SOURCE =
  "src/components/session/SessionSetupHint.tsx" as const;
