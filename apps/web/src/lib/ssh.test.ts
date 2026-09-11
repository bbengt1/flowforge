import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OpsConfigPin, OpsConfigSummary } from "./ops-config-types.ts";
import {
  applyParameterSchemaToSpec,
  authorizedCommandProfiles,
  authorizedSshTargets,
  commandProfilePublishGap,
  commandProfileSelectorLabel,
  hostSuppliedSshIdentityKeys,
  hostSuppliedSshIdentityProblem,
  isSshActionType,
  parseParameterSchema,
  parseSshEngineCatalog,
  sanitizeSshSpec,
  sshCredentialTypes,
  sshOpsKind,
  sshSecretKeysIn,
  sshTargetPublishGap,
  sshTargetSelectorLabel,
  templateForbiddenHits,
  writeParameterSchema,
} from "./ssh.ts";
import { SSH_CONTRACT_FALLBACK_CATALOG } from "./ssh-contract.ts";

const RESOURCE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const CREDENTIAL_ID = "33333333-3333-4333-8333-333333333333";
const FINGERPRINT_HEX = `sha256:${"a".repeat(64)}`;
const FINGERPRINT_B64 = `SHA256:${"A".repeat(43)}`;
const EMPTY_PARAMETER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {},
};

function target(overrides: Partial<OpsConfigSummary> = {}): OpsConfigSummary {
  return {
    id: RESOURCE_ID,
    kind: "ssh_target",
    name: "edge-ssh",
    status: "published",
    draftRevision: 1,
    latestVersionId: VERSION_ID,
    latestVersionNumber: 2,
    latestVersionDigest: "sha256:abcd",
    credentialId: CREDENTIAL_ID,
    ...overrides,
  };
}

function pin(overrides: Partial<OpsConfigPin> = {}): OpsConfigPin {
  return {
    kind: "command_profile",
    resourceId: RESOURCE_ID,
    versionId: VERSION_ID,
    versionNumber: 1,
    digest: "sha256:aa",
    name: "restart-unit",
    spec: {
      template: "systemctl restart nginx",
      parameterSchema: EMPTY_PARAMETER_SCHEMA,
    },
    ...overrides,
  };
}

