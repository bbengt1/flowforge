/**
 * Single retarget adapter for Chloe's E9.1 script authoring / publish UI.
 *
 * jonny owns the publish/scan/sign/pin pipeline (#92). This file is the
 * only place to retarget when that route map lands. Do not invent routes.
 * Do not change `apps/api`.
 *
 * Existing collections this UI consumes (already on main):
 *   GET  /workflows/catalog
 *   GET  /runtime-profiles  + POST …/select
 *   PUT  /workflows/{id}/draft
 *   POST /workflows/{id}/publish
 *   GET  /workflows/{id}/versions[/{id}]
 *
 * Until jonny posts the map, catalog overlay and artifact-status fields
 * use the marked `e91-contract-fallback`. Cookie session + `X-CSRF-Token`,
 * camelCase JSON, RFC 9457. Relates to #92 / Part of #91. Keep #92 open.
 */

import { CATALOG_PHASE_CORE } from "./workflow-types.ts";
import type {
  CatalogNode,
  CatalogNodeBounds,
  CatalogNodePolicy,
  CatalogPort,
  CatalogRedaction,
  CatalogWithField,
  WorkflowCatalog,
  WorkflowVersion,
} from "./workflow-types.ts";
import { isCatalogImplementationEnabled } from "./workflow.ts";
import { isForbiddenYamlKey, looksLikeSecretValue } from "./workflow-yaml-nodes.ts";

export const SCRIPT_STORY = 92;
export const SCRIPT_EPIC = 91;
/** 0 until jonny posts the scan/sign/pin route map. */
export const SCRIPT_API_PR = 0;
export const SCRIPT_ROUTE_MAP_SOURCE = "e91-contract-fallback" as const;

export const SCRIPT_PYTHON_TYPE = "script.python" as const;
export const SCRIPT_GO_TYPE = "script.go" as const;
export const SCRIPT_ACTION_TYPES = [SCRIPT_PYTHON_TYPE, SCRIPT_GO_TYPE] as const;
export type ScriptActionType = (typeof SCRIPT_ACTION_TYPES)[number];

export const SCRIPT_DEFAULT_TIMEOUT_SECONDS = 30;
export const SCRIPT_MIN_TIMEOUT_SECONDS = 1;
export const SCRIPT_MAX_TIMEOUT_SECONDS = 3600;
export const SCRIPT_DEFAULT_MEMORY_MIB = 128;
export const SCRIPT_MIN_MEMORY_MIB = 32;
export const SCRIPT_MAX_MEMORY_MIB = 4096;
export const SCRIPT_DEFAULT_PYTHON_ENTRYPOINT = "main.py";
export const SCRIPT_DEFAULT_GO_ENTRYPOINT = "main.go";

export const SCRIPT_CONTRACT_FALLBACK_HELP =
  "Using the marked e91-contract-fallback script map because jonny has not posted the #92 scan/sign/pin route map. Collections stay on /workflows/catalog, /runtime-profiles, draft save, and workflow publish.";

export const SCRIPT_PUBLISH_BOUNDARY_HELP =
  "Publish packages approved source, scans and signs the package, and pins an immutable content-addressed artifact on the workflow version. Draft save writes the same YAML schema only — it does not create an executable artifact.";

export const SCRIPT_DRAFT_NOT_EXECUTABLE_HELP =
  "Execution uses the pinned artifact digest, not mutable draft source. Drafts cannot run.";

export const SCRIPT_MUTABLE_REJECT_HELP =
  "Mutable or unscanned artifacts are rejected. Arbitrary package install and arbitrary base images are MVP non-goals.";

export const SCRIPT_SECRET_WITH_MESSAGE =
  "Secrets, tokens, keys, and credential handles cannot be stored in script YAML or logs. Runtime injects scoped handles only.";

export const SCRIPT_PACKAGE_INSTALL_MESSAGE =
  "Arbitrary package installation is denied. Use an approved runtime/dependency profile — do not pip install, go get, or vendor an unapproved image.";

export const SCRIPT_ARBITRARY_IMAGE_MESSAGE =
  "Arbitrary base images are denied. Choose a published approved runtime profile. image / baseImage / Dockerfile are not node fields.";

export const SCRIPT_SOURCE_REQUIRED_MESSAGE =
  "source is required. Author visible Python or Go source that versions with the workflow.";

export const SCRIPT_ENTRYPOINT_REQUIRED_MESSAGE =
  "entrypoint is required (main.py or main.go).";

export const SCRIPT_PROFILE_REQUIRED_MESSAGE =
  "runtimeProfileId is required. Choose a published approved runtime/dependency profile.";

