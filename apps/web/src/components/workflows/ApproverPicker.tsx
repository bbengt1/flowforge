"use client";

import { useEffect, useState } from "react";
import { Field } from "@/components/a11y/Field";
import { useEmbedMode } from "@/components/embed/EmbedMode";
import { listApproverCandidates } from "@/lib/approval-client";
import {
  APPROVERS_MAX,
  APPROVER_PICKER_EMPTY_GROUPS,
  APPROVER_PICKER_EMPTY_USERS,
  APPROVER_PICKER_GROUPS_LABEL,
  APPROVER_PICKER_HINT,
  APPROVER_PICKER_ROLE_FIRST,
  APPROVER_PICKER_ROLE_UNKNOWN,
  APPROVER_PICKER_UNAVAILABLE,
  APPROVER_PICKER_USERS_LABEL,
  approvalPrincipalLabel,
  approverSelectionCount,
  approverSelectionErrors,
  approverSelectionToWith,
  readApproverSelection,
  toggleApprover,
  type ApproverCandidates,
  type ApproverSelection,
} from "@/lib/approval-approvers";
import type { DevIdentity } from "@/lib/identity-headers";

type ApproverPickerProps = {
  identity: DevIdentity;
  /** The gate's approverRole; candidates are filtered by it on the server. */
  role: string;
  /** Current with.approvers. */
  value: unknown;
  onChange: (next: { users?: string[]; groups?: string[] } | undefined) => void;
};

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; candidates: ApproverCandidates }
  | { kind: "role-unknown" }
  | { kind: "unavailable" };

const CONTROL_CLASS =
  "mt-1 w-full rounded-lg border border-border px-3 py-2 text-sm";

/**
 * flow.approval `with.approvers` picker. Lists people and groups from
 * approver-candidates (display name and UUID only) and writes UUIDs to
 * the YAML. Never shown on embed, which the candidates route refuses.
 */
export function ApproverPicker(props: ApproverPickerProps) {
  const embed = useEmbedMode();
  if (embed) {
    return null;
  }
  return <ApproverPickerBody {...props} />;
}

function ApproverPickerBody({
  identity,
  role,
  value,
  onChange,
}: ApproverPickerProps) {
  const trimmedRole = role.trim();
  const [state, setState] = useState<LoadState>({ kind: "idle" });
  const selection = readApproverSelection(value);
  const count = approverSelectionCount(selection);
  const atCap = count >= APPROVERS_MAX;
  const clientErrors = approverSelectionErrors(selection);

  useEffect(() => {
    if (!trimmedRole) {
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      setState({ kind: "loading" });
      void listApproverCandidates(identity, trimmedRole).then((result) => {
        if (!live) {
          return;
        }
        if (result.ok) {
          setState({ kind: "ready", candidates: result.candidates });
          return;
        }
        const rolePath = result.problem.errors?.some((item) => item.path === "role");
        setState({
          kind: result.statusCode === 400 && rolePath ? "role-unknown" : "unavailable",
        });
      });
    }, 300);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [identity, trimmedRole]);

  function update(next: ApproverSelection) {
    onChange(approverSelectionToWith(next));
  }

  const candidates = state.kind === "ready" ? state.candidates : null;

  return (
    <fieldset data-approver-picker="" className="space-y-3 rounded-xl border border-border px-4 py-3">
      <legend className="px-1 text-sm font-medium">Approvers</legend>
      <p className="text-xs text-fg">{APPROVER_PICKER_HINT}</p>
      <p className="text-xs text-fg" aria-live="polite" data-approver-count="">
        {count} of {APPROVERS_MAX} picked
      </p>
      {!trimmedRole ? (
        <p className="text-sm text-fg">{APPROVER_PICKER_ROLE_FIRST}</p>
      ) : state.kind === "role-unknown" ? (
        <p role="status" className="text-sm text-fg">
          {APPROVER_PICKER_ROLE_UNKNOWN}
        </p>
      ) : state.kind === "unavailable" ? (
        <p role="status" className="text-sm text-fg">
          {APPROVER_PICKER_UNAVAILABLE}
        </p>
      ) : state.kind === "loading" || state.kind === "idle" ? (
        <p className="text-sm text-fg">Loading approvers…</p>
      ) : null}
      <ApproverKindField
        id="approver-picker-users"
        kind="users"
        label={APPROVER_PICKER_USERS_LABEL}
        emptyText={APPROVER_PICKER_EMPTY_USERS}
        options={candidates?.users ?? null}
        picked={selection.users}
        atCap={atCap}
        onToggle={(id) => update(toggleApprover(selection, "users", id))}
      />
      <ApproverKindField
        id="approver-picker-groups"
        kind="groups"
        label={APPROVER_PICKER_GROUPS_LABEL}
        emptyText={APPROVER_PICKER_EMPTY_GROUPS}
        options={candidates?.groups ?? null}
        picked={selection.groups}
        atCap={atCap}
        onToggle={(id) => update(toggleApprover(selection, "groups", id))}
      />
      {clientErrors.length > 0 ? (
        <ul role="alert" className="list-disc space-y-1 pl-5 text-sm text-danger">
          {clientErrors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}
    </fieldset>
  );
}

function ApproverKindField({
  id,
  kind,
  label,
  emptyText,
  options,
  picked,
  atCap,
  onToggle,
}: {
  id: string;
  kind: "users" | "groups";
  label: string;
  emptyText: string;
  options: readonly { id: string; displayName: string }[] | null;
  picked: readonly string[];
  atCap: boolean;
  onToggle: (id: string) => void;
}) {
  const pickedKeys = new Set(picked.map((item) => item.trim().toLowerCase()));
  const byId = new Map(
    (options ?? []).map((option) => [option.id.toLowerCase(), option]),
  );
  const available = (options ?? []).filter(
    (option) => !pickedKeys.has(option.id.toLowerCase()),
  );
  const hint =
    options && options.length === 0
      ? emptyText
      : atCap
        ? `You've picked ${APPROVERS_MAX}. Remove one to add another.`
        : undefined;
  return (
    <div data-approver-kind={kind} className="space-y-2">
      <Field id={id} label={label} hint={hint}>
        <select
          value=""
          disabled={!options || available.length === 0 || atCap}
          onChange={(event) => {
            if (event.target.value) {
              onToggle(event.target.value);
            }
          }}
          className={CONTROL_CLASS}
        >
          <option value="">
            {kind === "users" ? "Add a person" : "Add a group"}
          </option>
          {available.map((option) => (
            <option key={option.id} value={option.id}>
              {approvalPrincipalLabel(option)}
            </option>
          ))}
        </select>
      </Field>
      {picked.length > 0 ? (
        <ul className="space-y-1 text-sm" aria-label={`Picked ${label.toLowerCase()}`}>
          {picked.map((raw) => {
            const option = byId.get(raw.trim().toLowerCase());
            const name = option ? approvalPrincipalLabel(option) : raw;
            return (
              <li key={raw} className="flex flex-wrap items-center gap-2">
                <span className="break-all">{name}</span>
                <button
                  type="button"
                  onClick={() => onToggle(raw)}
                  aria-label={`Remove ${name}`}
                  className="rounded-lg border border-border px-2 py-0.5 text-xs hover:bg-fg/10"
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
