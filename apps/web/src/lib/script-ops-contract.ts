/**
 * Single retarget adapter for Chloe's E9.4 revoke + emergency-stop UI.
 * Wired to jonny's **#103** map on `main` (`e94-#103`).
 *
 * Prefer existing routes — do not invent any:
 *   GET  /scripts/catalog                         `revocation` / `emergencyStop` / `errors[]`
 *   GET  /scripts/{id}                            `revokedAt` (never package/storageRef)
 *   POST /scripts/{id}/revoke                     `{reason?}` · `script.revoke` · idempotent
 *   POST /executions/{id}/emergency-stop          `{stepId?, uncertain?}` · `script.emergencyStop`
 *   POST /executions/{id}/steps/{stepId}/emergency-stop
 *
 * Cookie session + `X-CSRF-Token`. JSON camelCase. RFC 9457.
 * Host-supplied `id` / `workspaceId` → 400 UX. Relates to #95 / Part of #91.
 * Keep #95 open (this UI story). Do not change `apps/api`.
 */

import { isResourceId } from "./identity-proxy-ids.ts";
import {
  SCRIPT_ARTIFACT_SECRET_KEYS,
  hostSuppliedScriptIdentityKeys,
  parseScriptArtifact,
  type ScriptArtifact,
  type ScriptNodeErrorShape,
  type ScriptVersionPin,
} from "./script-contract.ts";
import { isScriptIoActionType } from "./script-io-contract.ts";

export const SCRIPT_OPS_STORY = 95;
export const SCRIPT_OPS_EPIC = 91;
/** Jonny's E9.4 revoke + emergency-stop map on main. */
export const SCRIPT_OPS_API_PR = 103;
export const SCRIPT_OPS_ROUTE_MAP_SOURCE = "e94-#103" as const;

export const SCRIPT_REVOKE_PERMISSION = "script.revoke" as const;
export const SCRIPT_EMERGENCY_STOP_PERMISSION = "script.emergencyStop" as const;
export const SCRIPT_REVOKE_ACTION = "revoke" as const;
export const SCRIPT_EMERGENCY_STOP_ACTION = "emergency-stop" as const;
export const SCRIPT_REVOKE_AUDIT = "script.artifact.revoke" as const;
export const SCRIPT_EMERGENCY_STOP_AUDIT = "script.emergency_stop" as const;
export const SCRIPT_OPS_MAX_REASON_BYTES = 256;
export const SCRIPT_OPS_POLICY_ALLOW_FIELD = "allowEmergencyStop" as const;

export const SCRIPT_OPS_CONTRACT_FALLBACK_HELP =
  "Using marked e94-#103 revoke/stop defaults because GET /scripts/catalog revocation / emergencyStop was unavailable. Prefer GET /scripts/catalog revocation + emergencyStop + errors[]. POST /scripts/{id}/revoke {reason?} requires script.revoke (idempotent, sets revokedAt). POST /executions/{id}/emergency-stop requires script.emergencyStop and is policy-gated (allowEmergencyStop; missing policy allows). Revoked artifacts cannot start (409 artifact-revoked at start/claim/heartbeat). Already-running runs are not auto-halted — use emergency stop. Queued → canceled; running/uncertain → loud indeterminate until verified. No blind retry after stop.";

export const SCRIPT_REVOKE_HELP =
  "Revoke is idempotent and requires script.revoke (operator/admin). It sets revokedAt. New starts fail closed with 409 artifact-revoked. Dispatch rechecks signature, scan, and revocation at start, claim, and heartbeat-before-dispatch. Already-running executions are not auto-halted — use emergency stop.";

export const SCRIPT_REVOKE_CONFIRM_HELP =
  "Revoking this digest blocks every new start that pins it. Already-running script steps keep running until an authorized emergency stop. Optional reason is secret-free and at most 256 bytes.";

export const SCRIPT_REVOKED_STATUS_HELP =
  "This artifact is revoked. It cannot start. Dispatch rechecks revokedAt and returns 409 artifact-revoked. Publish a new signed digest to run again — revocation is not undone from this UI.";

export const SCRIPT_REVOKED_RUN_BLOCK_HELP =
  "A pinned script artifact on this version is revoked. Run is blocked. New starts return 409 artifact-revoked. Emergency-stop any already-running script separately.";

