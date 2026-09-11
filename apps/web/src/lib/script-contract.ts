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

import {
  CATALOG_SOURCE_UNAVAILABLE,
  ENGINE_CATALOG_UNAVAILABLE_HELP,
} from "./catalog-fail-closed.ts";
import { isResourceId } from "./identity-proxy-ids.ts";
import { validateScriptIoNodeExtras } from "./script-io-contract.ts";
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
  "Execute fails closed: drafts, mutable, unscanned, unsigned, scan-failed, or revoked artifacts cannot start. Revoked pins return 409 artifact-revoked at start, claim, and heartbeat. Dispatch needs script.run plus runtimeProfile.use. Isolated runners are server-enforced (E9.2 / #98).";

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
  "Resource limits and timeout are bounded. Inputs arrive as validated JSON against the declared schema and size bound; outputs must match too and are redacted.",
  "Credential handles are short-lived, scoped, and injected at runtime — never authored into source, schema, YAML, or logs.",
  "Retries default to zero. Retry-safe only with an idempotency key plus verification. Lease loss is indeterminate — never a blind re-run. Retry is shown only when result.retry.allowed is true.",
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
  controlHint: "text" | "textarea" | "enum" | "uuid" | "number" | "boolean" | "object-lines" | "json";
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
  revokedRejected: boolean;
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
  uid?: number;
  gid?: number;
  ephemeralWorkspace?: string;
  dropCapabilityNames?: string[];
  allowPrivilegeEscalation?: boolean;
  noServiceAccountMount?: boolean;
  defaultDenyEgress?: boolean;
  dnsConstrained?: boolean;
  metadataCIDRs?: string[];
  ciHarness?: string;
  kubernetesManifests?: string[];
  note: string;
  hooks: string[];
};

export type ScriptNodeCatalogSource =
  | "scripts-catalog"
  | "ops-config-catalog"
  | "workflow-catalog"
  | "unavailable";

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
  /** Additive E9.3 overlay from GET /scripts/catalog. Parsed by script-io-contract. */
  io?: Record<string, unknown>;
  retry?: Record<string, unknown>;
  /** Additive E9.4 overlay from GET /scripts/catalog. Parsed by script-ops-contract. */
  revocation?: Record<string, unknown>;
  emergencyStop?: Record<string, unknown>;
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
  revokedBy?: string;
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
  revokedAt?: string;
  status?: string;
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
  | "rejected"
  | "revoked";

