/**
 * Single retarget adapter for Chloe's E8.3 SSH indeterminate / retry
 * semantics UI. Wired to jonny's **#90** map on `main`:
 * GET /ssh/catalog (`retry.ui` / `retry.probe` / `errors[]`)
 * + GET /workflows/catalog `ssh.run.policy`
 * + POST /policy/evaluate (`retryMaxAttempts`, `retrySafe`,
 *   `retryAllowed`, `verificationDeclared`)
 * + GET /executions/{id} `result.retry.allowed`.
 *
 * Relates to #84 (already closed by #90) / Part of #81 — do not
 * re-close #84. Keep epic #81 open until this UI PR merges.
 * Cookie session + `X-CSRF-Token`, camelCase JSON, RFC 9457.
 * Do not invent verify / resume routes. Do not change `apps/api`.
 */

import { ENGINE_CATALOG_UNAVAILABLE_HELP } from "./catalog-fail-closed.ts";
import { isIndeterminateStatus } from "./execution.ts";
import type { ExecutionStatus } from "./execution-types.ts";

export const SSH_RETRY_STORY = 84;
export const SSH_RETRY_EPIC = 81;
/** Jonny's E8.3 map on main. */
export const SSH_RETRY_API_PR = 90;
export const SSH_RETRY_ROUTE_MAP_SOURCE = "e83-#90" as const;

export const SSH_RUN_NODE_TYPE = "ssh.run" as const;

export const SSH_DEFAULT_RETRY_MAX_ATTEMPTS = 0;
export const SSH_MAX_RETRY_ATTEMPTS = 5;
export const SSH_RETRY_SAFE_FLAG = "retrySafe" as const;
export const SSH_RETRY_SEMANTICS = "E8.3" as const;
export const SSH_VERIFICATION_FIELD = "verification" as const;
export const SSH_VERIFICATION_CONTRACT = "profile-declared-idempotent-probe" as const;

export const SSH_VERIFY_ALREADY_APPLIED = "already-applied" as const;
export const SSH_VERIFY_SAFE_TO_RETRY = "safe-to-retry" as const;
export const SSH_VERIFY_INDETERMINATE = "indeterminate" as const;
export const SSH_VERIFY_OUTCOMES = [
  SSH_VERIFY_ALREADY_APPLIED,
  SSH_VERIFY_SAFE_TO_RETRY,
  SSH_VERIFY_INDETERMINATE,
] as const;
export type SshVerifyOutcome = (typeof SSH_VERIFY_OUTCOMES)[number];

export const SSH_RETRY_SAFE_HELP =
  "Mark retrySafe only when this profile declares an idempotent verification probe. Enabling it means a later ssh.run may retry after that probe — never a blind repeat. Default is false. retrySafe=true requires spec.verification.template. maxAttempts>0 on ssh.run requires retrySafe plus verification.";

export const SSH_RETRY_ZERO_MESSAGE =
  "Retries default to zero (first attempt only). maxAttempts>0 requires a retrySafe profile with a declared verification probe.";

export const SSH_RETRY_DENIED_MESSAGE =
  "retryPolicy.maxAttempts>0 requires retrySafe plus verification. Otherwise the engine and POST …/retry return retry-denied.";

export const SSH_INVALID_VERIFICATION_MESSAGE =
  "retrySafe=true requires spec.verification.template (an idempotent read-only probe). Missing or invalid verification is invalid-verification at save/publish.";

export const SSH_INDETERMINATE_HELP =
  "Lease loss, unknown provider outcome, or an inconclusive probe is indeterminate. Never assume the remote command did not run.";

export const SSH_INDETERMINATE_LEASE_LOSS_HELP =
  "Indeterminate SSH outcome — lease lost, unknown after dispatch, or verification could not confirm state. A remote side effect may have occurred. Do not assume the command did not run.";

