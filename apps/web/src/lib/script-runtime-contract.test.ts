import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCreateBody, pickSafeSpec } from "./ops-config-contract.ts";
import type { OpsConfigPin } from "./ops-config-types.ts";
import {
  SCRIPT_RUNTIME_API_PR,
  SCRIPT_RUNTIME_CONTRACT_FALLBACK_HELP,
  SCRIPT_RUNTIME_EPIC,
  SCRIPT_RUNTIME_FORBIDDEN_SURFACES,
  SCRIPT_RUNTIME_ISOLATION_HELP,
  SCRIPT_RUNTIME_ROUTE_MAP_SOURCE,
  SCRIPT_RUNTIME_STORY,
  authorizedScriptRuntimeProfiles,
  emptyRuntimeProfileSpec,
  forbiddenRuntimeProfileKeys,
  isPinnedImageDigest,
  parseRuntimeProfileMap,
  pickRuntimeProfileSpec,
  runtimeProfileIsolationNotes,
  runtimeProfilePublishGap,
  runtimeProfileSelectorLabel,
  scriptRuntimePaths,
} from "./script-runtime-contract.ts";

const PROFILE_ID = "66666666-6666-4666-8666-666666666666";
const VERSION_ID = "77777777-7777-4777-8777-777777777777";
const DIGEST = `sha256:${"a".repeat(64)}`;
const LOCK = `sha256:${"b".repeat(64)}`;

function pin(overrides: Partial<OpsConfigPin> = {}): OpsConfigPin {
  return {
    kind: "runtime_profile",
    resourceId: PROFILE_ID,
    versionId: VERSION_ID,
    versionNumber: 1,
    digest: DIGEST,
    name: "python-approved",
    spec: {
      language: "python",
      imageDigest: DIGEST,
      dependencyLockDigest: LOCK,
    },
    ...overrides,
  };
}