export const SCRIPT_PROFILE_FAIL_CLOSED_MESSAGE =
  "Runtime profile selector failed closed. Only published workspace runtime profiles are listed; unauthorized or cross-workspace profiles are not shown.";

export const SCRIPT_PROFILE_LANGUAGE_MESSAGE =
  "The selected runtime profile language must match the node type (script.python → python, script.go → go).";

export const SCRIPT_HOST_SUPPLIED_IDENTITY_HELP =
  "Host-supplied id or workspaceId is not accepted. The API returns 400 invalid-request.";

export const SCRIPT_HOST_SUPPLIED_IDENTITY_DETAIL =
  "Do not send id or workspaceId on writes. Workspace scope comes from the session and tenant + workbench headers.";

export const SCRIPT_FORBIDDEN_WITH_KEYS = [
  "secret",
  "secrets",
  "token",
  "password",
  "apiKey",
  "privateKey",
  "kubeconfig",
  "credential",
  "credentials",
  "authorization",
  "image",
  "baseImage",
  "dockerfile",
  "Dockerfile",
  "imageDigest",
  "packages",
  "requirements",
  "pip",
  "goGet",
  "goMod",
] as const;

export const SCRIPT_NODE_POLICY_NOTES = [
  "Source is visible and versioned with the workflow YAML. Secrets are never serialized into YAML or logs.",
  "Draft save writes YAML only. Publish is the artifact creation boundary: package, scan, sign, and pin a digest on the workflow version.",
  "Execution uses the pinned digest, not mutable draft source. Drafts cannot run.",
  "Choose a published approved runtime/dependency profile. Arbitrary package install and arbitrary base images are denied.",
  "Resource limits and timeout are bounded. Inputs arrive as validated JSON; outputs must meet the declared schema.",
  "Credential handles are short-lived, scoped, and injected at runtime — never authored into source.",
  "Selectors fail closed on HTTP 403. Only published workspace runtime profiles are listed.",
] as const;

export const SCRIPT_NODE_PERMISSIONS = [
  "workflow.execute",
  "script.run",
  "runtimeProfile.use",
] as const;

/** Existing collections only. Do not invent /scripts/* until jonny's map. */
export const SCRIPT_EXISTING_API_PATHS = {
  workflowCatalog: "/workflows/catalog",
  runtimeProfiles: "/runtime-profiles",
  workflowDraft: (workflowId: string) => `/workflows/${workflowId}/draft`,
  workflowPublish: (workflowId: string) => `/workflows/${workflowId}/publish`,
  workflowVersions: (workflowId: string) => `/workflows/${workflowId}/versions`,
} as const;

export type ScriptNodeWithField = CatalogWithField & {
  label: string;
  advanced?: boolean;
  readOnly?: boolean;
  controlHint: "text" | "textarea" | "enum" | "uuid" | "number" | "object-lines";
  defaultValue?: unknown;
};