export const SSH_NO_BLIND_RETRY_HELP =
  "This UI never offers a blind retry for ssh.run. Retry is shown only when result.retry.allowed is true (retrySafe + verification + remaining attempts). POST …/retry is 409 retry-denied when closed.";

export const SSH_PROBE_HELP =
  "spec.verification is an idempotent read-only probe using the same parameterSchema and POSIX quoting as the mutating template. It is never the mutating command. already-applied succeeds without re-run; safe-to-retry may re-run once; onError stays indeterminate.";

export type SshRetryCatalogSource =
  | "ssh-catalog"
  | "ops-config-catalog"
  | "unavailable";

export type SshRetryErrorShape = {
  code: string;
  status: number;
  meaning: string;
};

export type SshRetryUI = {
  indeterminateBadge: string;
  retrySafeFlag: string;
  retryEnabledWhen: string;
  hideRetryWhen: string;
  neverAssumeAbsent: boolean;
};

export type SshRetryProbe = {
  requiredWhenRetrySafe: boolean;
  field: string;
  template: string;
  expectExitCodeDefault: number;
  onMatchDefault: string;
  onMismatchDefault: string;
  onError: string;
  outcomes: readonly string[];
  note: string;
};

export type SshRetryCatalog = {
  source: SshRetryCatalogSource;
  defaultMaxAttempts: number;
  maxAttempts: number;
  retrySafeFlag: string;
  retrySafeDefault: false;
  semantics: string;
  note: string;
  blindRetry: false;
  leaseLossOutcome: string;
  unknownOutcome: string;
  requiresVerificationWhenRetrySafe: boolean;
  verification: string;
  whenRetryAllowed: string;
  ui: SshRetryUI;
  probe: SshRetryProbe;
  errors: SshRetryErrorShape[];
  notes?: string;
};

export type SshRetryPolicy = {
  maxAttempts: number;
};

export type SshVerificationSpec = {
  template: string;
  expectExitCode: number;
  expectStdoutContains?: string;
  onMatch: string;
  onMismatch: string;
  onError: string;
};

export type SshRetryResult = {
  maxAttempts: number;
  executedAttempts: number;
  retrySafe: boolean;
  allowed: boolean;
  requiresVerification: boolean;
  verificationDeclared: boolean;
  semantics: string;
  note: string;
  verificationOutcome?: string;
};

export type SshEvaluateRetry = {
  nodeId: string;
  operation: string;
  retrySafe: boolean;
  retryMaxAttempts: number;
  retryAllowed: boolean;
  verificationDeclared: boolean;
};

export type SshRetryValidation = {
  ok: boolean;
  maxAttempts: number;
  errors: string[];
  warnings: string[];
};

export const DEFAULT_SSH_RETRY_UI: SshRetryUI = {
  indeterminateBadge: "indeterminate",
  retrySafeFlag: SSH_RETRY_SAFE_FLAG,
  retryEnabledWhen:
    "Show Retry when result.retry.allowed is true (retrySafe + verification + remaining attempts). Disable/hide Retry for non-retrySafe indeterminate.",
  hideRetryWhen: "indeterminate without retry.allowed, retry-denied, or maxAttempts=0",
  neverAssumeAbsent: true,
};

export const DEFAULT_SSH_RETRY_PROBE: SshRetryProbe = {
  requiredWhenRetrySafe: true,
  field: SSH_VERIFICATION_FIELD,
  template:
    "Reviewed {name} template using the same parameterSchema. Idempotent read-only probe. Never the mutating command.",
  expectExitCodeDefault: 0,
  onMatchDefault: SSH_VERIFY_ALREADY_APPLIED,
  onMismatchDefault: SSH_VERIFY_SAFE_TO_RETRY,
  onError: SSH_VERIFY_INDETERMINATE,
  outcomes: SSH_VERIFY_OUTCOMES,
  note: SSH_PROBE_HELP,
};

