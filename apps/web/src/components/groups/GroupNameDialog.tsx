"use client";

import { useId, useState } from "react";
import { Dialog } from "@/components/a11y/Dialog";
import { Field } from "@/components/a11y/Field";
import { ProblemBanner } from "@/components/ProblemBanner";
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
  GROUP_NAME_HINT,
  GROUP_NAME_LABEL,
  GROUP_NAME_MAX_CHARS,
  groupDisplayNameClientError,
  groupRenameIsNoOp,
  normalizeGroupDisplayName,
  workspaceGroupFieldError,
} from "@/lib/workspace-groups";

export type GroupNameDialogProps = {
  mode: "create" | "rename";
  initialName?: string;
  pending: boolean;
  /** Last server problem for this dialog. Path `displayName` lands on the field. */
  problem: ProblemDetails | null;
  onSubmit: (displayName: string) => void;
  onClose: () => void;
};

/** Create or rename a group. Mount it only while open so state resets. */
export function GroupNameDialog({
  mode,
  initialName = "",
  pending,
  problem,
  onSubmit,
  onClose,
}: GroupNameDialogProps) {
  const headingId = useId();
  const [name, setName] = useState(initialName);
  const [clientError, setClientError] = useState<string | null>(null);
  const [submittedName, setSubmittedName] = useState<string | null>(null);
  // A server error belongs to the name that was sent. Editing clears it.
  const serverFieldError =
    submittedName !== null && submittedName === name
      ? workspaceGroupFieldError(problem, "displayName")
      : null;
  const fieldError = clientError ?? serverFieldError;
  const bannerProblem =
    problem && !workspaceGroupFieldError(problem, "displayName") ? problem : null;
  const title = mode === "create" ? "Create group" : "Rename group";
  const submitLabel = mode === "create" ? "Create group" : "Save name";
  const pendingLabel = mode === "create" ? "Creating…" : "Saving…";
  // Exact match only: a case-only rename is a real change and is sent.
  const unchanged = mode === "rename" && groupRenameIsNoOp(initialName, name);

  function submit() {
    const error = groupDisplayNameClientError(name);
    setClientError(error);
    if (error || unchanged) {
      return;
    }
    setSubmittedName(name);
    onSubmit(normalizeGroupDisplayName(name));
  }

  return (
    <Dialog
      open
      onClose={onClose}
      labelledBy={headingId}
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 p-4"
    >
      <form
        data-group-name-dialog={mode}
        className={`${FF_OVERVIEW_DIALOG_CLASS} w-full max-w-lg`}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <h2 id={headingId} className={`text-lg ${FF_OVERVIEW_TITLE_CLASS}`}>
          {title}
        </h2>
        <p className={`mt-1 text-sm ${FF_OVERVIEW_MUTED_CLASS}`}>
          Groups only decide who approvals are sent to. They never grant a
          permission.
        </p>
        <div className="mt-4">
          <Field
            id="group-display-name"
            label={GROUP_NAME_LABEL}
            hint={GROUP_NAME_HINT}
            error={fieldError}
            required
          >
            <input
              type="text"
              value={name}
              autoComplete="off"
              maxLength={GROUP_NAME_MAX_CHARS}
              onChange={(event) => {
                setName(event.target.value);
                setClientError(null);
              }}
              className={`mt-1 ${FF_SETTINGS_CONTROL_CLASS}`}
            />
          </Field>
        </div>
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
            disabled={pending || unchanged}
            className={FF_SETTINGS_PRIMARY_CLASS}
          >
            {pending ? pendingLabel : submitLabel}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
