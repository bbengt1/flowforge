/**
 * Single retarget adapter for Chloe's E9.2 runtime-profile UI.
 * Wired to jonny's **#98** map on `main` (`e92-#98`).
 *
 *   GET  /scripts/catalog                 additive isolation + errors[]
 *   GET  /ops-config/catalog              scriptEngine; optional egress
 *   GET|POST /runtime-profiles            E4.2 draft/publish verbs
 *   GET|PUT  /runtime-profiles/{id}/draft
 *   POST /runtime-profiles/{id}/publish|select|disable|enable
 *   GET  /runtime-profiles/{id}/versions[/{versionId}]
 *   POST /ops-config/select
 *
 * Spec: language (python|go), digest-pinned imageDigest +
 * dependencyLockDigest (sha256:<64 hex>),
 * limits.{cpuMillis,memoryMib,timeoutSeconds,processes}, optional
 * egress.destinations[{host,port,protocol}] + egress.dnsConstrained
 * (omitted = default-deny; metadata / loopback / * rejected).
 *
 * Cookie session + `X-CSRF-Token` on mutations. JSON camelCase. RFC 9457.
 * Host-supplied `id` / `workspaceId` → 400 UX. Isolation is
 * server-enforced; the UI authors/selects published profiles only.
 * No package-install / Docker socket / metadata toggles.
 *
 * Relates to #93 (already closed by #98) / Part of #91 — do not
 * re-close #93; keep epic #91 open. Do not change `apps/api`.
 */

import type {
  OpsConfigPin,
  OpsConfigSpec,
  OpsConfigSummary,
} from "./ops-config-types.ts";
import type { ProblemDetails } from "./problem.ts";
import {
  DEFAULT_SCRIPT_ISOLATION,
  SCRIPT_ARBITRARY_IMAGE_MESSAGE,
  SCRIPT_PACKAGE_INSTALL_MESSAGE,
  SCRIPT_PROFILE_FAIL_CLOSED_MESSAGE,
  SCRIPT_PROFILE_LANGUAGE_MESSAGE,
  SCRIPT_RUNTIME_PROFILE_ENGINE,
  expectedRuntimeLanguage,
  isScriptRuntimeProfileSpec,
  parseScriptNodeCatalog,
  runtimeProfileLanguage,
  runtimeProfileMatchesNode,
  type ScriptIsolationRules,
  type ScriptNodeCatalog,
} from "./script-contract.ts";
import type { ScriptActionType } from "./script-contract.ts";

export const SCRIPT_RUNTIME_STORY = 93;
export const SCRIPT_RUNTIME_EPIC = 91;
/** Jonny's E9.2 isolated-runner map on main. */
export const SCRIPT_RUNTIME_API_PR = 98;
export const SCRIPT_RUNTIME_ROUTE_MAP_SOURCE = "e92-#98" as const;

export const SCRIPT_RUNTIME_CONTRACT_FALLBACK_HELP =
  "Using the marked e92-#98 runtime-profile map because GET /scripts/catalog was unavailable. Prefer GET /scripts/catalog isolation (or GET /ops-config/catalog scriptEngine) plus existing /runtime-profiles draft/publish/select verbs.";

export const SCRIPT_RUNTIME_ISOLATION_HELP =
  "Runners are non-root UID/GID 65532, read-only root filesystem, ephemeral /workspace, drop ALL capabilities, and no_new_privs. Egress is default-deny with constrained DNS. There is no Docker socket, cloud-instance metadata, Kubernetes SA mount, or arbitrary base image. CI uses HarnessRuntime (no live containers); production manifests are deploy/kubernetes/script-runner-*.yaml.";

export const SCRIPT_RUNTIME_DIGEST_HELP =
  "imageDigest and dependencyLockDigest must be sha256:<64 hex>. Mutable tags and unpinned names are rejected.";

export const SCRIPT_RUNTIME_NO_INSTALL_HELP = SCRIPT_PACKAGE_INSTALL_MESSAGE;

export const SCRIPT_RUNTIME_NO_IMAGE_HELP = SCRIPT_ARBITRARY_IMAGE_MESSAGE;

export const SCRIPT_RUNTIME_EGRESS_HELP =
  "Egress is default-deny when omitted. Destinations are {host,port,protocol}. Metadata, loopback, Docker socket, and * are rejected. dnsConstrained is always true — there is no unconstrained-DNS toggle.";

export const SCRIPT_RUNTIME_PROFILE_REQUIRED_HELP =
  "Publish requires language (python or go), digest-pinned imageDigest and dependencyLockDigest, and limits.cpuMillis / memoryMib / timeoutSeconds / processes.";