export const DEFAULT_SSH_RETRY_ERRORS: SshRetryErrorShape[] = [
  {
    code: "retry-denied",
    status: 400,
    meaning: SSH_RETRY_DENIED_MESSAGE,
  },
  {
    code: "invalid-verification",
    status: 400,
    meaning: SSH_INVALID_VERIFICATION_MESSAGE,
  },
  {
    code: "indeterminate",
    status: 409,
    meaning: SSH_INDETERMINATE_LEASE_LOSS_HELP,
  },
];

export const SSH_RETRY_UNAVAILABLE_CATALOG: SshRetryCatalog = {
  source: "unavailable",
  defaultMaxAttempts: SSH_DEFAULT_RETRY_MAX_ATTEMPTS,
  maxAttempts: SSH_MAX_RETRY_ATTEMPTS,
  retrySafeFlag: SSH_RETRY_SAFE_FLAG,
  retrySafeDefault: false,
  semantics: SSH_RETRY_SEMANTICS,
  note: SSH_RETRY_ZERO_MESSAGE,
  blindRetry: false,
  leaseLossOutcome: "indeterminate",
  unknownOutcome: "indeterminate",
  requiresVerificationWhenRetrySafe: true,
  verification: SSH_VERIFICATION_CONTRACT,
  whenRetryAllowed:
    "pinned command profile retrySafe=true AND verification.template is present AND retryPolicy.maxAttempts>0 AND attempts remain AND prior status is failed, canceled, or indeterminate after verification",
  ui: DEFAULT_SSH_RETRY_UI,
  probe: DEFAULT_SSH_RETRY_PROBE,
  errors: DEFAULT_SSH_RETRY_ERRORS,
  notes: ENGINE_CATALOG_UNAVAILABLE_HELP,
};

export function isSshRunType(type: string | undefined): boolean {
  return (type ?? "").trim() === SSH_RUN_NODE_TYPE;
}

export function commandProfileRetrySafe(
  spec: { retrySafe?: unknown } | null | undefined,
): boolean {
  return spec?.retrySafe === true;
}

export function commandProfileVerificationDeclared(
  spec: { verification?: unknown } | null | undefined,
): boolean {
  const parsed = parseSshVerificationSpec(spec?.verification);
  return Boolean(parsed?.template.trim());
}

export function defaultSshRetryPolicy(): SshRetryPolicy {
  return { maxAttempts: SSH_DEFAULT_RETRY_MAX_ATTEMPTS };
}

export function emptyCommandProfileRetrySafe(): false {
  return false;
}

export function defaultSshVerificationSpec(): SshVerificationSpec {
  return {
    template: "",
    expectExitCode: DEFAULT_SSH_RETRY_PROBE.expectExitCodeDefault,
    onMatch: DEFAULT_SSH_RETRY_PROBE.onMatchDefault,
    onMismatch: DEFAULT_SSH_RETRY_PROBE.onMismatchDefault,
    onError: DEFAULT_SSH_RETRY_PROBE.onError,
  };
}

export function parseSshVerificationSpec(
  raw: unknown,
): SshVerificationSpec | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const rec = raw as Record<string, unknown>;
  const template = String(rec.template ?? "").trim();
  const expectExitCode = Number.isInteger(Number(rec.expectExitCode))
    ? Number(rec.expectExitCode)
    : DEFAULT_SSH_RETRY_PROBE.expectExitCodeDefault;
  const expectStdoutContains = String(rec.expectStdoutContains ?? "").trim();
  return {
    template,
    expectExitCode,
    expectStdoutContains: expectStdoutContains || undefined,
    onMatch: String(rec.onMatch ?? "").trim() || DEFAULT_SSH_RETRY_PROBE.onMatchDefault,
    onMismatch:
      String(rec.onMismatch ?? "").trim() || DEFAULT_SSH_RETRY_PROBE.onMismatchDefault,
    onError: String(rec.onError ?? "").trim() || DEFAULT_SSH_RETRY_PROBE.onError,
  };
}