export type ScriptArtifactStatus = {
  kind: ScriptArtifactKind;
  label: string;
  help: string;
  digest?: string;
  scanStatus?: string;
  revokedAt?: string;
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
  revokedRejected: true,
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
  uid: 65532,
  gid: 65532,
  ephemeralWorkspace: "/workspace",
  dropCapabilityNames: ["ALL"],
  allowPrivilegeEscalation: false,
  noServiceAccountMount: true,
  defaultDenyEgress: true,
  dnsConstrained: true,
  ciHarness:
    "HarnessRuntime enforces UID/FS/caps/no_new_privs/metadata/egress/limits/package-install without starting a container.",
  kubernetesManifests: [
    "deploy/kubernetes/script-runner-deployment.yaml",
    "deploy/kubernetes/script-runner-networkpolicy.yaml",
  ],
  note: "E9.2 isolated runner. VerifyForDispatch then Execute. Typed I/O is E9.3; revocation is E9.4.",
  hooks: ["VerifyForDispatch", "Execute", "IsolationSpec"],
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
  { code: "artifact-revoked", status: 409, meaning: "Revoked artifacts cannot start. Rechecked at start, claim, heartbeat-before-dispatch, and Execute." },
  { code: "permission-denied", status: 403, meaning: "Missing workflow.execute, script.run, or runtimeProfile.use." },
  { code: "isolation-denied", status: 403, meaning: "Requested runner environment violates isolation (UID, FS, caps, mounts)." },
  { code: "root-denied", status: 403, meaning: "Runner UID/GID must be non-root (65532)." },
  { code: "writable-rootfs-denied", status: 403, meaning: "Root filesystem is read-only; only /workspace is writable." },
  { code: "capability-denied", status: 403, meaning: "All Linux capabilities are dropped." },
  { code: "privilege-escalation-denied", status: 403, meaning: "no_new_privs is required; privilege escalation is denied." },
  { code: "metadata-denied", status: 403, meaning: "Cloud instance metadata (169.254.169.254 and equivalents) is denied." },
  { code: "egress-denied", status: 403, meaning: "Destination is outside the default-deny egress allowlist, or DNS is unconstrained." },
  { code: "package-install-denied", status: 403, meaning: "Runtime package installation is denied." },
  { code: "image-denied", status: 400, meaning: "Arbitrary or mutable base images are denied. imageDigest must be sha256:<hex>." },
  { code: "docker-socket-denied", status: 403, meaning: "Host Docker socket is denied." },
  { code: "service-account-denied", status: 403, meaning: "Kubernetes service-account mounts are denied (MVP)." },
  { code: "resource-limit", status: 400, meaning: "CPU, memory, process, or time limit exceeded the pinned runtime profile." },
  { code: "input-rejected", status: 400, meaning: "Execution input failed schema, size, or secret checks before inject." },
  { code: "output-too-large", status: 400, meaning: "Runner output exceeded the 16 KiB persist cap." },
  { code: "handle-forbidden", status: 403, meaning: "Credential handle missing, expired, unscoped, or contained plaintext. Handles only." },
  { code: "env-denied", status: 403, meaning: "Runtime env key is outside the FLOWFORGE_* allowlist, or plaintext credentials were supplied as env." },
  { code: "retry-denied", status: 400, meaning: "retryPolicy.maxAttempts>0 without retrySafe+idempotencyKey+verification, or a step retry that is not allowed. HTTP execution retry uses 409 retry-denied." },
  { code: "invalid-verification", status: 400, meaning: "retrySafe=true without a valid idempotency key or verification.behavior." },
  { code: "indeterminate", status: 409, meaning: "Lease lost after dispatch, unknown provider outcome, uncertain emergency stop, or verification could not confirm state. Never a silent re-run." },
  { code: "emergency-stopped", status: 409, meaning: "Emergency stop halted the script before dispatch. The runner was not started." },
  { code: "emergency-stop-denied", status: 403, meaning: "Missing script.emergencyStop or kind=script policy denies emergency stop." },
  { code: "runner-not-implemented", status: 501, meaning: "Live container runtime requested but only the CI harness is available." },
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
  scriptCatalog?: ScriptNodeCatalog | null,
): readonly string[] {
  const types = new Set<string>();
  for (const node of catalog?.nodes ?? []) {
    if (
      isScriptConfigurableType(node.type) &&
      isCatalogImplementationEnabled(node)
    ) {
      types.add(node.type);
    }
  }
  if (scriptCatalog && scriptCatalog.source !== "unavailable") {
    for (const node of scriptCatalog.nodes) {
      if (isScriptConfigurableType(node.type)) {
        types.add(node.type);
      }
    }
  }
  return [...types];
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
    retryPolicy: { maxAttempts: 0 },
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
  if (!engineNode?.allowedWith.length) {
    return [];
  }
  return overlayScriptFields(engineNode.allowedWith, type);
}

function scriptFieldChrome(name: string, type: string): Partial<ScriptNodeWithField> {
  switch (name) {
    case "runtimeProfileId":
      return { label: "Runtime profile", controlHint: "uuid" };
    case "source":
      return {
        label: `${type === SCRIPT_GO_TYPE ? "Go" : "Python"} source`,
        controlHint: "textarea",
      };
    case "entrypoint":
      return {
        label: "Entrypoint",
        controlHint: "text",
        defaultValue: defaultScriptEntrypoint(type),
      };
    case "timeoutSeconds":
      return {
        label: "Timeout (seconds)",
        controlHint: "number",
        defaultValue: SCRIPT_DEFAULT_TIMEOUT_SECONDS,
      };
    case "memoryMiB":
      return {
        label: "Memory (MiB)",
        controlHint: "number",
        defaultValue: SCRIPT_DEFAULT_MEMORY_MIB,
      };
    case "cpuMillis":
      return { label: "CPU (millicores)", controlHint: "number", advanced: true };
    case "processes":
      return { label: "Processes", controlHint: "number", advanced: true };
    case "inputSchema":
      return { label: "Input schema", controlHint: "json" };
    case "outputSchema":
      return { label: "Output schema", controlHint: "json" };
    case "retrySafe":
      return { label: "Retry-safe", controlHint: "boolean", defaultValue: false };
    case "idempotencyKey":
      return { label: "Idempotency key", controlHint: "text" };
    case "verification":
      return { label: "Verification hook", controlHint: "json" };
    case "retryPolicy":
      return {
        label: "Retry policy",
        controlHint: "object-lines",
        defaultValue: { maxAttempts: 0 },
      };
    case "policyId":
      return { label: "Policy", controlHint: "uuid", advanced: true };
    default:
      return {};
  }
}

