"use client";

import { ConfirmDestructive } from "@/components/a11y/ConfirmDestructive";
import { Field } from "@/components/a11y/Field";
import {
  DELETE_WORKFLOW_LABEL,
  WORKFLOW_DELETE_CONFIRM_HINT,
  workflowDeleteDescription,
  workflowDeleteImpact,
  workflowDeleteNameMatches,
} from "@/lib/workflow-delete";
import {
  FF_OVERVIEW_CONTROL_CLASS,
  FF_OVERVIEW_DANGER_CLASS,
  FF_OVERVIEW_MUTED_CLASS,
} from "@/lib/overview-visual";

type DeleteWorkflowDialogProps = {
  open: boolean;
  name: string;
  status: string;
  typedName: string;
  pending: boolean;
  errorMessage?: string | null;
  errorKind?: string | null;
  returnFocusTo?: string | null;
  onTypedName: (value: string) => void;
  onConfirm: () => void;
  onClose: () => void;
};

export function DeleteWorkflowDialog({
  open,
  name,
  status,
  typedName,
  pending,
  errorMessage = null,
  errorKind = null,
  returnFocusTo = null,
  onTypedName,
  onConfirm,
  onClose,
}: DeleteWorkflowDialogProps) {
  const canConfirm = workflowDeleteNameMatches(name, typedName);
  return (
    <ConfirmDestructive
      open={open}
      title={DELETE_WORKFLOW_LABEL}
      description={workflowDeleteDescription(status)}
      reversibility="irreversible"
      confirmLabel={DELETE_WORKFLOW_LABEL}
      pending={pending}
      pendingLabel="Deleting…"
      canConfirm={canConfirm}
      impact={workflowDeleteImpact({ name, status })}
      returnFocusTo={returnFocusTo}
      restoreFocus="target"
      onConfirm={onConfirm}
      onClose={onClose}
    >
      <Field
        id="workflow-delete-confirm-name"
        label={`Type ${name} to confirm`}
        hint={WORKFLOW_DELETE_CONFIRM_HINT}
        className="mt-4"
        labelClassName={FF_OVERVIEW_MUTED_CLASS}
        hintClassName={`mt-1 block text-xs ${FF_OVERVIEW_MUTED_CLASS}`}
      >
        <input
          value={typedName}
          onChange={(event) => onTypedName(event.target.value)}
          autoComplete="off"
          data-workflow-delete="confirm-name"
          className={`mt-1 ${FF_OVERVIEW_CONTROL_CLASS}`}
        />
      </Field>
      {errorMessage ? (
        <p
          role="alert"
          data-workflow-delete={errorKind || "error"}
          className={`mt-3 text-sm ${FF_OVERVIEW_DANGER_CLASS}`}
        >
          {errorMessage}
        </p>
      ) : null}
    </ConfirmDestructive>
  );
}