export function validateSshVerificationSpec(input: {
  retrySafe?: boolean;
  verification?: unknown;
}): string[] {
  const retrySafe = input.retrySafe === true;
  const parsed = parseSshVerificationSpec(input.verification);
  const hasProbe = Boolean(parsed?.template.trim());
  if (retrySafe && !hasProbe) {
    return [SSH_INVALID_VERIFICATION_MESSAGE];
  }
  if (!retrySafe && hasProbe) {
    return [SSH_INVALID_VERIFICATION_MESSAGE];
  }
  if (parsed && parsed.onError !== SSH_VERIFY_INDETERMINATE) {
    return ["verification.onError must be indeterminate."];
  }
  return [];
}

/**
 * Parse GET /ssh/catalog (or ops-config `sshEngine`) retry.ui + retry.probe.
 */
export function parseSshRetryCatalog(raw: unknown): SshRetryCatalog {
  if (!raw || typeof raw !== "object") {
    return { ...SSH_RETRY_UNAVAILABLE_CATALOG };
  }
  const rec = raw as Record<string, unknown>;
  const nested =
    rec.sshEngine && typeof rec.sshEngine === "object" && !Array.isArray(rec.sshEngine)
      ? (rec.sshEngine as Record<string, unknown>)
      : rec;
  const retryRaw =
    nested.retry && typeof nested.retry === "object" && !Array.isArray(nested.retry)
      ? (nested.retry as Record<string, unknown>)
      : rec.retry && typeof rec.retry === "object" && !Array.isArray(rec.retry)
        ? (rec.retry as Record<string, unknown>)
        : {};
  const errorsRaw = Array.isArray(nested.errors)
    ? nested.errors
    : Array.isArray(rec.errors)
      ? rec.errors
      : [];
  const errors = errorsRaw
    .map(parseRetryError)
    .filter((item): item is SshRetryErrorShape => item !== null);
  const hasRetry =
    retryRaw.defaultMaxAttempts !== undefined ||
    retryRaw.retrySafeFlag !== undefined ||
    typeof retryRaw.semantics === "string" ||
    retryRaw.ui !== undefined ||
    retryRaw.probe !== undefined;
  if (!hasRetry && errors.length === 0) {
    return { ...SSH_RETRY_UNAVAILABLE_CATALOG };
  }
  const source: SshRetryCatalogSource =
    rec.sshEngine && typeof rec.sshEngine === "object"
      ? "ops-config-catalog"
      : hasRetry
        ? "ssh-catalog"
        : "unavailable";
  return {
    source,
    defaultMaxAttempts: finiteInteger(
      retryRaw.defaultMaxAttempts,
      SSH_DEFAULT_RETRY_MAX_ATTEMPTS,
    ),
    maxAttempts: finiteInteger(retryRaw.maxAttempts, SSH_MAX_RETRY_ATTEMPTS),
    retrySafeFlag: String(retryRaw.retrySafeFlag ?? "").trim() || SSH_RETRY_SAFE_FLAG,
    retrySafeDefault: false,
    semantics: String(retryRaw.semantics ?? "").trim() || SSH_RETRY_SEMANTICS,
    note: String(retryRaw.note ?? "").trim() || SSH_RETRY_ZERO_MESSAGE,
    blindRetry: false,
    leaseLossOutcome: String(retryRaw.leaseLossOutcome ?? "").trim() || "indeterminate",
    unknownOutcome: String(retryRaw.unknownOutcome ?? "").trim() || "indeterminate",
    requiresVerificationWhenRetrySafe: retryRaw.requiresVerificationWhenRetrySafe !== false,
    verification:
      String(retryRaw.verification ?? "").trim() || SSH_VERIFICATION_CONTRACT,
    whenRetryAllowed:
      String(retryRaw.whenRetryAllowed ?? "").trim() ||
      SSH_RETRY_UNAVAILABLE_CATALOG.whenRetryAllowed,
    ui: parseRetryUI(retryRaw.ui),
    probe: parseRetryProbe(retryRaw.probe),
    errors: errors.length ? overlayRetryErrorMeanings(errors) : DEFAULT_SSH_RETRY_ERRORS,
    notes:
      String(nested.notes ?? rec.notes ?? "").trim() ||
      (source === "unavailable" ? ENGINE_CATALOG_UNAVAILABLE_HELP : undefined),
  };
}

