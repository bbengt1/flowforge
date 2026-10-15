/**
 * Editor wiring for POST /workflows/{workflowId}/draft/typecheck (#650).
 *
 * The route checks the stored draft (never the unsaved buffer), never
 * evaluates, and returns types, codes and paths only. Messages are fixed
 * server strings that never echo expression text or values, and this
 * module adds none.
 *
 * Rules (Gracie, #650):
 * - The route allows 60 calls a minute per user. Check after a draft save
 *   or load, debounced (TYPECHECK_DEBOUNCE_MS), never per keystroke.
 * - 429, 503 and network failures are "check unavailable", never a pass.
 * - A pass for an older revision, or while the buffer has unsaved
 *   changes, is stale, not a pass.
 */

import {
  callIdentityProxy,
  type IdentityClientResult,
} from "./identity-client.ts";
import type { DevIdentity } from "./identity-headers.ts";

export const TYPECHECK_DEBOUNCE_MS = 1_500;

export function workflowDraftTypecheckPath(workflowId: string): string {
  return `/workflows/${workflowId}/draft/typecheck`;
}

export type TypecheckError = {
  path: string;
  nodeId?: string;
  code: string;
  message: string;
};

export type TypecheckResponse = {
  ok: boolean;
  catalogRevision: number;
  draftRevision: number;
  errors: TypecheckError[];
};

export type TypecheckOutcome =
  | { kind: "passed"; draftRevision: number }
  | { kind: "failed"; draftRevision: number; errors: TypecheckError[] }
  | { kind: "unavailable"; statusCode: number; retryAfterSeconds?: number }
  | { kind: "refused"; statusCode: number; code: string };

export type TypecheckView =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "passed" }
  | { state: "failed"; errors: TypecheckError[] }
  | { state: "stale"; reason: "unsaved" | "revision" }
  | { state: "unavailable" }
  | { state: "refused" };

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** Keep only the documented fields. Unknown fields are dropped, never shown. */
export function parseTypecheckResponse(value: unknown): TypecheckResponse | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const v = value as Record<string, unknown>;
  if (
    typeof v.ok !== "boolean" ||
    typeof v.draftRevision !== "number" ||
    !Array.isArray(v.errors)
  ) {
    return null;
  }
  const errors: TypecheckError[] = [];
  for (const raw of v.errors) {
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const e = raw as Record<string, unknown>;
    if (!isString(e.code) || !isString(e.message)) {
      return null;
    }
    errors.push({
      path: isString(e.path) ? e.path : "",
      ...(isString(e.nodeId) && e.nodeId !== "" ? { nodeId: e.nodeId } : {}),
      code: e.code,
      message: e.message,
    });
  }
  // ok must agree with errors; anything else is not trusted as a pass.
  if (v.ok !== (errors.length === 0)) {
    return null;
  }
  return {
    ok: v.ok,
    catalogRevision: typeof v.catalogRevision === "number" ? v.catalogRevision : 0,
    draftRevision: v.draftRevision,
    errors,
  };
}

/** Map a proxy result to an outcome. Only a well-formed 200 can pass. */
export function typecheckOutcome(
  result: IdentityClientResult<unknown>,
): TypecheckOutcome {
  if (!result.ok) {
    const status = result.statusCode;
    // Network failures reach here as 503 control-plane-unreachable.
    if (status === 429 || status === 0 || status >= 500) {
      return {
        kind: "unavailable",
        statusCode: status,
        ...(result.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: result.retryAfterSeconds }
          : {}),
      };
    }
    return { kind: "refused", statusCode: status, code: result.problem.code };
  }
  const parsed = parseTypecheckResponse(result.data);
  if (!parsed) {
    return { kind: "unavailable", statusCode: result.statusCode };
  }
  return parsed.ok
    ? { kind: "passed", draftRevision: parsed.draftRevision }
    : { kind: "failed", draftRevision: parsed.draftRevision, errors: parsed.errors };
}

/**
 * What the editor shows. A result for another revision than the saved one
 * is stale; a pass while the buffer is dirty is stale.
 */
