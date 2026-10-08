"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { notFound, useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";
import {
  ConfirmDestructive,
  DestructiveUndoBar,
  useDestructiveUndo,
} from "@/components/a11y/ConfirmDestructive";
import { ProblemBanner } from "@/components/ProblemBanner";
import { AddGroupMemberDialog } from "@/components/groups/AddGroupMemberDialog";
import { GroupNameDialog } from "@/components/groups/GroupNameDialog";
import {
  afterWorkspaceGroupDeleted,
  invalidateWorkspaceGroups,
  useWorkspaceGroupDetail,
} from "@/components/groups/useWorkspaceGroups";
import { WorkspaceGroupScimBadge } from "@/components/groups/WorkspaceGroupScimBadge";
import {
  WorkspaceGroupsAccess,
  WorkspaceGroupsForbidden,
} from "@/components/groups/WorkspaceGroupsAccess";
import type { DevIdentity } from "@/lib/identity-headers";
import type { ProblemDetails } from "@/lib/problem";
import { QueryCacheError } from "@/lib/query-cache";
import type { ScimGroupsMode } from "@/lib/scim-tokens";
import {
  FF_SETTINGS_DANGER_CLASS,
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
import { FF_LOUD_DANGER_CLASS } from "@/lib/vault-executions-visual";
import {
  GROUP_DELETE_DESCRIPTION,
  GROUP_MEMBER_REMOVE_DESCRIPTION,
  GROUP_SCIM_LOCKED_MESSAGE,
  GROUP_SCIM_REFUSED_MESSAGE,
  WORKSPACE_GROUP_MEMBERS_EMPTY,
  WORKSPACE_GROUPS_HREF,
  WORKSPACE_GROUPS_TITLE,
  isGroupManagedByScimProblem,
  isWorkspaceGroupId,
  scimGroupsModeFromProblem,
  workspaceGroupApprovalNote,
  workspaceGroupDeleteImpact,
  workspaceGroupManagement,
  workspaceGroupMemberCountLabel,
  workspaceGroupMemberLabel,
  workspaceGroupMemberRemoveImpact,
  workspaceGroupProblemTreatment,
  workspaceGroupRefusalStands,
  type WorkspaceGroupMember,
} from "@/lib/workspace-groups";
import {
  addWorkspaceGroupMember,
  deleteWorkspaceGroup,
  removeWorkspaceGroupMember,
  renameWorkspaceGroup,
} from "@/lib/workspace-groups-client";

export function WorkspaceGroupDetail({ groupId }: { groupId: string }) {
  if (!isWorkspaceGroupId(groupId)) {
    notFound();
  }
  return (
    <div
      data-ff-settings={FF_SETTINGS_VALUE}
      data-groups-page="detail"
      className={`${FF_SETTINGS_ROOT_CLASS} space-y-6`}
    >
      <WorkspaceGroupsAccess>
        {({ identity }) => <GroupDetailBody identity={identity} groupId={groupId} />}
      </WorkspaceGroupsAccess>
    </div>
  );
}

function problemOf(error: unknown): ProblemDetails | null {
  return error instanceof QueryCacheError ? error.problem : null;
}

/** The locked sentence. Disabled controls point at it with aria-describedby. */
const GROUP_LOCKED_NOTE_ID = "group-scim-locked-note";

function GroupHeader({
  title,
  badge,
  children,
}: {
  title: string;
  badge?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="space-y-3">
      <p className={FF_SETTINGS_EYEBROW_CLASS}>
        <Link href={WORKSPACE_GROUPS_HREF} className={FF_SETTINGS_LINK_CLASS}>
          {WORKSPACE_GROUPS_TITLE}
        </Link>
      </p>
      <h1 className={`text-3xl tracking-tight ${FF_SETTINGS_TITLE_CLASS}`}>{title}</h1>
      {badge}
      {children}
    </header>
  );
}

function GroupDetailBody({
  identity,
  groupId,
}: {
  identity: DevIdentity;
  groupId: string;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const detail = useWorkspaceGroupDetail(identity, groupId, true);
  const group = detail.group;
  const [dialog, setDialog] = useState<"rename" | "delete" | "add" | null>(null);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [actionProblem, setActionProblem] = useState<ProblemDetails | null>(null);
  // Set when the server refused a local edit with 409 group_managed_by_scim:
  // when the detail shown at that moment was read.
  const [refusedAt, setRefusedAt] = useState<number | null>(null);
  // The mode the 409 proved. Used only while the detail itself carries
  // no mode (an older server); the server's own value always wins.
  const [refusedMode, setRefusedMode] = useState<ScimGroupsMode | null>(null);
  const refused =
    refusedAt !== null &&
    workspaceGroupRefusalStands({
      refusedAt,
      dataUpdatedAt: detail.dataUpdatedAt,
      groupsMode: group?.groupsMode,
    });
  if (refusedAt !== null && !refused) {
    // A read after the refusal says the instance isn't in groups mode
    // now, so the group isn't locked: drop the note and the 409's mode.
    setRefusedAt(null);
    setRefusedMode(null);
  }
  const management = workspaceGroupManagement({
    managedBy: group?.managedBy,
    groupsMode: group?.groupsMode ?? refusedMode,
  });
  const locked = management === "scim-locked";
  const lockedDescribedBy = locked ? GROUP_LOCKED_NOTE_ID : undefined;

  async function refreshAll() {
    await invalidateWorkspaceGroups(queryClient, identity);
  }

  /**
   * A stale page offered an edit the server refused because SCIM manages
   * the group. Close whatever was open, show the plain sentence, note
   * that the instance is in groups mode, and refetch so the page switches
   * to the read-only view from the server's own `groupsMode`. If that
   * newer read says the instance isn't in groups mode, the note clears.
   * Status plus code only, never the title.
   */
  function handleScimRefusal(error: unknown): boolean {
    const problem = problemOf(error);
    if (!isGroupManagedByScimProblem(problem)) {
      return false;
    }
    setDialog(null);
    setRemoveId(null);
    setActionProblem(null);
    setRefusedAt(detail.dataUpdatedAt);
    setRefusedMode(scimGroupsModeFromProblem(problem));
    void refreshAll();
    return true;
  }

  const rename = useMutation({
    mutationFn: async (displayName: string) => {
      const result = await renameWorkspaceGroup(identity, groupId, displayName);
      if (!result.ok) {
        throw new QueryCacheError(result.problem);
      }
    },
    onSuccess: async () => {
      setDialog(null);
      await refreshAll();
    },
    onError: (error) => {
      handleScimRefusal(error);
    },
  });

  const remove = useMutation({
    mutationFn: async () => {
      const result = await deleteWorkspaceGroup(identity, groupId);
      if (!result.ok) {
        throw new QueryCacheError(result.problem);
      }
    },
    onSuccess: async () => {
      setDialog(null);
      router.push(WORKSPACE_GROUPS_HREF);
      await afterWorkspaceGroupDeleted(queryClient, identity, groupId);
    },
    onError: (error) => {
      if (handleScimRefusal(error)) {
        return;
      }
      setDialog(null);
      setActionProblem(problemOf(error));
    },
  });

  const addMember = useMutation({
    mutationFn: async (userId: string) => {
      const result = await addWorkspaceGroupMember(identity, groupId, userId);
      if (!result.ok) {
        throw new QueryCacheError(result.problem);
      }
    },
    onSuccess: async () => {
      setDialog(null);
      await refreshAll();
    },
    onError: (error) => {
      handleScimRefusal(error);
    },
  });

  const removeMember = useMutation({
    mutationFn: async (userId: string) => {
      const result = await removeWorkspaceGroupMember(identity, groupId, userId);
      if (!result.ok) {
        throw new QueryCacheError(result.problem);
      }
    },
    onSuccess: async () => {
      await refreshAll();
    },
    onError: (error) => {
      if (handleScimRefusal(error)) {
        return;
      }
      setActionProblem(problemOf(error));
    },
  });

  const memberUndo = useDestructiveUndo((userId) => {
    setActionProblem(null);
    removeMember.mutate(userId);
  });

  const members = useMemo(() => group?.members ?? [], [group]);
  const existingUserIds = useMemo(() => members.map((item) => item.userId), [members]);
  const removing = members.find((item) => item.userId === removeId) ?? null;
  const pendingRemovalId = memberUndo.ticket?.id ?? null;

  const treatment = workspaceGroupProblemTreatment(detail.problem);
  if (treatment === "not-found") {
    notFound();
  }
  if (treatment === "forbidden") {
    return (
      <>
        <GroupHeader title={WORKSPACE_GROUPS_TITLE} />
        <WorkspaceGroupsForbidden />
        {detail.problem ? <ProblemBanner problem={detail.problem} /> : null}
      </>
    );
  }

  if (!group) {
    return (
      <>
        <GroupHeader title="Group" />
        {detail.problem ? (
          <ProblemBanner problem={detail.problem} />
        ) : (
          <p className={`text-sm ${FF_SETTINGS_MUTED_CLASS}`} aria-live="polite">
            Loading group…
          </p>
        )}
      </>
    );
  }

  return (
    <>
      <GroupHeader
        title={group.displayName}
        badge={
          management === "local" ? null : (
            <div>
              <WorkspaceGroupScimBadge management={management} tipAlign="start" />
            </div>
          )
        }
      >
        <p className={FF_SETTINGS_HELP_CLASS}>
          {workspaceGroupMemberCountLabel(group.memberCount)}. Approvals sent
          to this group reach the members below who are allowed to decide
          them. Being in this group doesn&apos;t grant any permission.
        </p>
        {locked || refused ? (
          <p
            id={GROUP_LOCKED_NOTE_ID}
            role={refused ? "alert" : undefined}
            data-group-scim-locked={refused ? "refused" : "locked"}
            className={`text-sm ${refused ? FF_SETTINGS_DANGER_CLASS : FF_SETTINGS_MUTED_CLASS}`}
          >
            {refused ? GROUP_SCIM_REFUSED_MESSAGE : GROUP_SCIM_LOCKED_MESSAGE}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            data-group-rename=""
            disabled={locked}
            aria-describedby={lockedDescribedBy}
            onClick={() => {
              rename.reset();
              setDialog("rename");
            }}
            className={FF_SETTINGS_GHOST_CLASS}
          >
            Rename
          </button>
          <button
            type="button"
            data-group-delete=""
            disabled={locked}
            aria-describedby={lockedDescribedBy}
            onClick={() => {
              setActionProblem(null);
              setDialog("delete");
            }}
            className={`${FF_LOUD_DANGER_CLASS} rounded-lg px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-60`}
          >
            Delete group
          </button>
        </div>
      </GroupHeader>

      {actionProblem ? <ProblemBanner problem={actionProblem} /> : null}
      {detail.problem ? <ProblemBanner problem={detail.problem} /> : null}

      <section aria-labelledby="group-members-heading" className={FF_SETTINGS_PANEL_CLASS}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 id="group-members-heading" className={`text-lg ${FF_SETTINGS_TITLE_CLASS}`}>
            Members
          </h2>
          <button
            type="button"
            data-group-add-member=""
            disabled={locked}
            aria-describedby={lockedDescribedBy}
            onClick={() => {
              addMember.reset();
              setDialog("add");
            }}
            className={FF_SETTINGS_PRIMARY_CLASS}
          >
            Add member
          </button>
        </div>
        {members.length === 0 ? (
          <p data-group-members-empty="" className={`mt-4 text-sm ${FF_SETTINGS_MUTED_CLASS}`}>
            {WORKSPACE_GROUP_MEMBERS_EMPTY}
          </p>
        ) : (
          <ul aria-label={`Members of ${group.displayName}`} className="mt-4 divide-y divide-border">
            {members.map((member) => (
              <GroupMemberRow
                key={member.userId}
                member={member}
                removalPending={pendingRemovalId === member.userId}
                lockedNoteId={lockedDescribedBy}
                onRemove={() => {
                  setActionProblem(null);
                  setRemoveId(member.userId);
                }}
              />
            ))}
          </ul>
        )}
        <DestructiveUndoBar
          ticket={memberUndo.ticket}
          title="Member will be removed from this group"
          detail={
            memberUndo.ticket
              ? workspaceGroupMemberLabel({
                  displayName: members.find(
                    (item) => item.userId === memberUndo.ticket?.id,
                  )?.displayName,
                  userId: memberUndo.ticket.id,
                })
              : undefined
          }
          onUndo={memberUndo.undo}
          onCommit={memberUndo.commit}
        />
      </section>

      {dialog === "rename" && !locked ? (
        <GroupNameDialog
          mode="rename"
          initialName={group.displayName}
          pending={rename.isPending}
          problem={problemOf(rename.error)}
          onSubmit={(name) => rename.mutate(name)}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog === "add" && !locked ? (
        <AddGroupMemberDialog
          identity={identity}
          groupName={group.displayName}
          existingUserIds={existingUserIds}
          pending={addMember.isPending}
          problem={problemOf(addMember.error)}
          onSubmit={(userId) => addMember.mutate(userId)}
          onClose={() => setDialog(null)}
        />
      ) : null}

      <ConfirmDestructive
        open={dialog === "delete" && !locked}
        title="Delete this group?"
        description={GROUP_DELETE_DESCRIPTION}
        reversibility="irreversible"
        confirmLabel="Delete group"
        pending={remove.isPending}
        pendingLabel="Deleting…"
        impact={workspaceGroupDeleteImpact(group)}
        onClose={() => setDialog(null)}
        onConfirm={() => remove.mutate()}
      />

      {removing && !locked ? (
        <ConfirmDestructive
          open
          title="Remove from this group?"
          description={GROUP_MEMBER_REMOVE_DESCRIPTION}
          reversibility="undoable"
          confirmLabel="Remove member"
          impact={workspaceGroupMemberRemoveImpact({
            groupName: group.displayName,
            member: removing,
          })}
          onClose={() => setRemoveId(null)}
          onConfirm={() => {
            const userId = removing.userId;
            setRemoveId(null);
            memberUndo.arm(userId);
          }}
        />
      ) : null}
    </>
  );
}

function GroupMemberRow({
  member,
  removalPending,
  lockedNoteId,
  onRemove,
}: {
  member: WorkspaceGroupMember;
  removalPending: boolean;
  /** Set while the group is read-only: Remove is off and points here. */
  lockedNoteId?: string;
  onRemove: () => void;
}) {
  const note = workspaceGroupApprovalNote(member);
  const noteId = `group-member-note-${member.userId}`;
  const label = workspaceGroupMemberLabel(member);
  const describedBy = [lockedNoteId, note ? noteId : undefined].filter(Boolean).join(" ");
  return (
    <li
      data-group-member={member.userId}
      className="flex flex-wrap items-start justify-between gap-3 py-3"
    >
      <div className="min-w-0">
        <p className={`font-medium ${FF_SETTINGS_TITLE_CLASS}`}>{label}</p>
        <p className={`font-mono text-xs ${FF_SETTINGS_MUTED_CLASS}`}>{member.userId}</p>
        {note ? (
          <p
            data-group-member-cannot-approve=""
            className={`mt-1 text-sm ${FF_SETTINGS_MUTED_CLASS}`}
          >
            <span className="font-medium">{note.label}</span>
            <span id={noteId} className="block">
              {note.description}
            </span>
          </p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onRemove}
        disabled={removalPending || Boolean(lockedNoteId)}
        aria-label={`Remove ${label} from this group`}
        aria-describedby={describedBy || undefined}
        className={FF_SETTINGS_GHOST_CLASS}
      >
        Remove
      </button>
    </li>
  );
}
