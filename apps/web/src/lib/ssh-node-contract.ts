/**
 * Single retarget adapter for Chloe's E8.2 ssh.run node config
 * (library + wizard). Wired to jonny's **#88** map on `main`:
 * GET /workflows/catalog (`allowedWith` / `policy` / `redaction`)
 * + GET /ssh/catalog (`nodes[]` / `retry` / `errors[]` / `isolation`).
 *
 * E8.3 retry / indeterminate semantics live in `ssh-retry-contract.ts`
 * (wired to jonny's #90 map: retry.ui / retry.probe / result.retry.allowed).
 *
 * Consume existing SSH-target + command-profile list + POST …/select
 * (E8.1). Empty or unauthorized catalogs fail closed (R3.4 / #249) —
 * no invented node types, ports, or config fields. Do not invent
 * routes. Do not change `apps/api`.
 *
 * Relates to #83 / Part of #81. Keep #83 open — jonny owns isolation
 * + tests. Relates to #249 / Part of #229. Keep #249 open.
 * Cookie session + `X-CSRF-Token`, camelCase, RFC 9457.
 */

import {
  CATALOG_SOURCE_UNAVAILABLE,
  ENGINE_CATALOG_UNAVAILABLE_HELP,
  isLiveCatalogSource,
} from "./catalog-fail-closed.ts";

import { parseParameterSchema } from "./ssh.ts";
import {
  SSH_DEFAULT_RETRY_MAX_ATTEMPTS,
  SSH_INDETERMINATE_HELP,
  SSH_RETRY_DENIED_MESSAGE,
  SSH_RETRY_ZERO_MESSAGE,
  defaultSshRetryPolicy,
  validateSshRetryPolicy,
} from "./ssh-retry-contract.ts";
import {
  SSH_ACTION_TYPES,
  SSH_MAX_PARAMETERS,
  SSH_PARAM_NAME_RE,
  SSH_TEMPLATE_FORBIDDEN_TOKENS,
  type SshParameterConstraint,
} from "./ssh-types.ts";
import { CATALOG_PHASE_CORE } from "./workflow-types.ts";
import type {
  CatalogNode,
  CatalogWithField,
  WorkflowCatalog,
} from "./workflow-types.ts";
import { isCatalogImplementationEnabled } from "./workflow.ts";

export {
  SSH_DEFAULT_RETRY_MAX_ATTEMPTS,
  SSH_INDETERMINATE_HELP,
  SSH_MAX_RETRY_ATTEMPTS,
  SSH_RETRY_DENIED_MESSAGE,
  SSH_RETRY_ZERO_MESSAGE,
  commandProfileRetrySafe,
  commandProfileVerificationDeclared,
  defaultSshRetryPolicy,
} from "./ssh-retry-contract.ts";

export const SSH_NODE_STORY = 83;
export const SSH_NODE_EPIC = 81;
/** Jonny's isolated ssh.run map on main. */
export const SSH_NODE_API_PR = 88;
export const SSH_NODE_ROUTE_MAP_SOURCE = "e82-#88" as const;

export const SSH_RUN_NODE_TYPE = "ssh.run" as const;

export const SSH_DEFAULT_TIMEOUT_SECONDS = 60;
export const SSH_MIN_TIMEOUT_SECONDS = 1;
export const SSH_MAX_TIMEOUT_SECONDS = 3600;
export const SSH_DEFAULT_USERNAME = "flowforge";

/** Never user-controlled. Stripped from wizard `with` before YAML insert. */
export const SSH_FORBIDDEN_WITH_KEYS = [
  "privateKey",
  "passphrase",
  "password",
  "command",
  "shell",
  "script",
  "hostKeyFingerprint",
  "knownHosts",
  "agentForwarding",
  "portForwarding",
  "proxyCommand",
  "autoAcceptHostKey",
  "strictHostKeyChecking",
] as const;

