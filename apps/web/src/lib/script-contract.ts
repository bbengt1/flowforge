/**
 * Single retarget adapter for Chloe's E9.1 script authoring / publish UI.
 * Wired to jonny's **#97** map on `main` (`e91-#97`).
 *
 *   GET  /scripts/catalog
 *   GET  /ops-config/catalog            adds scriptEngine; runtime-profiles engine=script
 *   POST /scripts                       package/scan/sign → artifact metadata (no blob)
 *   GET  /scripts/{id}                  digest + scan/signature — never package/storageRef
 *   POST /workflows/{id}/publish        also packages script nodes → {version,pins,scriptArtifacts}
 *   GET  …/versions/{v}/script-artifacts  pins bound at publish
 *
 * Cookie session + `X-CSRF-Token` on POST. JSON camelCase. RFC 9457.
 * Host-supplied `id` / `workspaceId` → 400 UX. Never show package blobs
 * or storageRef. Relates to #92 (already closed by #97) / Part of #91 —
 * do not re-close #92; keep epic #91 open until this UI PR merges.
 * Do not change `apps/api`.
 */

import { isResourceId } from "./identity-proxy-ids.ts";
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
/** Jonny's E9.1 publish/scan/sign/pin map on main. */
export const SCRIPT_API_PR = 97;
export const SCRIPT_ROUTE_MAP_SOURCE = "e91-#97" as const;

export const SCRIPT_PYTHON_TYPE = "script.python" as const;
export const SCRIPT_GO_TYPE = "script.go" as const;
export const SCRIPT_ACTION_TYPES = [SCRIPT_PYTHON_TYPE, SCRIPT_GO_TYPE] as const;
export type ScriptActionType = (typeof SCRIPT_ACTION_TYPES)[number];

export const SCRIPT_DEFAULT_TIMEOUT_SECONDS = 30;
export const SCRIPT_MIN_TIMEOUT_SECONDS = 1;
export const SCRIPT_MAX_TIMEOUT_SECONDS = 3600;
export const SCRIPT_DEFAULT_MEMORY_MIB = 128;
export const SCRIPT_MIN_MEMORY_MIB = 32;
export const SCRIPT_MAX_MEMORY_MIB = 2048;
export const SCRIPT_MIN_CPU_MILLIS = 1;
export const SCRIPT_MAX_CPU_MILLIS = 8000;
export const SCRIPT_MIN_PROCESSES = 1;
export const SCRIPT_MAX_PROCESSES = 256;
export const SCRIPT_MAX_SOURCE_BYTES = 64 * 1024;
export const SCRIPT_DEFAULT_PYTHON_ENTRYPOINT = "main.py";
export const SCRIPT_DEFAULT_GO_ENTRYPOINT = "main.go";

export const SCRIPT_CONTRACT_FALLBACK_HELP =
  "Using the marked e91-#97 script map because GET /scripts/catalog was unavailable. Prefer GET /scripts/catalog (or GET /ops-config/catalog scriptEngine) plus GET /workflows/catalog.";

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
  "entrypoint is required (basename only: main.py / main.go, or Go package.Function).";

export const SCRIPT_ENTRYPOINT_INVALID_MESSAGE =
  "entrypoint must be a basename only (no path). Python: *.py. Go: *.go or package.Function.";

export const SCRIPT_TIMEOUT_REQUIRED_MESSAGE =
  "timeoutSeconds is required (1–3600).";

export const SCRIPT_BLOB_FORBIDDEN_MESSAGE =
  "Package blobs and storageRef are never shown. Artifact metadata is digest, scan, and signature only.";

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

export const SCRIPT_EXECUTE_FAIL_CLOSED_HELP =
  "Execute fails closed: drafts, mutable, unscanned, unsigned, or scan-failed artifacts return 400. Dispatch needs script.run plus runtimeProfile.use. Isolated runners are E9.2.";

export const SCRIPT_RUNTIME_PROFILE_ENGINE = "script" as const;