export function sshRetryPolicyFromWith(withValue: Record<string, unknown>): {
  maxAttempts: number;
  error?: string;
} {
  if (withValue.retryPolicy === undefined || withValue.retryPolicy === "") {
    return { maxAttempts: SSH_DEFAULT_RETRY_MAX_ATTEMPTS };
  }
  if (
    !withValue.retryPolicy ||
    typeof withValue.retryPolicy !== "object" ||
    Array.isArray(withValue.retryPolicy)
  ) {
    return {
      maxAttempts: SSH_DEFAULT_RETRY_MAX_ATTEMPTS,
      error: "retryPolicy must be an object.",
    };
  }
  const rec = withValue.retryPolicy as Record<string, unknown>;
  if (rec.maxAttempts === undefined || rec.maxAttempts === "") {
    return { maxAttempts: SSH_DEFAULT_RETRY_MAX_ATTEMPTS };
  }
  const maxAttempts = Number(rec.maxAttempts);
  if (
    !Number.isInteger(maxAttempts) ||
    maxAttempts < SSH_DEFAULT_RETRY_MAX_ATTEMPTS ||
    maxAttempts > SSH_MAX_RETRY_ATTEMPTS
  ) {
    return {
      maxAttempts: SSH_DEFAULT_RETRY_MAX_ATTEMPTS,
      error: `retryPolicy.maxAttempts must be between ${SSH_DEFAULT_RETRY_MAX_ATTEMPTS} and ${SSH_MAX_RETRY_ATTEMPTS}.`,
    };
  }
  return { maxAttempts };
}

export function validateSshRetryPolicy(input: {
  maxAttempts?: unknown;
  profileRetrySafe?: boolean;
  verificationDeclared?: boolean;
  withValue?: Record<string, unknown>;
}): SshRetryValidation {
  const parsed = input.withValue
    ? sshRetryPolicyFromWith(input.withValue)
    : parseMaxAttempts(input.maxAttempts);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (parsed.error) {
    errors.push(parsed.error);
  }
  const retrySafe = input.profileRetrySafe === true;
  const verified = input.verificationDeclared === true;
  if (parsed.maxAttempts > SSH_DEFAULT_RETRY_MAX_ATTEMPTS && !(retrySafe && verified)) {
    errors.push(SSH_RETRY_DENIED_MESSAGE);
    if (retrySafe && !verified) {
      errors.push(SSH_INVALID_VERIFICATION_MESSAGE);
    }
    warnings.push(SSH_RETRY_DENIED_MESSAGE);
  } else if (parsed.maxAttempts > SSH_DEFAULT_RETRY_MAX_ATTEMPTS) {
    warnings.push(
      "maxAttempts>0 is allowed only because the selected profile is retrySafe and declares verification. A later retry still runs the probe first — this is not a blind auto-retry.",
    );
  }
  return {
    ok: errors.length === 0,
    maxAttempts: parsed.maxAttempts,
    errors: [...new Set(errors)],
    warnings,
  };
}

/** Always false. Lease loss / unsafe SSH never invites a silent re-run. */
export function canBlindRetrySsh(input: {
  status?: ExecutionStatus | string;
  nodeType?: string;
  errorCode?: string;
} = {}): false {
  void input;
  return false;
}

