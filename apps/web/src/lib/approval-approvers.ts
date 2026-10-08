/**
 * Approval gate targeting: named users and groups, the decide "via", and
 * the no_eligible_decider cause. Pure helpers only; the server decides.
 *
 * Display name and UUID only. Group member lists are never read or shown.
 */

import type { ProblemDetails } from "./problem.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ---------- shapes ---------- */

export type ApprovalPrincipalRef = {
  id: string;
  displayName: string;
};

export type ApprovalApprovers = {
  users: ApprovalPrincipalRef[];
  groups: ApprovalPrincipalRef[];
};

export const APPROVAL_DECIDE_VIAS = ["target", "admin_override"] as const;
export type ApprovalDecideVia = (typeof APPROVAL_DECIDE_VIAS)[number];

export const APPROVAL_DECIDE_CAPABILITY_CODES = [
  "missing_permission",
  "self_approval",
  "role_mismatch",
  "approver_not_targeted",
  "not_pending",
  "approval_closed",
] as const;
export type ApprovalDecideCapabilityCode =
  (typeof APPROVAL_DECIDE_CAPABILITY_CODES)[number];

/** allowed true carries via; allowed false carries code. */
export type ApprovalDecideCapability =
  | { allowed: true; via: ApprovalDecideVia }
  | { allowed: false; code: ApprovalDecideCapabilityCode | "" };

export type ApprovalCapabilities = {
  decide: ApprovalDecideCapability;
};

export const NO_ELIGIBLE_DECIDER_CAUSE = "no_eligible_decider" as const;
export type RequirementUnresolvableCause = typeof NO_ELIGIBLE_DECIDER_CAUSE;

export const APPROVER_NOT_TARGETED_CODE = "approver_not_targeted" as const;
export const APPROVER_GROUP_NOT_FOUND_CODE = "approver-group-not-found" as const;
export const APPROVER_NOT_MEMBER_CODE = "approver-not-member" as const;
export const APPROVER_DISABLED_CODE = "approver-disabled" as const;
export const APPROVER_CANNOT_DECIDE_CODE = "approver-cannot-decide" as const;
export const APPROVER_ROLE_MISMATCH_CODE = "approver-role-mismatch" as const;

/** Server cap on with.approvers users plus groups. */
export const APPROVERS_MAX = 25;

/* ---------- copy ---------- */

export const APPROVERS_HEADING = "Approvers";
export const APPROVERS_USERS_LABEL = "People";
export const APPROVERS_GROUPS_LABEL = "Groups";
export const APPROVERS_NONE = "None";
export const APPROVERS_HELP =
  "Only these people and current members of these groups can decide this step. A workspace admin who didn't start the run can also decide it as an override.";

export const APPROVAL_ADMIN_OVERRIDE_TAG = "Admin override";
export const APPROVAL_ADMIN_OVERRIDE_NOTE =
  "You're not one of the named approvers for this step. If you decide it, you're using your workspace admin override, and the decision is recorded as an override.";
export const APPROVAL_ADMIN_OVERRIDE_CONFIRM_TITLE = "Decide as an admin override?";
export const APPROVAL_ADMIN_OVERRIDE_CONFIRM_BODY =
  "You're not a named approver for this step. Your decision will be recorded as a workspace admin override.";
export const APPROVAL_ADMIN_OVERRIDE_CONFIRM_APPROVE = "Approve as override";
export const APPROVAL_ADMIN_OVERRIDE_CONFIRM_REJECT = "Reject as override";

export const APPROVAL_NOT_TARGETED_MESSAGE =
  "You're not one of the named approvers for this step, so you can't decide it.";

export const NO_ELIGIBLE_DECIDER_RUN_SENTENCE =
  "No one other than the requester could approve this step, so it failed.";
export const NO_ELIGIBLE_DECIDER_CLOSE_SENTENCE =
  "Closed because no one other than the requester could approve it.";

export const APPROVER_PICKER_USERS_LABEL = "Approver people";
export const APPROVER_PICKER_GROUPS_LABEL = "Approver groups";
export const APPROVER_PICKER_HINT = `Optional. Pick up to ${APPROVERS_MAX} people and groups in total. Leave both empty to let anyone with the approver role decide.`;
export const APPROVER_PICKER_ROLE_FIRST =
  "Set the approver role first to see who can approve.";
export const APPROVER_PICKER_ROLE_UNKNOWN =
  "That approver role isn't a workspace role. Use one like approver or admin.";
export const APPROVER_PICKER_UNAVAILABLE =
  "The approver list couldn't be loaded. You can still name approvers in the YAML.";