/** Exact #97 forbidden `with` keys. */
export const SCRIPT_FORBIDDEN_WITH_KEYS = [
  "env",
  "environment",
  "secrets",
  "credentials",
  "privateKey",
  "token",
  "password",
  "kubeconfig",
  "command",
  "shell",
] as const;

/** Extra keys stripped before YAML insert (not in allowedWith). */
export const SCRIPT_STRIP_WITH_KEYS = [
  ...SCRIPT_FORBIDDEN_WITH_KEYS,
  "secret",
  "apiKey",
  "credential",
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
  "package",
  "storageRef",
] as const;

export const SCRIPT_ARTIFACT_SECRET_KEYS = [
  "package",
  "storageRef",
  "storage_ref",
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

export const SCRIPT_CATALOG_PATH = "/scripts/catalog";
export const SCRIPTS_PATH = "/scripts";
export const SCRIPT_OPS_CONFIG_CATALOG_PATH = "/ops-config/catalog";

export function scriptArtifactPath(artifactId: string): string {
  return `${SCRIPTS_PATH}/${artifactId}`;
}

export function workflowScriptArtifactsPath(
  workflowId: string,
  versionId: string,
): string {
  return `/workflows/${workflowId}/versions/${versionId}/script-artifacts`;
}

export const SCRIPT_EXISTING_API_PATHS = {
  scriptsCatalog: SCRIPT_CATALOG_PATH,
  scripts: SCRIPTS_PATH,
  scriptArtifact: scriptArtifactPath,
  opsConfigCatalog: SCRIPT_OPS_CONFIG_CATALOG_PATH,
  workflowCatalog: "/workflows/catalog",
  runtimeProfiles: "/runtime-profiles",
  workflowDraft: (workflowId: string) => `/workflows/${workflowId}/draft`,
  workflowPublish: (workflowId: string) => `/workflows/${workflowId}/publish`,
  workflowScriptArtifacts: workflowScriptArtifactsPath,
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
  language?: string;
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
  requiredWith: string[];
  allowedLanguages: string[];
  sourceVisibleInYAML: boolean;
  secretsForbiddenInYAML: boolean;
  draftsCannotExecute: boolean;
  mutableArtifactsRejected: boolean;
  unscannedRejected: boolean;
  unsignedRejected: boolean;
  failedScanRejected: boolean;
  publishedRevisionsPinned: boolean;
  digestPinnedRuntime: boolean;
  maxSourceBytes: number;
  maxTimeoutSeconds: number;
};

export type ScriptIsolationRules = {
  nonRoot: boolean;
  readOnlyRootFS: boolean;
  droppedCapabilities: boolean;
  noNewPrivs: boolean;
  noMetadataService: boolean;
  noHostDockerSocket: boolean;
  runtimePackageInstall: boolean;
  approvedImagesOnly: boolean;
  note: string;
  hooks: string[];
};

export type ScriptNodeCatalogSource =
  | "scripts-catalog"
  | "ops-config-catalog"
  | "workflow-catalog"
  | "contract-fallback";

export type ScriptNodeCatalog = {
  source: ScriptNodeCatalogSource;
  languages: string[];
  nodes: ScriptNodeEngineContract[];
  errors: ScriptNodeErrorShape[];
  permissions: string[];
  publish: ScriptPublishRules;
  isolation?: ScriptIsolationRules;
  hooks?: Record<string, string>;
  notes?: string;
};

export type ScriptArtifact = {
  id: string;
  language: string;
  entrypoint: string;
  digest: string;
  signature: string;
  scanStatus: string;
  status: string;
  runtimeProfileId?: string;
  runtimeProfileVersionId?: string;
  runtimeProfileDigest?: string;
  sourceBytes?: number;
  metadata?: Record<string, unknown>;
  createdBy?: string;
  createdAt?: string;
  revokedAt?: string;
};

export type ScriptVersionPin = {
  workflowVersionId: string;
  nodeId: string;
  nodeType?: string;
  artifactId: string;
  digest: string;
  scanStatus: string;
  signature?: string;
  language?: string;
  entrypoint?: string;
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
  source: "version" | "scripts-catalog" | "contract-fallback";
};

export const DEFAULT_SCRIPT_PUBLISH_RULES: ScriptPublishRules = {
  requiredWith: ["source", "entrypoint", "runtimeProfileId", "timeoutSeconds"],
  allowedLanguages: ["python", "go"],
  sourceVisibleInYAML: true,
  secretsForbiddenInYAML: true,
  draftsCannotExecute: true,
  mutableArtifactsRejected: true,
  unscannedRejected: true,
  unsignedRejected: true,
  failedScanRejected: true,
  publishedRevisionsPinned: true,
  digestPinnedRuntime: true,
  maxSourceBytes: SCRIPT_MAX_SOURCE_BYTES,
  maxTimeoutSeconds: SCRIPT_MAX_TIMEOUT_SECONDS,
};

export const DEFAULT_SCRIPT_ISOLATION: ScriptIsolationRules = {
  nonRoot: true,
  readOnlyRootFS: true,
  droppedCapabilities: true,
  noNewPrivs: true,
  noMetadataService: true,
  noHostDockerSocket: true,
  runtimePackageInstall: false,
  approvedImagesOnly: true,
  note: "E9.2 implements the isolated runner. E9.1 only packages, scans, signs, and pins.",
  hooks: ["VerifyForDispatch", "RunnerNotImplemented"],
};

export const DEFAULT_SCRIPT_NODE_ERRORS: ScriptNodeErrorShape[] = [
  { code: "invalid-source", status: 400, meaning: "Source is missing, not UTF-8, the wrong language shape, or exceeds 64 KiB." },
  { code: "invalid-entrypoint", status: 400, meaning: "Entrypoint is empty, a path, or does not match the language (main.py / main.go)." },
  { code: "invalid-runtime-profile", status: 400, meaning: "Runtime profile is missing, unpublished, or not digest-pinned." },
  { code: "language-mismatch", status: 400, meaning: SCRIPT_PROFILE_LANGUAGE_MESSAGE },
  { code: "invalid-schema", status: 400, meaning: "inputSchema or outputSchema is not the documented JSON Schema subset." },
  { code: "secret-forbidden", status: 400, meaning: SCRIPT_SECRET_WITH_MESSAGE },
  { code: "size-limit", status: 400, meaning: "Source, timeout, or resource limit exceeded the documented cap." },
  { code: "artifact-mutable", status: 400, meaning: "A draft or unsigned package cannot be executed. Publish first." },
  { code: "artifact-unscanned", status: 400, meaning: "Artifact scanStatus is pending or missing." },
  { code: "artifact-unsigned", status: 400, meaning: "Artifact signature is missing or does not verify." },
  { code: "artifact-scan-failed", status: 400, meaning: "Artifact scanStatus is failed." },
  { code: "artifact-revoked", status: 409, meaning: "E9.4: revoked artifacts cannot start. Hook only in E9.1." },
  { code: "permission-denied", status: 403, meaning: "Missing workflow.execute, script.run, or runtimeProfile.use." },
  { code: "runner-not-implemented", status: 501, meaning: "E9.2 isolated runner is not enabled." },
  { code: "typed-io-not-implemented", status: 501, meaning: "E9.3 typed I/O execution is not enabled." },
  { code: "revocation-not-implemented", status: 501, meaning: "E9.4 revocation API is not enabled." },
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

export function isScriptRuntimeProfileSpec(
  spec: { engine?: unknown; language?: unknown } | null | undefined,
): boolean {
  const engine = String(spec?.engine ?? "").trim().toLowerCase();
  if (engine) {
    return engine === SCRIPT_RUNTIME_PROFILE_ENGINE;
  }
  const language = runtimeProfileLanguage(spec);
  return language === "python" || language === "go" || language === "";
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
      required: true,
      label: "Timeout (seconds)",
      controlHint: "number",
      defaultValue: SCRIPT_DEFAULT_TIMEOUT_SECONDS,
      description: `Required. Bounded run timeout (${SCRIPT_MIN_TIMEOUT_SECONDS}–${SCRIPT_MAX_TIMEOUT_SECONDS}). Default ${SCRIPT_DEFAULT_TIMEOUT_SECONDS}.`,
    },
    {
      name: "memoryMiB",
      kind: "integer",
      label: "Memory (MiB)",
      controlHint: "number",
      defaultValue: SCRIPT_DEFAULT_MEMORY_MIB,
      description: `Optional. Bounded memory (${SCRIPT_MIN_MEMORY_MIB}–${SCRIPT_MAX_MEMORY_MIB}). Must not exceed the pinned profile.`,
    },
    {
      name: "cpuMillis",
      kind: "integer",
      label: "CPU (millicores)",
      controlHint: "number",
      advanced: true,
      description: `Optional CPU millicores (${SCRIPT_MIN_CPU_MILLIS}–${SCRIPT_MAX_CPU_MILLIS}). Must not exceed the pinned profile.`,
    },
    {
      name: "processes",
      kind: "integer",
      label: "Processes",
      controlHint: "number",
      advanced: true,
      description: `Optional process cap (${SCRIPT_MIN_PROCESSES}–${SCRIPT_MAX_PROCESSES}). Must not exceed the pinned profile.`,
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
          field.name === "cpuMillis" ||
          field.name === "processes" ||
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
    if ((SCRIPT_STRIP_WITH_KEYS as readonly string[]).includes(key)) {
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
  return !(SCRIPT_STRIP_WITH_KEYS as readonly string[]).includes(name);
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
    if (forbidden.some((key) => key === "command" || key === "shell")) {
      errors.push("command and shell are not script node fields. Author source + entrypoint only.");
    }
    if (
      forbidden.some((key) =>
        ["env", "environment", "secrets", "credentials", "privateKey", "token", "password", "kubeconfig"].includes(
          key,
        ),
      )
    ) {
      errors.push(SCRIPT_SECRET_WITH_MESSAGE);
    }
  }
  if (
    "image" in withValue ||
    "baseImage" in withValue ||
    "dockerfile" in withValue ||
    "imageDigest" in withValue
  ) {
    errors.push(SCRIPT_ARBITRARY_IMAGE_MESSAGE);
  }
  if (
    "packages" in withValue ||
    "requirements" in withValue ||
    "pip" in withValue ||
    "goGet" in withValue
  ) {
    errors.push(SCRIPT_PACKAGE_INSTALL_MESSAGE);
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
    if (new TextEncoder().encode(source).length > SCRIPT_MAX_SOURCE_BYTES) {
      errors.push(`source exceeds ${SCRIPT_MAX_SOURCE_BYTES} bytes.`);
    }
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
  } else if (!isValidScriptEntrypoint(type, entrypoint)) {
    errors.push(SCRIPT_ENTRYPOINT_INVALID_MESSAGE);
  }

  if (withValue.timeoutSeconds === undefined || withValue.timeoutSeconds === "") {
    errors.push(SCRIPT_TIMEOUT_REQUIRED_MESSAGE);
  } else {
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

  if (withValue.cpuMillis !== undefined) {
    const cpu = Number(withValue.cpuMillis);
    if (
      !Number.isFinite(cpu) ||
      cpu < SCRIPT_MIN_CPU_MILLIS ||
      cpu > SCRIPT_MAX_CPU_MILLIS
    ) {
      errors.push(
        `cpuMillis must be between ${SCRIPT_MIN_CPU_MILLIS} and ${SCRIPT_MAX_CPU_MILLIS}.`,
      );
    }
  }
  if (withValue.processes !== undefined) {
    const processes = Number(withValue.processes);
    if (
      !Number.isFinite(processes) ||
      processes < SCRIPT_MIN_PROCESSES ||
      processes > SCRIPT_MAX_PROCESSES
    ) {
      errors.push(
        `processes must be between ${SCRIPT_MIN_PROCESSES} and ${SCRIPT_MAX_PROCESSES}.`,
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

export function isValidScriptEntrypoint(type: string, entrypoint: string): boolean {
  if (!entrypoint || entrypoint.includes("/") || entrypoint.includes("\\") || entrypoint.includes("..")) {
    return false;
  }
  if (type === SCRIPT_PYTHON_TYPE) {
    return /^[A-Za-z][A-Za-z0-9._-]*\.py$/.test(entrypoint);
  }
  if (type === SCRIPT_GO_TYPE) {
    return (
      /^[A-Za-z][A-Za-z0-9._-]*\.go$/.test(entrypoint) ||
      /^[A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*$/.test(entrypoint)
    );
  }
  return false;
}

export function yamlHasScriptNodes(yaml: string): boolean {
  return /type:\s*script\.(python|go)\b/.test(yaml);
}

export function scriptArtifactStatus(input: {
  dirty?: boolean;
  hasPublishedVersion?: boolean;
  version?: WorkflowVersion | Record<string, unknown> | null;
  scriptArtifacts?: readonly ScriptVersionPin[] | null;
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
  const pins = (input.scriptArtifacts ?? []).filter((item) => item.artifactId);
  if (pins.length > 0) {
    const failed = pins.find(
      (item) =>
        item.scanStatus === "failed" ||
        item.scanStatus === "unsigned" ||
        !item.digest,
    );
    const pending = pins.find(
      (item) => item.scanStatus === "pending" || item.scanStatus === "scanning",
    );
    const unsigned = pins.find((item) => !item.signature);
    if (failed) {
      return {
        kind: "rejected",
        label: "Artifact rejected",
        help:
          failed.scanStatus === "failed"
            ? "scanStatus is failed. Mutable or failed-scan artifacts cannot run."
            : SCRIPT_MUTABLE_REJECT_HELP,
        digest: failed.digest,
        scanStatus: failed.scanStatus,
        source: "version",
      };
    }
    if (pending) {
      return {
        kind: "scanning",
        label: "Scan in progress",
        help: "Publish packaged the source. Execution waits for a clean signed scan.",
        digest: pending.digest,
        scanStatus: pending.scanStatus,
        source: "version",
      };
    }
    if (unsigned) {
      return {
        kind: "rejected",
        label: "Unsigned artifact",
        help: "Artifact signature is missing. Execution requires a signed, scanned pin.",
        digest: unsigned.digest,
        scanStatus: unsigned.scanStatus,
        source: "version",
      };
    }
    const clean = pins.find((item) => item.scanStatus === "clean" && item.digest);
    return {
      kind: "signed-pinned",
      label: "Signed and pinned",
      help: SCRIPT_DRAFT_NOT_EXECUTABLE_HELP,
      digest: clean?.digest ?? pins[0]?.digest,
      scanStatus: clean?.scanStatus ?? pins[0]?.scanStatus,
      source: "version",
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
    label: "Published — no script artifact pin",
    help: `${SCRIPT_PUBLISH_BOUNDARY_HELP} Inspect GET …/versions/{v}/script-artifacts after publish.`,
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
  const languages = stringList(nested.languages ?? rec.languages);
  const publish = parsePublishRules(nested.publishRules ?? rec.publishRules);
  const isolation = parseIsolation(nested.isolation ?? rec.isolation);
  const hooks = parseHooks(nested.hooks ?? rec.hooks);
  if (nodes.length === 0 && errors.length === 0 && permissions.length === 0) {
    return { ...SCRIPT_NODE_CONTRACT_FALLBACK_CATALOG };
  }
  const source: ScriptNodeCatalogSource =
    rec.scriptEngine && typeof rec.scriptEngine === "object"
      ? "ops-config-catalog"
      : nodes.length > 0
        ? "scripts-catalog"
        : "contract-fallback";
  return {
    source,
    languages: languages.length ? languages : ["python", "go"],
    nodes: nodes.length ? nodes : SCRIPT_NODE_CONTRACT_FALLBACK_CATALOG.nodes,
    errors: errors.length ? errors : DEFAULT_SCRIPT_NODE_ERRORS,
    permissions: permissions.length ? permissions : [...SCRIPT_NODE_PERMISSIONS],
    publish,
    isolation,
    hooks,
    notes:
      String(nested.notes ?? rec.notes ?? "").trim() ||
      (nodes.length ? undefined : SCRIPT_CONTRACT_FALLBACK_HELP),
  };
}

export const SCRIPT_NODE_CONTRACT_FALLBACK_CATALOG: ScriptNodeCatalog = {
  source: "contract-fallback",
  languages: ["python", "go"],
  nodes: [
    {
      type: SCRIPT_PYTHON_TYPE,
      language: "python",
      title: "Run Python script",
      description:
        "Publish approved Python source as a signed, scanned, content-addressed artifact. Execution uses the pinned digest, not draft source.",
      permissions: [...SCRIPT_NODE_PERMISSIONS],
      requiredWith: ["source", "entrypoint", "runtimeProfileId", "timeoutSeconds"],
      allowedWith: [],
      outputs: ["result"],
      sideEffects: true,
      retrySafe: false,
      defaultMaxAttempts: 0,
    },
    {
      type: SCRIPT_GO_TYPE,
      language: "go",
      title: "Run Go script",
      description:
        "Publish approved Go source as a signed, scanned, content-addressed artifact. The E9.2 runner builds a signed binary from this digest.",
      permissions: [...SCRIPT_NODE_PERMISSIONS],
      requiredWith: ["source", "entrypoint", "runtimeProfileId", "timeoutSeconds"],
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
  isolation: DEFAULT_SCRIPT_ISOLATION,
  hooks: {
    "E9.2": "isolated runner (VerifyForDispatch before exec)",
    "E9.3": "typed I/O + scoped handles + output redaction",
    "E9.4": "artifact revocation + emergency stop",
  },
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
    requiredWith: ["source", "entrypoint", "runtimeProfileId", "timeoutSeconds"],
    allowedWith: fieldsToAllowed(type),
  };
}

const SCRIPT_CONTRACT_FALLBACK: Record<string, CatalogNode> = {
  "script.python": {
    type: SCRIPT_PYTHON_TYPE,
    phase: CATALOG_PHASE_CORE,
    title: "Run Python script",
    description:
      "Publish approved Python source as a signed, scanned, content-addressed artifact. Execution uses the pinned digest, not draft source.",
    inputs: [
      inherit("input", "object", false, "Validated JSON input. Secrets are scoped handles, never plaintext."),
    ],
    outputs: [
      inherit("result", "object", false, "Redacted result matching the declared output schema."),
    ],
    requiredWith: ["source", "entrypoint", "runtimeProfileId", "timeoutSeconds"],
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
    title: "Run Go script",
    description:
      "Publish approved Go source as a signed, scanned, content-addressed artifact. The E9.2 runner builds a signed binary from this digest.",
    inputs: [
      inherit("input", "object", false, "Validated JSON input. Secrets are scoped handles, never plaintext."),
    ],
    outputs: [
      inherit("result", "object", false, "Redacted result matching the declared output schema."),
    ],
    requiredWith: ["source", "entrypoint", "runtimeProfileId", "timeoutSeconds"],
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
    language: String(rec.language ?? "").trim() || expectedRuntimeLanguage(type),
    title:
      String(rec.title ?? "").trim() ||
      (type === SCRIPT_GO_TYPE ? "Run Go script" : "Run Python script"),
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

function parsePublishRules(raw: unknown): ScriptPublishRules {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_SCRIPT_PUBLISH_RULES };
  }
  const rec = raw as Record<string, unknown>;
  return {
    requiredWith: stringList(rec.requiredWith).length
      ? stringList(rec.requiredWith)
      : DEFAULT_SCRIPT_PUBLISH_RULES.requiredWith,
    allowedLanguages: stringList(rec.allowedLanguages).length
      ? stringList(rec.allowedLanguages)
      : DEFAULT_SCRIPT_PUBLISH_RULES.allowedLanguages,
    sourceVisibleInYAML: rec.sourceVisibleInYAML !== false,
    secretsForbiddenInYAML: rec.secretsForbiddenInYAML !== false,
    draftsCannotExecute: rec.draftsCannotExecute !== false,
    mutableArtifactsRejected: rec.mutableArtifactsRejected !== false,
    unscannedRejected: rec.unscannedRejected !== false,
    unsignedRejected: rec.unsignedRejected !== false,
    failedScanRejected: rec.failedScanRejected !== false,
    publishedRevisionsPinned: rec.publishedRevisionsPinned !== false,
    digestPinnedRuntime: rec.digestPinnedRuntime !== false,
    maxSourceBytes: Number.isFinite(Number(rec.maxSourceBytes))
      ? Number(rec.maxSourceBytes)
      : SCRIPT_MAX_SOURCE_BYTES,
    maxTimeoutSeconds: Number.isFinite(Number(rec.maxTimeoutSeconds))
      ? Number(rec.maxTimeoutSeconds)
      : SCRIPT_MAX_TIMEOUT_SECONDS,
  };
}

function parseIsolation(raw: unknown): ScriptIsolationRules {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_SCRIPT_ISOLATION };
  }
  const rec = raw as Record<string, unknown>;
  return {
    nonRoot: rec.nonRoot !== false,
    readOnlyRootFS: rec.readOnlyRootFS !== false,
    droppedCapabilities: rec.droppedCapabilities !== false,
    noNewPrivs: rec.noNewPrivs !== false,
    noMetadataService: rec.noMetadataService !== false,
    noHostDockerSocket: rec.noHostDockerSocket !== false,
    runtimePackageInstall: rec.runtimePackageInstall === true,
    approvedImagesOnly: rec.approvedImagesOnly !== false,
    note: String(rec.note ?? "").trim() || DEFAULT_SCRIPT_ISOLATION.note,
    hooks: stringList(rec.hooks).length
      ? stringList(rec.hooks)
      : DEFAULT_SCRIPT_ISOLATION.hooks,
  };
}

function parseHooks(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && value.trim()) {
      out[key] = value.trim();
    }
  }
  return Object.keys(out).length ? out : undefined;
}

export function artifactHasForbiddenBlob(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return false;
  }
  const rec = raw as Record<string, unknown>;
  return SCRIPT_ARTIFACT_SECRET_KEYS.some((key) => key in rec);
}

export function stripScriptArtifactSecrets(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if ((SCRIPT_ARTIFACT_SECRET_KEYS as readonly string[]).includes(key)) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function parseScriptArtifact(raw: unknown): ScriptArtifact | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const rec = stripScriptArtifactSecrets(raw as Record<string, unknown>);
  const id = String(rec.id ?? "").trim();
  const digest = String(rec.digest ?? "").trim();
  if (!id || !digest) {
    return null;
  }
  return {
    id,
    language: String(rec.language ?? "").trim(),
    entrypoint: String(rec.entrypoint ?? "").trim(),
    digest,
    signature: String(rec.signature ?? "").trim(),
    scanStatus: String(rec.scanStatus ?? "").trim(),
    status: String(rec.status ?? "").trim(),
    runtimeProfileId: firstString(rec.runtimeProfileId),
    runtimeProfileVersionId: firstString(rec.runtimeProfileVersionId),
    runtimeProfileDigest: firstString(rec.runtimeProfileDigest),
    sourceBytes: Number.isFinite(Number(rec.sourceBytes))
      ? Number(rec.sourceBytes)
      : undefined,
    metadata:
      rec.metadata && typeof rec.metadata === "object" && !Array.isArray(rec.metadata)
        ? stripScriptArtifactSecrets(rec.metadata as Record<string, unknown>)
        : undefined,
    createdBy: firstString(rec.createdBy),
    createdAt: firstString(rec.createdAt),
    revokedAt: firstString(rec.revokedAt),
  };
}

export function parseScriptVersionPin(raw: unknown): ScriptVersionPin | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const rec = stripScriptArtifactSecrets(raw as Record<string, unknown>);
  const artifactId = String(rec.artifactId ?? "").trim();
  const digest = String(rec.digest ?? "").trim();
  const nodeId = String(rec.nodeId ?? "").trim();
  if (!artifactId || !digest || !nodeId) {
    return null;
  }
  return {
    workflowVersionId: String(rec.workflowVersionId ?? "").trim(),
    nodeId,
    nodeType: firstString(rec.nodeType),
    artifactId,
    digest,
    scanStatus: String(rec.scanStatus ?? "").trim(),
    signature: firstString(rec.signature),
    language: firstString(rec.language),
    entrypoint: firstString(rec.entrypoint),
  };
}

export function parseScriptVersionPins(raw: unknown): ScriptVersionPin[] {
  const items = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { items?: unknown }).items)
      ? (raw as { items: unknown[] }).items
      : [];
  return items
    .map(parseScriptVersionPin)
    .filter((item): item is ScriptVersionPin => item !== null);
}

export function buildScriptPublishBody(input: {
  language: "python" | "go";
  source: string;
  entrypoint: string;
  runtimeProfileId: string;
  runtimeProfileVersionId?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  timeoutSeconds?: number;
  memoryMiB?: number;
  cpuMillis?: number;
  processes?: number;
}): Record<string, unknown> {
  return stripScriptForbiddenWith({
    language: input.language,
    source: input.source,
    entrypoint: input.entrypoint,
    runtimeProfileId: input.runtimeProfileId,
    ...(input.runtimeProfileVersionId
      ? { runtimeProfileVersionId: input.runtimeProfileVersionId }
      : {}),
    ...(input.inputSchema ? { inputSchema: input.inputSchema } : {}),
    ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
    timeoutSeconds: input.timeoutSeconds ?? SCRIPT_DEFAULT_TIMEOUT_SECONDS,
    ...(input.memoryMiB !== undefined ? { memoryMiB: input.memoryMiB } : {}),
    ...(input.cpuMillis !== undefined ? { cpuMillis: input.cpuMillis } : {}),
    ...(input.processes !== undefined ? { processes: input.processes } : {}),
  });
}

export function retargetScriptApiPath(uiApiPath: string): string {
  return uiApiPath;
}

export function isScriptProxySegments(segments: string[]): boolean {
  return (
    segments[0] === "scripts" ||
    (segments[0] === "workflows" &&
      segments[2] === "versions" &&
      segments[4] === "script-artifacts")
  );
}

export type ScriptProxyRoute = {
  methods: readonly string[];
  match: (segments: string[]) => boolean;
};

export const SCRIPT_PROXY_ROUTES: readonly ScriptProxyRoute[] = [
  {
    methods: ["GET"],
    match: (s) => s.length === 2 && s[0] === "scripts" && s[1] === "catalog",
  },
  {
    methods: ["GET", "POST"],
    match: (s) => s.length === 1 && s[0] === "scripts",
  },
  {
    methods: ["GET"],
    match: (s) => s.length === 2 && s[0] === "scripts" && isResourceId(s[1]),
  },
  {
    methods: ["GET"],
    match: (s) =>
      s.length === 5 &&
      s[0] === "workflows" &&
      isResourceId(s[1]) &&
      s[2] === "versions" &&
      isResourceId(s[3]) &&
      s[4] === "script-artifacts",
  },
];