export const SSH_NODE_POLICY_NOTES = [
  "Ephemeral credential handle only. Vault privateKey is parsed into an in-memory signer. Handle JSON is {id, sshTargetId, credentialId?, username?, expiresAt} — never on the API, UI, or logs.",
  "Known-host fingerprint must match the pinned hostKeyFingerprint. Mismatch fails closed. Host-key auto-accept is disabled and is not a toggle.",
  "Every resolved address must be in the target allowedAddresses (and policy allowlist when present). A DNS name without an allowlist is denied.",
  "The worker dials only the verified ip:port. Dialing the original hostname is denied (anti DNS-rebinding / SSRF).",
  "Key-only authentication. Password, keyboard-interactive, agent forwarding, port forwarding, proxy commands, and interactive shells are hard-denied. The UI does not offer those toggles.",
  "Non-root remote account (default flowforge). root / toor / administrator are denied.",
  "This is not an interactive terminal. Choose a published command profile with typed parameters — no arbitrary user shell.",
  "YAML stores sshTargetId, commandProfileId, parameter values, timeoutSeconds, retryPolicy, and optional policyId only. Never keys, passwords, host fingerprints, connection settings, or raw logs.",
  "Retries default to zero. maxAttempts>0 requires a retrySafe profile with a declared verification probe. Lease loss is indeterminate — never a blind retry. Retry is shown only when result.retry.allowed is true.",
  "Selectors fail closed on HTTP 403. Only published workspace SSH targets and command profiles are listed.",
] as const;

export const SSH_TARGET_FAIL_CLOSED_MESSAGE =
  "SSH target selector failed closed. Only published workspace SSH targets are listed; unauthorized or cross-workspace targets are not shown.";

export const SSH_PROFILE_FAIL_CLOSED_MESSAGE =
  "Command profile selector failed closed. Only published workspace command profiles are listed; unauthorized or cross-workspace profiles are not shown.";

export const SSH_TARGET_REQUIRED_MESSAGE =
  "sshTargetId is required. Choose a published workspace SSH target.";

export const SSH_PROFILE_REQUIRED_MESSAGE =
  "commandProfileId is required. Choose a published command profile.";

export const SSH_SECRET_WITH_MESSAGE =
  "SSH keys, passwords, host fingerprints, connection settings, and raw logs cannot be stored in workflow YAML.";

export const SSH_FREEFORM_SHELL_MESSAGE =
  "ssh.run is not a free-form shell. Use a published command profile with typed parameters.";

export const SSH_CONTRACT_FALLBACK_NODE_HELP =
  "Using the marked e82-#88 ssh.run map because GET /ssh/catalog isolation/nodes[] was unavailable. Collections stay on /ssh-targets and /command-profiles.";

export type SshNodeWithField = CatalogWithField & {
  label: string;
  advanced?: boolean;
  readOnly?: boolean;
  controlHint: "text" | "textarea" | "enum" | "uuid" | "number" | "object-lines";
  defaultValue?: unknown;
};

export type SshNodeEngineContract = {
  type: string;
  title: string;
  description: string;
  permissions: string[];
  requiredWith: string[];
  allowedWith: CatalogWithField[];
  outputs: string[];
  sideEffects: boolean;
  retrySafe: boolean;
  defaultMaxAttempts: number;
};

export type SshNodeErrorShape = {
  code: string;
  status: number;
  meaning: string;
};

export type SshNodeRetryRules = {
  defaultMaxAttempts: number;
  retrySafeFlag: boolean;
  semantics: string;
  note?: string;
};

export type SshIsolationRules = {
  authMethods: readonly string[];
  passwordAuth: boolean;
  agentForwarding: boolean;
  portForwarding: boolean;
  proxyCommand: boolean;
  hostKeyAutoAccept: boolean;
  interactiveShell: boolean;
  knownHostVerification: string;
  resolveThenAllowlist: boolean;
  connectVerifiedAddressOnly: boolean;
  ephemeralCredentialHandle: boolean;
  nonRootRemoteAccount: boolean;
  defaultUsername: string;
  privateKeyNeverExported: boolean;
};

export type SshNodeCatalogSource =
  | "ssh-catalog"
  | "ops-config-catalog"
  | "unavailable";

export type SshNodeCatalog = {
  source: SshNodeCatalogSource;
  nodes: SshNodeEngineContract[];
  errors: SshNodeErrorShape[];
  retry: SshNodeRetryRules;
  permissions: string[];
  isolation?: SshIsolationRules;
  notes?: string;
};

