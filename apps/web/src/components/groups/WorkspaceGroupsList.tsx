"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ProblemBanner } from "@/components/ProblemBanner";
import { GroupNameDialog } from "@/components/groups/GroupNameDialog";
import { WorkspaceGroupScimBadge } from "@/components/groups/WorkspaceGroupScimBadge";
import {
  invalidateWorkspaceGroups,
  useWorkspaceGroupsList,
} from "@/components/groups/useWorkspaceGroups";
import {
  WorkspaceGroupsAccess,
  WorkspaceGroupsForbidden,
} from "@/components/groups/WorkspaceGroupsAccess";
import type { DevIdentity } from "@/lib/identity-headers";
import { QueryCacheError } from "@/lib/query-cache";
import {
  FF_SETTINGS_EYEBROW_CLASS,
  FF_SETTINGS_GHOST_CLASS,
  FF_SETTINGS_HELP_CLASS,
  FF_SETTINGS_LINK_CLASS,
  FF_SETTINGS_MUTED_CLASS,
  FF_SETTINGS_PANEL_CLASS,
  FF_SETTINGS_PRIMARY_CLASS,
  FF_SETTINGS_ROOT_CLASS,
  FF_SETTINGS_TITLE_CLASS,
  FF_SETTINGS_VALUE,
} from "@/lib/settings-wizard-visual";
import {
  WORKSPACE_GROUPS_EMPTY_HEADING,
  WORKSPACE_GROUPS_EMPTY_HELP,
  WORKSPACE_GROUPS_HELP,
  WORKSPACE_GROUPS_TITLE,
  workspaceGroupHref,
  workspaceGroupManagement,
  workspaceGroupMemberCountLabel,
  workspaceGroupProblemTreatment,
} from "@/lib/workspace-groups";
import { createWorkspaceGroup } from "@/lib/workspace-groups-client";

export function WorkspaceGroupsList() {
  return (
    <div
      data-ff-settings={FF_SETTINGS_VALUE}
      data-groups-page="list"
      className={`${FF_SETTINGS_ROOT_CLASS} space-y-6`}
    >
      <header className="space-y-3">
        <p className={FF_SETTINGS_EYEBROW_CLASS}>Workspace administration</p>
        <h1 className={`text-3xl tracking-tight ${FF_SETTINGS_TITLE_CLASS}`}>
          {WORKSPACE_GROUPS_TITLE}
        </h1>
        <p className={FF_SETTINGS_HELP_CLASS}>{WORKSPACE_GROUPS_HELP}</p>
      </header>
      <WorkspaceGroupsAccess>
        {({ identity }) => <GroupsListBody identity={identity} />}
      </WorkspaceGroupsAccess>
    </div>
  );
}

function GroupsListBody({ identity }: { identity: DevIdentity }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const list = useWorkspaceGroupsList(identity, true);
  const [createOpen, setCreateOpen] = useState(false);
  const create = useMutation({
    mutationFn: async (displayName: string) => {
      const result = await createWorkspaceGroup(identity, displayName);
      if (!result.ok) {
        throw new QueryCacheError(result.problem);
      }
      return result.group;
    },
    onSuccess: async (group) => {
      await invalidateWorkspaceGroups(queryClient, identity);
      setCreateOpen(false);
      if (group) {
        router.push(workspaceGroupHref(group.id));
      }
    },
  });
  const createProblem =
    create.error instanceof QueryCacheError ? create.error.problem : null;
  const treatment = workspaceGroupProblemTreatment(list.problem);

  if (treatment === "forbidden") {
    return (
      <div className="space-y-4">
        <WorkspaceGroupsForbidden />
        {list.problem ? <ProblemBanner problem={list.problem} /> : null}
      </div>
    );
  }

  return (
    <section
      aria-labelledby="groups-list-heading"
      className={FF_SETTINGS_PANEL_CLASS}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="groups-list-heading" className={`text-lg ${FF_SETTINGS_TITLE_CLASS}`}>
            Groups
          </h2>
          <p className={`mt-1 text-sm ${FF_SETTINGS_MUTED_CLASS}`} aria-live="polite">
            {!list.loaded
              ? list.problem
                ? "Groups could not be loaded."
                : "Loading groups…"
              : `${list.groups.length}${list.hasMore ? "+" : ""} ${
                  list.groups.length === 1 && !list.hasMore ? "group" : "groups"
                }`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={list.refresh}
            disabled={list.pending}
            className={FF_SETTINGS_GHOST_CLASS}
          >
            {list.pending ? "Loading…" : "Refresh"}
          </button>
          <button
            type="button"
            data-groups-create=""
            onClick={() => {
              create.reset();
              setCreateOpen(true);
            }}
            className={FF_SETTINGS_PRIMARY_CLASS}
          >
            Create group
          </button>
        </div>
      </div>

      {list.problem ? (
        <div className="mt-4">
          <ProblemBanner problem={list.problem} />
        </div>
      ) : null}

      {list.loaded && list.groups.length === 0 ? (
        <div data-groups-empty="" className="mt-6 text-center">
          <h3 className={`text-base ${FF_SETTINGS_TITLE_CLASS}`}>
            {WORKSPACE_GROUPS_EMPTY_HEADING}
          </h3>
          <p className={`mt-2 text-sm ${FF_SETTINGS_MUTED_CLASS}`}>
            {WORKSPACE_GROUPS_EMPTY_HELP}
          </p>
        </div>
      ) : null}

      {list.groups.length > 0 ? (
        <ul aria-label="Workspace groups" className="mt-4 divide-y divide-border">
          {list.groups.map((group) => (
            <li
              key={group.id}
              data-group-row={group.id}
              className="flex flex-wrap items-center justify-between gap-3 py-3"
            >
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <Link
                  href={workspaceGroupHref(group.id)}
                  className={`font-medium ${FF_SETTINGS_LINK_CLASS}`}
                >
                  {group.displayName}
                </Link>
                <WorkspaceGroupScimBadge
                  tipAlign="start"
                  management={workspaceGroupManagement({
                    managedBy: group.managedBy,
                    groupsMode: list.groupsMode,
                  })}
                />
              </span>
              <span className={`text-sm ${FF_SETTINGS_MUTED_CLASS}`}>
                {workspaceGroupMemberCountLabel(group.memberCount)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {list.hasMore ? (
        <div className="flex justify-center pt-3">
          <button
            type="button"
            data-collection-load-more="true"
            onClick={list.loadMore}
            disabled={list.loadingMore}
            className={FF_SETTINGS_GHOST_CLASS}
          >
            {list.loadingMore ? "Loading…" : "Load more groups"}
          </button>
        </div>
      ) : null}

      {createOpen ? (
        <GroupNameDialog
          mode="create"
          pending={create.isPending}
          problem={createProblem}
          onSubmit={(name) => create.mutate(name)}
          onClose={() => setCreateOpen(false)}
        />
      ) : null}
    </section>
  );
}