export const SCRIPT_REVOKE_FORBIDDEN_MESSAGE =
  "Revoke requires script.revoke (operator/admin). HTTP 403 is fail-closed; the artifact is not treated as revoked.";

export const SCRIPT_EMERGENCY_STOP_HELP =
  "Emergency stop is distinct from Cancel. It requires script.emergencyStop and may be denied by a bound kind=script policy (allowEmergencyStop=false). Viewer → 403.";

export const SCRIPT_EMERGENCY_STOP_CONFIRM_HELP =
  "Queued or claimed (no heartbeat) stops become canceled — the runner never started. Running or uncertain provider outcome stays loud indeterminate until verified. Never assume the script did not run. This UI does not offer a blind retry after stop.";

export const SCRIPT_EMERGENCY_STOP_INDETERMINATE_HELP =
  "Emergency stop left an uncertain provider outcome. Status is indeterminate until verified. A side effect may have occurred. Do not assume the script did not run. Retry is hidden — never a blind re-run.";

export const SCRIPT_EMERGENCY_STOP_CANCELED_HELP =
  "Emergency stop halted the script before dispatch. The runner was not started. Status is canceled.";

export const SCRIPT_EMERGENCY_STOP_FORBIDDEN_MESSAGE =
  "Emergency stop requires script.emergencyStop (operator/admin) and an allowing kind=script policy. HTTP 403 is fail-closed; the run is not treated as stopped.";

export const SCRIPT_EMERGENCY_STOP_DENIED_MESSAGE =
  "Emergency stop was denied (403 emergency-stop-denied or policy allowEmergencyStop=false). The run is unchanged.";

export const SCRIPT_NO_BLIND_RETRY_AFTER_STOP_HELP =
  "This UI never offers a blind retry after emergency stop. Queued stops stay canceled. Running/uncertain stays indeterminate until a verification hook. POST …/retry is 409 retry-denied when closed.";

export const SCRIPT_OPS_AUDIT_SECRET_FREE_HELP =
  "Audit rows script.artifact.revoke and script.emergency_stop are secret-free (digest, actor, outcome). Package blobs, storageRef, and secrets are never shown.";

export type ScriptOpsCatalogSource =
  | "scripts-catalog"
  | "ops-config-catalog"
  | "contract-fallback";

export type ScriptRevocationRules = {
  permission: string;
  route: string;
  idempotent: boolean;
  blocksNewRuns: boolean;
  recheckOn: string[];
  failClosed: boolean;
  errorCode: string;
  auditAction: string;
  auditSecretFree: boolean;
  note: string;
};

export type ScriptEmergencyStopRules = {
  permission: string;
  route: string;
  policyGated: boolean;
  missingPolicyAllows: boolean;
  policyAllowField: string;
  uncertainOutcome: string;
  beforeDispatch: string;
  neverAssumeAbsent: boolean;
  states: string[];
  auditAction: string;
  auditSecretFree: boolean;
  denyWithoutPermission: string;
  note: string;
};

export type ScriptOpsCatalog = {
  source: ScriptOpsCatalogSource;
  revocation: ScriptRevocationRules;
  emergencyStop: ScriptEmergencyStopRules;
  errors: ScriptNodeErrorShape[];
  notes?: string;
};

export const DEFAULT_SCRIPT_OPS_ERRORS: ScriptNodeErrorShape[] = [
  {
    code: "artifact-revoked",
    status: 409,
    meaning:
      "Revoked artifacts cannot start. Rechecked at start, claim, heartbeat-before-dispatch, and Execute.",
  },
  {
    code: "emergency-stopped",
    status: 409,
    meaning: "Emergency stop halted the script before dispatch. The runner was not started.",
  },
  {
    code: "emergency-stop-denied",
    status: 403,
    meaning:
      "Missing script.emergencyStop or kind=script policy denies emergency stop (allowEmergencyStop=false).",
  },
  {
    code: "permission-denied",
    status: 403,
    meaning: "Missing script.revoke or script.emergencyStop.",
  },
  {
    code: "policy-denied",
    status: 403,
    meaning: "kind=script policy deny, including emergency-stop deny (allowEmergencyStop=false).",
  },
  {
    code: "indeterminate",
    status: 409,
    meaning:
      "Lease lost after dispatch, unknown provider outcome, uncertain emergency stop, or verification could not confirm state. Never a silent re-run.",
  },
];