export type ScriptNodeEngineContract = {
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

export type ScriptNodeErrorShape = {
  code: string;
  status: number;
  meaning: string;
};

export type ScriptPublishRules = {
  draftCreatesArtifact: false;
  publishPackagesScansSigns: true;
  pinOnWorkflowVersion: true;
  executionUsesPinnedDigest: true;
  rejectMutableUnscanned: true;
  arbitraryPackageInstall: false;
  arbitraryBaseImages: false;
};

export type ScriptNodeCatalogSource = "workflow-catalog" | "contract-fallback";

export type ScriptNodeCatalog = {
  source: ScriptNodeCatalogSource;
  nodes: ScriptNodeEngineContract[];
  errors: ScriptNodeErrorShape[];
  permissions: string[];
  publish: ScriptPublishRules;
  notes?: string;
};

export type ScriptNodeConfigContext = {
  profileSelectorClosed?: boolean;
  profileLanguage?: "python" | "go" | "";
  scriptCatalog?: ScriptNodeCatalog | null;
};

export type ScriptArtifactKind =
  | "draft"
  | "dirty-draft"
  | "published-unpinned"
  | "scanning"
  | "signed-pinned"
  | "rejected";

export type ScriptArtifactStatus = {
  kind: ScriptArtifactKind;
  label: string;
  help: string;
  digest?: string;
  scanStatus?: string;
  source: "version" | "contract-fallback";
};

export const DEFAULT_SCRIPT_PUBLISH_RULES: ScriptPublishRules = {
  draftCreatesArtifact: false,
  publishPackagesScansSigns: true,
  pinOnWorkflowVersion: true,
  executionUsesPinnedDigest: true,
  rejectMutableUnscanned: true,
  arbitraryPackageInstall: false,
  arbitraryBaseImages: false,
};

export const DEFAULT_SCRIPT_NODE_ERRORS: ScriptNodeErrorShape[] = [
  {
    code: "invalid-source",
    status: 400,
    meaning: "Source, entrypoint, or declared I/O schema is invalid.",
  },
  {
    code: "package-install-denied",
    status: 400,
    meaning: SCRIPT_PACKAGE_INSTALL_MESSAGE,
  },
  {
    code: "arbitrary-image-denied",
    status: 400,
    meaning: SCRIPT_ARBITRARY_IMAGE_MESSAGE,
  },
  {
    code: "secret-in-yaml",
    status: 400,
    meaning: SCRIPT_SECRET_WITH_MESSAGE,
  },
  {
    code: "invalid-request",
    status: 400,
    meaning: SCRIPT_HOST_SUPPLIED_IDENTITY_HELP,
  },
  {
    code: "forbidden",
    status: 403,
    meaning:
      "Missing workflow.execute, script.run, or runtimeProfile.use. Selectors fail closed.",
  },
  {
    code: "mutable-artifact",
    status: 409,
    meaning: SCRIPT_MUTABLE_REJECT_HELP,
  },
  {
    code: "unscanned-artifact",
    status: 409,
    meaning: "Unscanned artifacts cannot run. Publish must complete scan/sign/pin.",
  },
];

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PACKAGE_INSTALL_HINT =
  /\b(?:pip3?\s+install|python\s+-m\s+pip|easy_install|poetry\s+add|conda\s+install|go\s+get\b|go\s+install\b|npm\s+install|yarn\s+add|apt-get\s+install|apk\s+add)\b/i;

const ARBITRARY_IMAGE_HINT =
  /^\s*(?:FROM\s+\S+|image:\s+\S+)/im;

export function isScriptActionType(type: string): type is ScriptActionType {
  return (SCRIPT_ACTION_TYPES as readonly string[]).includes(type);
}

export function isScriptConfigurableType(type: string): boolean {
  return isScriptActionType(type);
}

export function scriptLibraryTypes(
  catalog?: WorkflowCatalog | null,
): readonly string[] {
  void catalog;
  return [...SCRIPT_ACTION_TYPES];
}

export function catalogListsScriptType(
  catalog: WorkflowCatalog | null | undefined,
  type: string,
): boolean {
  return (catalog?.nodes ?? []).some(
    (item) => item.type === type && isCatalogImplementationEnabled(item),
  );
}

export function hasScriptNodeContract(node: CatalogNode | undefined): boolean {
  return Boolean(
    node &&
      ((node.allowedWith && node.allowedWith.length > 0) ||
        node.policy ||
        node.bounds ||
        node.redaction),
  );
}

export function defaultScriptEntrypoint(type: string): string {
  return type === SCRIPT_GO_TYPE
    ? SCRIPT_DEFAULT_GO_ENTRYPOINT
    : SCRIPT_DEFAULT_PYTHON_ENTRYPOINT;
}

export function defaultScriptWith(type: string): Record<string, unknown> {
  if (!isScriptConfigurableType(type)) {
    return {};
  }
  return {
    entrypoint: defaultScriptEntrypoint(type),
    timeoutSeconds: SCRIPT_DEFAULT_TIMEOUT_SECONDS,
    memoryMiB: SCRIPT_DEFAULT_MEMORY_MIB,
  };
}

export function expectedRuntimeLanguage(
  type: string,
): "python" | "go" | undefined {
  if (type === SCRIPT_PYTHON_TYPE) {
    return "python";
  }
  if (type === SCRIPT_GO_TYPE) {
    return "go";
  }
  return undefined;
}

export function runtimeProfileLanguage(
  spec: { language?: unknown } | null | undefined,
): "python" | "go" | "" {
  const value = String(spec?.language ?? "").trim().toLowerCase();
  if (value === "python" || value === "go") {
    return value;
  }
  return "";
}

export function runtimeProfileMatchesNode(
  type: string,
  spec: { language?: unknown } | null | undefined,
): boolean {
  const expected = expectedRuntimeLanguage(type);
  const language = runtimeProfileLanguage(spec);
  if (!expected || !language) {
    return true;
  }
  return language === expected;
}

export function scriptNodeContract(
  type: string,
  catalog?: ScriptNodeCatalog | null,
): ScriptNodeEngineContract | undefined {
  return catalog?.nodes.find((item) => item.type === type);
}

export function scriptNodeErrorShapes(
  catalog?: ScriptNodeCatalog | null,
): ScriptNodeErrorShape[] {
  return catalog?.errors ?? DEFAULT_SCRIPT_NODE_ERRORS;
}

export function scriptPublishRules(
  catalog?: ScriptNodeCatalog | null,
): ScriptPublishRules {
  return catalog?.publish ?? DEFAULT_SCRIPT_PUBLISH_RULES;
}

export function scriptNodeWithFields(
  type: string,
  scriptCatalog?: ScriptNodeCatalog | null,
): ScriptNodeWithField[] {
  const engineNode = scriptNodeContract(type, scriptCatalog);
  if (engineNode?.allowedWith.length) {
    return overlayScriptFields(engineNode.allowedWith, type);
  }
  if (!isScriptConfigurableType(type)) {
    return [];
  }
  const language = type === SCRIPT_GO_TYPE ? "Go" : "Python";
  return [
    {
      name: "runtimeProfileId",
      kind: "uuid",
      required: true,
      label: "Runtime profile",
      controlHint: "uuid",
      description:
        "Published approved runtime/dependency profile (display name + id). Not an arbitrary image.",
    },
    {
      name: "source",
      kind: "string",
      required: true,
      label: `${language} source`,
      controlHint: "textarea",
      description:
        "Visible, versioned source. Secrets and credential handles are injected at runtime — never write them here.",
    },
    {
      name: "entrypoint",
      kind: "string",
      required: true,
      label: "Entrypoint",
      controlHint: "text",
      defaultValue: defaultScriptEntrypoint(type),
      description: `File the approved runtime executes. Default ${defaultScriptEntrypoint(type)}.`,
    },
    {
      name: "timeoutSeconds",
      kind: "integer",
      label: "Timeout (seconds)",
      controlHint: "number",
      defaultValue: SCRIPT_DEFAULT_TIMEOUT_SECONDS,
      description: `Bounded run timeout (${SCRIPT_MIN_TIMEOUT_SECONDS}–${SCRIPT_MAX_TIMEOUT_SECONDS}). Default ${SCRIPT_DEFAULT_TIMEOUT_SECONDS}.`,
    },
    {
      name: "memoryMiB",
      kind: "integer",
      label: "Memory (MiB)",
      controlHint: "number",
      defaultValue: SCRIPT_DEFAULT_MEMORY_MIB,
      description: `Bounded memory (${SCRIPT_MIN_MEMORY_MIB}–${SCRIPT_MAX_MEMORY_MIB}). Default ${SCRIPT_DEFAULT_MEMORY_MIB}.`,
    },
    {
      name: "inputSchema",
      kind: "object",
      label: "Input schema",
      controlHint: "object-lines",
      advanced: true,
      description:
        "Optional declared input schema stub (name=type lines). Validated JSON only. No secrets.",
    },
    {
      name: "outputSchema",
      kind: "object",
      label: "Output schema",
      controlHint: "object-lines",
      advanced: true,
      description:
        "Optional declared output schema stub (name=type lines). Outputs must meet schema and size limits.",
    },
    {
      name: "policyId",
      kind: "uuid",
      label: "Policy",
      controlHint: "uuid",
      advanced: true,
      description: "Optional published kind=script policy UUID.",
    },
  ];
}

export function overlayScriptFields(
  fields: CatalogWithField[],
  type: string,
): ScriptNodeWithField[] {
  const fallback = new Map(
    scriptNodeWithFields(type).map((field) => [field.name, field]),
  );
  return fields
    .filter((field) => !scriptForbiddenWithKeys({ [field.name]: true }).length)
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
                : field.name === "source"
                  ? "textarea"
                  : "text");
      return {
        name: field.name,
        kind: field.kind,
        required: field.required === true,
        enum: field.enum?.length ? field.enum : base?.enum,
        description: field.description || base?.description || "",
        label: base?.label || field.name,
        advanced:
          field.name === "inputSchema" ||
          field.name === "outputSchema" ||
          field.name === "policyId" ||
          base?.advanced,
        readOnly: base?.readOnly,
        controlHint,
        defaultValue: base?.defaultValue,
      };
    });
}