export function overlayScriptFields(
  fields: CatalogWithField[],
  type: string,
): ScriptNodeWithField[] {
  return fields
    .filter((field) => !scriptForbiddenWithKeys({ [field.name]: true }).length)
    .map((field) => {
      const chrome = scriptFieldChrome(field.name, type);
      const controlHint =
        chrome.controlHint ??
        (field.kind === "uuid"
          ? "uuid"
          : field.kind === "integer"
            ? "number"
            : field.kind === "boolean"
              ? "boolean"
              : field.kind === "object"
              ? field.name === "inputSchema" ||
                field.name === "outputSchema" ||
                field.name === "verification"
                ? "json"
                : "object-lines"
              : field.enum?.length
                ? "enum"
                : field.name === "source"
                  ? "textarea"
                  : "text");
      return {
        name: field.name,
        kind: field.kind,
        required: field.required === true,
        enum: field.enum?.length ? field.enum : chrome.enum,
        description: field.description || chrome.description || "",
        label: chrome.label || field.name,
        advanced:
          field.name === "policyId" ||
          field.name === "cpuMillis" ||
          field.name === "processes" ||
          chrome.advanced,
        readOnly: chrome.readOnly,
        controlHint,
        defaultValue: chrome.defaultValue,
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

  errors.push(...validateScriptIoNodeExtras(withValue));

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
  artifacts?: readonly ScriptArtifact[] | null;
}): ScriptArtifactStatus {
  const revokedPin = (input.scriptArtifacts ?? []).find((item) => {
    if (item.revokedAt || item.status === "revoked") {
      return true;
    }
    return (input.artifacts ?? []).some(
      (artifact) => artifact.id === item.artifactId && Boolean(artifact.revokedAt),
    );
  });
  const revokedArtifact = (input.artifacts ?? []).find((item) => item.revokedAt);
  if (revokedPin || revokedArtifact) {
    return {
      kind: "revoked",
      label: "Revoked — cannot start",
      help: "This pinned digest is revoked. New starts fail closed with 409 artifact-revoked. Dispatch rechecks signature, scan, and revokedAt. Already-running executions use emergency stop.",
      digest: revokedPin?.digest ?? revokedArtifact?.digest,
      scanStatus: revokedPin?.scanStatus ?? revokedArtifact?.scanStatus,
      revokedAt: revokedPin?.revokedAt ?? revokedArtifact?.revokedAt,
      source: "version",
    };
  }
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

export function adaptScriptNodeEntries(
  catalog: WorkflowCatalog | null | undefined,
  scriptCatalog?: ScriptNodeCatalog | null,
): CatalogNode[] {
  return scriptLibraryTypes(catalog, scriptCatalog).flatMap((type) => {
    const listed = (catalog?.nodes ?? []).find((item) => item.type === type);
    const engine = scriptNodeContract(type, scriptCatalog);
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
        policy: listed?.policy ?? null,
        bounds: listed?.bounds ?? null,
        redaction: listed?.redaction ?? null,
      },
    ];
  });
}

export function parseScriptNodeCatalog(raw: unknown): ScriptNodeCatalog {
  if (!raw || typeof raw !== "object") {
    return { ...SCRIPT_NODE_UNAVAILABLE_CATALOG };
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
    return { ...SCRIPT_NODE_UNAVAILABLE_CATALOG };
  }
  const source: ScriptNodeCatalogSource =
    rec.scriptEngine && typeof rec.scriptEngine === "object"
      ? "ops-config-catalog"
      : nodes.length > 0
        ? "scripts-catalog"
        : "unavailable";
  return {
    source,
    languages,
    nodes,
    errors,
    permissions,
    publish,
    isolation,
    hooks,
    notes:
      String(nested.notes ?? rec.notes ?? "").trim() ||
      (nodes.length ? undefined : SCRIPT_CONTRACT_FALLBACK_HELP),
    io:
      nested.io && typeof nested.io === "object" && !Array.isArray(nested.io)
        ? (nested.io as Record<string, unknown>)
        : rec.io && typeof rec.io === "object" && !Array.isArray(rec.io)
          ? (rec.io as Record<string, unknown>)
          : undefined,
    retry:
      nested.retry && typeof nested.retry === "object" && !Array.isArray(nested.retry)
        ? (nested.retry as Record<string, unknown>)
        : rec.retry && typeof rec.retry === "object" && !Array.isArray(rec.retry)
          ? (rec.retry as Record<string, unknown>)
          : undefined,
    revocation:
      nested.revocation &&
      typeof nested.revocation === "object" &&
      !Array.isArray(nested.revocation)
        ? (nested.revocation as Record<string, unknown>)
        : rec.revocation &&
            typeof rec.revocation === "object" &&
            !Array.isArray(rec.revocation)
          ? (rec.revocation as Record<string, unknown>)
          : undefined,
    emergencyStop:
      nested.emergencyStop &&
      typeof nested.emergencyStop === "object" &&
      !Array.isArray(nested.emergencyStop)
        ? (nested.emergencyStop as Record<string, unknown>)
        : rec.emergencyStop &&
            typeof rec.emergencyStop === "object" &&
            !Array.isArray(rec.emergencyStop)
          ? (rec.emergencyStop as Record<string, unknown>)
          : undefined,
  };
}

export const SCRIPT_NODE_UNAVAILABLE_CATALOG: ScriptNodeCatalog = {
  source: CATALOG_SOURCE_UNAVAILABLE,
  languages: [],
  nodes: [],
  errors: [],
  permissions: [],
  publish: DEFAULT_SCRIPT_PUBLISH_RULES,
  notes: ENGINE_CATALOG_UNAVAILABLE_HELP,
};

/** @deprecated R3.4 — empty fail-closed catalog. Kept for import compatibility. */
export const SCRIPT_NODE_CONTRACT_FALLBACK_CATALOG = SCRIPT_NODE_UNAVAILABLE_CATALOG;

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
    revokedRejected: rec.revokedRejected !== false,
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
  const uid = Number(rec.uid);
  const gid = Number(rec.gid);
  return {
    nonRoot: rec.nonRoot !== false,
    readOnlyRootFS: rec.readOnlyRootFS !== false,
    droppedCapabilities: rec.droppedCapabilities !== false,
    noNewPrivs: rec.noNewPrivs !== false,
    noMetadataService: rec.noMetadataService !== false,
    noHostDockerSocket: rec.noHostDockerSocket !== false,
    runtimePackageInstall: rec.runtimePackageInstall === true,
    approvedImagesOnly: rec.approvedImagesOnly !== false,
    uid: Number.isInteger(uid) && uid > 0 ? uid : DEFAULT_SCRIPT_ISOLATION.uid,
    gid: Number.isInteger(gid) && gid > 0 ? gid : DEFAULT_SCRIPT_ISOLATION.gid,
    ephemeralWorkspace:
      String(rec.ephemeralWorkspace ?? "").trim() ||
      DEFAULT_SCRIPT_ISOLATION.ephemeralWorkspace,
    dropCapabilityNames: stringList(rec.dropCapabilityNames).length
      ? stringList(rec.dropCapabilityNames)
      : DEFAULT_SCRIPT_ISOLATION.dropCapabilityNames,
    allowPrivilegeEscalation: rec.allowPrivilegeEscalation === true,
    noServiceAccountMount: rec.noServiceAccountMount !== false,
    defaultDenyEgress: rec.defaultDenyEgress !== false,
    dnsConstrained: rec.dnsConstrained !== false,
    metadataCIDRs: stringList(rec.metadataCIDRs),
    ciHarness:
      String(rec.ciHarness ?? "").trim() || DEFAULT_SCRIPT_ISOLATION.ciHarness,
    kubernetesManifests: stringList(rec.kubernetesManifests).length
      ? stringList(rec.kubernetesManifests)
      : DEFAULT_SCRIPT_ISOLATION.kubernetesManifests,
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
    revokedBy: firstString(rec.revokedBy),
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
    revokedAt: firstString(rec.revokedAt),
    status: firstString(rec.status),
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

