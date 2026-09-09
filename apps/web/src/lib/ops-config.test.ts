import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  batchSelectPath,
  buildBatchSelectBody,
  buildCreateBody,
  buildPublishBody,
  buildSaveDraftBody,
  buildSelectBody,
  catalogPath,
  collectionPath,
  descriptorForKind,
  draftPath,
  emptySpecForKind,
  isOpsConfigCollection,
  isOpsConfigKind,
  kindFromCollection,
  OPS_CONFIG_COLLECTIONS,
  OPS_CONFIG_KIND_CATALOG,
  pickSafeSpec,
  publishPath,
  selectPath,
  versionPath,
  workflowVersionPinsPath,
} from "./ops-config-contract.ts";
import {
  authorizedSelectorOptions,
  canPublishDraft,
  canSeeOpsConfigNav,
  clientCompareSpecs,
  failClosedReason,
  isDraftEditable,
  isPublishedVersionReadOnly,
  isSecretKey,
  parseAuthorizedPins,
  parseOpsConfigDraft,
  parseOpsConfigRecord,
  parseOpsConfigVersion,
  pinFromVersion,
  sanitizeSpec,
  selectorOptionLabel,
  versionPinLabel,
} from "./ops-config.ts";
import type { OpsConfigPin, OpsConfigVersion } from "./ops-config-types.ts";

const RESOURCE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";

function pin(overrides: Partial<OpsConfigPin> = {}): OpsConfigPin {
  return {
    kind: "cluster_target",
    resourceId: RESOURCE_ID,
    name: "prod-cluster",
    versionId: VERSION_ID,
    versionNumber: 3,
    digest: "sha256:abcdef0123456789",
    ...overrides,
  };
}

function version(overrides: Partial<OpsConfigVersion> = {}): OpsConfigVersion {
  return {
    id: VERSION_ID,
    resourceId: RESOURCE_ID,
    kind: "command_profile",
    versionNumber: 2,
    digest: "sha256:deadbeefcafebabe",
    spec: { template: "systemctl restart nginx", retrySafe: false },
    ...overrides,
  };
}

describe("ops-config contract (#41)", () => {
  it("maps every kind onto a kebab collection under /api/v1 style paths", () => {
    assert.equal(OPS_CONFIG_KIND_CATALOG.length, 9);
    assert.equal(collectionPath("cluster_target"), "/cluster-targets");
    assert.equal(catalogPath(), "/ops-config/catalog");
    assert.equal(batchSelectPath(), "/ops-config/select");
    assert.equal(selectPath("ssh_target", RESOURCE_ID), `/ssh-targets/${RESOURCE_ID}/select`);
    assert.equal(draftPath("command_profile", RESOURCE_ID), `/command-profiles/${RESOURCE_ID}/draft`);
    assert.equal(publishPath("runtime_profile", RESOURCE_ID), `/runtime-profiles/${RESOURCE_ID}/publish`);
    assert.equal(
      versionPath("policy", RESOURCE_ID, VERSION_ID),
      `/policies/${RESOURCE_ID}/versions/${VERSION_ID}`,
    );
    assert.equal(
      workflowVersionPinsPath(RESOURCE_ID, VERSION_ID),
      `/workflows/${RESOURCE_ID}/versions/${VERSION_ID}/pins`,
    );
    assert.equal(isOpsConfigCollection("cluster-targets"), true);
    assert.equal(isOpsConfigCollection("credentials"), false);
    assert.equal(kindFromCollection("message-templates"), "message_template");
    assert.equal(isOpsConfigKind("cluster_target"), true);
    assert.equal(isOpsConfigKind("credentials"), false);
    assert.equal(descriptorForKind("recipient_list").yamlRef, "recipientListId");
    assert.equal(Object.keys(OPS_CONFIG_COLLECTIONS).length, 9);
  });

  it("never sends host-supplied id or workspaceId on writes", () => {
    const created = buildCreateBody("  edge-ssh  ", {
      credentialId: RESOURCE_ID,
      hostname: "edge.example",
      kubeconfig: "kind: Secret",
    } as never);
    assert.deepEqual(Object.keys(created).sort(), ["name", "spec"]);
    assert.equal(created.name, "edge-ssh");
    assert.equal(created.spec.credentialId, RESOURCE_ID);
    assert.equal("id" in created, false);
    assert.equal("workspaceId" in created, false);
    assert.equal("workspace_id" in created, false);

    const saved = buildSaveDraftBody(2, { hostname: "edge.example" }, "edge-ssh");
    assert.equal(saved.revision, 2);
    assert.equal(saved.name, "edge-ssh");
    assert.equal("workspaceId" in saved, false);
    assert.deepEqual(buildSelectBody(VERSION_ID), { versionId: VERSION_ID });
    assert.deepEqual(buildSelectBody(), {});
    assert.deepEqual(buildBatchSelectBody([{ kind: "policy", resourceId: RESOURCE_ID }]), {
      refs: [{ kind: "policy", resourceId: RESOURCE_ID }],
    });

    const published = buildPublishBody(2, " pin v2 ");
    assert.deepEqual(published, { revision: 2, note: "pin v2" });
  });

  it("empty specs stay secret-free and pickSafeSpec drops blank credential ids", () => {
    const spec = emptySpecForKind("cluster_target");
    assert.equal(spec.credentialId, "");
    assert.equal(spec.endpoint?.apiServer, "");
    assert.equal("kubeconfig" in spec, false);
    const picked = pickSafeSpec({
      credentialId: "  ",
      endpoint: { apiServer: "https://k8s.example" },
    });
    assert.equal(picked.credentialId, undefined);
    assert.equal(picked.endpoint?.apiServer, "https://k8s.example");
  });
});