export const SCRIPT_RUNTIME_LANGUAGE_FILTER_HELP =
  "Script nodes only list published runtime profiles whose language matches the node (script.python → python, script.go → go).";

export const SCRIPT_RUNTIME_FORBIDDEN_SURFACES = [
  "image",
  "baseImage",
  "dockerfile",
  "Dockerfile",
  "tag",
  "imageTag",
  "installPackages",
  "packageInstall",
  "pip",
  "goGet",
  "privileged",
  "dockerSocket",
  "allowPrivilegeEscalation",
  "root",
  "capAdd",
] as const;

export const SCRIPT_RUNTIME_ALLOWED_SPEC_KEYS = [
  "language",
  "imageDigest",
  "dependencyLockDigest",
  "limits",
  "egress",
] as const;

export const SCRIPT_RUNTIME_DENIED_EGRESS_HOSTS = [
  "*",
  "0.0.0.0",
  "localhost",
  "127.0.0.1",
] as const;

export const SCRIPT_RUNTIME_LANGUAGES = ["python", "go"] as const;
export type ScriptRuntimeLanguage = (typeof SCRIPT_RUNTIME_LANGUAGES)[number];

export const SCRIPT_RUNTIME_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export const SCRIPT_RUNTIME_LIMIT_BOUNDS = {
  cpuMillis: { min: 1, max: 8000, fallback: 500 },
  memoryMib: { min: 32, max: 2048, fallback: 256 },
  timeoutSeconds: { min: 1, max: 3600, fallback: 30 },
  processes: { min: 1, max: 256, fallback: 1 },
} as const;

export type ScriptRuntimeLimitKey = keyof typeof SCRIPT_RUNTIME_LIMIT_BOUNDS;

export type ScriptRuntimeEgressDestination = {
  host: string;
  port: number;
  protocol: "tcp" | "udp";
};

export type ScriptRuntimeEgress = {
  destinations?: ScriptRuntimeEgressDestination[];
  dnsConstrained?: boolean;
};

export type ScriptRuntimeProfileMap = {
  source: "scripts-catalog" | "ops-config-catalog" | "unavailable";
  engine: typeof SCRIPT_RUNTIME_PROFILE_ENGINE;
  languages: readonly ScriptRuntimeLanguage[];
  requiredSpec: readonly string[];
  allowedSpec: readonly string[];
  egressExposed: boolean;
  isolation: ScriptIsolationRules;
  notes: string;
};

export type AuthorizedRuntimeProfileResult = {
  options: OpsConfigPin[];
  closed: boolean;
  reason: string | null;
};

const LIMIT_KEYS = Object.keys(
  SCRIPT_RUNTIME_LIMIT_BOUNDS,
) as ScriptRuntimeLimitKey[];

export const SCRIPT_RUNTIME_PROFILE_MAP_FALLBACK: ScriptRuntimeProfileMap = {
  source: "unavailable",
  engine: SCRIPT_RUNTIME_PROFILE_ENGINE,
  languages: SCRIPT_RUNTIME_LANGUAGES,
  requiredSpec: ["language", "imageDigest", "dependencyLockDigest", "limits"],
  allowedSpec: SCRIPT_RUNTIME_ALLOWED_SPEC_KEYS,
  egressExposed: false,
  isolation: {
    ...DEFAULT_SCRIPT_ISOLATION,
    note: SCRIPT_RUNTIME_ISOLATION_HELP,
  },
  notes: SCRIPT_RUNTIME_CONTRACT_FALLBACK_HELP,
};

export function emptyRuntimeProfileSpec(): OpsConfigSpec {
  return {
    language: "python",
    imageDigest: "",
    dependencyLockDigest: "",
    limits: {
      cpuMillis: SCRIPT_RUNTIME_LIMIT_BOUNDS.cpuMillis.fallback,
      memoryMib: SCRIPT_RUNTIME_LIMIT_BOUNDS.memoryMib.fallback,
      timeoutSeconds: SCRIPT_RUNTIME_LIMIT_BOUNDS.timeoutSeconds.fallback,
      processes: SCRIPT_RUNTIME_LIMIT_BOUNDS.processes.fallback,
    },
  };
}

export function isPinnedImageDigest(value: string | undefined): boolean {
  return SCRIPT_RUNTIME_DIGEST_RE.test(String(value ?? "").trim());
}

export function isScriptRuntimeLanguage(
  value: string | undefined,
): value is ScriptRuntimeLanguage {
  const normalized = String(value ?? "").trim().toLowerCase();
  return (
    normalized === "python" || normalized === "go"
  );
}