export const APPROVER_PICKER_EMPTY_USERS = "No one with this role can approve yet.";
export const APPROVER_PICKER_EMPTY_GROUPS = "This workspace has no groups yet.";
export const APPROVER_GROUP_NOT_FOUND_MESSAGE =
  "This group isn't in this workspace. Pick a group from the list.";
export const APPROVER_NOT_MEMBER_MESSAGE =
  "This person isn't a member of this workspace. Pick someone from the list.";
export const APPROVER_DISABLED_MESSAGE =
  "This person's account is turned off, so they can't approve. Pick someone else.";
export const APPROVER_CANNOT_DECIDE_MESSAGE =
  "This person's roles don't let them approve. Pick someone else or change their roles.";
export const APPROVER_ROLE_MISMATCH_MESSAGE =
  "This person doesn't have the approver role this step asks for. Pick someone who does.";
export const APPROVERS_TOO_MANY_MESSAGE = `Pick ${APPROVERS_MAX} or fewer people and groups in total.`;
export const APPROVERS_DUPLICATE_MESSAGE = "Each person or group can be picked only once.";
export const APPROVERS_INVALID_ID_MESSAGE = "Pick approvers from the list.";
export const APPROVERS_EMPTY_MESSAGE =
  "Pick at least one person or group, or clear approvers.";

/* ---------- parsing ---------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** UUID rows only, first occurrence wins. Never reads member lists. */
export function parseApprovalPrincipalRefs(raw: unknown): ApprovalPrincipalRef[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: ApprovalPrincipalRef[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const row = asRecord(item);
    if (!row) {
      continue;
    }
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (!UUID.test(id)) {
      continue;
    }
    const key = id.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({
      id,
      displayName: typeof row.displayName === "string" ? row.displayName : "",
    });
  }
  return out;
}

/** Present only on a targeted gate. Missing or malformed → undefined. */
export function parseApprovalApprovers(raw: unknown): ApprovalApprovers | undefined {
  const row = asRecord(raw);
  if (!row) {
    return undefined;
  }
  if (!Array.isArray(row.users) && !Array.isArray(row.groups)) {
    return undefined;
  }
  return {
    users: parseApprovalPrincipalRefs(row.users),
    groups: parseApprovalPrincipalRefs(row.groups),
  };
}

function isDecideVia(value: unknown): value is ApprovalDecideVia {
  return (
    typeof value === "string" &&
    (APPROVAL_DECIDE_VIAS as readonly string[]).includes(value)
  );
}

function isCapabilityCode(value: unknown): value is ApprovalDecideCapabilityCode {
  return (
    typeof value === "string" &&
    (APPROVAL_DECIDE_CAPABILITY_CODES as readonly string[]).includes(value)
  );
}

/**
 * capabilities.decide. Missing or malformed → undefined so callers keep
 * the older client-side checks. An allowed capability with an unknown via
 * fails closed to undefined: the web never guesses override vs target.
 */
export function parseApprovalCapabilities(raw: unknown): ApprovalCapabilities | undefined {
  const decide = asRecord(asRecord(raw)?.decide);
  if (!decide || typeof decide.allowed !== "boolean") {
    return undefined;
  }
  if (decide.allowed) {
    if (!isDecideVia(decide.via)) {
      return undefined;
    }
    return { decide: { allowed: true, via: decide.via } };
  }
  return {
    decide: {
      allowed: false,
      code: isCapabilityCode(decide.code) ? decide.code : "",
    },
  };
}

/** details.cause for requirement_unresolvable, or empty when unknown. */
export function readRequirementUnresolvableCause(
  details: unknown,
): RequirementUnresolvableCause | "" {
  const row = asRecord(details);
  return row?.cause === NO_ELIGIBLE_DECIDER_CAUSE ? NO_ELIGIBLE_DECIDER_CAUSE : "";
}

/* ---------- labels ---------- */

/** Display name, then the UUID. Never an email. */
export function approvalPrincipalLabel(ref: {
  id: string;
  displayName?: string;
}): string {
  const name = ref.displayName?.trim() ?? "";
  return name || ref.id;
}

export type ApprovalApproverSet = {
  kind: "users" | "groups";
  label: string;
  items: { id: string; label: string }[];
};

/** Two labeled sets, people then groups. Group members are never listed. */
export function approvalApproverSets(
  approvers: ApprovalApprovers | undefined | null,
): ApprovalApproverSet[] {
  if (!approvers) {
    return [];
  }
  const map = (refs: readonly ApprovalPrincipalRef[]) =>
    refs.map((ref) => ({ id: ref.id, label: approvalPrincipalLabel(ref) }));
  return [
    { kind: "users", label: APPROVERS_USERS_LABEL, items: map(approvers.users) },
    { kind: "groups", label: APPROVERS_GROUPS_LABEL, items: map(approvers.groups) },
  ];
}