export function parseSshRetryResult(
  ...bags: unknown[]
): SshRetryResult | null {
  for (const bag of bags) {
    const rec = asRecord(bag);
    const retry =
      asRecord(rec?.retry) ??
      asRecord(asRecord(rec?.result)?.retry) ??
      asRecord(asRecord(rec?.error)?.retry);
    if (!retry) {
      continue;
    }
    const verification = asRecord(retry.verification);
    return {
      maxAttempts: finiteInteger(retry.maxAttempts, SSH_DEFAULT_RETRY_MAX_ATTEMPTS),
      executedAttempts: finiteInteger(retry.executedAttempts, 0),
      retrySafe: retry.retrySafe === true,
      allowed: retry.allowed === true,
      requiresVerification: retry.requiresVerification !== false,
      verificationDeclared: retry.verificationDeclared === true,
      semantics: String(retry.semantics ?? "").trim() || SSH_RETRY_SEMANTICS,
      note: String(retry.note ?? "").trim(),
      verificationOutcome: String(verification?.outcome ?? "").trim() || undefined,
    };
  }
  return null;
}

export function sshRetryAllowed(input: {
  output?: unknown;
  error?: unknown;
  input?: unknown;
  evaluation?: SshEvaluateRetry | null;
}): boolean {
  const fromResult = parseSshRetryResult(input.output, input.error, input.input);
  if (fromResult) {
    return fromResult.allowed === true;
  }
  return input.evaluation?.retryAllowed === true;
}

export function canOfferSshRetry(input: {
  permissions?: readonly string[] | null;
  nodeType?: string;
  status?: string;
  output?: unknown;
  error?: unknown;
  input?: unknown;
  evaluation?: SshEvaluateRetry | null;
}): boolean {
  if (input.permissions != null && !input.permissions.includes("workflow.execute")) {
    return false;
  }
  if (!isSshRunType(input.nodeType) && !parseSshRetryResult(input.output, input.error)) {
    return false;
  }
  return sshRetryAllowed(input);
}

export function parseSshEvaluateRetry(raw: unknown): SshEvaluateRetry[] {
  const rec = asRecord(raw);
  const operations = Array.isArray(rec?.operations)
    ? rec.operations
    : Array.isArray(raw)
      ? raw
      : [];
  const out: SshEvaluateRetry[] = [];
  for (const item of operations) {
    const row = asRecord(item);
    if (!row) {
      continue;
    }
    const operation = String(row.operation ?? "").trim();
    if (operation && operation !== SSH_RUN_NODE_TYPE && !operation.startsWith("ssh.")) {
      continue;
    }
    out.push({
      nodeId: String(row.nodeId ?? "").trim(),
      operation: operation || SSH_RUN_NODE_TYPE,
      retrySafe: row.retrySafe === true,
      retryMaxAttempts: finiteInteger(row.retryMaxAttempts, SSH_DEFAULT_RETRY_MAX_ATTEMPTS),
      retryAllowed: row.retryAllowed === true,
      verificationDeclared: row.verificationDeclared === true,
    });
  }
  return out;
}

export function isSshRunStep(step: {
  nodeType?: string;
  output?: unknown;
  input?: unknown;
  error?: unknown;
}): boolean {
  if (isSshRunType(step.nodeType)) {
    return true;
  }
  const bag = mergeBags(asRecord(step.output), asRecord(step.input), asRecord(step.error));
  return (
    isSshRunType(String(bag.type ?? bag.nodeType ?? "")) ||
    typeof bag.sshTargetId === "string" ||
    typeof bag.commandProfileId === "string"
  );
}

export function executionHasSshRun(
  steps: readonly { nodeType?: string; output?: unknown; input?: unknown; error?: unknown }[] = [],
): boolean {
  return steps.some((step) => isSshRunStep(step));
}

export function executionHasSshIndeterminate(
  steps: readonly {
    status?: string;
    nodeType?: string;
    output?: unknown;
    input?: unknown;
    error?: unknown;
  }[] = [],
): boolean {
  return steps.some(
    (step) => isIndeterminateStatus(step.status) && isSshRunStep(step),
  );
}