export function scriptForbiddenWithKeys(
  value: Record<string, unknown>,
): string[] {
  return SCRIPT_FORBIDDEN_WITH_KEYS.filter((key) => key in value);
}

export function stripScriptForbiddenWith(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if ((SCRIPT_FORBIDDEN_WITH_KEYS as readonly string[]).includes(key)) {
      continue;
    }
    if (isForbiddenYamlKey(key)) {
      continue;
    }
    out[key] = raw;
  }
  return out;
}

export function isExposedScriptWithField(name: string): boolean {
  return !(SCRIPT_FORBIDDEN_WITH_KEYS as readonly string[]).includes(name);
}

export function hostSuppliedScriptIdentityKeys(
  value: Record<string, unknown> | null | undefined,
): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const hits: string[] = [];
  if (value.id !== undefined) {
    hits.push("id");
  }
  if (value.workspaceId !== undefined) {
    hits.push("workspaceId");
  }
  if (value.workspace_id !== undefined) {
    hits.push("workspace_id");
  }
  return hits;
}

export function hostSuppliedScriptIdentityProblem(keys: string[]): {
  title: string;
  status: number;
  code: string;
  detail: string;
} {
  return {
    title: "Invalid request",
    status: 400,
    code: "invalid-request",
    detail: `${SCRIPT_HOST_SUPPLIED_IDENTITY_DETAIL} Found: ${keys.join(", ")}.`,
  };
}

