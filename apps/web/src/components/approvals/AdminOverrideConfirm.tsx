"use client";

import { useId } from "react";
import { Dialog } from "@/components/a11y/Dialog";
import {
  APPROVAL_ADMIN_OVERRIDE_CONFIRM_APPROVE,
  APPROVAL_ADMIN_OVERRIDE_CONFIRM_BODY,
  APPROVAL_ADMIN_OVERRIDE_CONFIRM_REJECT,
  APPROVAL_ADMIN_OVERRIDE_CONFIRM_TITLE,
} from "@/lib/approval-approvers";
import {
  FF_OVERVIEW_DIALOG_CLASS,
  FF_OVERVIEW_MUTED_CLASS,
  FF_OVERVIEW_TITLE_CLASS,
} from "@/lib/overview-visual";
import {
  FF_SETTINGS_GHOST_CLASS,
  FF_SETTINGS_PRIMARY_CLASS,
} from "@/lib/settings-wizard-visual";

type AdminOverrideConfirmProps = {
  action: "approve" | "reject";
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Explicit confirm before a workspace admin decides a gate they are not
 * named on. Nothing is sent until the confirm button is pressed.
 */
export function AdminOverrideConfirm({
  action,
  onConfirm,
  onCancel,
}: AdminOverrideConfirmProps) {
  const headingId = useId();
  const bodyId = useId();
  return (
    <Dialog
      open
      onClose={onCancel}
      labelledBy={headingId}
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 p-4"
    >
      <div
        data-approval-override-confirm={action}
        aria-describedby={bodyId}
        className={`${FF_OVERVIEW_DIALOG_CLASS} w-full max-w-lg`}
      >
        <h2 id={headingId} className={`text-lg ${FF_OVERVIEW_TITLE_CLASS}`}>
          {APPROVAL_ADMIN_OVERRIDE_CONFIRM_TITLE}
        </h2>
        <p id={bodyId} className={`mt-2 text-sm ${FF_OVERVIEW_MUTED_CLASS}`}>
          {APPROVAL_ADMIN_OVERRIDE_CONFIRM_BODY}
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <button type="button" onClick={onCancel} className={FF_SETTINGS_GHOST_CLASS}>
            Cancel
          </button>
          <button type="button" onClick={onConfirm} className={FF_SETTINGS_PRIMARY_CLASS}>
            {action === "approve"
              ? APPROVAL_ADMIN_OVERRIDE_CONFIRM_APPROVE
              : APPROVAL_ADMIN_OVERRIDE_CONFIRM_REJECT}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