export function parseRuntimeProfileMap(raw: unknown): ScriptRuntimeProfileMap {
  const catalog = parseScriptNodeCatalog(raw);
  const rec =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const nested =
    rec.scriptEngine &&
    typeof rec.scriptEngine === "object" &&
    !Array.isArray(rec.scriptEngine)
      ? (rec.scriptEngine as Record<string, unknown>)
      : rec;
  const declared =
    nested.runtimeProfile &&
    typeof nested.runtimeProfile === "object" &&
    !Array.isArray(nested.runtimeProfile)
      ? (nested.runtimeProfile as Record<string, unknown>)
      : rec.runtimeProfile &&
          typeof rec.runtimeProfile === "object" &&
          !Array.isArray(rec.runtimeProfile)
        ? (rec.runtimeProfile as Record<string, unknown>)
        : {};
  const allowedSpec = stringList(declared.allowedSpec ?? declared.allowedWith);
  const requiredSpec = stringList(declared.requiredSpec ?? declared.requiredWith);
  const languages = stringList(declared.languages ?? catalog.languages).filter(
    isScriptRuntimeLanguage,
  );
  const isolation = catalog.isolation ?? SCRIPT_RUNTIME_PROFILE_MAP_FALLBACK.isolation;
  const thin =
    catalog.source === "unavailable" &&
    Object.keys(declared).length === 0 &&
    !rec.scriptEngine;
  const egressExposed = thin
    ? false
    : runtimeProfileEgressExposed(declared, allowedSpec);
  return {
    source: thin
      ? "unavailable"
      : catalog.source === "ops-config-catalog"
        ? "ops-config-catalog"
        : "scripts-catalog",
    engine: SCRIPT_RUNTIME_PROFILE_ENGINE,
    languages: languages.length ? languages : SCRIPT_RUNTIME_LANGUAGES,
    requiredSpec: requiredSpec.length
      ? requiredSpec
      : SCRIPT_RUNTIME_ALLOWED_SPEC_KEYS,
    allowedSpec: allowedSpec.length
      ? allowedSpec
      : SCRIPT_RUNTIME_ALLOWED_SPEC_KEYS,
    egressExposed,
    isolation,
    notes: thin
      ? SCRIPT_RUNTIME_CONTRACT_FALLBACK_HELP
      : String(declared.notes ?? nested.notes ?? catalog.notes ?? "").trim() ||
        SCRIPT_RUNTIME_ISOLATION_HELP,
  };
}

export function runtimeProfileMapFromCatalog(
  catalog: ScriptNodeCatalog | null | undefined,
): ScriptRuntimeProfileMap {
  if (!catalog) {
    return { ...SCRIPT_RUNTIME_PROFILE_MAP_FALLBACK };
  }
  return parseRuntimeProfileMap({
    nodes: catalog.nodes,
    languages: catalog.languages,
    isolation: catalog.isolation,
    notes: catalog.notes,
    source: catalog.source,
  });
}

export function pickRuntimeProfileSpec(
  spec: OpsConfigSpec,
  map?: ScriptRuntimeProfileMap | null,
): OpsConfigSpec {
  const out: OpsConfigSpec = {};
  const language = runtimeProfileLanguage(spec);
  if (language) {
    out.language = language;
  }
  const image = String(spec.imageDigest ?? "").trim();
  if (image) {
    out.imageDigest = image;
  }
  const lock = String(spec.dependencyLockDigest ?? "").trim();
  if (lock) {
    out.dependencyLockDigest = lock;
  }
  const limits = pickRuntimeLimits(spec.limits);
  if (limits) {
    out.limits = limits;
  }
  const egress =
    map?.egressExposed === false ? undefined : pickRuntimeEgress(spec.egress);
  if (egress) {
    out.egress = egress;
  }
  return out;
}