export function validateScriptNodeConfig(
  type: string,
  withValue: Record<string, unknown>,
  context: ScriptNodeConfigContext = {},
): string[] {
  if (!isScriptConfigurableType(type)) {
    return [];
  }
  const errors: string[] = [];
  if (context.profileSelectorClosed) {
    errors.push(SCRIPT_PROFILE_FAIL_CLOSED_MESSAGE);
  }
  const forbidden = scriptForbiddenWithKeys(withValue);
  if (forbidden.length > 0) {
    if (
      forbidden.some((key) =>
        ["image", "baseImage", "dockerfile", "Dockerfile", "imageDigest"].includes(
          key,
        ),
      )
    ) {
      errors.push(SCRIPT_ARBITRARY_IMAGE_MESSAGE);
    }
    if (
      forbidden.some((key) =>
        ["packages", "requirements", "pip", "goGet", "goMod"].includes(key),
      )
    ) {
      errors.push(SCRIPT_PACKAGE_INSTALL_MESSAGE);
    }
    if (
      forbidden.some(
        (key) =>
          ![
            "image",
            "baseImage",
            "dockerfile",
            "Dockerfile",
            "imageDigest",
            "packages",
            "requirements",
            "pip",
            "goGet",
            "goMod",
          ].includes(key),
      )
    ) {
      errors.push(SCRIPT_SECRET_WITH_MESSAGE);
    }
  }

  const runtimeProfileId =
    typeof withValue.runtimeProfileId === "string"
      ? withValue.runtimeProfileId.trim()
      : "";
  if (!runtimeProfileId) {
    errors.push(SCRIPT_PROFILE_REQUIRED_MESSAGE);
  } else if (!UUID.test(runtimeProfileId)) {
    errors.push("runtimeProfileId must be a workspace UUID.");
  } else if (
    context.profileLanguage &&
    !runtimeProfileMatchesNode(type, { language: context.profileLanguage })
  ) {
    errors.push(SCRIPT_PROFILE_LANGUAGE_MESSAGE);
  }

  const source =
    typeof withValue.source === "string" ? withValue.source : "";
  if (!source.trim()) {
    errors.push(SCRIPT_SOURCE_REQUIRED_MESSAGE);
  } else {
    if (looksLikeSecretValue(source)) {
      errors.push(SCRIPT_SECRET_WITH_MESSAGE);
    }
    if (PACKAGE_INSTALL_HINT.test(source)) {
      errors.push(SCRIPT_PACKAGE_INSTALL_MESSAGE);
    }
    if (ARBITRARY_IMAGE_HINT.test(source)) {
      errors.push(SCRIPT_ARBITRARY_IMAGE_MESSAGE);
    }
  }

  const entrypoint =
    typeof withValue.entrypoint === "string" ? withValue.entrypoint.trim() : "";
  if (!entrypoint) {
    errors.push(SCRIPT_ENTRYPOINT_REQUIRED_MESSAGE);
  } else if (looksLikeSecretValue(entrypoint) || isForbiddenYamlKey(entrypoint)) {
    errors.push(SCRIPT_SECRET_WITH_MESSAGE);
  }

  if (withValue.timeoutSeconds !== undefined) {
    const timeout = Number(withValue.timeoutSeconds);
    if (
      !Number.isFinite(timeout) ||
      timeout < SCRIPT_MIN_TIMEOUT_SECONDS ||
      timeout > SCRIPT_MAX_TIMEOUT_SECONDS
    ) {
      errors.push(
        `timeoutSeconds must be between ${SCRIPT_MIN_TIMEOUT_SECONDS} and ${SCRIPT_MAX_TIMEOUT_SECONDS}.`,
      );
    }
  }

  if (withValue.memoryMiB !== undefined) {
    const memory = Number(withValue.memoryMiB);
    if (
      !Number.isFinite(memory) ||
      memory < SCRIPT_MIN_MEMORY_MIB ||
      memory > SCRIPT_MAX_MEMORY_MIB
    ) {
      errors.push(
        `memoryMiB must be between ${SCRIPT_MIN_MEMORY_MIB} and ${SCRIPT_MAX_MEMORY_MIB}.`,
      );
    }
  }

  if (withValue.policyId !== undefined && withValue.policyId !== "") {
    const policyId = String(withValue.policyId).trim();
    if (!UUID.test(policyId)) {
      errors.push("policyId must be a workspace UUID.");
    }
  }

  errors.push(...validateSchemaStub("inputSchema", withValue.inputSchema));
  errors.push(...validateSchemaStub("outputSchema", withValue.outputSchema));

  return unique(errors);
}