export const DEFAULT_SCRIPT_REVOCATION: ScriptRevocationRules = {
  permission: SCRIPT_REVOKE_PERMISSION,
  route: "POST /scripts/{artifactId}/revoke",
  idempotent: true,
  blocksNewRuns: true,
  recheckOn: [
    "start",
    "claim",
    "heartbeat-before-dispatch",
    "Execute",
    "VerifyForDispatch",
  ],
  failClosed: true,
  errorCode: "artifact-revoked",
  auditAction: SCRIPT_REVOKE_AUDIT,
  auditSecretFree: true,
  note: SCRIPT_REVOKE_HELP,
};

export const DEFAULT_SCRIPT_EMERGENCY_STOP: ScriptEmergencyStopRules = {
  permission: SCRIPT_EMERGENCY_STOP_PERMISSION,
  route: "POST /executions/{executionId}/emergency-stop",
  policyGated: true,
  missingPolicyAllows: true,
  policyAllowField: `policy.${SCRIPT_OPS_POLICY_ALLOW_FIELD}`,
  uncertainOutcome: "indeterminate",
  beforeDispatch: "canceled",
  neverAssumeAbsent: true,
  states: ["queued", "running", "canceled", "indeterminate"],
  auditAction: SCRIPT_EMERGENCY_STOP_AUDIT,
  auditSecretFree: true,
  denyWithoutPermission: "403 permission-denied",
  note: SCRIPT_EMERGENCY_STOP_HELP,
};

export const SCRIPT_OPS_CONTRACT_FALLBACK_CATALOG: ScriptOpsCatalog = {
  source: "contract-fallback",
  revocation: DEFAULT_SCRIPT_REVOCATION,
  emergencyStop: DEFAULT_SCRIPT_EMERGENCY_STOP,
  errors: DEFAULT_SCRIPT_OPS_ERRORS,
  notes: SCRIPT_OPS_CONTRACT_FALLBACK_HELP,
};

export function scriptRevokePath(artifactId: string): string {
  return `/scripts/${artifactId}/${SCRIPT_REVOKE_ACTION}`;
}

export function executionEmergencyStopPath(executionId: string): string {
  return `/executions/${executionId}/${SCRIPT_EMERGENCY_STOP_ACTION}`;
}

export function executionStepEmergencyStopPath(
  executionId: string,
  stepId: string,
): string {
  return `/executions/${executionId}/steps/${stepId}/${SCRIPT_EMERGENCY_STOP_ACTION}`;
}

export const SCRIPT_OPS_EXISTING_API_PATHS = {
  scriptsCatalog: "/scripts/catalog",
  scriptArtifact: (artifactId: string) => `/scripts/${artifactId}`,
  revoke: scriptRevokePath,
  emergencyStop: executionEmergencyStopPath,
  stepEmergencyStop: executionStepEmergencyStopPath,
} as const;

export function retargetScriptOpsApiPath(uiApiPath: string): string {
  return uiApiPath;
}

export function isScriptOpsProxySegments(segments: string[]): boolean {
  if (
    segments.length === 3 &&
    segments[0] === "scripts" &&
    isResourceId(segments[1]) &&
    segments[2] === SCRIPT_REVOKE_ACTION
  ) {
    return true;
  }
  if (
    segments.length === 3 &&
    segments[0] === "executions" &&
    isResourceId(segments[1]) &&
    segments[2] === SCRIPT_EMERGENCY_STOP_ACTION
  ) {
    return true;
  }
  return (
    segments.length === 5 &&
    segments[0] === "executions" &&
    isResourceId(segments[1]) &&
    segments[2] === "steps" &&
    isResourceId(segments[3]) &&
    segments[4] === SCRIPT_EMERGENCY_STOP_ACTION
  );
}

export type ScriptOpsProxyRoute = {
  methods: readonly string[];
  match: (segments: string[]) => boolean;
};

