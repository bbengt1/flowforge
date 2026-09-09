import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SCRIPT_API_PR,
  SCRIPT_ARBITRARY_IMAGE_MESSAGE,
  SCRIPT_CONTRACT_FALLBACK_HELP,
  SCRIPT_DEFAULT_TIMEOUT_SECONDS,
  SCRIPT_DRAFT_NOT_EXECUTABLE_HELP,
  SCRIPT_EPIC,
  SCRIPT_EXISTING_API_PATHS,
  SCRIPT_FORBIDDEN_WITH_KEYS,
  SCRIPT_GO_TYPE,
  SCRIPT_HOST_SUPPLIED_IDENTITY_HELP,
  SCRIPT_NODE_CONTRACT_FALLBACK_CATALOG,
  SCRIPT_PACKAGE_INSTALL_MESSAGE,
  SCRIPT_PROFILE_FAIL_CLOSED_MESSAGE,
  SCRIPT_PROFILE_LANGUAGE_MESSAGE,
  SCRIPT_PROFILE_REQUIRED_MESSAGE,
  SCRIPT_PUBLISH_BOUNDARY_HELP,
  SCRIPT_PYTHON_TYPE,
  SCRIPT_ROUTE_MAP_SOURCE,
  SCRIPT_SECRET_WITH_MESSAGE,
  SCRIPT_SOURCE_REQUIRED_MESSAGE,
  SCRIPT_STORY,
  SCRIPT_STRIP_WITH_KEYS,
  SCRIPT_TIMEOUT_REQUIRED_MESSAGE,
  adaptScriptNodeEntries,
  artifactHasForbiddenBlob,
  catalogListsScriptType,
  defaultScriptWith,
  hasScriptNodeContract,
  hostSuppliedScriptIdentityKeys,
  hostSuppliedScriptIdentityProblem,
  isScriptActionType,
  isScriptConfigurableType,
  isScriptRuntimeProfileSpec,
  parseScriptArtifact,
  parseScriptNodeCatalog,
  parseScriptVersionPins,
  runtimeProfileLanguage,
  runtimeProfileMatchesNode,
  scriptArtifactStatus,
  scriptFallbackNode,
  scriptForbiddenWithKeys,
  scriptLibraryTypes,
  scriptNodeWithFields,
  stripScriptForbiddenWith,
  validateScriptNodeConfig,
  yamlHasScriptNodes,
} from "./script-contract.ts";
import type { WorkflowCatalog } from "./workflow-types.ts";

const PROFILE_ID = "66666666-6666-4666-8666-666666666666";

const catalog: WorkflowCatalog = {
  apiVersion: "flowforge/v1",
  nodes: [
    {
      type: "script.python",
      phase: "core",
      requiredWith: ["source", "entrypoint", "runtimeProfileId"],
    },
  ],
};