export function yamlHasScriptNodes(yaml: string): boolean {
  return /type:\s*script\.(python|go)\b/.test(yaml);
}

export function scriptArtifactStatus(input: {
  dirty?: boolean;
  hasPublishedVersion?: boolean;
  version?: WorkflowVersion | Record<string, unknown> | null;
}): ScriptArtifactStatus {
  if (input.dirty) {
    return {
      kind: "dirty-draft",
      label: "Unsaved draft source",
      help: `${SCRIPT_PUBLISH_BOUNDARY_HELP} Save the draft, then publish to package/scan/sign/pin.`,
      source: "contract-fallback",
    };
  }
  if (!input.hasPublishedVersion) {
    return {
      kind: "draft",
      label: "Draft — no executable artifact",
      help: SCRIPT_PUBLISH_BOUNDARY_HELP,
      source: "contract-fallback",
    };
  }
  const parsed = parseVersionArtifact(input.version);
  if (parsed.rejected) {
    return {
      kind: "rejected",
      label: "Artifact rejected",
      help: parsed.reason || SCRIPT_MUTABLE_REJECT_HELP,
      digest: parsed.digest,
      scanStatus: parsed.scanStatus,
      source: parsed.fromVersion ? "version" : "contract-fallback",
    };
  }
  if (parsed.scanning) {
    return {
      kind: "scanning",
      label: "Scan in progress",
      help: "Publish packaged the source. Execution waits for a clean signed scan before the digest can run.",
      digest: parsed.digest,
      scanStatus: parsed.scanStatus,
      source: "version",
    };
  }
  if (parsed.digest && parsed.signed) {
    return {
      kind: "signed-pinned",
      label: "Signed and pinned",
      help: SCRIPT_DRAFT_NOT_EXECUTABLE_HELP,
      digest: parsed.digest,
      scanStatus: parsed.scanStatus,
      source: "version",
    };
  }
  return {
    kind: "published-unpinned",
    label: "Published — artifact pin pending route map",
    help: `${SCRIPT_PUBLISH_BOUNDARY_HELP} ${SCRIPT_CONTRACT_FALLBACK_HELP}`,
    digest: parsed.digest,
    scanStatus: parsed.scanStatus,
    source: parsed.fromVersion ? "version" : "contract-fallback",
  };
}

export function scriptFallbackNode(type: string): CatalogNode {
  return SCRIPT_CONTRACT_FALLBACK[type] ?? thinFallback(type);
}