describe("ssh target / profile publish gaps", () => {
  it("requires credential, hostname, and known-host fingerprint", () => {
    assert.match(
      sshTargetPublishGap({
        hostname: "edge.example",
        hostKeyFingerprint: FINGERPRINT_HEX,
      }) ?? "",
      /credentialId/,
    );
    assert.match(
      sshTargetPublishGap({
        credentialId: CREDENTIAL_ID,
        hostKeyFingerprint: FINGERPRINT_HEX,
      }) ?? "",
      /hostname/,
    );
    assert.match(
      sshTargetPublishGap({
        credentialId: CREDENTIAL_ID,
        hostname: "edge.example",
      }) ?? "",
      /fingerprint/,
    );
    assert.match(
      sshTargetPublishGap({
        credentialId: CREDENTIAL_ID,
        hostname: "edge.example",
        hostKeyFingerprint: "sha256:aa",
      }) ?? "",
      /sha256/,
    );
    assert.match(
      sshTargetPublishGap({
        credentialId: CREDENTIAL_ID,
        hostname: "edge.example",
        hostKeyFingerprint: "SHA256:abcd",
      }) ?? "",
      /sha256/,
    );
    assert.equal(
      sshTargetPublishGap({
        credentialId: CREDENTIAL_ID,
        hostname: "edge.example",
        hostKeyFingerprint: FINGERPRINT_HEX,
        port: 22,
      }),
      null,
    );
    assert.equal(
      sshTargetPublishGap({
        credentialId: CREDENTIAL_ID,
        hostname: "edge.example",
        hostKeyFingerprint: FINGERPRINT_B64,
      }),
      null,
    );
  });

  it("rejects empty and default-route address allowlists", () => {
    assert.match(
      sshTargetPublishGap({
        credentialId: CREDENTIAL_ID,
        hostname: "edge.example",
        hostKeyFingerprint: FINGERPRINT_HEX,
        allowedAddresses: [],
      }) ?? "",
      /empty/,
    );
    assert.match(
      sshTargetPublishGap({
        credentialId: CREDENTIAL_ID,
        hostname: "edge.example",
        hostKeyFingerprint: FINGERPRINT_HEX,
        allowedAddresses: ["0.0.0.0/0"],
      }) ?? "",
      /default-route/,
    );
    assert.equal(
      sshTargetPublishGap({
        credentialId: CREDENTIAL_ID,
        hostname: "edge.example",
        hostKeyFingerprint: FINGERPRINT_HEX,
        allowedAddresses: ["10.0.0.0/8"],
      }),
      null,
    );
  });

  it("rejects raw shell interpolation and empty templates", () => {
    assert.match(commandProfilePublishGap({ template: "" }) ?? "", /template/i);
    assert.match(
      commandProfilePublishGap({
        template: "echo $(whoami)",
        parameterSchema: EMPTY_PARAMETER_SCHEMA,
      }) ?? "",
      /interpolation/,
    );
    assert.match(
      commandProfilePublishGap({ template: "echo `id`" }) ?? "",
      /interpolation/,
    );
    assert.match(
      commandProfilePublishGap({ template: "echo ${HOME}" }) ?? "",
      /interpolation/,
    );
    assert.match(
      commandProfilePublishGap({ template: "echo {{name}}" }) ?? "",
      /interpolation/,
    );
    assert.equal(
      commandProfilePublishGap({
        template: "systemctl restart nginx",
        parameterSchema: EMPTY_PARAMETER_SCHEMA,
      }),
      null,
    );
    assert.match(
      commandProfilePublishGap({
        template: "systemctl restart {unit}",
        parameterSchema: EMPTY_PARAMETER_SCHEMA,
      }) ?? "",
      /\{unit\}/,
    );
    assert.equal(
      commandProfilePublishGap({
        template: "systemctl restart {unit}",
        parameterSchema: {
          type: "object",
          additionalProperties: false,
          properties: { unit: { type: "string" } },
        },
      }),
      null,
    );
    assert.deepEqual(templateForbiddenHits("echo $(whoami) ${x} `id` {{y}}"), [
      "$()",
      "`",
      "${",
      "{{",
    ]);
    assert.match(
      commandProfilePublishGap({
        template: "systemctl restart nginx",
        parameterSchema: EMPTY_PARAMETER_SCHEMA,
        retrySafe: true,
      }) ?? "",
      /verification/,
    );
    assert.equal(
      commandProfilePublishGap({
        template: "systemctl restart nginx",
        parameterSchema: EMPTY_PARAMETER_SCHEMA,
        retrySafe: true,
        verification: { template: "systemctl is-active nginx" },
      }),
      null,
    );
  });
});

describe("typed parameter schema", () => {
  it("round-trips JSON Schema properties without free-form shell", () => {
    const rows = parseParameterSchema({
      type: "object",
      required: ["unit"],
      properties: {
        unit: {
          type: "string",
          minLength: 1,
          maxLength: 64,
          pattern: "^[a-z0-9.-]+$",
        },
        count: { type: "integer", minimum: 1, maximum: 3 },
        mode: { type: "string", enum: ["start", "stop"] },
      },
    });
    assert.equal(rows.length, 3);
    assert.equal(rows[0]?.name, "unit");
    assert.equal(rows[0]?.required, true);
    assert.equal(rows[2]?.type, "string");
    assert.deepEqual(rows[2]?.enum, ["start", "stop"]);
    assert.equal(
      parseParameterSchema({
        type: "object",
        properties: { mode: { type: "enum", enum: ["start", "stop"] } },
      }).length,
      0,
    );
    const written = writeParameterSchema(rows);
    assert.equal(written.type, "object");
    assert.equal(written.additionalProperties, false);
    const properties = written.properties as Record<string, Record<string, unknown>>;
    assert.equal(properties.unit?.type, "string");
    assert.deepEqual(written.required, ["unit"]);
    assert.deepEqual(writeParameterSchema([]), EMPTY_PARAMETER_SCHEMA);
    const spec = applyParameterSchemaToSpec(
      { template: "systemctl restart nginx", privateKey: "LEAK" },
      rows,
    );
    assert.equal("privateKey" in spec, false);
    assert.ok(spec.parameterSchema);
  });

  it("treats host-supplied id/workspaceId as 400 invalid-request UX", () => {
    const keys = hostSuppliedSshIdentityKeys({
      id: RESOURCE_ID,
      workspaceId: VERSION_ID,
      credentialId: CREDENTIAL_ID,
    });
    assert.deepEqual(keys, ["id", "workspaceId"]);
    const problem = hostSuppliedSshIdentityProblem(keys);
    assert.equal(problem.status, 400);
    assert.equal(problem.code, "invalid-request");
    assert.match(problem.detail ?? "", /id, workspaceId/);
  });
});

