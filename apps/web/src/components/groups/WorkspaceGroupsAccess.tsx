"use client";

import type { ReactNode } from "react";
import { useEmbedMode } from "@/components/embed/EmbedMode";
import { SessionSetupHint } from "@/components/session/SessionSetupHint";
import { useWorkspace } from "@/components/shell/WorkspaceProvider";
import type { DevIdentity } from "@/lib/identity-headers";
import { FF_SETTINGS_DANGER_CLASS, FF_SETTINGS_MUTED_CLASS } from "@/lib/settings-wizard-visual";
import {
  WORKSPACE_GROUPS_EMBED_UNAVAILABLE,
  WORKSPACE_GROUPS_FORBIDDEN,
  canManageWorkspaceGroups,
} from "@/lib/workspace-groups";

export type WorkspaceGroupsAccessState = {
  identity: DevIdentity;
  /** Session, workspace lookup, and `workspace.administer` are all present outside embed. */
  allowed: boolean;
  embed: boolean;
};

/**
 * Admin-only and never in embed. Nothing calls the groups API until the
 * caller is known to hold `workspace.administer`; the API still decides.
 */
export function WorkspaceGroupsAccess({
  children,
}: {
  children: (state: WorkspaceGroupsAccessState) => ReactNode;
}) {
  const embed = useEmbedMode();
  const { identity, ready, permissions } = useWorkspace();
  if (embed) {
    return (
      <p data-groups-access="embed" className={`text-sm ${FF_SETTINGS_MUTED_CLASS}`}>
        {WORKSPACE_GROUPS_EMBED_UNAVAILABLE}
      </p>
    );
  }
  if (!ready) {
    return <SessionSetupHint purpose="before managing groups." />;
  }
  if (permissions == null) {
    return (
      <p className={`text-sm ${FF_SETTINGS_MUTED_CLASS}`} aria-live="polite">
        Checking access…
      </p>
    );
  }
  if (!canManageWorkspaceGroups(permissions)) {
    return <WorkspaceGroupsForbidden />;
  }
  return <>{children({ identity, allowed: true, embed })}</>;
}

export function WorkspaceGroupsForbidden() {
  return (
    <p data-groups-access="forbidden" className={`text-sm ${FF_SETTINGS_DANGER_CLASS}`}>
      {WORKSPACE_GROUPS_FORBIDDEN}
    </p>
  );
}