export type SshNodeConfigContext = {
  targetSelectorClosed?: boolean;
  profileSelectorClosed?: boolean;
  verificationDeclared?: boolean;
  parameterConstraints?: readonly SshParameterConstraint[];
  profileRetrySafe?: boolean;
  sshCatalog?: SshNodeCatalog | null;
};

export const DEFAULT_SSH_RETRY_RULES: SshNodeRetryRules = {
  defaultMaxAttempts: SSH_DEFAULT_RETRY_MAX_ATTEMPTS,
  retrySafeFlag: true,
  semantics: "E8.3",
  note: SSH_RETRY_ZERO_MESSAGE,
};

export const DEFAULT_SSH_ISOLATION: SshIsolationRules = {
  authMethods: ["publickey"],
  passwordAuth: false,
  agentForwarding: false,
  portForwarding: false,
  proxyCommand: false,
  hostKeyAutoAccept: false,
  interactiveShell: false,
  knownHostVerification: "fingerprint-match-fail-closed",
  resolveThenAllowlist: true,
  connectVerifiedAddressOnly: true,
  ephemeralCredentialHandle: true,
  nonRootRemoteAccount: true,
  defaultUsername: SSH_DEFAULT_USERNAME,
  privateKeyNeverExported: true,
};

export const SSH_NODE_PERMISSIONS = [
  "workflow.execute",
  "ssh.run",
  "sshTarget.use",
  "commandProfile.use",
] as const;

export const DEFAULT_SSH_NODE_ERRORS: SshNodeErrorShape[] = [
  {
    code: "parameter-rejected",
    status: 400,
    meaning: "A parameter is missing, extra, or outside schema constraints.",
  },
  {
    code: "interpolation-denied",
    status: 400,
    meaning: "Raw shell interpolation is denied. The reviewed renderer owns quoting.",
  },
  {
    code: "retry-denied",
    status: 400,
    meaning: SSH_RETRY_DENIED_MESSAGE,
  },
  {
    code: "forbidden",
    status: 403,
    meaning: "Missing workflow.execute, ssh.run, sshTarget.use, or commandProfile.use.",
  },
  {
    code: "host-key-mismatch",
    status: 403,
    meaning: "Presented host key does not match the pinned fingerprint. Auto-accept is disabled.",
  },
  {
    code: "address-denied",
    status: 403,
    meaning: "A resolved address was outside allowedAddresses, or a DNS name had no allowlist.",
  },
  {
    code: "auth-denied",
    status: 403,
    meaning: "Password or keyboard-interactive authentication was requested. Key-only auth is required.",
  },
  {
    code: "forwarding-denied",
    status: 403,
    meaning: "Agent forwarding, port forwarding, proxy commands, or an interactive shell was requested.",
  },
  {
    code: "root-denied",
    status: 403,
    meaning: "Remote account is root (or another denied privileged name).",
  },
  {
    code: "handle-forbidden",
    status: 403,
    meaning: "Credential handle missing, expired, or unusable. privateKey is never accepted on the node.",
  },
  {
    code: "indeterminate",
    status: 409,
    meaning: SSH_INDETERMINATE_HELP,
  },
];

export function isSshRunType(type: string): boolean {
  return type === SSH_RUN_NODE_TYPE;
}

export function isSshConfigurableType(type: string): boolean {
  return (SSH_ACTION_TYPES as readonly string[]).includes(type);
}

export function sshLibraryTypes(
  catalog?: WorkflowCatalog | null,
  sshCatalog?: SshNodeCatalog | null,
): readonly string[] {
  const types = new Set<string>();
  for (const node of catalog?.nodes ?? []) {
    if (isSshConfigurableType(node.type) && isCatalogImplementationEnabled(node)) {
      types.add(node.type);
    }
  }
  if (sshCatalog && isLiveCatalogSource(sshCatalog.source)) {
    for (const node of sshCatalog.nodes) {
      if (isSshConfigurableType(node.type)) {
        types.add(node.type);
      }
    }
  }
  return [...types];
}