/* ---------- via ---------- */

/** The server's via when it says the caller may decide; otherwise null. */
export function approvalDecideVia(approval: {
  capabilities?: ApprovalCapabilities;
}): ApprovalDecideVia | null {
  const decide = approval.capabilities?.decide;
  return decide?.allowed ? decide.via : null;
}

export function approvalIsAdminOverride(approval: {
  status?: string;
  capabilities?: ApprovalCapabilities;
}): boolean {
  if (approval.status !== undefined && approval.status !== "pending") {
    return false;
  }
  return approvalDecideVia(approval) === "admin_override";
}

/** Server says the caller isn't targeted (and isn't an admin). */
export function approvalCapabilityNotTargeted(approval: {
  capabilities?: ApprovalCapabilities;
}): boolean {
  const decide = approval.capabilities?.decide;
  return decide?.allowed === false && decide.code === APPROVER_NOT_TARGETED_CODE;
}

/**
 * Server says the caller is the requester. This also covers a requester
 * who reaches a targeted gate through a group.
 */
export function approvalCapabilitySelfApproval(approval: {
  capabilities?: ApprovalCapabilities;
}): boolean {
  const decide = approval.capabilities?.decide;
  return decide?.allowed === false && decide.code === "self_approval";
}

/** Server capability denies decide. Missing capability → false (unknown). */
export function approvalCapabilityDenies(approval: {
  capabilities?: ApprovalCapabilities;
}): boolean {
  return approval.capabilities?.decide.allowed === false;
}

export function isApproverNotTargetedProblem(
  problem: Pick<ProblemDetails, "code"> | null | undefined,
): boolean {
  return problem?.code === APPROVER_NOT_TARGETED_CODE;
}

/* ---------- no_eligible_decider ---------- */

/**
 * Specific sentence when requirement_unresolvable carries
 * no_eligible_decider. Any other reason or cause returns null so callers
 * keep their existing copy.
 */
export function noEligibleDeciderSentence(input: {
  reason: unknown;
  cause: unknown;
}): string | null {
  if (input.reason !== "requirement_unresolvable") {
    return null;
  }
  return input.cause === NO_ELIGIBLE_DECIDER_CAUSE
    ? NO_ELIGIBLE_DECIDER_RUN_SENTENCE
    : null;
}

/* ---------- editor picker ---------- */

export type ApproverSelection = {
  users: string[];
  groups: string[];
};

export type ApproverCandidates = {
  users: ApprovalPrincipalRef[];
  groups: ApprovalPrincipalRef[];
};

export function parseApproverCandidates(raw: unknown): ApproverCandidates | null {
  const row = asRecord(raw);
  if (!row || (!Array.isArray(row.users) && !Array.isArray(row.groups))) {
    return null;
  }
  return {
    users: parseApprovalPrincipalRefs(row.users),
    groups: parseApprovalPrincipalRefs(row.groups),
  };
}

function readIdList(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((item): item is string => typeof item === "string");
}

/** with.approvers from YAML. Anything that isn't a list reads as empty. */
export function readApproverSelection(raw: unknown): ApproverSelection {
  const row = asRecord(raw);
  return {
    users: readIdList(row?.users),
    groups: readIdList(row?.groups),
  };
}

export function approverSelectionCount(selection: ApproverSelection): number {
  return selection.users.length + selection.groups.length;
}

/**
 * Client checks that mirror publish: UUIDs only, no duplicate within a
 * list, at most 25 combined. Zero is allowed here because the picker
 * removes approvers entirely when nothing is picked.
 */
export function approverSelectionErrors(selection: ApproverSelection): string[] {
  const errors: string[] = [];
  let invalid = false;
  let duplicate = false;
  for (const list of [selection.users, selection.groups]) {
    const seen = new Set<string>();
    for (const raw of list) {
      const id = raw.trim().toLowerCase();
      if (!UUID.test(id)) {
        invalid = true;
        continue;
      }
      if (seen.has(id)) {
        duplicate = true;
      }
      seen.add(id);
    }
  }
  if (invalid) {
    errors.push(APPROVERS_INVALID_ID_MESSAGE);
  }
  if (duplicate) {
    errors.push(APPROVERS_DUPLICATE_MESSAGE);
  }
  if (approverSelectionCount(selection) > APPROVERS_MAX) {
    errors.push(APPROVERS_TOO_MANY_MESSAGE);
  }
  return errors;
}