export const SCRIPT_OPS_PROXY_ROUTES: readonly ScriptOpsProxyRoute[] = [
  {
    methods: ["POST"],
    match: (s) =>
      s.length === 3 &&
      s[0] === "scripts" &&
      isResourceId(s[1]) &&
      s[2] === SCRIPT_REVOKE_ACTION,
  },
  {
    methods: ["POST"],
    match: (s) =>
      s.length === 3 &&
      s[0] === "executions" &&
      isResourceId(s[1]) &&
      s[2] === SCRIPT_EMERGENCY_STOP_ACTION,
  },
  {
    methods: ["POST"],
    match: (s) =>
      s.length === 5 &&
      s[0] === "executions" &&
      isResourceId(s[1]) &&
      s[2] === "steps" &&
      isResourceId(s[3]) &&
      s[4] === SCRIPT_EMERGENCY_STOP_ACTION,
  },
];

export function parseScriptOpsCatalog(raw: unknown): ScriptOpsCatalog {
  if (!raw || typeof raw !== "object") {
    return { ...SCRIPT_OPS_CONTRACT_FALLBACK_CATALOG };
  }
  const rec = raw as Record<string, unknown>;
  const nested =
    rec.scriptEngine &&
    typeof rec.scriptEngine === "object" &&
    !Array.isArray(rec.scriptEngine)
      ? (rec.scriptEngine as Record<string, unknown>)
      : rec;
  const revocationRaw =
    nested.revocation &&
    typeof nested.revocation === "object" &&
    !Array.isArray(nested.revocation)
      ? (nested.revocation as Record<string, unknown>)
      : rec.revocation &&
          typeof rec.revocation === "object" &&
          !Array.isArray(rec.revocation)
        ? (rec.revocation as Record<string, unknown>)
        : null;
  const stopRaw =
    nested.emergencyStop &&
    typeof nested.emergencyStop === "object" &&
    !Array.isArray(nested.emergencyStop)
      ? (nested.emergencyStop as Record<string, unknown>)
      : rec.emergencyStop &&
          typeof rec.emergencyStop === "object" &&
          !Array.isArray(rec.emergencyStop)
        ? (rec.emergencyStop as Record<string, unknown>)
        : null;
  const errorsRaw = Array.isArray(nested.errors)
    ? nested.errors
    : Array.isArray(rec.errors)
      ? rec.errors
      : [];
  const errors = errorsRaw
    .map(parseOpsError)
    .filter((item): item is ScriptNodeErrorShape => item !== null);
  if (!revocationRaw && !stopRaw && errors.length === 0) {
    return { ...SCRIPT_OPS_CONTRACT_FALLBACK_CATALOG };
  }
  const source: ScriptOpsCatalogSource =
    rec.scriptEngine && typeof rec.scriptEngine === "object"
      ? "ops-config-catalog"
      : revocationRaw || stopRaw
        ? "scripts-catalog"
        : "contract-fallback";
  return {
    source,
    revocation: parseRevocation(revocationRaw),
    emergencyStop: parseEmergencyStop(stopRaw),
    errors: mergeOpsErrors(errors),
    notes:
      String(nested.notes ?? rec.notes ?? "").trim() ||
      (source === "contract-fallback" ? SCRIPT_OPS_CONTRACT_FALLBACK_HELP : undefined),
  };
}

export function scriptOpsCatalog(
  catalog?: ScriptOpsCatalog | null,
): ScriptOpsCatalog {
  return catalog ?? SCRIPT_OPS_CONTRACT_FALLBACK_CATALOG;
}

export function isArtifactRevoked(
  artifact?: Pick<ScriptArtifact, "revokedAt" | "status"> | null,
): boolean {
  if (!artifact) {
    return false;
  }
  if (String(artifact.status ?? "").trim().toLowerCase() === "revoked") {
    return true;
  }
  return Boolean(String(artifact.revokedAt ?? "").trim());
}

export function pinLooksRevoked(
  pin: ScriptVersionPin & { revokedAt?: string; status?: string },
  artifacts?: readonly ScriptArtifact[] | null,
): boolean {
  if (String(pin.revokedAt ?? "").trim()) {
    return true;
  }
  if (String(pin.status ?? "").trim().toLowerCase() === "revoked") {
    return true;
  }
  const match = (artifacts ?? []).find((item) => item.id === pin.artifactId);
  return isArtifactRevoked(match);
}