export function sshIndeterminateCopy(input: {
  status?: string;
  nodeType?: string;
  errorCode?: string;
  verificationOutcome?: string;
} = {}): string {
  if (input.verificationOutcome === SSH_VERIFY_ALREADY_APPLIED) {
    return "Verification matched already-applied. The mutating command was not re-run.";
  }
  if (input.verificationOutcome === SSH_VERIFY_SAFE_TO_RETRY) {
    return "Verification reported safe-to-retry. Another mutating attempt may run after the probe.";
  }
  return SSH_INDETERMINATE_LEASE_LOSS_HELP;
}

export function sshRetryBlockedMessage(input: {
  status?: string;
  nodeType?: string;
  steps?: readonly { status?: string; nodeType?: string; output?: unknown; error?: unknown }[];
  output?: unknown;
  error?: unknown;
  catalog?: SshRetryCatalog | null;
} = {}): string {
  const retry = parseSshRetryResult(input.output, input.error);
  if (retry?.allowed) {
    return `${SSH_NO_BLIND_RETRY_HELP} result.retry.allowed is true — Retry queues a verify-first attempt.`;
  }
  if (isIndeterminateStatus(input.status)) {
    return `${SSH_INDETERMINATE_LEASE_LOSS_HELP} ${input.catalog?.ui.hideRetryWhen || DEFAULT_SSH_RETRY_UI.hideRetryWhen}.`;
  }
  return SSH_NO_BLIND_RETRY_HELP;
}

export function sshRetryPolicyHint(input: {
  profileRetrySafe?: boolean;
  verificationDeclared?: boolean;
  maxAttempts?: number;
  catalog?: SshRetryCatalog | null;
}): string {
  const retrySafe = input.profileRetrySafe === true;
  const verified = input.verificationDeclared === true;
  const maxAttempts =
    typeof input.maxAttempts === "number"
      ? input.maxAttempts
      : input.catalog?.defaultMaxAttempts ?? SSH_DEFAULT_RETRY_MAX_ATTEMPTS;
  if (!retrySafe) {
    return `retrySafe is false. maxAttempts stays ${SSH_DEFAULT_RETRY_MAX_ATTEMPTS}. ${SSH_RETRY_SAFE_HELP}`;
  }
  if (!verified) {
    return `retrySafe is true but verification is missing. ${SSH_INVALID_VERIFICATION_MESSAGE}`;
  }
  return `retrySafe is true and verification is declared. maxAttempts is ${maxAttempts}. ${input.catalog?.note || SSH_RETRY_ZERO_MESSAGE} ${SSH_INDETERMINATE_HELP}`;
}

export function sshVerificationOutcomeCopy(outcome?: string): string {
  if (outcome === SSH_VERIFY_ALREADY_APPLIED) {
    return "already-applied — probe matched; the mutating command was not repeated.";
  }
  if (outcome === SSH_VERIFY_SAFE_TO_RETRY) {
    return "safe-to-retry — probe did not match; one more mutating attempt may run.";
  }
  if (outcome === SSH_VERIFY_INDETERMINATE) {
    return "indeterminate — the probe failed or could not confirm state. Stay loud; do not re-run.";
  }
  return SSH_PROBE_HELP;
}

function parseMaxAttempts(value: unknown): {
  maxAttempts: number;
  error?: string;
} {
  if (value === undefined || value === "") {
    return { maxAttempts: SSH_DEFAULT_RETRY_MAX_ATTEMPTS };
  }
  const maxAttempts = Number(value);
  if (
    !Number.isInteger(maxAttempts) ||
    maxAttempts < SSH_DEFAULT_RETRY_MAX_ATTEMPTS ||
    maxAttempts > SSH_MAX_RETRY_ATTEMPTS
  ) {
    return {
      maxAttempts: SSH_DEFAULT_RETRY_MAX_ATTEMPTS,
      error: `retryPolicy.maxAttempts must be between ${SSH_DEFAULT_RETRY_MAX_ATTEMPTS} and ${SSH_MAX_RETRY_ATTEMPTS}.`,
    };
  }
  return { maxAttempts };
}

