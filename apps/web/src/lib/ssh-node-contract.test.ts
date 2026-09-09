import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SSH_CONTRACT_FALLBACK_NODE_HELP,
  SSH_DEFAULT_RETRY_MAX_ATTEMPTS,
  SSH_DEFAULT_TIMEOUT_SECONDS,
  SSH_FORBIDDEN_WITH_KEYS,
  SSH_FREEFORM_SHELL_MESSAGE,
  SSH_NODE_API_PR,
  SSH_NODE_CONTRACT_FALLBACK_CATALOG,
  SSH_NODE_EPIC,
  SSH_NODE_ROUTE_MAP_SOURCE,
  SSH_NODE_STORY,
  SSH_PROFILE_FAIL_CLOSED_MESSAGE,
  SSH_PROFILE_REQUIRED_MESSAGE,
  SSH_RETRY_DENIED_MESSAGE,
  SSH_RUN_NODE_TYPE,
  SSH_SECRET_WITH_MESSAGE,
  SSH_TARGET_FAIL_CLOSED_MESSAGE,
  SSH_TARGET_REQUIRED_MESSAGE,
  adaptSshNodeEntries,
  catalogListsSshType,
  commandProfileParameterConstraints,
  commandProfileRetrySafe,
  defaultSshWith,
  hasSshNodeContract,
  isSshConfigurableType,
  isSshRunType,
  parseSshNodeCatalog,
  pruneSshParameters,
  sshFallbackNode,
  sshForbiddenWithKeys,
  sshLibraryTypes,
  sshNodeWithFields,
  stripSshForbiddenWith,
  validateSshNodeConfig,
  validateSshParameters,
} from "./ssh-node-contract.ts";
import type { WorkflowCatalog } from "./workflow-types.ts";

const TARGET_ID = "22222222-2222-4222-8222-222222222222";
const PROFILE_ID = "33333333-3333-4333-8333-333333333333";

const catalog: WorkflowCatalog = {
  apiVersion: "flowforge/v1",
  nodes: [
    {
      type: "ssh.run",
      phase: "core",
      requiredWith: ["sshTargetId", "commandProfileId"],
    },
  ],
};

