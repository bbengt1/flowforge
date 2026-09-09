/**
 * Single retarget adapter for Chloe's E8.3 SSH indeterminate / retry
 * semantics UI. Prefer GET /ssh/catalog (`retry` / `errors[]`) plus
 * existing E5 executions (`GET /executions/{id}`). Do not invent
 * verify / resume routes. Do not change `apps/api`.
 *
 * Relates to #84 / Part of #81. Keep #84 open — jonny owns
 * indeterminate / retry semantics. Cookie session + `X-CSRF-Token`,
 * camelCase JSON, RFC 9457.
 *
 * Retarget here when jonny posts the E8.3 contract map. Until then
 * catalog overlays use marked `contract-fallback` for verification /
 * resume (no such route is listed on `main` after #86 / #88).
 */

import { isIndeterminateStatus } from "./execution.ts";
import type { ExecutionStatus } from "./execution-types.ts";

export const SSH_RETRY_STORY = 84;
export const SSH_RETRY_EPIC = 81;
/** Jonny's E8.3 map is not on main yet. */
export const SSH_RETRY_API_PR = 0;
export const SSH_RETRY_ROUTE_MAP_SOURCE = "e83-contract-fallback" as const;

export const SSH_RUN_NODE_TYPE = "ssh.run" as const;

export const SSH_DEFAULT_RETRY_MAX_ATTEMPTS = 0;
export const SSH_MAX_RETRY_ATTEMPTS = 5;
export const SSH_RETRY_SAFE_FLAG = "retrySafe" as const;
export const SSH_RETRY_SEMANTICS = "E8.3" as const;

export const SSH_RETRY_SAFE_HELP =
  "Mark retrySafe only when this profile has an idempotent verification path. Enabling it means a later ssh.run may retry after verification — never a blind repeat. Default is false. maxAttempts>0 on ssh.run requires retrySafe.";

export const SSH_RETRY_ZERO_MESSAGE =
  "Retries default to zero. Only a retrySafe command profile may set maxAttempts>0, and those retries still require verification.";

export const SSH_RETRY_DENIED_MESSAGE =
  "retryPolicy.maxAttempts>0 requires a retrySafe command profile with an idempotent verification path. Unsafe or unverified SSH operations must not retry.";

export const SSH_INDETERMINATE_HELP =
  "Lease loss after dispatch is indeterminate until an idempotent profile-specific verification confirms state. The engine never blindly repeats the command.";

export const SSH_INDETERMINATE_LEASE_LOSS_HELP =
  "Indeterminate SSH outcome — lease lost or unverified after dispatch. A remote side effect may have occurred. Do not assume the command did not run, and do not blindly retry.";

export const SSH_NO_BLIND_RETRY_HELP =
  "This UI never offers a blind retry for ssh.run. Retry is hidden for indeterminate and provider SSH steps (E5.2). Verification, when jonny lists it, is the only resume path.";

export const SSH_VERIFICATION_UNAVAILABLE_HELP =
  "Using marked e83-contract-fallback: GET /ssh/catalog does not yet list a verification or resume route. This UI does not invent one. Inspect diagnostics until jonny's E8.3 map lands.";

export const SSH_RETRY_CONTRACT_FALLBACK_HELP =
  "Using local E8.3 retry defaults because GET /ssh/catalog retry schema was unavailable. maxAttempts defaults to 0; retrySafe defaults to false; lease loss is indeterminate.";

export type SshRetryCatalogSource =
  | "ssh-catalog"
  | "ops-config-catalog"
  | "contract-fallback";

export type SshRetryErrorShape = {
  code: string;
  status: number;
  meaning: string;
};

export type SshRetryVerification = {
  available: boolean;
  path?: string;
  method?: string;
  note: string;
  source: SshRetryCatalogSource;
};

export type SshRetryCatalog = {
  source: SshRetryCatalogSource;
  defaultMaxAttempts: number;
  maxAttempts: number;
  retrySafeFlag: string;
  retrySafeDefault: false;
  semantics: string;
  note: string;
  verification: SshRetryVerification;
  errors: SshRetryErrorShape[];
  notes?: string;
};

export type SshRetryPolicy = {
  maxAttempts: number;
};

export type SshRetryValidation = {
  ok: boolean;
  maxAttempts: number;
  errors: string[];
  warnings: string[];
};

export const DEFAULT_SSH_RETRY_ERRORS: SshRetryErrorShape[] = [
  {
    code: "retry-denied",
    status: 400,
    meaning: SSH_RETRY_DENIED_MESSAGE,
  },
  {
    code: "indeterminate",
    status: 409,
    meaning: SSH_INDETERMINATE_LEASE_LOSS_HELP,
  },
];