describe("script contract adapter", () => {
  it("cites E9.1 / #97 map and the closed #92 / open #91 issue pairing", () => {
    assert.equal(SCRIPT_STORY, 92);
    assert.equal(SCRIPT_EPIC, 91);
    assert.equal(SCRIPT_API_PR, 97);
    assert.equal(SCRIPT_ROUTE_MAP_SOURCE, "e91-#97");
    assert.equal(SCRIPT_PYTHON_TYPE, "script.python");
    assert.equal(SCRIPT_GO_TYPE, "script.go");
    assert.equal(SCRIPT_DEFAULT_TIMEOUT_SECONDS, 30);
    assert.deepEqual([...SCRIPT_FORBIDDEN_WITH_KEYS], [
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
    ]);
    assert.ok(SCRIPT_STRIP_WITH_KEYS.includes("secret"));
    assert.ok(SCRIPT_STRIP_WITH_KEYS.includes("image"));
    assert.ok(SCRIPT_STRIP_WITH_KEYS.includes("pip"));
    assert.ok(SCRIPT_STRIP_WITH_KEYS.includes("package"));
    assert.ok(SCRIPT_STRIP_WITH_KEYS.includes("storageRef"));
    assert.match(SCRIPT_CONTRACT_FALLBACK_HELP, /e91-#97/);
    assert.match(SCRIPT_PUBLISH_BOUNDARY_HELP, /Draft save/i);
    assert.match(SCRIPT_PUBLISH_BOUNDARY_HELP, /does not create an executable artifact/i);
    assert.match(SCRIPT_DRAFT_NOT_EXECUTABLE_HELP, /pinned artifact digest/i);
    assert.equal(SCRIPT_EXISTING_API_PATHS.scriptsCatalog, "/scripts/catalog");
    assert.equal(SCRIPT_EXISTING_API_PATHS.scripts, "/scripts");
    assert.equal(SCRIPT_EXISTING_API_PATHS.opsConfigCatalog, "/ops-config/catalog");
    assert.equal(SCRIPT_EXISTING_API_PATHS.workflowCatalog, "/workflows/catalog");
    assert.equal(SCRIPT_EXISTING_API_PATHS.runtimeProfiles, "/runtime-profiles");
    assert.equal(
      SCRIPT_EXISTING_API_PATHS.workflowPublish("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
      "/workflows/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/publish",
    );
    assert.equal(
      SCRIPT_EXISTING_API_PATHS.scriptArtifact("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
      "/scripts/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    );
    assert.equal(
      SCRIPT_EXISTING_API_PATHS.workflowScriptArtifacts(
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      ),
      "/workflows/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/versions/cccccccc-cccc-4ccc-8ccc-cccccccccccc/script-artifacts",
    );
  });

  it("falls back to marked contract entries when catalog is thin or missing", () => {
    assert.deepEqual([...scriptLibraryTypes(null)], [
      "script.python",
      "script.go",
    ]);
    assert.equal(isScriptActionType("script.python"), true);
    assert.equal(isScriptConfigurableType("script.go"), true);
    assert.equal(isScriptConfigurableType("ssh.run"), false);
    assert.equal(catalogListsScriptType(catalog, "script.python"), true);
    const fallback = scriptFallbackNode("script.python");
    assert.equal(fallback.title, "Run Python script");
    assert.match(fallback.description ?? "", /signed, scanned/i);
    assert.deepEqual(fallback.requiredWith, [
      "source",
      "entrypoint",
      "runtimeProfileId",
      "timeoutSeconds",
    ]);
    assert.equal(fallback.policy?.retrySafe, false);
    assert.ok((fallback.allowedWith ?? []).some((field) => field.name === "source"));
    assert.ok(
      (fallback.allowedWith ?? []).some((field) => field.name === "runtimeProfileId"),
    );
    assert.ok(
      (fallback.allowedWith ?? []).some((field) => field.name === "inputSchema"),
    );
    assert.ok(
      (fallback.allowedWith ?? []).some((field) => field.name === "retrySafe"),
    );
    assert.ok(
      (fallback.allowedWith ?? []).some((field) => field.name === "idempotencyKey"),
    );
    assert.ok(
      (fallback.allowedWith ?? []).some((field) => field.name === "verification"),
    );
    assert.ok(
      (fallback.allowedWith ?? []).some((field) => field.name === "retryPolicy"),
    );
    assert.equal(fallback.policy?.verification, "node-declared-idempotent-hook");
    assert.equal(
      (fallback.allowedWith ?? []).some((field) => field.name === "image"),
      false,
    );
    assert.equal(hasScriptNodeContract(fallback), true);
    const missing = adaptScriptNodeEntries(null);
    assert.equal(missing[0]?.type, "script.python");
    assert.equal(missing[1]?.type, "script.go");
    const thin = adaptScriptNodeEntries(catalog);
    assert.equal(thin[0]?.title, "Run Python script");
    assert.ok((thin[0]?.allowedWith?.length ?? 0) > 0);
  });

  it("defaults entrypoint, timeout, and memory", () => {
    assert.deepEqual(defaultScriptWith("script.python"), {
      entrypoint: "main.py",
      timeoutSeconds: 30,
      memoryMiB: 128,
      retryPolicy: { maxAttempts: 0 },
    });
    assert.deepEqual(defaultScriptWith("script.go"), {
      entrypoint: "main.go",
      timeoutSeconds: 30,
      memoryMiB: 128,
      retryPolicy: { maxAttempts: 0 },
    });
    assert.deepEqual(defaultScriptWith("ssh.run"), {});
  });

  it("strips secrets, images, and package-install keys from with", () => {
    const stripped = stripScriptForbiddenWith({
      runtimeProfileId: PROFILE_ID,
      source: "print('ok')",
      secret: "hunter2",
      image: "python:latest",
      pip: "requests",
      timeoutSeconds: 30,
    });
    assert.equal("secret" in stripped, false);
    assert.equal("image" in stripped, false);
    assert.equal("pip" in stripped, false);
    assert.equal(stripped.runtimeProfileId, PROFILE_ID);
    assert.deepEqual(scriptForbiddenWithKeys({ token: "x", command: "x" }), [
      "token",
      "command",
    ]);
    assert.deepEqual(scriptForbiddenWithKeys({ baseImage: "x" }), []);
  });

  it("requires source, entrypoint, and a published runtime profile", () => {
    const missing = validateScriptNodeConfig("script.python", {});
    assert.ok(missing.includes(SCRIPT_SOURCE_REQUIRED_MESSAGE));
    assert.ok(missing.includes(SCRIPT_PROFILE_REQUIRED_MESSAGE));
    assert.ok(missing.includes(SCRIPT_TIMEOUT_REQUIRED_MESSAGE));
    assert.ok(missing.some((error) => /entrypoint/.test(error)));

    const closed = validateScriptNodeConfig(
      "script.python",
      {
        source: "print('ok')",
        entrypoint: "main.py",
        runtimeProfileId: PROFILE_ID,
      },
      { profileSelectorClosed: true },
    );
    assert.ok(closed.includes(SCRIPT_PROFILE_FAIL_CLOSED_MESSAGE));
  });

  it("rejects secrets, package install, arbitrary images, and language mismatch", () => {
    const rejected = validateScriptNodeConfig("script.python", {
      runtimeProfileId: PROFILE_ID,
      source: "pip install requests\nprint('ok')",
      entrypoint: "main.py",
      image: "python:3.12",
      token: "ghp_notareal",
      timeoutSeconds: 9999,
    });
    assert.ok(rejected.includes(SCRIPT_PACKAGE_INSTALL_MESSAGE));
    assert.ok(rejected.includes(SCRIPT_ARBITRARY_IMAGE_MESSAGE));
    assert.ok(rejected.includes(SCRIPT_SECRET_WITH_MESSAGE));
    assert.ok(rejected.some((error) => /timeoutSeconds/.test(error)));

    const secretSource = validateScriptNodeConfig("script.go", {
      runtimeProfileId: PROFILE_ID,
      source: "package main\nconst t = \"Bearer abc\"\n",
      entrypoint: "main.go",
    });
    assert.ok(secretSource.includes(SCRIPT_SECRET_WITH_MESSAGE));

    const dockerfile = validateScriptNodeConfig("script.python", {
      runtimeProfileId: PROFILE_ID,
      source: "FROM python:3.12\nprint('no')\n",
      entrypoint: "main.py",
    });
    assert.ok(dockerfile.includes(SCRIPT_ARBITRARY_IMAGE_MESSAGE));

    const mismatch = validateScriptNodeConfig(
      "script.python",
      {
        runtimeProfileId: PROFILE_ID,
        source: "print('ok')",
        entrypoint: "main.py",
      },
      { profileLanguage: "go" },
    );
    assert.ok(mismatch.includes(SCRIPT_PROFILE_LANGUAGE_MESSAGE));
    assert.equal(runtimeProfileLanguage({ language: "Python" }), "python");
    assert.equal(runtimeProfileMatchesNode("script.go", { language: "go" }), true);
  });

  it("accepts approved source plus optional I/O schema stubs", () => {
    const ok = validateScriptNodeConfig("script.python", {
      runtimeProfileId: PROFILE_ID,
      source: "print('ok')\n",
      entrypoint: "main.py",
      timeoutSeconds: 30,
      memoryMiB: 128,
      inputSchema: { payload: "object" },
      outputSchema: {
        type: "object",
        properties: { status: { type: "string" } },
        additionalProperties: false,
      },
    });
    assert.deepEqual(ok, []);

    const secretSchema = validateScriptNodeConfig("script.python", {
      runtimeProfileId: PROFILE_ID,
      source: "print('ok')\n",
      entrypoint: "main.py",
      timeoutSeconds: 30,
      inputSchema: {
        type: "object",
        properties: { token: { type: "string" } },
      },
    });
    assert.ok(secretSchema.some((error) => /secret|handle/i.test(error)));

    const retryDenied = validateScriptNodeConfig("script.python", {
      runtimeProfileId: PROFILE_ID,
      source: "print('ok')\n",
      entrypoint: "main.py",
      timeoutSeconds: 30,
      retryPolicy: { maxAttempts: 2 },
    });
    assert.ok(retryDenied.some((error) => /retry-denied|retrySafe/i.test(error)));

    const retryOk = validateScriptNodeConfig("script.python", {
      runtimeProfileId: PROFILE_ID,
      source: "print('ok')\n",
      entrypoint: "main.py",
      timeoutSeconds: 30,
      retrySafe: true,
      idempotencyKey: "summarize-v1",
      verification: { behavior: "declared-hook" },
      retryPolicy: { maxAttempts: 2 },
    });
    assert.deepEqual(retryOk, []);
  });

  it("treats host-supplied id/workspaceId as 400 invalid-request UX", () => {
    const keys = hostSuppliedScriptIdentityKeys({
      id: PROFILE_ID,
      workspaceId: PROFILE_ID,
      source: "print('ok')",
    });
    assert.deepEqual(keys, ["id", "workspaceId"]);
    const problem = hostSuppliedScriptIdentityProblem(keys);
    assert.equal(problem.status, 400);
    assert.equal(problem.code, "invalid-request");
    assert.match(problem.detail, /id, workspaceId/);
    assert.match(SCRIPT_HOST_SUPPLIED_IDENTITY_HELP, /400/);
  });

  it("distinguishes draft save from publish/artifact pin messaging", () => {
    const draft = scriptArtifactStatus({ hasPublishedVersion: false });
    assert.equal(draft.kind, "draft");
    assert.match(draft.label, /no executable artifact/i);
    assert.match(draft.help, /Draft save/i);
    assert.match(draft.help, /does not create an executable artifact/i);
    assert.equal(draft.source, "contract-fallback");

    const dirty = scriptArtifactStatus({ dirty: true, hasPublishedVersion: true });
    assert.equal(dirty.kind, "dirty-draft");
    assert.match(dirty.help, /Save the draft, then publish/i);

    const pending = scriptArtifactStatus({
      hasPublishedVersion: true,
      version: {
        id: PROFILE_ID,
        workflowId: PROFILE_ID,
        versionNumber: 1,
        digest: "sha256:workflowyaml",
        publishNote: "ship",
        publishedAt: "2026-09-09T00:00:00.000Z",
      },
    });
    assert.equal(pending.kind, "published-unpinned");
    assert.match(pending.help, /script-artifacts/);
    assert.match(pending.help, /Publish packages/i);

    const pinned = scriptArtifactStatus({
      hasPublishedVersion: true,
      version: {
        digest: "sha256:workflowyaml",
        artifactDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        scanStatus: "clean",
        signed: true,
      },
    });
    assert.equal(pinned.kind, "signed-pinned");
    assert.equal(pinned.digest, "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert.match(pinned.help, /pinned artifact digest/i);

    const scanning = scriptArtifactStatus({
      hasPublishedVersion: true,
      version: { artifactDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", scanStatus: "scanning" },
    });
    assert.equal(scanning.kind, "scanning");

    const rejected = scriptArtifactStatus({
      hasPublishedVersion: true,
      version: { scanStatus: "mutable", reason: "mutable tag" },
    });
    assert.equal(rejected.kind, "rejected");

    const fromPins = scriptArtifactStatus({
      hasPublishedVersion: true,
      scriptArtifacts: [
        {
          workflowVersionId: PROFILE_ID,
          nodeId: "summarize",
          artifactId: PROFILE_ID,
          digest: "sha256:cccccccccccccccccccccccccccccccc",
          scanStatus: "clean",
          signature: "ed25519:pin",
        },
      ],
    });
    assert.equal(fromPins.kind, "signed-pinned");
    assert.equal(fromPins.digest, "sha256:cccccccccccccccccccccccccccccccc");
    assert.equal(fromPins.scanStatus, "clean");

    const revoked = scriptArtifactStatus({
      hasPublishedVersion: true,
      scriptArtifacts: [
        {
          workflowVersionId: PROFILE_ID,
          nodeId: "summarize",
          artifactId: PROFILE_ID,
          digest: "sha256:cccccccccccccccccccccccccccccccc",
          scanStatus: "clean",
          signature: "ed25519:pin",
        },
      ],
      artifacts: [
        {
          id: PROFILE_ID,
          language: "python",
          entrypoint: "main.py",
          digest: "sha256:cccccccccccccccccccccccccccccccc",
          signature: "ed25519:pin",
          scanStatus: "clean",
          status: "published",
          revokedAt: "2026-09-09T15:04:00Z",
        },
      ],
    });
    assert.equal(revoked.kind, "revoked");
    assert.match(revoked.label, /cannot start/i);
    assert.match(revoked.help, /artifact-revoked/);
    assert.equal(revoked.revokedAt, "2026-09-09T15:04:00Z");
  });

  it("detects script nodes in YAML and overlays catalog nodes[] when present", () => {
    assert.equal(
      yamlHasScriptNodes("    type: script.python\n    name: Summarize\n"),
      true,
    );
    assert.equal(yamlHasScriptNodes("type: ssh.run\n"), false);

    const parsed = parseScriptNodeCatalog({
      nodes: [
        {
          type: "script.python",
          title: "Approved Python",
          description: "Pinned profile only.",
          permissions: ["workflow.execute", "script.run"],
          requiredWith: ["source", "entrypoint", "runtimeProfileId"],
          allowedWith: [
            { name: "runtimeProfileId", kind: "uuid", required: true },
            { name: "source", kind: "string", required: true },
            { name: "entrypoint", kind: "string", required: true },
            { name: "secret", kind: "string" },
          ],
          outputs: ["result"],
          sideEffects: true,
          retrySafe: false,
          defaultMaxAttempts: 0,
        },
      ],
      errors: [
        { code: "package-install-denied", status: 400, meaning: "No pip." },
      ],
    });
    assert.equal(parsed.source, "scripts-catalog");
    assert.equal(parsed.nodes[0]?.title, "Approved Python");
    const fields = scriptNodeWithFields("script.python", parsed);
    assert.equal(fields.some((field) => field.name === "source"), true);
    assert.equal(fields.some((field) => field.name === "secret"), false);

    const empty = parseScriptNodeCatalog({});
    assert.equal(empty.source, "contract-fallback");
    assert.equal(empty.notes, SCRIPT_NODE_CONTRACT_FALLBACK_CATALOG.notes);

    const adapted = adaptScriptNodeEntries(catalog, parsed);
    assert.equal(adapted[0]?.title, "Approved Python");

    const fromOps = parseScriptNodeCatalog({
      scriptEngine: {
        languages: ["python", "go"],
        nodes: [
          {
            type: "script.go",
            title: "Run Go script",
            requiredWith: ["source", "entrypoint", "runtimeProfileId", "timeoutSeconds"],
          },
        ],
        publishRules: { maxSourceBytes: 65536 },
      },
    });
    assert.equal(fromOps.source, "ops-config-catalog");
    assert.equal(fromOps.nodes.some((item) => item.type === "script.go"), true);
  });

  it("parses artifact metadata and never keeps package or storageRef", () => {
    const blob = {
      id: PROFILE_ID,
      language: "python",
      entrypoint: "main.py",
      digest: "sha256:dddddddddddddddddddddddddddddddd",
      signature: "ed25519:sig",
      scanStatus: "clean",
      status: "published",
      package: "blob",
      storageRef: "s3://secret",
    };
    assert.equal(artifactHasForbiddenBlob(blob), true);
    const parsed = parseScriptArtifact(blob);
    assert.ok(parsed);
    assert.equal(parsed?.digest, "sha256:dddddddddddddddddddddddddddddddd");
    assert.equal("package" in (parsed ?? {}), false);
    assert.equal("storageRef" in (parsed ?? {}), false);
    assert.equal(isScriptRuntimeProfileSpec({ engine: "script", language: "python" }), true);
    assert.equal(isScriptRuntimeProfileSpec({ engine: "kubernetes" }), false);
    assert.deepEqual(
      parseScriptVersionPins({
        items: [
          {
            workflowVersionId: PROFILE_ID,
            nodeId: "summarize",
            artifactId: PROFILE_ID,
            digest: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            scanStatus: "clean",
            signature: "ed25519:pin",
            package: "nope",
          },
        ],
      }).map((item) => item.digest),
      ["sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"],
    );
  });
});