export function catalogListsSshType(
  catalog: WorkflowCatalog | null | undefined,
  type: string,
): boolean {
  return (catalog?.nodes ?? []).some(
    (item) => item.type === type && isCatalogImplementationEnabled(item),
  );
}

export function hasSshNodeContract(node: CatalogNode | undefined): boolean {
  return Boolean(
    node &&
      ((node.allowedWith && node.allowedWith.length > 0) ||
        node.policy ||
        node.bounds ||
        node.redaction),
  );
}

export function defaultSshWith(type: string): Record<string, unknown> {
  if (!isSshConfigurableType(type)) {
    return {};
  }
  return {
    timeoutSeconds: SSH_DEFAULT_TIMEOUT_SECONDS,
    retryPolicy: { maxAttempts: SSH_DEFAULT_RETRY_MAX_ATTEMPTS },
  };
}


export function sshNodeContract(
  type: string,
  catalog?: SshNodeCatalog | null,
): SshNodeEngineContract | undefined {
  return catalog?.nodes.find((item) => item.type === type);
}

export function sshNodeErrorShapes(
  catalog?: SshNodeCatalog | null,
): SshNodeErrorShape[] {
  return catalog?.errors ?? DEFAULT_SSH_NODE_ERRORS;
}

export function sshRetryRules(
  catalog?: SshNodeCatalog | null,
): SshNodeRetryRules {
  return catalog?.retry ?? DEFAULT_SSH_RETRY_RULES;
}

export function sshIsolationRules(
  catalog?: SshNodeCatalog | null,
): SshIsolationRules {
  return catalog?.isolation ?? DEFAULT_SSH_ISOLATION;
}

export function sshNodeWithFields(
  type: string,
  sshCatalog?: SshNodeCatalog | null,
): SshNodeWithField[] {
  const engineNode = sshNodeContract(type, sshCatalog);
  if (!engineNode?.allowedWith.length) {
    return [];
  }
  return overlaySshFields(engineNode.allowedWith, type);
}

function sshFieldChrome(name: string): Partial<SshNodeWithField> {
  switch (name) {
    case "sshTargetId":
      return { label: "SSH target", controlHint: "uuid" };
    case "commandProfileId":
      return { label: "Command profile", controlHint: "uuid" };
    case "parameters":
      return { label: "Parameters", controlHint: "object-lines" };
    case "timeoutSeconds":
      return {
        label: "Timeout (seconds)",
        controlHint: "number",
        defaultValue: SSH_DEFAULT_TIMEOUT_SECONDS,
      };
    case "retryPolicy":
      return {
        label: "Retry policy",
        controlHint: "text",
        defaultValue: defaultSshRetryPolicy(),
        advanced: true,
      };
    case "policyId":
      return { label: "Policy", controlHint: "uuid", advanced: true };
    default:
      return {};
  }
}

export function overlaySshFields(
  fields: CatalogWithField[],
  type: string,
): SshNodeWithField[] {
  void type;
  return fields
    .filter((field) => !sshForbiddenWithKeys({ [field.name]: true }).length)
    .map((field) => {
      const chrome = sshFieldChrome(field.name);
      const controlHint =
        chrome.controlHint ??
        (field.kind === "uuid"
          ? "uuid"
          : field.kind === "integer"
            ? "number"
            : field.kind === "object"
              ? "object-lines"
              : field.enum?.length
                ? "enum"
                : "text");
      return {
        name: field.name,
        kind: field.kind,
        required: field.required === true,
        enum: field.enum?.length ? field.enum : chrome.enum,
        description: field.description || chrome.description || "",
        label: chrome.label || field.name,
        advanced:
          field.name === "retryPolicy" ||
          field.name === "policyId" ||
          chrome.advanced,
        readOnly: chrome.readOnly,
        controlHint,
        defaultValue:
          field.name === "retryPolicy"
            ? defaultSshRetryPolicy()
            : chrome.defaultValue,
      };
    });
}

export function sshForbiddenWithKeys(
  value: Record<string, unknown>,
): string[] {
  return SSH_FORBIDDEN_WITH_KEYS.filter((key) => key in value);
}