function parseRetryError(raw: unknown): SshRetryErrorShape | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const rec = raw as Record<string, unknown>;
  const code = String(rec.code ?? "").trim();
  if (!code) {
    return null;
  }
  return {
    code,
    status: Number.isFinite(Number(rec.status)) ? Number(rec.status) : 0,
    meaning: String(rec.meaning ?? "").trim() || code,
  };
}

function overlayRetryErrorMeanings(
  errors: SshRetryErrorShape[],
): SshRetryErrorShape[] {
  return errors.map((item) => {
    if (item.code === "retry-denied") {
      return { ...item, meaning: item.meaning || SSH_RETRY_DENIED_MESSAGE };
    }
    if (item.code === "invalid-verification") {
      return { ...item, meaning: item.meaning || SSH_INVALID_VERIFICATION_MESSAGE };
    }
    if (item.code === "indeterminate") {
      return { ...item, meaning: item.meaning || SSH_INDETERMINATE_LEASE_LOSS_HELP };
    }
    return item;
  });
}

function parseRetryUI(raw: unknown): SshRetryUI {
  const rec = asRecord(raw);
  if (!rec) {
    return DEFAULT_SSH_RETRY_UI;
  }
  return {
    indeterminateBadge:
      String(rec.indeterminateBadge ?? "").trim() || DEFAULT_SSH_RETRY_UI.indeterminateBadge,
    retrySafeFlag: String(rec.retrySafeFlag ?? "").trim() || SSH_RETRY_SAFE_FLAG,
    retryEnabledWhen:
      String(rec.retryEnabledWhen ?? "").trim() || DEFAULT_SSH_RETRY_UI.retryEnabledWhen,
    hideRetryWhen:
      String(rec.hideRetryWhen ?? "").trim() || DEFAULT_SSH_RETRY_UI.hideRetryWhen,
    neverAssumeAbsent: rec.neverAssumeAbsent !== false,
  };
}

function parseRetryProbe(raw: unknown): SshRetryProbe {
  const rec = asRecord(raw);
  if (!rec) {
    return DEFAULT_SSH_RETRY_PROBE;
  }
  const outcomes = Array.isArray(rec.outcomes)
    ? rec.outcomes.filter((item): item is string => typeof item === "string")
    : [...SSH_VERIFY_OUTCOMES];
  return {
    requiredWhenRetrySafe: rec.requiredWhenRetrySafe !== false,
    field: String(rec.field ?? "").trim() || SSH_VERIFICATION_FIELD,
    template: String(rec.template ?? "").trim() || DEFAULT_SSH_RETRY_PROBE.template,
    expectExitCodeDefault: finiteInteger(
      rec.expectExitCodeDefault,
      DEFAULT_SSH_RETRY_PROBE.expectExitCodeDefault,
    ),
    onMatchDefault:
      String(rec.onMatchDefault ?? "").trim() || DEFAULT_SSH_RETRY_PROBE.onMatchDefault,
    onMismatchDefault:
      String(rec.onMismatchDefault ?? "").trim() ||
      DEFAULT_SSH_RETRY_PROBE.onMismatchDefault,
    onError: String(rec.onError ?? "").trim() || DEFAULT_SSH_RETRY_PROBE.onError,
    outcomes: outcomes.length ? outcomes : SSH_VERIFY_OUTCOMES,
    note: String(rec.note ?? "").trim() || SSH_PROBE_HELP,
  };
}

function finiteInteger(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function mergeBags(
  ...bags: (Record<string, unknown> | null)[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const bag of bags) {
    if (bag) {
      Object.assign(out, bag);
    }
  }
  return out;
}