export function hasRevokedScriptPin(input: {
  pins?: readonly ScriptVersionPin[] | null;
  artifacts?: readonly ScriptArtifact[] | null;
}): boolean {
  return (input.pins ?? []).some((pin) => pinLooksRevoked(pin, input.artifacts));
}

export function canRevokeScriptArtifact(input: {
  permissions?: readonly string[] | null;
  artifact?: ScriptArtifact | null;
  catalog?: ScriptOpsCatalog | null;
}): boolean {
  const rules = scriptOpsCatalog(input.catalog).revocation;
  if (input.permissions != null && !input.permissions.includes(rules.permission)) {
    return false;
  }
  if (!input.artifact) {
    return false;
  }
  return !isArtifactRevoked(input.artifact);
}

export function canOfferScriptEmergencyStop(input: {
  permissions?: readonly string[] | null;
  status?: string;
  nodeType?: string;
  steps?: readonly { nodeType?: string; status?: string }[];
  catalog?: ScriptOpsCatalog | null;
}): boolean {
  const rules = scriptOpsCatalog(input.catalog).emergencyStop;
  if (
    input.permissions != null &&
    !input.permissions.includes(rules.permission)
  ) {
    return false;
  }
  const steps = input.steps?.length
    ? input.steps
    : input.nodeType
      ? [{ nodeType: input.nodeType, status: input.status }]
      : [];
  const scriptSteps = steps.filter((step) => isScriptIoActionType(step.nodeType ?? ""));
  if (scriptSteps.length === 0 && !isScriptIoActionType(input.nodeType ?? "")) {
    return false;
  }
  const open = [input.status, ...scriptSteps.map((step) => step.status)].some(
    (status) => isOpenScriptStopStatus(status),
  );
  return open;
}

export function isOpenScriptStopStatus(status?: string): boolean {
  const folded = String(status ?? "").trim().toLowerCase();
  return folded === "queued" || folded === "claimed" || folded === "running";
}

export function emergencyStopShouldMarkUncertain(status?: string): boolean {
  const folded = String(status ?? "").trim().toLowerCase();
  return folded === "running" || folded === "indeterminate";
}

export function emergencyStopExpectedOutcome(input: {
  status?: string;
  uncertain?: boolean;
  catalog?: ScriptOpsCatalog | null;
}): "canceled" | "indeterminate" {
  const rules = scriptOpsCatalog(input.catalog).emergencyStop;
  if (input.uncertain || emergencyStopShouldMarkUncertain(input.status)) {
    return rules.uncertainOutcome === "canceled" ? "canceled" : "indeterminate";
  }
  return rules.beforeDispatch === "indeterminate" ? "indeterminate" : "canceled";
}

export function canBlindRetryAfterEmergencyStop(): false {
  return false;
}

export function scriptEmergencyStopCopy(input: {
  outcome?: string;
  uncertain?: boolean;
  status?: string;
} = {}): string {
  if (
    input.uncertain ||
    input.outcome === "indeterminate" ||
    String(input.status ?? "").trim().toLowerCase() === "indeterminate"
  ) {
    return SCRIPT_EMERGENCY_STOP_INDETERMINATE_HELP;
  }
  if (input.outcome === "canceled") {
    return SCRIPT_EMERGENCY_STOP_CANCELED_HELP;
  }
  return SCRIPT_EMERGENCY_STOP_CONFIRM_HELP;
}

export function buildScriptRevokeBody(input: { reason?: string } = {}): Record<string, unknown> {
  const reason = String(input.reason ?? "").trim();
  return reason ? { reason } : {};
}

export function buildScriptEmergencyStopBody(input: {
  stepId?: string;
  uncertain?: boolean;
} = {}): Record<string, unknown> {
  return {
    ...(input.stepId?.trim() ? { stepId: input.stepId.trim() } : {}),
    ...(input.uncertain ? { uncertain: true } : {}),
  };
}