export function stripSshForbiddenWith(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if ((SSH_FORBIDDEN_WITH_KEYS as readonly string[]).includes(key)) {
      continue;
    }
    out[key] = raw;
  }
  return out;
}

export function isExposedSshWithField(name: string): boolean {
  return !(SSH_FORBIDDEN_WITH_KEYS as readonly string[]).includes(name);
}

export function commandProfileParameterConstraints(
  spec: { parameterSchema?: unknown } | null | undefined,
): SshParameterConstraint[] {
  return parseParameterSchema(spec?.parameterSchema);
}


export function pruneSshParameters(
  parameters: Record<string, unknown> | undefined,
  constraints: readonly SshParameterConstraint[],
): Record<string, unknown> {
  if (!parameters) {
    return {};
  }
  if (constraints.length === 0) {
    return { ...parameters };
  }
  const allowed = new Set(constraints.map((item) => item.name));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parameters)) {
    if (allowed.has(key)) {
      out[key] = value;
    }
  }
  return out;
}

export function validateSshNodeConfig(
  type: string,
  withValue: Record<string, unknown>,
  context: SshNodeConfigContext = {},
): string[] {
  if (!isSshConfigurableType(type)) {
    return [];
  }
  const errors: string[] = [];
  if (context.targetSelectorClosed) {
    errors.push(SSH_TARGET_FAIL_CLOSED_MESSAGE);
  }
  if (context.profileSelectorClosed) {
    errors.push(SSH_PROFILE_FAIL_CLOSED_MESSAGE);
  }
  const forbidden = sshForbiddenWithKeys(withValue);
  if (forbidden.length > 0) {
    if (forbidden.some((key) => key === "command" || key === "shell" || key === "script")) {
      errors.push(SSH_FREEFORM_SHELL_MESSAGE);
    }
    if (
      forbidden.some(
        (key) =>
          key !== "command" && key !== "shell" && key !== "script",
      )
    ) {
      errors.push(SSH_SECRET_WITH_MESSAGE);
    }
  }

  const sshTargetId =
    typeof withValue.sshTargetId === "string" ? withValue.sshTargetId.trim() : "";
  if (!sshTargetId) {
    errors.push(SSH_TARGET_REQUIRED_MESSAGE);
  } else if (!UUID.test(sshTargetId)) {
    errors.push("sshTargetId must be a workspace UUID.");
  }

  const commandProfileId =
    typeof withValue.commandProfileId === "string"
      ? withValue.commandProfileId.trim()
      : "";
  if (!commandProfileId) {
    errors.push(SSH_PROFILE_REQUIRED_MESSAGE);
  } else if (!UUID.test(commandProfileId)) {
    errors.push("commandProfileId must be a workspace UUID.");
  }

  if (withValue.timeoutSeconds !== undefined) {
    const timeout = Number(withValue.timeoutSeconds);
    if (
      !Number.isFinite(timeout) ||
      timeout < SSH_MIN_TIMEOUT_SECONDS ||
      timeout > SSH_MAX_TIMEOUT_SECONDS
    ) {
      errors.push(
        `timeoutSeconds must be between ${SSH_MIN_TIMEOUT_SECONDS} and ${SSH_MAX_TIMEOUT_SECONDS}.`,
      );
    }
  }

  const retryPolicy = validateSshRetryPolicy({
    withValue,
    profileRetrySafe: context.profileRetrySafe,
    verificationDeclared: context.verificationDeclared,
  });
  errors.push(...retryPolicy.errors);

  if (withValue.policyId !== undefined && withValue.policyId !== "") {
    const policyId = String(withValue.policyId).trim();
    if (!UUID.test(policyId)) {
      errors.push("policyId must be a workspace UUID.");
    }
  }

  const parameters = asParameterObject(withValue.parameters);
  if (parameters.error) {
    errors.push(parameters.error);
  } else {
    errors.push(
      ...validateSshParameters(parameters.value, context.parameterConstraints ?? []),
    );
  }

  return unique(errors);
}