export function typecheckView(input: {
  outcome: TypecheckOutcome | null;
  pending: boolean;
  savedRevision: number | null;
  dirty: boolean;
}): TypecheckView {
  const { outcome, pending, savedRevision, dirty } = input;
  if (pending) {
    return { state: "checking" };
  }
  if (!outcome) {
    return { state: "idle" };
  }
  if (outcome.kind === "unavailable") {
    return { state: "unavailable" };
  }
  if (outcome.kind === "refused") {
    return { state: "refused" };
  }
  if (savedRevision === null || outcome.draftRevision !== savedRevision) {
    return { state: "stale", reason: "revision" };
  }
  if (outcome.kind === "passed") {
    return dirty ? { state: "stale", reason: "unsaved" } : { state: "passed" };
  }
  return { state: "failed", errors: outcome.errors };
}

/** Group errors by nodeId. Errors without a nodeId go under the workflow. */
export function typecheckErrorsByNode(errors: readonly TypecheckError[]): {
  byNode: Map<string, TypecheckError[]>;
  workflow: TypecheckError[];
} {
  const byNode = new Map<string, TypecheckError[]>();
  const workflow: TypecheckError[] = [];
  for (const error of errors) {
    if (!error.nodeId) {
      workflow.push(error);
      continue;
    }
    const list = byNode.get(error.nodeId);
    if (list) {
      list.push(error);
    } else {
      byNode.set(error.nodeId, [error]);
    }
  }
  return { byNode, workflow };
}

export const TYPECHECK_COPY = {
  idle: "Expressions not checked yet.",
  checking: "Checking expressions…",
  passed: "Expressions check passed for the saved draft.",
  staleUnsaved: "Expression check is out of date. Save to check again.",
  staleRevision: "Expression check is out of date.",
  unavailable: "Expression check unavailable. Publish still checks.",
  refused: "Expression check could not run.",
} as const;

export function typecheckSummary(view: TypecheckView): string {
  switch (view.state) {
    case "idle":
      return TYPECHECK_COPY.idle;
    case "checking":
      return TYPECHECK_COPY.checking;
    case "passed":
      return TYPECHECK_COPY.passed;
    case "failed":
      return `${view.errors.length} expression ${
        view.errors.length === 1 ? "problem" : "problems"
      } in the saved draft.`;
    case "stale":
      return view.reason === "unsaved"
        ? TYPECHECK_COPY.staleUnsaved
        : TYPECHECK_COPY.staleRevision;
    case "unavailable":
      return TYPECHECK_COPY.unavailable;
    case "refused":
      return TYPECHECK_COPY.refused;
  }
}

type TimerApi = {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

const defaultTimers: TimerApi = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Trailing debounce. Repeated requests inside the window collapse into one
 * call with the last value; nothing fires more often than once per window.
 */
export function createTypecheckDebouncer<T>(
  fire: (value: T) => void,
  options: { delayMs?: number; timers?: TimerApi } = {},
) {
  const delay = Math.max(options.delayMs ?? TYPECHECK_DEBOUNCE_MS, 1_000);
  const timers = options.timers ?? defaultTimers;
  let handle: unknown = null;
  return {
    delayMs: delay,
    request(value: T) {
      if (handle !== null) {
        timers.clear(handle);
      }
      handle = timers.set(() => {
        handle = null;
        fire(value);
      }, delay);
    },
    cancel() {
      if (handle !== null) {
        timers.clear(handle);
        handle = null;
      }
    },
  };
}

/** TanStack Query key; one entry per workflow and saved revision. */
export function workflowTypecheckQueryKey(
  scope: string,
  workflowId: string,
  revision: number,
): readonly ["flowforge", string, "workflows", "typecheck", string, number] {
  return ["flowforge", scope, "workflows", "typecheck", workflowId, revision] as const;
}

type CallFn = typeof callIdentityProxy;

/**
 * POST the typecheck. CSRF and identity headers go through
 * callIdentityProxy exactly as the draft save does. There is no body:
 * the server checks the stored draft.
 */
export async function typecheckWorkflowDraft(
  identity: DevIdentity,
  workflowId: string,
  call: CallFn = callIdentityProxy,
): Promise<TypecheckOutcome> {
  try {
    const result = await call<unknown>(
      workflowDraftTypecheckPath(workflowId),
      identity,
      { method: "POST", quietMfa: true },
    );
    return typecheckOutcome(result);
  } catch {
    return { kind: "unavailable", statusCode: 0 };
  }
}