/** with.approvers as written to YAML: undefined when nothing is picked. */
export function approverSelectionToWith(
  selection: ApproverSelection,
): { users?: string[]; groups?: string[] } | undefined {
  const out: { users?: string[]; groups?: string[] } = {};
  if (selection.users.length > 0) {
    out.users = [...selection.users];
  }
  if (selection.groups.length > 0) {
    out.groups = [...selection.groups];
  }
  return out.users || out.groups ? out : undefined;
}

/** Toggle one id in a list. Adding past the cap is refused. */
export function toggleApprover(
  selection: ApproverSelection,
  kind: "users" | "groups",
  id: string,
): ApproverSelection {
  const key = id.trim().toLowerCase();
  const list = selection[kind];
  const present = list.some((item) => item.trim().toLowerCase() === key);
  if (present) {
    return {
      ...selection,
      [kind]: list.filter((item) => item.trim().toLowerCase() !== key),
    };
  }
  if (approverSelectionCount(selection) >= APPROVERS_MAX) {
    return selection;
  }
  return { ...selection, [kind]: [...list, id] };
}

/** Validation errors for a raw with.approvers value (wizard draft). */
export function approversWithErrors(raw: unknown): string[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  const row = asRecord(raw);
  if (!row) {
    return [APPROVERS_INVALID_ID_MESSAGE];
  }
  const selection = readApproverSelection(row);
  const errors = approverSelectionErrors(selection);
  if (approverSelectionCount(selection) === 0) {
    errors.push(APPROVERS_EMPTY_MESSAGE);
  }
  return errors;
}

/**
 * "users" or "groups" for a publish field path such as
 * spec.nodes[2].with.approvers.groups[0]; null for anything else.
 */
export function approverFieldForPath(path: string | undefined): "users" | "groups" | null {
  const match = /\.with\.approvers\.(users|groups)(?:\[\d+\])?$/.exec(path?.trim() ?? "");
  return match ? (match[1] as "users" | "groups") : null;
}

const APPROVER_USER_FIELD_MESSAGES: Record<string, string> = {
  [APPROVER_NOT_MEMBER_CODE]: APPROVER_NOT_MEMBER_MESSAGE,
  [APPROVER_DISABLED_CODE]: APPROVER_DISABLED_MESSAGE,
  [APPROVER_CANNOT_DECIDE_CODE]: APPROVER_CANNOT_DECIDE_MESSAGE,
  [APPROVER_ROLE_MISMATCH_CODE]: APPROVER_ROLE_MISMATCH_MESSAGE,
};

/**
 * Plain sentence for a publish error on the approver groups field, placed
 * by path only. approver-group-not-found on groups[i] gets the group
 * sentence; anything else returns null so the server message stays.
 */
export function approverGroupFieldError(error: {
  path?: string;
  code?: string;
}): string | null {
  if (approverFieldForPath(error.path) !== "groups") {
    return null;
  }
  return error.code === APPROVER_GROUP_NOT_FOUND_CODE
    ? APPROVER_GROUP_NOT_FOUND_MESSAGE
    : null;
}

/**
 * Plain sentence for a publish error on the approver people field
 * (not a member, disabled, can't decide, wrong role), placed by path
 * only. Unknown codes return null so the server message stays.
 */
export function approverUserFieldError(error: {
  path?: string;
  code?: string;
}): string | null {
  if (approverFieldForPath(error.path) !== "users") {
    return null;
  }
  return APPROVER_USER_FIELD_MESSAGES[error.code ?? ""] ?? null;
}

export type ApproverPublishFieldError = {
  field: "users" | "groups";
  label: string;
  path: string;
  message: string;
};

/**
 * Publish field errors that land on with.approvers, placed by path only,
 * so the editor can show them under the approver field label. Known group
 * and people codes get plain sentences; other codes keep the server message.
 */
export function approverPublishFieldErrors(problem: {
  errors?: readonly { path?: string; code?: string; message?: string }[];
} | null | undefined): ApproverPublishFieldError[] {
  const out: ApproverPublishFieldError[] = [];
  for (const error of problem?.errors ?? []) {
    const field = approverFieldForPath(error.path);
    if (!field || !error.path) {
      continue;
    }
    out.push({
      field,
      label: field === "groups" ? APPROVER_PICKER_GROUPS_LABEL : APPROVER_PICKER_USERS_LABEL,
      path: error.path,
      message:
        approverGroupFieldError(error) ?? approverUserFieldError(error) ?? error.message ?? "",
    });
  }
  return out;
}