export function validateSshParameters(
  parameters: Record<string, unknown>,
  constraints: readonly SshParameterConstraint[],
): string[] {
  const errors: string[] = [];
  const keys = Object.keys(parameters);
  if (keys.length > SSH_MAX_PARAMETERS) {
    errors.push(`parameters exceeds ${SSH_MAX_PARAMETERS} items.`);
  }
  for (const [name, value] of Object.entries(parameters)) {
    if (!SSH_PARAM_NAME_RE.test(name)) {
      errors.push(`${name} must match [A-Za-z][A-Za-z0-9_]{0,31}.`);
    }
    if (typeof value === "string") {
      const hits = interpolationHits(value);
      if (hits.length > 0) {
        errors.push(
          `parameters.${name} must not use raw shell interpolation (${hits.join(", ")}).`,
        );
      }
      if (/(-----BEGIN |Bearer |ghp_|sk-|xox[baprs]-)/i.test(value)) {
        errors.push(SSH_SECRET_WITH_MESSAGE);
      }
    }
    if ((SSH_FORBIDDEN_WITH_KEYS as readonly string[]).includes(name)) {
      errors.push(SSH_SECRET_WITH_MESSAGE);
    }
  }
  if (constraints.length === 0) {
    return unique(errors);
  }
  const allowed = new Set(constraints.map((item) => item.name));
  for (const name of keys) {
    if (!allowed.has(name)) {
      errors.push(
        `parameters.${name} is not in the pinned command-profile schema.`,
      );
    }
  }
  for (const constraint of constraints) {
    const value = parameters[constraint.name];
    if (value === undefined || value === "") {
      if (constraint.required) {
        errors.push(`parameters.${constraint.name} is required.`);
      }
      continue;
    }
    errors.push(...validateConstraintValue(constraint, value));
  }
  return unique(errors);
}

export function sshFallbackNode(type: string): CatalogNode {
  return {
    type,
    phase: CATALOG_PHASE_CORE,
    title: type,
    description: ENGINE_CATALOG_UNAVAILABLE_HELP,
    inputs: [],
    outputs: [],
    requiredWith: [],
    allowedWith: [],
  };
}

export function adaptSshNodeEntries(
  catalog: WorkflowCatalog | null | undefined,
  sshCatalog?: SshNodeCatalog | null,
): CatalogNode[] {
  return sshLibraryTypes(catalog, sshCatalog).flatMap((type) => {
    const listed = (catalog?.nodes ?? []).find((item) => item.type === type);
    const engine = sshNodeContract(type, sshCatalog);
    if (!listed && !engine) {
      return [];
    }
    const engineAllowed = engine?.allowedWith.length
      ? engine.allowedWith
      : undefined;
    return [
      {
        type,
        phase: listed?.phase ?? CATALOG_PHASE_CORE,
        title: listed?.title || engine?.title || type,
        description: listed?.description || engine?.description || "",
        inputs: listed?.inputs ?? [],
        outputs: listed?.outputs ?? [],
        requiredWith: listed?.requiredWith?.length
          ? listed.requiredWith
          : engine?.requiredWith ?? [],
        allowedWith: listed?.allowedWith?.length
          ? listed.allowedWith
          : engineAllowed ?? [],
        policy: listed?.policy,
        bounds: listed?.bounds,
        redaction: listed?.redaction,
      },
    ];
  });
}