describe("script runtime contract adapter", () => {
  it("cites E9.2 / #93 and keeps the issue open via fallback map source", () => {
    assert.equal(SCRIPT_RUNTIME_STORY, 93);
    assert.equal(SCRIPT_RUNTIME_EPIC, 91);
    assert.equal(SCRIPT_RUNTIME_API_PR, 0);
    assert.equal(SCRIPT_RUNTIME_ROUTE_MAP_SOURCE, "e92-contract-fallback");
    assert.match(SCRIPT_RUNTIME_CONTRACT_FALLBACK_HELP, /e92-contract-fallback/);
    assert.match(SCRIPT_RUNTIME_ISOLATION_HELP, /non-root/i);
    assert.match(SCRIPT_RUNTIME_ISOLATION_HELP, /Docker socket/);
    assert.equal(scriptRuntimePaths().runtimeProfiles, "/runtime-profiles");
    assert.equal(scriptRuntimePaths().scriptsCatalog, "/scripts/catalog");
    assert.equal(scriptRuntimePaths().opsConfigCatalog, "/ops-config/catalog");
    assert.ok(SCRIPT_RUNTIME_FORBIDDEN_SURFACES.includes("image"));
    assert.ok(SCRIPT_RUNTIME_FORBIDDEN_SURFACES.includes("packageInstall"));
    assert.ok(SCRIPT_RUNTIME_FORBIDDEN_SURFACES.includes("dockerSocket"));
  });

  it("requires digest-pinned image and lock, and rejects mutable tags", () => {
    const empty = emptyRuntimeProfileSpec();
    assert.equal(empty.language, "python");
    assert.equal(runtimeProfilePublishGap(empty), "Publish requires imageDigest as sha256:<64 hex>. Mutable tags are rejected.");
    assert.equal(isPinnedImageDigest("python:3.12"), false);
    assert.equal(isPinnedImageDigest("sha256:abcd"), false);
    assert.equal(isPinnedImageDigest(DIGEST), true);
    assert.match(
      runtimeProfilePublishGap({
        language: "python",
        imageDigest: "python:3.12",
        dependencyLockDigest: LOCK,
        limits: { cpuMillis: 500, memoryMib: 256, timeoutSeconds: 30, processes: 1 },
      }) ?? "",
      /sha256/,
    );
    assert.equal(
      runtimeProfilePublishGap({
        language: "python",
        imageDigest: DIGEST,
        dependencyLockDigest: LOCK,
        limits: { cpuMillis: 500, memoryMib: 256, timeoutSeconds: 30, processes: 1 },
      }),
      null,
    );
    assert.match(
      runtimeProfilePublishGap({
        language: "rust",
        imageDigest: DIGEST,
        dependencyLockDigest: LOCK,
        limits: { cpuMillis: 500, memoryMib: 256, timeoutSeconds: 30, processes: 1 },
      }) ?? "",
      /python or go/,
    );
  });

  it("never sends forbidden surfaces or egress until the catalog exposes them", () => {
    const dirty = {
      language: "python",
      imageDigest: DIGEST,
      dependencyLockDigest: LOCK,
      limits: { cpuMillis: 500, memoryMib: 256, timeoutSeconds: 30, processes: 1 },
      image: "python:3.12",
      packageInstall: true,
      dockerSocket: true,
      egress: { destinations: ["*"] },
    } as never;
    assert.deepEqual(forbiddenRuntimeProfileKeys(dirty), [
      "image",
      "packageInstall",
      "dockerSocket",
    ]);
    const picked = pickRuntimeProfileSpec(dirty);
    assert.equal(picked.language, "python");
    assert.equal(picked.imageDigest, DIGEST);
    assert.equal("image" in picked, false);
    assert.equal("packageInstall" in picked, false);
    assert.equal("egress" in picked, false);
    const created = buildCreateBody("python-approved", dirty, undefined, "runtime_profile");
    assert.deepEqual(Object.keys(created.spec).sort(), [
      "dependencyLockDigest",
      "imageDigest",
      "language",
      "limits",
    ]);
    assert.equal(
      pickSafeSpec(dirty, "runtime_profile").egress,
      undefined,
    );
    assert.match(
      runtimeProfilePublishGap(dirty) ?? "",
      /image tags|package-install|privileged/i,
    );
  });

  it("surfaces egress allowlists only when the catalog exposes them", () => {
    const fallback = parseRuntimeProfileMap(null);
    assert.equal(fallback.source, "contract-fallback");
    assert.equal(fallback.egressExposed, false);
    assert.match(fallback.notes, /e92-contract-fallback/);
    const exposed = parseRuntimeProfileMap({
      languages: ["python", "go"],
      isolation: { nonRoot: true, noHostDockerSocket: true },
      runtimeProfile: { egressExposed: true, allowedSpec: ["language", "egress"] },
      nodes: [{ type: "script.python", title: "Run Python script" }],
    });
    assert.equal(exposed.egressExposed, true);
    const spec = {
      language: "go" as const,
      imageDigest: DIGEST,
      dependencyLockDigest: LOCK,
      limits: { cpuMillis: 500, memoryMib: 256, timeoutSeconds: 30, processes: 1 },
      egress: { destinations: ["*"] },
    };
    assert.match(runtimeProfilePublishGap(spec, exposed) ?? "", /wildcard/);
    assert.deepEqual(
      pickRuntimeProfileSpec(
        { ...spec, egress: { destinations: ["registry.example"] } },
        exposed,
      ).egress,
      { destinations: ["registry.example"] },
    );
  });

  it("lists only published language-matching profiles and fails closed on 403", () => {
    const python = pin();
    const go = pin({
      resourceId: "88888888-8888-4888-8888-888888888888",
      name: "go-approved",
      spec: { language: "go", imageDigest: DIGEST, dependencyLockDigest: LOCK },
    });
    const kube = pin({
      resourceId: "99999999-9999-4999-8999-999999999999",
      spec: { engine: "kubernetes" },
    });
    const filtered = authorizedScriptRuntimeProfiles({
      pins: [python, go, kube],
      nodeType: "script.python",
    });
    assert.equal(filtered.closed, false);
    assert.deepEqual(
      filtered.options.map((item) => item.resourceId),
      [PROFILE_ID],
    );
    const none = authorizedScriptRuntimeProfiles({
      pins: [go],
      nodeType: "script.python",
    });
    assert.equal(none.closed, true);
    assert.match(none.reason ?? "", /python/);
    const forbidden = authorizedScriptRuntimeProfiles({
      pins: [python],
      nodeType: "script.python",
      statusCode: 403,
    });
    assert.equal(forbidden.closed, true);
    assert.deepEqual(forbidden.options, []);
    assert.match(forbidden.reason ?? "", /failed closed|published/i);
    assert.match(
      runtimeProfileSelectorLabel(python),
      /python/,
    );
    assert.ok(
      runtimeProfileIsolationNotes().some((note) => /default-deny/i.test(note)),
    );
  });
});