describe("ssh node contract adapter", () => {
  it("cites E8.2 / E8 and jonny's #88 map on main", () => {
    assert.equal(SSH_NODE_STORY, 83);
    assert.equal(SSH_NODE_EPIC, 81);
    assert.equal(SSH_NODE_API_PR, 88);
    assert.equal(SSH_NODE_ROUTE_MAP_SOURCE, "e82-#88");
    assert.equal(SSH_RUN_NODE_TYPE, "ssh.run");
    assert.equal(SSH_DEFAULT_TIMEOUT_SECONDS, 60);
    assert.equal(SSH_DEFAULT_RETRY_MAX_ATTEMPTS, 0);
    assert.ok(SSH_FORBIDDEN_WITH_KEYS.includes("privateKey"));
    assert.ok(SSH_FORBIDDEN_WITH_KEYS.includes("command"));
    assert.ok(SSH_FORBIDDEN_WITH_KEYS.includes("password"));
    assert.match(SSH_CONTRACT_FALLBACK_NODE_HELP, /e82-#88/);
  });

  it("falls back to marked contract entries when catalog is thin or missing", () => {
    assert.deepEqual([...sshLibraryTypes(null)], ["ssh.run"]);
    assert.equal(isSshRunType("ssh.run"), true);
    assert.equal(isSshConfigurableType("ssh.run"), true);
    assert.equal(isSshConfigurableType("kubernetes.apply"), false);
    assert.equal(catalogListsSshType(catalog, "ssh.run"), true);
    const fallback = sshFallbackNode("ssh.run");
    assert.equal(fallback.source, undefined);
    assert.equal(fallback.title, "Run command profile");
    assert.match(fallback.description ?? "", /ephemeral key handle/i);
    assert.deepEqual(fallback.requiredWith, ["sshTargetId", "commandProfileId"]);
    assert.equal(fallback.policy?.retrySafe, false);
    assert.equal(fallback.policy?.defaultMaxAttempts, 0);
    assert.ok((fallback.allowedWith ?? []).some((field) => field.name === "sshTargetId"));
    assert.ok((fallback.allowedWith ?? []).some((field) => field.name === "retryPolicy"));
    assert.ok((fallback.allowedWith ?? []).some((field) => field.name === "policyId"));
    assert.equal(
      (fallback.allowedWith ?? []).some((field) => field.name === "command"),
      false,
    );
    assert.equal(hasSshNodeContract(fallback), true);
    const missing = adaptSshNodeEntries(null);
    assert.equal(missing[0]?.type, "ssh.run");
    assert.equal(missing[0]?.title, "Run command profile");
    const thin = adaptSshNodeEntries(catalog);
    assert.equal(thin[0]?.title, "Run command profile");
    assert.ok((thin[0]?.allowedWith?.length ?? 0) > 0);
  });

  it("defaults timeout and zero-retry policy", () => {
    assert.deepEqual(defaultSshWith("ssh.run"), {
      timeoutSeconds: 60,
      retryPolicy: { maxAttempts: 0 },
    });
    assert.deepEqual(defaultSshWith("http.request"), {});
  });

  it("strips secret and free-form shell keys from with", () => {
    const stripped = stripSshForbiddenWith({
      sshTargetId: TARGET_ID,
      commandProfileId: PROFILE_ID,
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
      passphrase: "x",
      command: "rm -rf /",
      timeoutSeconds: 60,
    });
    assert.equal("privateKey" in stripped, false);
    assert.equal("passphrase" in stripped, false);
    assert.equal("command" in stripped, false);
    assert.equal(stripped.sshTargetId, TARGET_ID);
    assert.deepEqual(sshForbiddenWithKeys({ command: "id", password: "x" }), [
      "password",
      "command",
    ]);
  });

  it("requires target + profile and fails closed on unauthorized selectors", () => {
    const missing = validateSshNodeConfig("ssh.run", {});
    assert.ok(missing.includes(SSH_TARGET_REQUIRED_MESSAGE));
    assert.ok(missing.includes(SSH_PROFILE_REQUIRED_MESSAGE));

    const closed = validateSshNodeConfig(
      "ssh.run",
      { sshTargetId: TARGET_ID, commandProfileId: PROFILE_ID },
      { targetSelectorClosed: true, profileSelectorClosed: true },
    );
    assert.ok(closed.includes(SSH_TARGET_FAIL_CLOSED_MESSAGE));
    assert.ok(closed.includes(SSH_PROFILE_FAIL_CLOSED_MESSAGE));
  });

  it("rejects free-form shell, secret material, retries, and interpolation", () => {
    const rejected = validateSshNodeConfig("ssh.run", {
      sshTargetId: TARGET_ID,
      commandProfileId: PROFILE_ID,
      command: "bash",
      privateKey: "k",
      timeoutSeconds: 9999,
      retryPolicy: { maxAttempts: 3 },
      parameters: { service: "api$(reboot)" },
    });
    assert.ok(rejected.includes(SSH_FREEFORM_SHELL_MESSAGE));
    assert.ok(rejected.includes(SSH_SECRET_WITH_MESSAGE));
    assert.ok(rejected.includes(SSH_RETRY_DENIED_MESSAGE));
    assert.ok(rejected.some((error) => /timeoutSeconds/.test(error)));
    assert.ok(rejected.some((error) => /interpolation/.test(error)));
  });

  it("validates typed parameters against the pinned profile schema", () => {
    const constraints = commandProfileParameterConstraints({
      parameterSchema: {
        type: "object",
        additionalProperties: false,
        required: ["service"],
        properties: {
          service: { type: "string", enum: ["api", "worker"] },
          replicas: { type: "integer", minimum: 1, maximum: 4 },
        },
      },
    });
    assert.equal(constraints.length, 2);
    assert.equal(commandProfileRetrySafe({ retrySafe: true }), true);
    assert.equal(commandProfileRetrySafe({}), false);

    const missing = validateSshParameters({}, constraints);
    assert.ok(missing.some((error) => /parameters.service is required/.test(error)));

    const extra = validateSshParameters(
      { service: "api", unknown: "x" },
      constraints,
    );
    assert.ok(extra.some((error) => /not in the pinned command-profile schema/.test(error)));

    const ok = validateSshNodeConfig(
      "ssh.run",
      {
        sshTargetId: TARGET_ID,
        commandProfileId: PROFILE_ID,
        parameters: { service: "api", replicas: 2 },
        timeoutSeconds: 30,
        retryPolicy: { maxAttempts: 0 },
      },
      { parameterConstraints: constraints },
    );
    assert.deepEqual(ok, []);

    assert.deepEqual(
      pruneSshParameters({ service: "api", stale: "drop" }, constraints),
      { service: "api" },
    );

    const retrySafe = validateSshNodeConfig(
      "ssh.run",
      {
        sshTargetId: TARGET_ID,
        commandProfileId: PROFILE_ID,
        retryPolicy: { maxAttempts: 1 },
        policyId: TARGET_ID,
      },
      { profileRetrySafe: true, verificationDeclared: true },
    );
    assert.deepEqual(retrySafe, []);
  });

  it("overlays GET /ssh/catalog nodes[] when present", () => {
    const parsed = parseSshNodeCatalog({
      nodes: [
        {
          type: "ssh.run",
          title: "Approved remote command",
          description: "Pinned profile only.",
          permissions: ["workflow.execute", "ssh.run"],
          requiredWith: ["sshTargetId", "commandProfileId"],
          allowedWith: [
            { name: "sshTargetId", kind: "uuid", required: true },
            { name: "commandProfileId", kind: "uuid", required: true },
            { name: "timeoutSeconds", kind: "integer" },
            { name: "retryPolicy", kind: "object" },
            { name: "policyId", kind: "uuid" },
            { name: "privateKey", kind: "string" },
          ],
          outputs: ["result", "stdout", "exitCode"],
          sideEffects: true,
          retrySafe: false,
          defaultMaxAttempts: 0,
        },
      ],
      retry: {
        defaultMaxAttempts: 0,
        retrySafeFlag: "retrySafe",
        semantics: "E8.3",
        note: "E8.2 never blindly re-runs.",
      },
      isolation: {
        authMethods: ["publickey"],
        passwordAuth: false,
        ephemeralCredentialHandle: true,
        privateKeyNeverExported: true,
        knownHostVerification: "fingerprint-match-fail-closed",
        resolveThenAllowlist: true,
        connectVerifiedAddressOnly: true,
        nonRootRemoteAccount: true,
        defaultUsername: "flowforge",
      },
      permissions: ["workflow.execute", "ssh.run", "sshTarget.use", "commandProfile.use"],
      errors: [
        { code: "parameter-rejected", status: 400, meaning: "Schema mismatch." },
        { code: "retry-denied", status: 400, meaning: "maxAttempts>0 needs retrySafe." },
        { code: "indeterminate", status: 409, meaning: "Lease lost. No blind retry." },
      ],
    });
    assert.equal(parsed.source, "ssh-catalog");
    assert.equal(parsed.nodes[0]?.title, "Approved remote command");
    assert.equal(parsed.isolation?.ephemeralCredentialHandle, true);
    assert.equal(parsed.isolation?.defaultUsername, "flowforge");
    const fields = sshNodeWithFields("ssh.run", parsed);
    assert.equal(fields.some((field) => field.name === "sshTargetId"), true);
    assert.equal(fields.some((field) => field.name === "policyId"), true);
    assert.equal(fields.some((field) => field.name === "privateKey"), false);
    assert.equal(fields.find((field) => field.name === "retryPolicy")?.readOnly, undefined);

    const empty = parseSshNodeCatalog({});
    assert.equal(empty.source, "contract-fallback");
    assert.equal(empty.notes, SSH_NODE_CONTRACT_FALLBACK_CATALOG.notes);

    const adapted = adaptSshNodeEntries(catalog, parsed);
    assert.equal(adapted[0]?.title, "Approved remote command");
  });
});