export function runtimeProfilePublishGap(
  spec: OpsConfigSpec,
  map?: ScriptRuntimeProfileMap | null,
): string | null {
  const language = runtimeProfileLanguage(spec);
  if (!isScriptRuntimeLanguage(language)) {
    return "Publish requires language python or go.";
  }
  if (!isPinnedImageDigest(spec.imageDigest)) {
    return "Publish requires imageDigest as sha256:<64 hex>. Mutable tags are rejected.";
  }
  if (!isPinnedImageDigest(spec.dependencyLockDigest)) {
    return "Publish requires dependencyLockDigest as sha256:<64 hex>.";
  }
  const limits = spec.limits ?? {};
  for (const key of LIMIT_KEYS) {
    const gap = limitGap(key, limits[key]);
    if (gap) {
      return gap;
    }
  }
  if (forbiddenRuntimeProfileKeys(spec).length > 0) {
    return "Runtime profiles cannot set image tags, package-install toggles, or privileged surfaces. Isolation is server-enforced.";
  }
  if (map?.egressExposed === false && spec.egress) {
    return "Egress allowlists are not exposed by the current catalog. Leave them unset — default-deny is server-enforced.";
  }
  const egressGap = runtimeEgressPublishGap(spec.egress);
  if (egressGap) {
    return egressGap;
  }
  return null;
}

export function forbiddenRuntimeProfileKeys(spec: OpsConfigSpec): string[] {
  const rec = spec as Record<string, unknown>;
  return SCRIPT_RUNTIME_FORBIDDEN_SURFACES.filter((key) => {
    const value = rec[key];
    return value !== undefined && value !== null && value !== false && value !== "";
  });
}

export function runtimeProfileIsolationNotes(
  map?: ScriptRuntimeProfileMap | null,
): string[] {
  const isolation = map?.isolation ?? SCRIPT_RUNTIME_PROFILE_MAP_FALLBACK.isolation;
  const uid = isolation.uid ?? 65532;
  const workspace = isolation.ephemeralWorkspace ?? "/workspace";
  return [
    SCRIPT_RUNTIME_ISOLATION_HELP,
    `Non-root UID/GID ${uid}. Read-only root FS. Ephemeral writable ${workspace}. Drop ${isolation.dropCapabilityNames?.join(", ") || "ALL"}. no_new_privs. No Docker socket, metadata, or SA mount.`,
    SCRIPT_RUNTIME_DIGEST_HELP,
    SCRIPT_RUNTIME_NO_INSTALL_HELP,
    SCRIPT_RUNTIME_NO_IMAGE_HELP,
    SCRIPT_RUNTIME_EGRESS_HELP,
    isolation.ciHarness,
    ...(isolation.kubernetesManifests ?? []),
    isolation.note,
  ].filter((note, index, all): note is string => Boolean(note) && all.indexOf(note) === index);
}

export function runtimeProfileSelectorLabel(pin: OpsConfigPin): string {
  const language = runtimeProfileLanguage(pin.spec);
  const name = (pin.name ?? "untitled").trim() || "untitled";
  const version =
    typeof pin.versionNumber === "number" && pin.versionNumber >= 1
      ? `v${pin.versionNumber}`
      : "unpinned";
  const digest = pin.digest?.replace(/^sha256:/i, "") ?? "";
  const short = digest.length > 12 ? `${digest.slice(0, 12)}…` : digest;
  const lang = language ? `${language} · ` : "";
  return short
    ? `${lang}${name} @ ${version} (${short})`
    : `${lang}${name} @ ${version}`;
}

export function authorizedScriptRuntimeProfiles(input: {
  pins?: OpsConfigPin[] | null;
  items?: OpsConfigSummary[] | null;
  nodeType?: string | null;
  problem?: ProblemDetails | null;
  statusCode?: number;
}): AuthorizedRuntimeProfileResult {
  if (input.problem || (input.statusCode && input.statusCode >= 400)) {
    return {
      options: [],
      closed: true,
      reason: SCRIPT_PROFILE_FAIL_CLOSED_MESSAGE,
    };
  }
  const fromPins = (input.pins ?? []).filter(
    (pin) => pin.kind === "runtime_profile" || !pin.kind,
  );
  const fromItems = (input.items ?? [])
    .filter((item) => item.kind === "runtime_profile" && item.status !== "disabled")
    .map(summaryToPin)
    .filter((pin): pin is OpsConfigPin => pin !== null);
  const merged = fromPins.length > 0 ? fromPins : fromItems;
  const matching = merged.filter((pin) => {
    if (!pin.resourceId || !pin.versionId) {
      return false;
    }
    if (!isScriptRuntimeProfileSpec(pin.spec)) {
      return false;
    }
    if (input.nodeType && !runtimeProfileMatchesNode(input.nodeType, pin.spec)) {
      return false;
    }
    if (input.nodeType && !runtimeProfileLanguage(pin.spec)) {
      return false;
    }
    return true;
  });
  if (matching.length === 0) {
    if (merged.length > 0 && input.nodeType) {
      const expected = expectedRuntimeLanguage(input.nodeType);
      return {
        options: [],
        closed: true,
        reason: expected
          ? `No published ${expected} runtime profiles. ${SCRIPT_RUNTIME_LANGUAGE_FILTER_HELP}`
          : SCRIPT_PROFILE_LANGUAGE_MESSAGE,
      };
    }
    return {
      options: [],
      closed: true,
      reason: SCRIPT_PROFILE_FAIL_CLOSED_MESSAGE,
    };
  }
  return { options: matching, closed: false, reason: null };
}