export function validateScriptRevokeReason(reason?: string): string[] {
  const value = String(reason ?? "");
  if (!value.trim()) {
    return [];
  }
  if (new TextEncoder().encode(value).length > SCRIPT_OPS_MAX_REASON_BYTES) {
    return [`reason must be at most ${SCRIPT_OPS_MAX_REASON_BYTES} bytes.`];
  }
  if (hostSuppliedScriptIdentityKeys({ reason: value }).length) {
    return ["reason cannot carry host-supplied identity."];
  }
  if (SCRIPT_ARTIFACT_SECRET_KEYS.some((key) => value.includes(key))) {
    return ["reason must be secret-free. Do not include package or storage locators."];
  }
  return [];
}

export function parseRevokedArtifact(raw: unknown): ScriptArtifact | null {
  return parseScriptArtifact(raw);
}

function parseRevocation(raw: Record<string, unknown> | null): ScriptRevocationRules {
  if (!raw) {
    return { ...DEFAULT_SCRIPT_REVOCATION };
  }
  return {
    permission: String(raw.permission ?? "").trim() || DEFAULT_SCRIPT_REVOCATION.permission,
    route: String(raw.route ?? "").trim() || DEFAULT_SCRIPT_REVOCATION.route,
    idempotent: raw.idempotent !== false,
    blocksNewRuns: raw.blocksNewRuns !== false,
    recheckOn: stringList(raw.recheckOn).length
      ? stringList(raw.recheckOn)
      : DEFAULT_SCRIPT_REVOCATION.recheckOn,
    failClosed: raw.failClosed !== false,
    errorCode: String(raw.errorCode ?? "").trim() || DEFAULT_SCRIPT_REVOCATION.errorCode,
    auditAction: String(raw.auditAction ?? "").trim() || DEFAULT_SCRIPT_REVOCATION.auditAction,
    auditSecretFree: raw.auditSecretFree !== false,
    note: String(raw.note ?? "").trim() || DEFAULT_SCRIPT_REVOCATION.note,
  };
}

function parseEmergencyStop(raw: Record<string, unknown> | null): ScriptEmergencyStopRules {
  if (!raw) {
    return { ...DEFAULT_SCRIPT_EMERGENCY_STOP };
  }
  return {
    permission:
      String(raw.permission ?? "").trim() || DEFAULT_SCRIPT_EMERGENCY_STOP.permission,
    route: String(raw.route ?? "").trim() || DEFAULT_SCRIPT_EMERGENCY_STOP.route,
    policyGated: raw.policyGated !== false,
    missingPolicyAllows: raw.missingPolicyAllows !== false,
    policyAllowField:
      String(raw.policyAllowField ?? "").trim() ||
      DEFAULT_SCRIPT_EMERGENCY_STOP.policyAllowField,
    uncertainOutcome:
      String(raw.uncertainOutcome ?? "").trim() ||
      DEFAULT_SCRIPT_EMERGENCY_STOP.uncertainOutcome,
    beforeDispatch:
      String(raw.beforeDispatch ?? "").trim() ||
      DEFAULT_SCRIPT_EMERGENCY_STOP.beforeDispatch,
    neverAssumeAbsent: raw.neverAssumeAbsent !== false,
    states: stringList(raw.states).length
      ? stringList(raw.states)
      : DEFAULT_SCRIPT_EMERGENCY_STOP.states,
    auditAction:
      String(raw.auditAction ?? "").trim() || DEFAULT_SCRIPT_EMERGENCY_STOP.auditAction,
    auditSecretFree: raw.auditSecretFree !== false,
    denyWithoutPermission:
      String(raw.denyWithoutPermission ?? "").trim() ||
      DEFAULT_SCRIPT_EMERGENCY_STOP.denyWithoutPermission,
    note: String(raw.note ?? "").trim() || DEFAULT_SCRIPT_EMERGENCY_STOP.note,
  };
}

function parseOpsError(raw: unknown): ScriptNodeErrorShape | null {
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
    status: Number.isFinite(Number(rec.status)) ? Number(rec.status) : 400,
    meaning: String(rec.meaning ?? rec.detail ?? "").trim(),
  };
}

function mergeOpsErrors(errors: ScriptNodeErrorShape[]): ScriptNodeErrorShape[] {
  const seen = new Set(errors.map((item) => item.code));
  return [
    ...errors,
    ...DEFAULT_SCRIPT_OPS_ERRORS.filter((item) => !seen.has(item.code)),
  ];
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}
