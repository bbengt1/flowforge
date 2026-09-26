"use client";

import { useEffect, useState } from "react";
import { ConfirmDestructive } from "@/components/a11y/ConfirmDestructive";
import { Field } from "@/components/a11y/Field";
import type { DevIdentity } from "@/lib/identity-headers";
import { getWorkflow } from "@/lib/workflow-client";
import {
  DELETE_WORKFLOW_LABEL,
  WORKFLOW_DELETE_CONFIRM_HINT,
  workflowDeleteConfirmState,
  workflowDeleteImpact,
  workflowDeleteNameMatches,
  workflowDeleteShownImpact,
} from "@/lib/workflow-delete";
import type { WorkflowDeleteImpact } from "@/lib/workflow-types";
import {
  FF_OVERVIEW_CONTROL_CLASS,
  FF_OVERVIEW_DANGER_CLASS,
  FF_OVERVIEW_MUTED_CLASS,
} from "@/lib/overview-visual";

type DeleteWorkflowDialogProps = {
  open: boolean;
  workflowId: string;
  identity: DevIdentity;
  name: string;
  status: string;
  typedName: string;
  pending: boolean;
  /** Already parsed from a loaded detail. Omitted starts a detail fetch. */
  deleteImpact?: WorkflowDeleteImpact | null;
  embed?: boolean;
  errorMessage?: string | null;
  errorKind?: string | null;
  returnFocusTo?: string | null;
  onTypedName: (value: string) => void;
  onConfirm: () => void;
  onClose: () => void;
};

export function DeleteWorkflowDialog({
  open,
  workflowId,
  identity,
  name,
  status,
  typedName,
  pending,
  deleteImpact,
  embed = false,
  errorMessage = null,
  errorKind = null,
  returnFocusTo = null,
  onTypedName,
  onConfirm,
  onClose,
}: DeleteWorkflowDialogProps) {
  const [fetched, setFetched] = useState<WorkflowDeleteImpact | null>(null);
  useEffect(() => {
    if (!open || embed || deleteImpact) {
      return;
    }
    let cancelled = false;
    setFetched(null);
    void getWorkflow(identity, workflowId).then((result) => {
      if (cancelled) {
        return;
      }
      setFetched(result.ok ? (result.workflow.deleteImpact ?? null) : null);
    });
    return () => {
      cancelled = true;
    };
  }, [open, embed, workflowId, deleteImpact, identity]);

  const shown = workflowDeleteShownImpact({
    embed,
    deleteImpact: deleteImpact ?? fetched,
  });
  const confirm = workflowDeleteConfirmState({ status, deleteImpact: shown });
  const canConfirm =
    workflowDeleteNameMatches(name, typedName) && !confirm.confirmDisabled;
  return (
    <ConfirmDestructive
      open={open}
      title={DELETE_WORKFLOW_LABEL}
      description={confirm.description}
      reversibility="irreversible"
      confirmLabel={DELETE_WORKFLOW_LABEL}
      pending={pending}
      pendingLabel="Deleting…"
      canConfirm={canConfirm}
      impact={workflowDeleteImpact({ name, status, deleteImpact: shown })}
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
