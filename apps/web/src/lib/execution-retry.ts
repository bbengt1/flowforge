/**
 * Read-only retry capability from GET /executions/{id}, the step list,
 * step get, and the retry 201. The UI offers retry only when
 * `capabilities.retry.allowed` is true. Missing or malformed payloads
 * fail closed.
 */

import { RETRY_CONFLICT_MESSAGE } from "./execution-contract.ts";
import type { ProblemDetails } from "./problem.ts";
import {
  RETRY_CAPABILITY_CODES,
  RETRY_CAPABILITY_REASONS,
  type ExecutionCapabilities,
  type RetryCapability,
  type RetryCapabilityCode,
  type RetryCapabilityReason,
} from "./execution-types.ts";

export const RETRY_REASON_MESSAGE: Record<RetryCapabilityReason, string> = {
  run_canceled: "Canceled runs can't be retried.",
  run_not_failed: "Only a failed run can be retried.",
  step_not_started: "This step hasn't started, so it can't be retried.",
  step_not_failed: "This step didn't fail, so it can't be retried.",
  incoming_unresolved:
    "Upstream steps are still unresolved, so this step can't be retried.",
  retry_not_allowed: "This step isn't safe to retry.",
  workflow_deleted: "This workflow was deleted.",
};

export const STEP_ATTEMPT_SUPERSEDED_MESSAGE =
  "A newer attempt of this step already exists.";

export const APPROVAL_CLOSED_MESSAGE =
  "This approval is already closed. No decision was recorded.";

export const RETRY_CAPABILITY_UNAVAILABLE_MESSAGE =
  "Retry isn't available for this run.";

export const EXECUTION_NOT_RETRYABLE_MESSAGE =
  "This execution can't be retried.";

const RETRY_FIELDS = new Set(["allowed", "code", "reason"]);

const REFETCH_CODES = new Set([
  "execution_not_retryable",
  "step_attempt_superseded",
  "approval_closed",
]);

export type ParsedRetryCapability =
  | { state: "missing" }
  | { state: "malformed" }
  | { state: "allowed"; capability: { allowed: true } }
  | {
      state: "denied";
      capability: Exclude<RetryCapability, { allowed: true }>;
      message: string;
    };

export type RetryAffordance = {
  show: boolean;
  /** Plain sentence for a known denial. Empty when allowed, missing, or malformed. */
  denial: string;
  state: ParsedRetryCapability["state"];
};

function isRetryCapabilityCode(value: string): value is RetryCapabilityCode {
  return (RETRY_CAPABILITY_CODES as readonly string[]).includes(value);
}

export function isRetryCapabilityReason(
  value: string | undefined,
): value is RetryCapabilityReason {
  return (
    typeof value === "string" &&
    (RETRY_CAPABILITY_REASONS as readonly string[]).includes(value)
  );
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function parseRetryObject(raw: unknown): ParsedRetryCapability {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { state: "malformed" };
  }
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!RETRY_FIELDS.has(key)) {
      return { state: "malformed" };
    }
  }
  if (typeof body.allowed !== "boolean") {
    return { state: "malformed" };
  }
  const hasCode = hasOwn(body, "code");
  const hasReason = hasOwn(body, "reason");
  if (body.allowed) {
    if (hasCode || hasReason) {
      return { state: "malformed" };
    }
    return { state: "allowed", capability: { allowed: true } };
  }
  if (!hasCode || typeof body.code !== "string" || !isRetryCapabilityCode(body.code)) {
    return { state: "malformed" };
  }
  if (body.code === "step_attempt_superseded") {
    if (hasReason) {
      return { state: "malformed" };
    }
    return {
      state: "denied",
      capability: { allowed: false, code: "step_attempt_superseded" },
      message: STEP_ATTEMPT_SUPERSEDED_MESSAGE,
    };
  }
  if (!hasReason || typeof body.reason !== "string" || !isRetryCapabilityReason(body.reason)) {
    return { state: "malformed" };
  }
  return {
    state: "denied",
    capability: {
      allowed: false,
      code: "execution_not_retryable",
      reason: body.reason,
    },
    message: RETRY_REASON_MESSAGE[body.reason],
  };
}

/** Parse a `capabilities` object. `undefined` means the field was omitted. */
export function parseAnnotatedCapabilities(
  raw: unknown,
): ParsedRetryCapability {
  if (raw === undefined) {
    return { state: "missing" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { state: "malformed" };
  }
  const body = raw as Record<string, unknown>;
  if (!hasOwn(body, "retry")) {
    return { state: "malformed" };
  }
  return parseRetryObject(body.retry);
}

export function readRecordCapabilities(row: Record<string, unknown>): {
  capabilities?: ExecutionCapabilities;
  capabilitiesInvalid?: boolean;
} {
  if (!hasOwn(row, "capabilities")) {
    return {};
  }
  const parsed = parseAnnotatedCapabilities(row.capabilities);
  if (parsed.state === "allowed" || parsed.state === "denied") {
    return { capabilities: { retry: parsed.capability } };
  }
  return { capabilitiesInvalid: true };
}

export function retryCapabilityAffordance(input: {
  capabilities?: ExecutionCapabilities;
  capabilitiesInvalid?: boolean;
}): RetryAffordance {
  if (input.capabilitiesInvalid) {
    return { show: false, denial: "", state: "malformed" };
  }
  const retry = input.capabilities?.retry;
  if (!retry) {
    return { show: false, denial: "", state: "missing" };
  }
  if (retry.allowed === true) {
    return { show: true, denial: "", state: "allowed" };
  }
  return {
    show: false,
    denial:
      retry.code === "step_attempt_superseded"
        ? STEP_ATTEMPT_SUPERSEDED_MESSAGE
        : RETRY_REASON_MESSAGE[retry.reason],
    state: "denied",
  };
}

/** Sentence for the execution-level slot when the button stays hidden. */
export function retryHiddenCopy(
  affordance: RetryAffordance,
  indeterminate: { active: boolean; copy: string },
): string {
  if (affordance.show) {
    return "";
  }
  if (affordance.denial) {
    return affordance.denial;
  }
  if (indeterminate.active) {
    return indeterminate.copy;
  }
  return RETRY_CAPABILITY_UNAVAILABLE_MESSAGE;
}

/** Human copy for a known retry or approval 409. Null when the code is not one of those. */
export function retryProblemMessage(
  problem: Pick<ProblemDetails, "code"> & { reason?: string },
): string | null {
  if (problem.code === "step_attempt_superseded") {
    return STEP_ATTEMPT_SUPERSEDED_MESSAGE;
  }
  if (problem.code === "approval_closed") {
    return APPROVAL_CLOSED_MESSAGE;
  }
  if (problem.code === "execution_not_retryable") {
    if (isRetryCapabilityReason(problem.reason)) {
      return RETRY_REASON_MESSAGE[problem.reason];
    }
    return EXECUTION_NOT_RETRYABLE_MESSAGE;
  }
  return null;
}

export function retryProblemShouldRefetch(problem: { code?: string }): boolean {
  return REFETCH_CODES.has(problem.code ?? "");
}

/**
 * Sentence shown after a retry attempt. Known 409s use the capability
 * reason. Any other 409, including a stale code, stays a plain sentence.
 */
export function retryFailureCopy(
  problem: Pick<ProblemDetails, "code"> & { reason?: string },
  statusCode: number,
): string | null {
  const mapped = retryProblemMessage(problem);
  if (mapped) {
    return mapped;
  }
  if (statusCode === 409) {
    return RETRY_CONFLICT_MESSAGE;
  }
  return null;
}