export function scriptRuntimePaths() {
  return {
    scriptsCatalog: "/scripts/catalog",
    opsConfigCatalog: "/ops-config/catalog",
    runtimeProfiles: "/runtime-profiles",
    select: "/ops-config/select",
  } as const;
}

function pickRuntimeLimits(
  limits: OpsConfigSpec["limits"] | undefined,
): OpsConfigSpec["limits"] | undefined {
  if (!limits) {
    return undefined;
  }
  const out: NonNullable<OpsConfigSpec["limits"]> = {};
  for (const key of LIMIT_KEYS) {
    const value = limits[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function pickRuntimeEgress(
  egress: OpsConfigSpec["egress"] | undefined,
): ScriptRuntimeEgress | undefined {
  if (!egress) {
    return undefined;
  }
  const destinations = (egress.destinations ?? [])
    .map(normalizeEgressDestination)
    .filter((item): item is ScriptRuntimeEgressDestination => item !== null);
  if (!destinations.length && egress.dnsConstrained !== true) {
    return undefined;
  }
  return {
    dnsConstrained: true,
    ...(destinations.length ? { destinations } : {}),
  };
}

function normalizeEgressDestination(
  raw: unknown,
): ScriptRuntimeEgressDestination | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const rec = raw as Record<string, unknown>;
  const host = String(rec.host ?? "").trim().toLowerCase();
  if (!host) {
    return null;
  }
  const portRaw = rec.port == null ? 443 : Number(rec.port);
  const port = Number.isInteger(portRaw) ? portRaw : 443;
  const protocol = String(rec.protocol ?? "tcp").trim().toLowerCase();
  return {
    host,
    port: port >= 1 && port <= 65535 ? port : 443,
    protocol: protocol === "udp" ? "udp" : "tcp",
  };
}

export function deniedEgressHost(host: string | undefined): boolean {
  const normalized = String(host ?? "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (
    (SCRIPT_RUNTIME_DENIED_EGRESS_HOSTS as readonly string[]).includes(normalized)
  ) {
    return true;
  }
  return (
    normalized.startsWith("169.254.") ||
    normalized.includes("metadata.google") ||
    normalized.includes("docker.sock")
  );
}

function runtimeEgressPublishGap(
  egress: OpsConfigSpec["egress"] | undefined,
): string | null {
  if (!egress) {
    return null;
  }
  if (egress.dnsConstrained === false) {
    return "Unconstrained DNS is denied. Omit egress for default-deny, or keep dnsConstrained true.";
  }
  for (const item of egress.destinations ?? []) {
    const host = String(item.host ?? "").trim();
    if (!host) {
      return "Each egress destination requires a host.";
    }
    if (deniedEgressHost(host)) {
      return "Egress destinations cannot be metadata, loopback, Docker socket, or *.";
    }
    const port = item.port ?? 443;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return "Egress destination port must be 1–65535.";
    }
    const protocol = String(item.protocol ?? "tcp").toLowerCase();
    if (protocol !== "tcp" && protocol !== "udp") {
      return "Egress protocol must be tcp or udp.";
    }
  }
  return null;
}

function limitGap(key: ScriptRuntimeLimitKey, value: unknown): string | null {
  const bounds = SCRIPT_RUNTIME_LIMIT_BOUNDS[key];
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < bounds.min || n > bounds.max) {
    return `Publish requires limits.${key} between ${bounds.min} and ${bounds.max}.`;
  }
  return null;
}

function runtimeProfileEgressExposed(
  declared: Record<string, unknown>,
  allowedSpec: string[],
): boolean {
  if (declared.egressExposed === true) {
    return true;
  }
  return allowedSpec.includes("egress");
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
}

function summaryToPin(item: OpsConfigSummary): OpsConfigPin | null {
  if (!item.latestVersionId || !item.latestVersionNumber) {
    return null;
  }
  return {
    kind: item.kind,
    resourceId: item.id,
    versionId: item.latestVersionId,
    versionNumber: item.latestVersionNumber,
    digest: item.latestVersionDigest ?? "",
    name: item.name,
    slug: item.slug,
    spec: item.spec,
  };
}

export type { ScriptActionType };