describe("publish / pin immutability UX helpers", () => {
  it("treats drafts as editable and published versions as read-only", () => {
    assert.equal(isDraftEditable("draft"), true);
    assert.equal(isDraftEditable("published"), true);
    assert.equal(isDraftEditable("disabled"), false);
    assert.equal(isPublishedVersionReadOnly(version()), true);
    assert.equal(isPublishedVersionReadOnly(null), false);
    assert.equal(canPublishDraft({ revision: 1 }, "prod-cluster", false), true);
    assert.equal(canPublishDraft({ revision: 1 }, "prod-cluster", true), false);
    assert.equal(canPublishDraft({ revision: 0 }, "x", false), false);
    assert.equal(canPublishDraft({ revision: 1 }, "  ", false), false);
  });

  it("formats version pins as display name + version, never secrets", () => {
    const label = versionPinLabel({
      name: "prod-cluster",
      versionNumber: 3,
      digest: "sha256:abcdef0123456789ffff",
    });
    assert.match(label, /prod-cluster @ v3/);
    assert.match(label, /abcdef012345/);
    assert.doesNotMatch(label, /BEGIN|kubeconfig|token|secret/i);
    assert.equal(
      selectorOptionLabel(pin()),
      versionPinLabel({
        name: "prod-cluster",
        versionNumber: 3,
        digest: "sha256:abcdef0123456789",
      }),
    );
    const fromVersion = pinFromVersion(version(), "restart-nginx");
    assert.equal(fromVersion.name, "restart-nginx");
    assert.equal(fromVersion.resourceId, RESOURCE_ID);
    assert.equal(fromVersion.versionId, VERSION_ID);
    assert.equal(fromVersion.versionNumber, 2);
  });

  it("strips unexpected secret fields from specs", () => {
    assert.equal(isSecretKey("kubeconfig"), true);
    assert.equal(isSecretKey("credentialId"), false);
    const sanitized = sanitizeSpec({
      hostname: "edge.example",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
      token: "super-secret",
      credentialId: RESOURCE_ID,
    });
    assert.equal(sanitized.hostname, "edge.example");
    assert.equal(sanitized.credentialId, RESOURCE_ID);
    assert.equal("privateKey" in sanitized, false);
    assert.equal("token" in sanitized, false);
  });

  it("compares specs client-side because #41 has no compare route", () => {
    const same = clientCompareSpecs({ template: "true" }, { template: "true" });
    assert.equal(same.equal, true);
    const different = clientCompareSpecs({ template: "a" }, { template: "b" });
    assert.equal(different.equal, false);
    assert.equal(different.digestMatch, false);
    assert.equal(different.changes[0]?.path, "spec");
  });
});