export const SSH_RETRY_CONTRACT_FALLBACK_CATALOG: SshRetryCatalog = {
  source: "contract-fallback",
  defaultMaxAttempts: SSH_DEFAULT_RETRY_MAX_ATTEMPTS,
  maxAttempts: SSH_MAX_RETRY_ATTEMPTS,
  retrySafeFlag: SSH_RETRY_SAFE_FLAG,
  retrySafeDefault: false,
  semantics: SSH_RETRY_SEMANTICS,
  note: SSH_RETRY_ZERO_MESSAGE,
  verification: {
    available: false,
    note: SSH_VERIFICATION_UNAVAILABLE_HELP,
    source: "contract-fallback",
  },
  errors: DEFAULT_SSH_RETRY_ERRORS,
  notes: SSH_RETRY_CONTRACT_FALLBACK_HELP,
};

export function isSshRunType(type: string | undefined): boolean {
  return (type ?? "").trim() === SSH_RUN_NODE_TYPE;
}

export function commandProfileRetrySafe(
  spec: { retrySafe?: unknown } | null | undefined,
): boolean {
  return spec?.retrySafe === true;
}

export function defaultSshRetryPolicy(): SshRetryPolicy {
  return { maxAttempts: SSH_DEFAULT_RETRY_MAX_ATTEMPTS };
}

export function emptyCommandProfileRetrySafe(): false {
  return false;
}

/**
 * Parse GET /ssh/catalog (or ops-config `sshEngine`) retry schema.
 * Verification / resume stay unavailable unless the catalog lists a
 * concrete path — never invent a route.
 */
