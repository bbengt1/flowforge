"use client";

import { useId, useMemo, useState } from "react";
import { Dialog } from "@/components/a11y/Dialog";
import { Field } from "@/components/a11y/Field";
import { ProblemBanner } from "@/components/ProblemBanner";
import { useWorkspaceGroupPicker } from "@/components/groups/useWorkspaceGroups";
import type { DevIdentity } from "@/lib/identity-headers";
import type { ProblemDetails } from "@/lib/problem";
import {
  FF_OVERVIEW_DIALOG_CLASS,
  FF_OVERVIEW_MUTED_CLASS,
  FF_OVERVIEW_TITLE_CLASS,
} from "@/lib/overview-visual";
import {
  FF_SETTINGS_CONTROL_CLASS,
  FF_SETTINGS_GHOST_CLASS,
  FF_SETTINGS_PRIMARY_CLASS,
} from "@/lib/settings-wizard-visual";
import {
  GROUP_MEMBER_HINT,
  GROUP_MEMBER_INVALID_MESSAGE,
  GROUP_MEMBER_LABEL,
  GROUP_MEMBER_PICKER_EMPTY,
  GROUP_MEMBER_PICKER_MORE,
  workspaceGroupCandidates,
  workspaceGroupFieldError,
} from "@/lib/workspace-groups";

export type AddGroupMemberDialogProps = {
  identity: DevIdentity;
  groupName: string;
  existingUserIds: readonly string[];
  pending: boolean;
  /** Last server problem for this dialog. Path `userId` lands on the picker. */
  problem: ProblemDetails | null;
  onSubmit: (userId: string) => void;
  onClose: () => void;
};

/**
 * Pick an active workspace member who is not in the group yet. The
 * list comes from the admin-only `GET /workspace/members`, filtered on
 * the client; the server still decides who may be added.
 */
export function AddGroupMemberDialog({
  identity,
  groupName,
  existingUserIds,
  pending,
  problem,
  onSubmit,
  onClose,
}: AddGroupMemberDialogProps) {
  const headingId = useId();
  const picker = useWorkspaceGroupPicker(identity, true);
  const candidates = useMemo(
    () => workspaceGroupCandidates(picker.members, existingUserIds),
    [picker.members, existingUserIds],
  );
  const [chosen, setChosen] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [clientError, setClientError] = useState<string | null>(null);
  const selected = candidates.some((item) => item.userId === chosen) ? chosen : "";
  const serverFieldError =
    submitted !== null && submitted === chosen
      ? workspaceGroupFieldError(problem, "userId")
      : null;
  const fieldError = clientError ?? serverFieldError;
  const bannerProblem =
    problem && !workspaceGroupFieldError(problem, "userId") ? problem : null;
  const listEmpty = picker.loaded && candidates.length === 0;

  function submit() {
    if (!selected) {
      setClientError(GROUP_MEMBER_INVALID_MESSAGE);
      return;
    }
    setClientError(null);
    setSubmitted(selected);
    onSubmit(selected);
  }

  return (
    <Dialog
      open
      onClose={onClose}
      labelledBy={headingId}
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 p-4"
    >
      <form
        data-group-add-member-dialog=""
        className={`${FF_OVERVIEW_DIALOG_CLASS} w-full max-w-lg`}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <h2 id={headingId} className={`text-lg ${FF_OVERVIEW_TITLE_CLASS}`}>
          Add member to {groupName}
        </h2>
        <p className={`mt-1 text-sm ${FF_OVERVIEW_MUTED_CLASS}`}>
          Adding someone to a group doesn&apos;t change their roles or what
          they can do.
        </p>
        {picker.problem ? (
          <div className="mt-4">
            <ProblemBanner problem={picker.problem} />
          </div>
        ) : null}
        <div className="mt-4">
          <Field
            id="group-member-user"
            label={GROUP_MEMBER_LABEL}
            hint={GROUP_MEMBER_HINT}
            error={fieldError}
            required
          >
            <select
              value={selected}
              disabled={!picker.loaded || candidates.length === 0}
              onChange={(event) => {
                setChosen(event.target.value);
                setClientError(null);
              }}
              className={`mt-1 ${FF_SETTINGS_CONTROL_CLASS}`}
            >
              <option value="">
                {picker.loaded ? "Choose a member" : "Loading members…"}
              </option>
              {candidates.map((item) => (
                <option key={item.userId} value={item.userId}>
                  {item.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <p className={`mt-2 text-sm ${FF_OVERVIEW_MUTED_CLASS}`} aria-live="polite">
          {!picker.loaded
            ? picker.problem
              ? ""
              : "Loading workspace members…"
            : listEmpty && !picker.hasMore
              ? GROUP_MEMBER_PICKER_EMPTY
              : picker.hasMore
                ? GROUP_MEMBER_PICKER_MORE
                : `${candidates.length} ${candidates.length === 1 ? "person" : "people"} can be added.`}
        </p>
        {picker.hasMore ? (
          <button
            type="button"
            data-group-picker-more=""
            onClick={picker.loadMore}
            disabled={picker.loadingMore}
            className={`mt-2 ${FF_SETTINGS_GHOST_CLASS}`}
          >
            {picker.loadingMore ? "Loading…" : "Load more members"}
          </button>
        ) : null}
        {bannerProblem ? (
          <div className="mt-4">
            <ProblemBanner problem={bannerProblem} />
          </div>
        ) : null}
        <div className="mt-5 flex flex-wrap gap-2">
          <button type="button" onClick={onClose} className={FF_SETTINGS_GHOST_CLASS}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={pending || !selected}
            className={FF_SETTINGS_PRIMARY_CLASS}
          >
            {pending ? "Adding…" : "Add member"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
