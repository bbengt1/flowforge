/**
 * Single retarget adapter for Chloe's E8.2 ssh.run node config
 * (library + wizard). Prefer GET /workflows/catalog + GET /ssh/catalog
 * `nodes[]` / `retry` / `errors[]` / `permissions[]` when present.
 * Fallback entries stay marked `contract-fallback` until jonny posts
 * the isolated ssh.run node map.
 *
 * Consume existing SSH-target + command-profile list + POST …/select
 * (E8.1). Do not invent routes. Do not change `apps/api`.
 *
 * Relates to #83 / Part of #81. Keep #83 open — jonny owns isolation
 * + tests. Cookie session + `X-CSRF-Token`, camelCase, RFC 9457.
 */

import { parseParameterSchema } from "./ssh.ts";
import { SSH_NOT_A_TERMINAL_HELP } from "./ssh-contract.ts";
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
  CatalogNodeBounds,
  CatalogNodePolicy,
  CatalogPort,
  CatalogRedaction,
  CatalogWithField,
  WorkflowCatalog,
} from "./workflow-types.ts";
import { isCatalogImplementationEnabled } from "./workflow.ts";

export const SSH_NODE_STORY = 83;
export const SSH_NODE_EPIC = 81;
/** Jonny's isolated ssh.run node map is not on main yet. */
export const SSH_NODE_API_PR = 0;
export const SSH_NODE_ROUTE_MAP_SOURCE = "e82-contract-fallback" as const;

export const SSH_RUN_NODE_TYPE = "ssh.run" as const;

export const SSH_DEFAULT_TIMEOUT_SECONDS = 60;
export const SSH_MIN_TIMEOUT_SECONDS = 1;
export const SSH_MAX_TIMEOUT_SECONDS = 3600;
export const SSH_DEFAULT_RETRY_MAX_ATTEMPTS = 0;

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
  "Execution uses ephemeral keys, verified known-host fingerprints, and host/address allowlists. Those gates are server-enforced.",
  "This is not an interactive terminal. Choose a published command profile with typed parameters — no arbitrary user shell.",
  "YAML stores sshTargetId, commandProfileId, parameter values, timeoutSeconds, and retryPolicy only. Never keys, passwords, host fingerprints, connection settings, or raw logs.",
  "Password authentication, agent forwarding, port forwarding, proxy commands, and host-key auto-acceptance are denied. The UI does not offer those toggles.",
  "Automatic retries default to zero. retrySafe is a read-only profile flag; bounded retry is E8.3.",
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

export const SSH_RETRY_ZERO_MESSAGE =
  "Automatic retries stay at zero until E8.3. retrySafe is a profile flag only.";

export const SSH_CONTRACT_FALLBACK_NODE_HELP =
  "Using the marked E8.2 contract-fallback ssh.run map because GET /ssh/catalog nodes[] is not available yet. Retarget ssh-node-contract.ts when jonny posts the node map.";

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
};

export type SshNodeCatalogSource =
  | "ssh-catalog"
  | "ops-config-catalog"
  | "contract-fallback";

export type SshNodeCatalog = {
  source: SshNodeCatalogSource;
  nodes: SshNodeEngineContract[];
  errors: SshNodeErrorShape[];
  retry: SshNodeRetryRules;
  permissions: string[];
  notes?: string;
};

export type SshNodeConfigContext = {
  targetSelectorClosed?: boolean;
  profileSelectorClosed?: boolean;
  parameterConstraints?: readonly SshParameterConstraint[];
  profileRetrySafe?: boolean;
  sshCatalog?: SshNodeCatalog | null;
};