export function parseSshNodeCatalog(raw: unknown): SshNodeCatalog {
  if (!raw || typeof raw !== "object") {
    return { ...SSH_NODE_UNAVAILABLE_CATALOG };
  }
  const rec = raw as Record<string, unknown>;
  const nested =
    rec.sshEngine && typeof rec.sshEngine === "object" && !Array.isArray(rec.sshEngine)
      ? (rec.sshEngine as Record<string, unknown>)
      : rec;
  const nodesRaw = Array.isArray(nested.nodes)
    ? nested.nodes
    : Array.isArray(rec.nodes)
      ? rec.nodes
      : [];
  const nodes = nodesRaw
    .map(parseEngineNode)
    .filter((item): item is SshNodeEngineContract => item !== null);
  const errorsRaw = Array.isArray(nested.errors)
    ? nested.errors
    : Array.isArray(rec.errors)
      ? rec.errors
      : [];
  const errors = errorsRaw
    .map(parseEngineError)
    .filter((item): item is SshNodeErrorShape => item !== null);
  const retryRaw =
    nested.retry && typeof nested.retry === "object" && !Array.isArray(nested.retry)
      ? (nested.retry as Record<string, unknown>)
      : rec.retry && typeof rec.retry === "object" && !Array.isArray(rec.retry)
        ? (rec.retry as Record<string, unknown>)
        : {};
  const permissions = stringList(nested.permissions ?? rec.permissions);
  const isolation = parseIsolation(nested.isolation ?? rec.isolation);
  const hasNodeMap = nodes.length > 0;
  const hasRetry =
    retryRaw.defaultMaxAttempts !== undefined ||
    retryRaw.retrySafeFlag !== undefined ||
    typeof retryRaw.semantics === "string" ||
    typeof retryRaw.note === "string";
  const hasIsolation = isolation !== undefined;
  if (
    !hasNodeMap &&
    !hasRetry &&
    errors.length === 0 &&
    permissions.length === 0 &&
    !hasIsolation
  ) {
    return { ...SSH_NODE_UNAVAILABLE_CATALOG };
  }
  const source: SshNodeCatalogSource =
    rec.sshEngine && typeof rec.sshEngine === "object"
      ? "ops-config-catalog"
      : "ssh-catalog";
  return {
    source,
    nodes,
    errors,
    retry: {
      defaultMaxAttempts: Number.isFinite(Number(retryRaw.defaultMaxAttempts))
        ? Number(retryRaw.defaultMaxAttempts)
        : SSH_DEFAULT_RETRY_MAX_ATTEMPTS,
      retrySafeFlag: retryRaw.retrySafeFlag === true,
      semantics: String(retryRaw.semantics ?? "").trim(),
      note: String(retryRaw.note ?? "").trim(),
    },
    permissions,
    isolation,
    notes: String(nested.notes ?? rec.notes ?? "").trim() || undefined,
  };
}

export const SSH_NODE_UNAVAILABLE_CATALOG: SshNodeCatalog = {
  source: CATALOG_SOURCE_UNAVAILABLE,
  nodes: [],
  errors: [],
  retry: {
    defaultMaxAttempts: SSH_DEFAULT_RETRY_MAX_ATTEMPTS,
    retrySafeFlag: false,
    semantics: "",
    note: ENGINE_CATALOG_UNAVAILABLE_HELP,
  },
  permissions: [],
  notes: ENGINE_CATALOG_UNAVAILABLE_HELP,
};

/** @deprecated R3.4 — empty fail-closed catalog. Kept for import compatibility. */
export const SSH_NODE_CONTRACT_FALLBACK_CATALOG = SSH_NODE_UNAVAILABLE_CATALOG;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseEngineNode(raw: unknown): SshNodeEngineContract | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const rec = raw as Record<string, unknown>;
  const type = String(rec.type ?? "").trim();
  if (!isSshConfigurableType(type)) {
    return null;
  }
  const allowedWith = Array.isArray(rec.allowedWith)
    ? rec.allowedWith
        .map(parseAllowedField)
        .filter((item): item is CatalogWithField => item !== null)
    : [];
  return {
    type,
    title: String(rec.title ?? "").trim() || "Run command profile",
    description: String(rec.description ?? "").trim(),
    permissions: stringList(rec.permissions),
    requiredWith: stringList(rec.requiredWith),
    allowedWith,
    outputs: stringList(rec.outputs),
    sideEffects: rec.sideEffects !== false,
    retrySafe: rec.retrySafe === true,
    defaultMaxAttempts:
      Number.isFinite(Number(rec.defaultMaxAttempts))
        ? Number(rec.defaultMaxAttempts)
        : SSH_DEFAULT_RETRY_MAX_ATTEMPTS,
  };
}

function parseAllowedField(raw: unknown): CatalogWithField | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const rec = raw as Record<string, unknown>;
  const name = String(rec.name ?? "").trim();
  if (!name || !isExposedSshWithField(name)) {
    return null;
  }
  return {
    name,
    kind: String(rec.kind ?? "string"),
    required: rec.required === true,
    enum: stringList(rec.enum),
    description: String(rec.description ?? "").trim() || undefined,
  };
}