describe("select-only pins", () => {
  it("fails closed on 403 / problem+json and never invents foreign options", () => {
    const forbidden = authorizedSelectorOptions({
      statusCode: 403,
      problem: {
        type: "urn:flowforge:problem:forbidden",
        title: "Forbidden",
        status: 403,
        detail: "Cross-workspace resource.",
        instance: "/ops-config/select",
        code: "forbidden",
        request_id: "req-forbidden-16x",
      },
      items: [pin({ resourceId: "99999999-9999-4999-8999-999999999999" })],
    });
    assert.equal(forbidden.closed, true);
    assert.deepEqual(forbidden.options, []);
    assert.match(forbidden.reason ?? "", /Forbidden|Cross-workspace/);
    assert.match(
      failClosedReason(
        {
          type: "urn:flowforge:problem:forbidden",
          title: "Forbidden",
          status: 403,
          detail: "Cross-workspace resource.",
          instance: "/ops-config/select",
          code: "forbidden",
          request_id: "req-forbidden-16x",
        },
        403,
      ),
      /Forbidden/,
    );
  });

  it("fails closed on an empty authorized list", () => {
    const empty = authorizedSelectorOptions({ items: [], statusCode: 200 });
    assert.equal(empty.closed, true);
    assert.deepEqual(empty.options, []);
    assert.match(empty.reason ?? "", /No server-authorized/);
  });

  it("accepts only pins with resourceId and version id", () => {
    const ok = authorizedSelectorOptions({ items: [pin()], statusCode: 200 });
    assert.equal(ok.closed, false);
    assert.equal(ok.options.length, 1);
    assert.equal(ok.options[0]?.name, "prod-cluster");
    assert.equal(ok.options[0]?.resourceId, RESOURCE_ID);

    const parsed = parseAuthorizedPins({
      items: [
        {
          kind: "cluster_target",
          resourceId: RESOURCE_ID,
          name: "prod-cluster",
          versionId: VERSION_ID,
          versionNumber: 1,
          digest: "sha256:aa",
        },
        { id: "not-a-uuid", displayName: "foreign", versionNumber: 1 },
      ],
    });
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.name, "prod-cluster");
    assert.equal(parsed[0]?.resourceId, RESOURCE_ID);
  });
});

describe("RBAC-aware config nav", () => {
  it("shows config when opsconfig.view is present", () => {
    assert.equal(canSeeOpsConfigNav(["workflow.view", "execution.view"]), false);
    assert.equal(canSeeOpsConfigNav(["credential.view"]), false);
    assert.equal(canSeeOpsConfigNav(["opsconfig.view"]), true);
    assert.equal(canSeeOpsConfigNav(["opsconfig.edit"]), false);
    assert.equal(canSeeOpsConfigNav(null), true);
  });
});

describe("payload parsers", () => {
  it("reads camelCase and snake_case; draft/version omit name", () => {
    const record = parseOpsConfigRecord({
      id: RESOURCE_ID,
      kind: "ssh_target",
      name: "edge",
      status: "draft",
      draft_revision: 4,
      latest_version_digest: "sha256:aa",
    });
    assert.equal(record?.draftRevision, 4);
    assert.equal(record?.name, "edge");
    assert.equal(record?.latestVersionDigest, "sha256:aa");

    const draft = parseOpsConfigDraft({
      resourceId: RESOURCE_ID,
      kind: "policy",
      name: "ignored-on-draft",
      revision: 1,
      spec: { kind: "kubernetes", policy: { namespaces: ["app"] } },
    });
    assert.equal(draft?.revision, 1);
    assert.equal(draft?.kind, "policy");
    assert.equal("name" in (draft ?? {}), false);
    assert.equal(draft?.spec.kind, "kubernetes");

    const published = parseOpsConfigVersion({
      id: VERSION_ID,
      resource_id: RESOURCE_ID,
      kind: "response_schema",
      version_number: 1,
      digest: "sha256:ff",
      spec: { schema: { type: "object" }, maxBytes: 1024 },
    });
    assert.equal(published?.versionNumber, 1);
    assert.equal(published?.spec.maxBytes, 1024);
    assert.equal("name" in (published ?? {}), false);
  });
});