export const DEFAULT_SSH_RETRY_RULES: SshNodeRetryRules = {
  defaultMaxAttempts: SSH_DEFAULT_RETRY_MAX_ATTEMPTS,
  retrySafeFlag: true,
  semantics: "E8.3",
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
    meaning: "Parameter values must match the pinned command-profile schema.",
  },
  {
    code: "interpolation-denied",
    status: 400,
    meaning: "Raw shell interpolation is denied. The reviewed renderer owns quoting.",
  },
  {
    code: "forbidden",
    status: 403,
    meaning: "Unauthorized or cross-workspace SSH targets and profiles fail closed.",
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
): readonly string[] {
  void catalog;
  return [...SSH_ACTION_TYPES];
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

export function defaultSshRetryPolicy(): { maxAttempts: number } {
  return { maxAttempts: SSH_DEFAULT_RETRY_MAX_ATTEMPTS };
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

export function sshNodeWithFields(
  type: string,
  sshCatalog?: SshNodeCatalog | null,
): SshNodeWithField[] {
  const engineNode = sshNodeContract(type, sshCatalog);
  if (engineNode?.allowedWith.length) {
    return overlaySshFields(engineNode.allowedWith, type);
  }
  if (!isSshConfigurableType(type)) {
    return [];
  }
  const retry = sshRetryRules(sshCatalog);
  return [
    {
      name: "sshTargetId",
      kind: "uuid",
      required: true,
      label: "SSH target",
      controlHint: "uuid",
      description:
        "Published workspace SSH target (display name + id). The target binds a vault credential. Never a private key.",
    },
    {
      name: "commandProfileId",
      kind: "uuid",
      required: true,
      label: "Command profile",
      controlHint: "uuid",
      description:
        "Published administrator-owned command profile. Typed parameters only — not a free-form shell.",
    },
    {
      name: "parameters",
      kind: "object",
      label: "Parameters",
      controlHint: "object-lines",
      description:
        "Typed profile parameter values. No raw shell, interpolation tokens, keys, or passwords.",
    },
    {
      name: "timeoutSeconds",
      kind: "integer",
      label: "Timeout (seconds)",
      controlHint: "number",
      defaultValue: SSH_DEFAULT_TIMEOUT_SECONDS,
      description: `Bounded command timeout (${SSH_MIN_TIMEOUT_SECONDS}–${SSH_MAX_TIMEOUT_SECONDS}). Default ${SSH_DEFAULT_TIMEOUT_SECONDS}.`,
    },
    {
      name: "retryPolicy",
      kind: "object",
      label: "Retry policy",
      controlHint: "text",
      defaultValue: defaultSshRetryPolicy(),
      readOnly: true,
      advanced: true,
      description: `${SSH_RETRY_ZERO_MESSAGE} Catalog retry.defaultMaxAttempts=${retry.defaultMaxAttempts}; semantics=${retry.semantics}.`,
    },
  ];
}

export function overlaySshFields(
  fields: CatalogWithField[],
  type: string,
): SshNodeWithField[] {
  const fallback = new Map(
    sshNodeWithFields(type).map((field) => [field.name, field]),
  );
  return fields
    .filter((field) => !sshForbiddenWithKeys({ [field.name]: true }).length)
    .map((field) => {
      const base = fallback.get(field.name);
      const controlHint =
        base?.controlHint ??
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
        enum: field.enum?.length ? field.enum : base?.enum,
        description: field.description || base?.description || "",
        label: base?.label || field.name,
        advanced: base?.advanced,
        readOnly: field.name === "retryPolicy" || base?.readOnly,
        controlHint,
        defaultValue:
          field.name === "retryPolicy"
            ? defaultSshRetryPolicy()
            : base?.defaultValue,
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

export function commandProfileRetrySafe(
  spec: { retrySafe?: unknown } | null | undefined,
): boolean {
  return spec?.retrySafe === true;
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

  const retryPolicy = retryPolicyFromWith(withValue);
  if (retryPolicy.error) {
    errors.push(retryPolicy.error);
  } else if (retryPolicy.maxAttempts !== SSH_DEFAULT_RETRY_MAX_ATTEMPTS) {
    errors.push(SSH_RETRY_ZERO_MESSAGE);
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
  return SSH_CONTRACT_FALLBACK[type] ?? thinFallback(type);
}

export function adaptSshNodeEntries(
  catalog: WorkflowCatalog | null | undefined,
  sshCatalog?: SshNodeCatalog | null,
): CatalogNode[] {
  return sshLibraryTypes(catalog).map((type) => {
    const listed = (catalog?.nodes ?? []).find((item) => item.type === type);
    const fallback = sshFallbackNode(type);
    const engine = sshNodeContract(type, sshCatalog);
    const engineAllowed = engine?.allowedWith.length
      ? engine.allowedWith
      : undefined;
    if (!listed) {
      if (!engine) {
        return fallback;
      }
      return {
        ...fallback,
        title: engine.title || fallback.title,
        description: engine.description || fallback.description,
        requiredWith: engine.requiredWith.length
          ? engine.requiredWith
          : fallback.requiredWith,
        allowedWith: engineAllowed ?? fallback.allowedWith,
      };
    }
    return {
      ...fallback,
      ...listed,
      title: listed.title || engine?.title || fallback.title,
      description:
        listed.description || engine?.description || fallback.description,
      inputs: listed.inputs?.length ? listed.inputs : fallback.inputs,
      outputs: listed.outputs?.length ? listed.outputs : fallback.outputs,
      requiredWith: listed.requiredWith?.length
        ? listed.requiredWith
        : engine?.requiredWith.length
          ? engine.requiredWith
          : fallback.requiredWith,
      allowedWith: listed.allowedWith?.length
        ? listed.allowedWith
        : engineAllowed ?? fallback.allowedWith,
      policy: listed.policy ?? fallback.policy,
      bounds: listed.bounds ?? fallback.bounds,
      redaction: listed.redaction ?? fallback.redaction,
    };
  });
}

export function parseSshNodeCatalog(raw: unknown): SshNodeCatalog {
  if (!raw || typeof raw !== "object") {
    return { ...SSH_NODE_CONTRACT_FALLBACK_CATALOG };
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
  const hasNodeMap = nodes.length > 0;
  const hasRetry =
    retryRaw.defaultMaxAttempts !== undefined ||
    retryRaw.retrySafeFlag !== undefined ||
    typeof retryRaw.semantics === "string";
  if (!hasNodeMap && !hasRetry && errors.length === 0 && permissions.length === 0) {
    return { ...SSH_NODE_CONTRACT_FALLBACK_CATALOG };
  }
  const source: SshNodeCatalogSource =
    rec.sshEngine && typeof rec.sshEngine === "object"
      ? "ops-config-catalog"
      : hasNodeMap
        ? "ssh-catalog"
        : "contract-fallback";
  return {
    source,
    nodes: hasNodeMap ? nodes : SSH_NODE_CONTRACT_FALLBACK_CATALOG.nodes,
    errors: errors.length ? errors : DEFAULT_SSH_NODE_ERRORS,
    retry: {
      defaultMaxAttempts:
        Number.isFinite(Number(retryRaw.defaultMaxAttempts))
          ? Number(retryRaw.defaultMaxAttempts)
          : SSH_DEFAULT_RETRY_MAX_ATTEMPTS,
      retrySafeFlag: retryRaw.retrySafeFlag !== false,
      semantics: String(retryRaw.semantics ?? "").trim() || "E8.3",
    },
    permissions: permissions.length ? permissions : [...SSH_NODE_PERMISSIONS],
    notes:
      String(nested.notes ?? rec.notes ?? "").trim() ||
      (hasNodeMap ? undefined : SSH_CONTRACT_FALLBACK_NODE_HELP),
  };
}

export const SSH_NODE_CONTRACT_FALLBACK_CATALOG: SshNodeCatalog = {
  source: "contract-fallback",
  nodes: [
    {
      type: SSH_RUN_NODE_TYPE,
      title: "Run command profile",
      description:
        "Run a published SSH command profile on a published workspace target. Not an interactive terminal.",
      permissions: [...SSH_NODE_PERMISSIONS],
      requiredWith: ["sshTargetId", "commandProfileId"],
      allowedWith: [],
      outputs: ["result", "stdout", "exitCode"],
      sideEffects: true,
      retrySafe: false,
      defaultMaxAttempts: SSH_DEFAULT_RETRY_MAX_ATTEMPTS,
    },
  ],
  errors: DEFAULT_SSH_NODE_ERRORS,
  retry: DEFAULT_SSH_RETRY_RULES,
  permissions: [...SSH_NODE_PERMISSIONS],
  notes: SSH_CONTRACT_FALLBACK_NODE_HELP,
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function inherit(
  name: string,
  kind: string,
  required: boolean,
  description: string,
): CatalogPort {
  return {
    name,
    kind,
    required,
    classification: "internal",
    maxBytes: 16 * 1024,
    description,
  };
}

function sshPolicy(): CatalogNodePolicy {
  return {
    permissions: [...SSH_NODE_PERMISSIONS],
    retrySafe: false,
    sideEffects: true,
    idempotent: false,
    cancellation: "stop-wait",
    verification: "none",
    defaultMaxAttempts: SSH_DEFAULT_RETRY_MAX_ATTEMPTS,
  };
}

function defaultBounds(): CatalogNodeBounds {
  return {
    maxInputBytes: 16 * 1024,
    maxOutputBytes: 64 * 1024,
    maxWithBytes: 16 * 1024,
    maxAggregationItems: SSH_MAX_PARAMETERS,
    maxDurationSeconds: SSH_MAX_TIMEOUT_SECONDS,
  };
}

function redaction(auditFields: string[]): CatalogRedaction {
  return {
    auditFields,
    redactInputs: true,
    redactOutputs: true,
    strategy: "drop-secrets",
  };
}

function fieldsToAllowed(type: string): CatalogWithField[] {
  return sshNodeWithFields(type).map((field) => ({
    name: field.name,
    kind: field.kind,
    required: field.required,
    enum: field.enum,
    description: field.description,
  }));
}

function thinFallback(type: string): CatalogNode {
  return {
    type,
    phase: CATALOG_PHASE_CORE,
    title: type,
    description: SSH_NOT_A_TERMINAL_HELP,
    inputs: [],
    outputs: [],
    requiredWith: ["sshTargetId", "commandProfileId"],
    allowedWith: fieldsToAllowed(type),
  };
}

const SSH_CONTRACT_FALLBACK: Record<string, CatalogNode> = {
  "ssh.run": {
    type: SSH_RUN_NODE_TYPE,
    phase: CATALOG_PHASE_CORE,
    title: "Run command profile",
    description:
      "Run a published SSH command profile on a published workspace target using ephemeral keys and known-host verification. Not an interactive terminal.",
    inputs: [
      inherit("parameters", "object", false, "Optional typed profile parameters."),
    ],
    outputs: [
      inherit("result", "object", false, "Redacted result object."),
      inherit("stdout", "string", false, "Redacted command output."),
      inherit("exitCode", "integer", false, "Process exit code."),
    ],
    requiredWith: ["sshTargetId", "commandProfileId"],
    allowedWith: fieldsToAllowed(SSH_RUN_NODE_TYPE),
    policy: sshPolicy(),
    bounds: defaultBounds(),
    redaction: redaction([
      "sshTargetId",
      "commandProfileId",
      "parameterNames",
      "timeoutSeconds",
      "retryPolicy",
      "exitCode",
      "correlationId",
    ]),
  },
};

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

function retryPolicyFromWith(withValue: Record<string, unknown>): {
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
    return { maxAttempts: SSH_DEFAULT_RETRY_MAX_ATTEMPTS, error: "retryPolicy must be an object." };
  }
  const rec = withValue.retryPolicy as Record<string, unknown>;
  if (rec.maxAttempts === undefined || rec.maxAttempts === "") {
    return { maxAttempts: SSH_DEFAULT_RETRY_MAX_ATTEMPTS };
  }
  const maxAttempts = Number(rec.maxAttempts);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 0) {
    return {
      maxAttempts: SSH_DEFAULT_RETRY_MAX_ATTEMPTS,
      error: "retryPolicy.maxAttempts must be a non-negative integer.",
    };
  }
  return { maxAttempts };
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