export function adaptScriptNodeEntries(
  catalog: WorkflowCatalog | null | undefined,
  scriptCatalog?: ScriptNodeCatalog | null,
): CatalogNode[] {
  return scriptLibraryTypes(catalog).map((type) => {
    const listed = (catalog?.nodes ?? []).find((item) => item.type === type);
    const fallback = scriptFallbackNode(type);
    const engine = scriptNodeContract(type, scriptCatalog);
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

export function parseScriptNodeCatalog(raw: unknown): ScriptNodeCatalog {
  if (!raw || typeof raw !== "object") {
    return { ...SCRIPT_NODE_CONTRACT_FALLBACK_CATALOG };
  }
  const rec = raw as Record<string, unknown>;
  const nested =
    rec.scriptEngine &&
    typeof rec.scriptEngine === "object" &&
    !Array.isArray(rec.scriptEngine)
      ? (rec.scriptEngine as Record<string, unknown>)
      : rec;
  const nodesRaw = Array.isArray(nested.nodes)
    ? nested.nodes
    : Array.isArray(rec.nodes)
      ? rec.nodes
      : [];
  const nodes = nodesRaw
    .map(parseEngineNode)
    .filter((item): item is ScriptNodeEngineContract => item !== null);
  const errorsRaw = Array.isArray(nested.errors)
    ? nested.errors
    : Array.isArray(rec.errors)
      ? rec.errors
      : [];
  const errors = errorsRaw
    .map(parseEngineError)
    .filter((item): item is ScriptNodeErrorShape => item !== null);
  const permissions = stringList(nested.permissions ?? rec.permissions);
  if (nodes.length === 0 && errors.length === 0 && permissions.length === 0) {
    return { ...SCRIPT_NODE_CONTRACT_FALLBACK_CATALOG };
  }
  return {
    source: nodes.length > 0 ? "workflow-catalog" : "contract-fallback",
    nodes: nodes.length ? nodes : SCRIPT_NODE_CONTRACT_FALLBACK_CATALOG.nodes,
    errors: errors.length ? errors : DEFAULT_SCRIPT_NODE_ERRORS,
    permissions: permissions.length ? permissions : [...SCRIPT_NODE_PERMISSIONS],
    publish: DEFAULT_SCRIPT_PUBLISH_RULES,
    notes:
      String(nested.notes ?? rec.notes ?? "").trim() ||
      (nodes.length ? undefined : SCRIPT_CONTRACT_FALLBACK_HELP),
  };
}

export const SCRIPT_NODE_CONTRACT_FALLBACK_CATALOG: ScriptNodeCatalog = {
  source: "contract-fallback",
  nodes: [
    {
      type: SCRIPT_PYTHON_TYPE,
      title: "Python script",
      description:
        "Run approved Python source as an isolated node. Publish packages, scans, signs, and pins an immutable artifact. Draft save does not create an executable artifact.",
      permissions: [...SCRIPT_NODE_PERMISSIONS],
      requiredWith: ["source", "entrypoint", "runtimeProfileId"],
      allowedWith: [],
      outputs: ["result"],
      sideEffects: true,
      retrySafe: false,
      defaultMaxAttempts: 0,
    },
    {
      type: SCRIPT_GO_TYPE,
      title: "Go script",
      description:
        "Run approved Go source as an isolated node. Publish packages, scans, signs, and pins an immutable artifact. Draft save does not create an executable artifact.",
      permissions: [...SCRIPT_NODE_PERMISSIONS],
      requiredWith: ["source", "entrypoint", "runtimeProfileId"],
      allowedWith: [],
      outputs: ["result"],
      sideEffects: true,
      retrySafe: false,
      defaultMaxAttempts: 0,
    },
  ],
  errors: DEFAULT_SCRIPT_NODE_ERRORS,
  permissions: [...SCRIPT_NODE_PERMISSIONS],
  publish: DEFAULT_SCRIPT_PUBLISH_RULES,
  notes: SCRIPT_CONTRACT_FALLBACK_HELP,
};

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

function scriptPolicy(): CatalogNodePolicy {
  return {
    permissions: [...SCRIPT_NODE_PERMISSIONS],
    retrySafe: false,
    sideEffects: true,
    idempotent: false,
    cancellation: "abort-process",
    verification: "e9.1-stub",
    defaultMaxAttempts: 0,
  };
}

function defaultBounds(): CatalogNodeBounds {
  return {
    maxInputBytes: 16 * 1024,
    maxOutputBytes: 64 * 1024,
    maxWithBytes: 256 * 1024,
    maxAggregationItems: 32,
    maxDurationSeconds: SCRIPT_MAX_TIMEOUT_SECONDS,
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
  return scriptNodeWithFields(type).map((field) => ({
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
    description: SCRIPT_PUBLISH_BOUNDARY_HELP,
    inputs: [],
    outputs: [],
    requiredWith: ["source", "entrypoint", "runtimeProfileId"],
    allowedWith: fieldsToAllowed(type),
  };
}

const SCRIPT_CONTRACT_FALLBACK: Record<string, CatalogNode> = {
  "script.python": {
    type: SCRIPT_PYTHON_TYPE,
    phase: CATALOG_PHASE_CORE,
    title: "Python script",
    description:
      "Run approved Python source as an isolated node. Publish packages, scans, signs, and pins an immutable artifact. Draft save does not create an executable artifact.",
    inputs: [
      inherit("input", "object", false, "Validated JSON input. Secrets are scoped handles, never plaintext."),
    ],
    outputs: [
      inherit("result", "object", false, "Redacted result matching the declared output schema."),
    ],
    requiredWith: ["source", "entrypoint", "runtimeProfileId"],
    allowedWith: fieldsToAllowed(SCRIPT_PYTHON_TYPE),
    policy: scriptPolicy(),
    bounds: defaultBounds(),
    redaction: redaction([
      "runtimeProfileId",
      "entrypoint",
      "artifactDigest",
      "scanStatus",
      "correlationId",
    ]),
  },
  "script.go": {
    type: SCRIPT_GO_TYPE,
    phase: CATALOG_PHASE_CORE,
    title: "Go script",
    description:
      "Run approved Go source as an isolated node. Publish packages, scans, signs, and pins an immutable artifact. Draft save does not create an executable artifact.",
    inputs: [
      inherit("input", "object", false, "Validated JSON input. Secrets are scoped handles, never plaintext."),
    ],
    outputs: [
      inherit("result", "object", false, "Redacted result matching the declared output schema."),
    ],
    requiredWith: ["source", "entrypoint", "runtimeProfileId"],
    allowedWith: fieldsToAllowed(SCRIPT_GO_TYPE),
    policy: scriptPolicy(),
    bounds: defaultBounds(),
    redaction: redaction([
      "runtimeProfileId",
      "entrypoint",
      "artifactDigest",
      "scanStatus",
      "correlationId",
    ]),
  },
};

function parseEngineNode(raw: unknown): ScriptNodeEngineContract | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const rec = raw as Record<string, unknown>;
  const type = String(rec.type ?? "").trim();
  if (!isScriptConfigurableType(type)) {
    return null;
  }
  const allowedWith = Array.isArray(rec.allowedWith)
    ? rec.allowedWith
        .map(parseAllowedField)
        .filter((item): item is CatalogWithField => item !== null)
    : [];
  return {
    type,
    title:
      String(rec.title ?? "").trim() ||
      (type === SCRIPT_GO_TYPE ? "Go script" : "Python script"),
    description: String(rec.description ?? "").trim(),
    permissions: stringList(rec.permissions),
    requiredWith: stringList(rec.requiredWith),
    allowedWith,
    outputs: stringList(rec.outputs),
    sideEffects: rec.sideEffects !== false,
    retrySafe: rec.retrySafe === true,
    defaultMaxAttempts: Number.isFinite(Number(rec.defaultMaxAttempts))
      ? Number(rec.defaultMaxAttempts)
      : 0,
  };
}

function parseAllowedField(raw: unknown): CatalogWithField | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const rec = raw as Record<string, unknown>;
  const name = String(rec.name ?? "").trim();
  if (!name || !isExposedScriptWithField(name)) {
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

function parseEngineError(raw: unknown): ScriptNodeErrorShape | null {
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

function parseVersionArtifact(version: unknown): {
  digest?: string;
  scanStatus?: string;
  signed: boolean;
  scanning: boolean;
  rejected: boolean;
  reason?: string;
  fromVersion: boolean;
} {
  if (!version || typeof version !== "object") {
    return { signed: false, scanning: false, rejected: false, fromVersion: false };
  }
  const rec = version as Record<string, unknown>;
  const artifact =
    rec.scriptArtifact && typeof rec.scriptArtifact === "object"
      ? (rec.scriptArtifact as Record<string, unknown>)
      : rec.artifact && typeof rec.artifact === "object"
        ? (rec.artifact as Record<string, unknown>)
        : rec;
  const digest = firstString(
    artifact.artifactDigest,
    artifact.digest,
    artifact.scriptArtifactDigest,
    rec.artifactDigest,
    rec.scriptArtifactDigest,
  );
  const digestLooksPinned =
    Boolean(digest) &&
    digest !== firstString(rec.digest) &&
    /^sha256:[0-9a-f]{16,}$/i.test(digest ?? "");
  const scanStatus = firstString(
    artifact.scanStatus,
    artifact.scan,
    rec.scanStatus,
  )?.toLowerCase();
  const signed =
    artifact.signed === true ||
    rec.signed === true ||
    String(artifact.signatureStatus ?? rec.signatureStatus ?? "")
      .toLowerCase()
      .includes("signed");
  const scanning =
    scanStatus === "scanning" ||
    scanStatus === "pending" ||
    scanStatus === "queued";
  const rejected =
    scanStatus === "failed" ||
    scanStatus === "rejected" ||
    scanStatus === "mutable" ||
    artifact.rejected === true;
  const reason = firstString(artifact.reason, rec.reason, artifact.detail);
  const fromVersion = Boolean(
    digestLooksPinned ||
      scanStatus ||
      artifact.signed !== undefined ||
      rec.scriptArtifact ||
      rec.artifactDigest ||
      rec.scriptArtifactDigest,
  );
  return {
    digest: digestLooksPinned || fromVersion ? digest : undefined,
    scanStatus,
    signed: signed && Boolean(digest),
    scanning,
    rejected,
    reason,
    fromVersion,
  };
}

function validateSchemaStub(name: string, value: unknown): string[] {
  if (value === undefined || value === "") {
    return [];
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [`${name} must be an object of name=type declarations.`];
  }
  const errors: string[] = [];
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (!key.trim() || isForbiddenYamlKey(key)) {
      errors.push(`${name} must not declare secret field names.`);
      continue;
    }
    if (typeof nested === "string" && looksLikeSecretValue(nested)) {
      errors.push(SCRIPT_SECRET_WITH_MESSAGE);
    }
  }
  return unique(errors);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
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