export function parseSshRetryCatalog(raw: unknown): SshRetryCatalog {
  if (!raw || typeof raw !== "object") {
    return { ...SSH_RETRY_CONTRACT_FALLBACK_CATALOG };
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
    typeof retryRaw.note === "string" ||
    retryRaw.verification !== undefined ||
    retryRaw.verify !== undefined ||
    retryRaw.resume !== undefined;
  if (!hasRetry && errors.length === 0) {
    return { ...SSH_RETRY_CONTRACT_FALLBACK_CATALOG };
  }
  const source: SshRetryCatalogSource =
    rec.sshEngine && typeof rec.sshEngine === "object"
      ? "ops-config-catalog"
      : hasRetry
        ? "ssh-catalog"
        : "contract-fallback";
  const verification = parseVerification(retryRaw, nested, rec, source);
  const defaultMaxAttempts = finiteInteger(
    retryRaw.defaultMaxAttempts,
    SSH_DEFAULT_RETRY_MAX_ATTEMPTS,
  );
  return {
    source,
    defaultMaxAttempts,
    maxAttempts: finiteInteger(retryRaw.maxAttempts, SSH_MAX_RETRY_ATTEMPTS),
    retrySafeFlag:
      String(retryRaw.retrySafeFlag ?? "").trim() || SSH_RETRY_SAFE_FLAG,
    retrySafeDefault: false,
    semantics: String(retryRaw.semantics ?? "").trim() || SSH_RETRY_SEMANTICS,
    note: String(retryRaw.note ?? "").trim() || SSH_RETRY_ZERO_MESSAGE,
    verification,
    errors: errors.length ? overlayRetryErrorMeanings(errors) : DEFAULT_SSH_RETRY_ERRORS,
    notes:
      String(nested.notes ?? rec.notes ?? "").trim() ||
      (source === "contract-fallback"
        ? SSH_RETRY_CONTRACT_FALLBACK_HELP
        : verification.available
          ? undefined
          : SSH_VERIFICATION_UNAVAILABLE_HELP),
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
  if (
    parsed.maxAttempts > SSH_DEFAULT_RETRY_MAX_ATTEMPTS &&
    input.profileRetrySafe !== true
  ) {
    errors.push(SSH_RETRY_DENIED_MESSAGE);
    warnings.push(SSH_RETRY_DENIED_MESSAGE);
  } else if (
    parsed.maxAttempts > SSH_DEFAULT_RETRY_MAX_ATTEMPTS &&
    input.profileRetrySafe === true
  ) {
    warnings.push(
      "maxAttempts>0 is allowed only because the selected profile is retrySafe. Retries still require verification — this is not a blind auto-retry.",
    );
  }
  return {
    ok: errors.length === 0,
    maxAttempts: parsed.maxAttempts,
    errors,
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

export function sshVerificationAvailable(
  catalog?: SshRetryCatalog | null,
): boolean {
  return catalog?.verification.available === true;
}

export function sshVerificationAction(catalog?: SshRetryCatalog | null): {
  available: boolean;
  path?: string;
  method?: string;
  note: string;
} {
  const verification =
    catalog?.verification ?? SSH_RETRY_CONTRACT_FALLBACK_CATALOG.verification;
  if (!verification.available || !verification.path || !verification.method) {
    return {
      available: false,
      note: verification.note || SSH_VERIFICATION_UNAVAILABLE_HELP,
    };
  }
  return {
    available: true,
    path: verification.path,
    method: verification.method,
    note: verification.note,
  };
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
} = {}): string {
  const ssh =
    isSshRunType(input.nodeType) ||
    input.errorCode === "indeterminate" ||
    input.errorCode === "lease-lost";
  if (isIndeterminateStatus(input.status) || ssh) {
    return SSH_INDETERMINATE_LEASE_LOSS_HELP;
  }
  return SSH_INDETERMINATE_HELP;
}

export function sshRetryBlockedMessage(input: {
  status?: string;
  nodeType?: string;
  steps?: readonly { status?: string; nodeType?: string }[];
  catalog?: SshRetryCatalog | null;
} = {}): string {
  const ssh =
    isSshRunType(input.nodeType) ||
    (input.steps ?? []).some((step) => isSshRunType(step.nodeType));
  const indeterminate =
    isIndeterminateStatus(input.status) ||
    (input.steps ?? []).some((step) => isIndeterminateStatus(step.status));
  if (indeterminate && ssh) {
    const verify = sshVerificationAction(input.catalog);
    if (verify.available) {
      return `${SSH_INDETERMINATE_LEASE_LOSS_HELP} ${verify.note}`;
    }
    return `${SSH_INDETERMINATE_LEASE_LOSS_HELP} ${SSH_NO_BLIND_RETRY_HELP}`;
  }
  if (indeterminate) {
    return SSH_INDETERMINATE_LEASE_LOSS_HELP;
  }
  if (ssh) {
    return SSH_NO_BLIND_RETRY_HELP;
  }
  return SSH_NO_BLIND_RETRY_HELP;
}

export function sshRetryPolicyHint(input: {
  profileRetrySafe?: boolean;
  maxAttempts?: number;
  catalog?: SshRetryCatalog | null;
}): string {
  const retrySafe = input.profileRetrySafe === true;
  const maxAttempts =
    typeof input.maxAttempts === "number"
      ? input.maxAttempts
      : input.catalog?.defaultMaxAttempts ?? SSH_DEFAULT_RETRY_MAX_ATTEMPTS;
  const catalogNote = input.catalog?.note;
  if (!retrySafe) {
    return `retrySafe is false on the selected profile. maxAttempts stays ${SSH_DEFAULT_RETRY_MAX_ATTEMPTS}. ${SSH_RETRY_SAFE_HELP}`;
  }
  return `retrySafe is true. maxAttempts is ${maxAttempts} (catalog default ${input.catalog?.defaultMaxAttempts ?? SSH_DEFAULT_RETRY_MAX_ATTEMPTS}). ${catalogNote || SSH_RETRY_ZERO_MESSAGE} ${SSH_INDETERMINATE_HELP}`;
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
    if (item.code === "retry-denied" && /E8\.2|still does not retry/i.test(item.meaning)) {
      return { ...item, meaning: SSH_RETRY_DENIED_MESSAGE };
    }
    if (item.code === "indeterminate" && /E8\.2|E8\.3 adds/i.test(item.meaning)) {
      return { ...item, meaning: SSH_INDETERMINATE_LEASE_LOSS_HELP };
    }
    return item;
  });
}

function parseVerification(
  retryRaw: Record<string, unknown>,
  nested: Record<string, unknown>,
  rec: Record<string, unknown>,
  source: SshRetryCatalogSource,
): SshRetryVerification {
  const candidate =
    asRecord(retryRaw.verification) ??
    asRecord(retryRaw.verify) ??
    asRecord(retryRaw.resume) ??
    asRecord(nested.verification) ??
    asRecord(rec.verification);
  const path = String(
    candidate?.path ??
      candidate?.href ??
      retryRaw.verifyPath ??
      retryRaw.resumePath ??
      "",
  ).trim();
  const method = String(candidate?.method ?? "").trim().toUpperCase();
  const availableFlag = candidate?.available === true;
  const listed = Boolean(path && method);
  if (!listed && !availableFlag) {
    return {
      available: false,
      note: SSH_VERIFICATION_UNAVAILABLE_HELP,
      source: source === "ssh-catalog" ? "ssh-catalog" : "contract-fallback",
    };
  }
  if (!listed) {
    return {
      available: false,
      note: SSH_VERIFICATION_UNAVAILABLE_HELP,
      source: "contract-fallback",
    };
  }
  return {
    available: true,
    path,
    method,
    note: String(candidate?.note ?? "").trim() ||
      "Catalog-listed verification. This UI does not blindly re-run the SSH command.",
    source,
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