describe("secret stripping", () => {
  it("strips keys, passwords, and host private material from specs", () => {
    const sanitized = sanitizeSshSpec({
      credentialId: CREDENTIAL_ID,
      hostname: "edge.example",
      hostKeyFingerprint: FINGERPRINT_HEX,
      privateKey: "-----BEGIN FAKE-----",
      password: "hunter2",
      passphrase: "secret",
      token: "super-secret",
    });
    assert.equal(sanitized.credentialId, CREDENTIAL_ID);
    assert.equal(sanitized.hostname, "edge.example");
    assert.equal("privateKey" in sanitized, false);
    assert.equal("password" in sanitized, false);
    assert.equal("passphrase" in sanitized, false);
    assert.equal("token" in sanitized, false);
    const leaked = sshSecretKeysIn({
      spec: { privateKey: "abc", credentialId: CREDENTIAL_ID },
    });
    assert.ok(leaked.some((key) => key.toLowerCase().includes("privatekey")));
    assert.equal(
      leaked.some((key) => key.toLowerCase().includes("credentialid")),
      false,
    );
  });
});

describe("authorized SSH selectors", () => {
  it("fails closed on 403 and never lists leaked targets", () => {
    const forbidden = authorizedSshTargets({
      statusCode: 403,
      problem: {
        type: "urn:flowforge:problem:forbidden",
        title: "Forbidden",
        status: 403,
        detail: "Cross-workspace resource.",
        instance: "/ssh-targets",
        code: "forbidden",
        request_id: "req-forbidden-16x",
      },
      items: [target()],
    });
    assert.equal(forbidden.closed, true);
    assert.deepEqual(forbidden.options, []);
    assert.match(forbidden.reason ?? "", /Forbidden/);
    assert.equal(
      JSON.stringify(forbidden.options).includes("BEGIN"),
      false,
    );
  });

  it("lists only published credential-bound SSH targets", () => {
    const result = authorizedSshTargets({
      items: [
        target(),
        target({
          id: "44444444-4444-4444-8444-444444444444",
          name: "unbound",
          credentialId: "",
          latestVersionId: "55555555-5555-4555-8555-555555555555",
        }),
        target({
          id: "66666666-6666-4666-8666-666666666666",
          name: "draft-only",
          latestVersionId: undefined,
          latestVersionNumber: undefined,
        }),
        target({
          id: "77777777-7777-4777-8777-777777777777",
          kind: "cluster_target",
          name: "prod-cluster",
        }),
      ],
    });
    assert.equal(result.closed, false);
    assert.deepEqual(
      result.options.map((item) => item.name),
      ["edge-ssh"],
    );
    assert.doesNotMatch(
      sshTargetSelectorLabel(result.options[0]!),
      /BEGIN|password|privateKey/i,
    );
  });

  it("fails closed when nothing is authorized", () => {
    const empty = authorizedSshTargets({ items: [] });
    assert.equal(empty.closed, true);
    assert.deepEqual(empty.options, []);
  });

  it("fails closed on 403 for command profiles and drops other kinds", () => {
    const forbidden = authorizedCommandProfiles({
      statusCode: 403,
      problem: {
        type: "about:blank",
        title: "Forbidden",
        status: 403,
        detail: "not authorized",
        instance: "/command-profiles",
        code: "forbidden",
        request_id: "req-1",
      },
      pins: [pin()],
    });
    assert.equal(forbidden.closed, true);
    assert.equal(forbidden.options.length, 0);

    const filtered = authorizedCommandProfiles({
      pins: [
        pin(),
        pin({
          resourceId: "88888888-8888-4888-8888-888888888888",
          kind: "runtime_profile",
          name: "python-runtime",
        }),
      ],
    });
    assert.equal(filtered.closed, false);
    assert.deepEqual(
      filtered.options.map((item) => item.name),
      ["restart-unit"],
    );
    assert.doesNotMatch(commandProfileSelectorLabel(filtered.options[0]!), /\$\(/);
  });
});

describe("ssh catalog (#86)", () => {
  it("fails closed until sshEngine or GET /ssh/catalog is present", () => {
    const fallback = parseSshEngineCatalog({ kinds: [] });
    assert.equal(fallback.source, "unavailable");
    assert.equal(fallback.retrySafeExposed, false);
    assert.deepEqual(fallback.authMethods, []);
    assert.ok(fallback.denied.some((item) => /password/i.test(item)));

    const fromKinds = parseSshEngineCatalog({
      kinds: [
        {
          kind: "ssh_target",
          collection: "ssh-targets",
          displayName: "SSH targets",
          yamlFields: ["sshTargetId"],
          usePermission: "sshTarget.use",
          allowedCredentialTypes: ["ssh"],
        },
      ],
    });
    assert.equal(fromKinds.source, "ops-config-catalog");
    assert.deepEqual(sshCredentialTypes(fromKinds), ["ssh_private_key"]);

    const engine = parseSshEngineCatalog({
      kinds: [],
      sshEngine: {
        credentialType: "ssh_private_key",
        retrySafeExposed: true,
        notes: "from catalog",
      },
    });
    assert.equal(engine.source, "ops-config-catalog");
    assert.equal(engine.retrySafeExposed, true);
    assert.equal(engine.notes, "from catalog");
    assert.equal(SSH_CONTRACT_FALLBACK_CATALOG.source, "unavailable");
    assert.equal(SSH_CONTRACT_FALLBACK_CATALOG.retrySafeExposed, false);
  });

  it("parses the #86 GET /ssh/catalog shape as ssh-catalog", () => {
    const catalog = parseSshEngineCatalog({
      credentialType: "ssh_private_key",
      credentialSecretFields: ["privateKey", "passphrase"],
      parameterTypes: [
        { type: "string" },
        { type: "integer" },
        { type: "boolean" },
      ],
      render: {
        owner: "reviewed-profile-renderer",
        quoting: "posix-single-quotes",
        placeholderSyntax: "{name}",
        forbiddenTokens: ["$(", "`", "${", "{{"],
        rawShellInterpolation: false,
      },
      retry: {
        defaultMaxAttempts: 0,
        retrySafeFlag: "retrySafe",
        semantics: "E8.3",
        note: "Retries default to zero.",
      },
    });
    assert.equal(catalog.source, "ssh-catalog");
    assert.equal(catalog.retrySafeExposed, true);
    assert.deepEqual(catalog.parameterTypes, ["string", "integer", "boolean"]);
    assert.equal(catalog.renderOwner, "reviewed-profile-renderer");
    assert.equal(catalog.quoting, "posix-single-quotes");
    assert.equal(catalog.placeholderSyntax, "{name}");
    assert.equal(catalog.retryNote, "Retries default to zero.");
    assert.deepEqual(catalog.credentialSecretFields, [
      "privateKey",
      "passphrase",
    ]);
    assert.deepEqual(sshCredentialTypes(catalog), ["ssh_private_key"]);
  });
});

describe("ssh action detection", () => {
  it("recognizes ssh.run only", () => {
    assert.equal(isSshActionType("ssh.run"), true);
    assert.equal(isSshActionType("kubernetes.apply"), false);
    assert.equal(sshOpsKind("ssh_target"), true);
    assert.equal(sshOpsKind("command_profile"), true);
    assert.equal(sshOpsKind("cluster_target"), false);
  });
});