function parseEngineError(raw: unknown): SshNodeErrorShape | null {
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

function parseIsolation(raw: unknown): SshIsolationRules | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const rec = raw as Record<string, unknown>;
  const looksLike =
    typeof rec.knownHostVerification === "string" ||
    rec.ephemeralCredentialHandle !== undefined ||
    rec.connectVerifiedAddressOnly !== undefined ||
    rec.privateKeyNeverExported !== undefined;
  if (!looksLike) {
    return undefined;
  }
  return {
    authMethods: stringList(rec.authMethods).length
      ? stringList(rec.authMethods)
      : DEFAULT_SSH_ISOLATION.authMethods,
    passwordAuth: rec.passwordAuth === true,
    agentForwarding: rec.agentForwarding === true,
    portForwarding: rec.portForwarding === true,
    proxyCommand: rec.proxyCommand === true,
    hostKeyAutoAccept: rec.hostKeyAutoAccept === true,
    interactiveShell: rec.interactiveShell === true,
    knownHostVerification:
      String(rec.knownHostVerification ?? "").trim() ||
      DEFAULT_SSH_ISOLATION.knownHostVerification,
    resolveThenAllowlist: rec.resolveThenAllowlist !== false,
    connectVerifiedAddressOnly:
      rec.connectVerifiedAddressOnly !== false &&
      rec.connectVerifiedAddress !== false,
    ephemeralCredentialHandle: rec.ephemeralCredentialHandle !== false,
    nonRootRemoteAccount: rec.nonRootRemoteAccount !== false,
    defaultUsername:
      String(rec.defaultUsername ?? "").trim() || SSH_DEFAULT_USERNAME,
    privateKeyNeverExported: rec.privateKeyNeverExported !== false,
  };
}

function asParameterObject(value: unknown): {
  value: Record<string, unknown>;
  error?: string;
} {
  if (value === undefined || value === "") {
    return { value: {} };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { value: {}, error: "parameters must be a typed object." };
  }
  return { value: value as Record<string, unknown> };
}

function validateConstraintValue(
  constraint: SshParameterConstraint,
  value: unknown,
): string[] {
  const name = `parameters.${constraint.name}`;
  if (constraint.type === "boolean") {
    if (typeof value !== "boolean" && value !== "true" && value !== "false") {
      return [`${name} must be a boolean.`];
    }
    return [];
  }
  if (constraint.type === "integer") {
    const number = typeof value === "number" ? value : Number(value);
    if (!Number.isInteger(number)) {
      return [`${name} must be an integer.`];
    }
    if (typeof constraint.minimum === "number" && number < constraint.minimum) {
      return [`${name} must be ≥ ${constraint.minimum}.`];
    }
    if (typeof constraint.maximum === "number" && number > constraint.maximum) {
      return [`${name} must be ≤ ${constraint.maximum}.`];
    }
    if (constraint.enum?.length && !constraint.enum.includes(String(number))) {
      return [`${name} must be one of: ${constraint.enum.join(", ")}.`];
    }
    return [];
  }
  if (typeof value !== "string") {
    return [`${name} must be a string.`];
  }
  if (typeof constraint.minLength === "number" && value.length < constraint.minLength) {
    return [`${name} must be at least ${constraint.minLength} characters.`];
  }
  if (typeof constraint.maxLength === "number" && value.length > constraint.maxLength) {
    return [`${name} must be at most ${constraint.maxLength} characters.`];
  }
  if (constraint.enum?.length && !constraint.enum.includes(value)) {
    return [`${name} must be one of: ${constraint.enum.join(", ")}.`];
  }
  if (constraint.pattern) {
    try {
      if (!new RegExp(constraint.pattern).test(value)) {
        return [`${name} does not match the profile pattern.`];
      }
    } catch {
      return [`${name} profile pattern is invalid.`];
    }
  }
  return [];
}

function interpolationHits(value: string): string[] {
  const hits: string[] = [];
  for (const token of SSH_TEMPLATE_FORBIDDEN_TOKENS) {
    if (value.includes(token)) {
      hits.push(token === "$(" ? "$()" : token);
    }
  }
  return hits;
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

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
