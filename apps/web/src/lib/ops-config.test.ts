import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  authorizedPath,
  buildCreateBody,
  buildPublishBody,
  buildSaveDraftBody,
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
  restorePath,
  versionPath,
} from "./ops-config-contract.ts";
import {
  authorizedSelectorOptions,
  canPublishDraft,
  canSeeOpsConfigNav,
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
    id: RESOURCE_ID,
    kind: "cluster_target",
    displayName: "prod-cluster",
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
    name: "restart-nginx",
    versionNumber: 2,
    digest: "sha256:deadbeefcafebabe",
    spec: { template: "systemctl restart nginx", retrySafe: false },
    ...overrides,
  };
}

describe("ops-config contract (#36)", () => {
  it("maps every kind onto a kebab collection under /api/v1 style paths", () => {
    assert.equal(OPS_CONFIG_KIND_CATALOG.length, 9);
    assert.equal(collectionPath("cluster_target"), "/cluster-targets");
    assert.equal(authorizedPath("ssh_target"), "/ssh-targets/authorized");
    assert.equal(draftPath("command_profile", RESOURCE_ID), `/command-profiles/${RESOURCE_ID}/draft`);
    assert.equal(publishPath("runtime_profile", RESOURCE_ID), `/runtime-profiles/${RESOURCE_ID}/publish`);
    assert.equal(
      versionPath("policy", RESOURCE_ID, VERSION_ID),
      `/policies/${RESOURCE_ID}/versions/${VERSION_ID}`,
    );
    assert.equal(
      restorePath("connection", RESOURCE_ID, VERSION_ID),
      `/connections/${RESOURCE_ID}/versions/${VERSION_ID}/restore`,
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

    const saved = buildSaveDraftBody(2, "edge-ssh", { hostname: "edge.example" });
    assert.equal(saved.revision, 2);
    assert.equal("workspaceId" in saved, false);

    const published = buildPublishBody(2, " pin v2 ");
    assert.deepEqual(published, { revision: 2, note: "pin v2" });
  });

  it("empty specs stay secret-free and pickSafeSpec drops blank credential ids", () => {
    const spec = emptySpecForKind("cluster_target");
    assert.equal(spec.credentialId, "");
    assert.equal("kubeconfig" in spec, false);
    const picked = pickSafeSpec({
      credentialId: "  ",
      endpointMetadata: { apiServerHost: "k8s.example" },
    });
    assert.equal(picked.credentialId, undefined);
    assert.equal(picked.endpointMetadata?.apiServerHost, "k8s.example");
  });
});

describe("publish / pin immutability UX helpers", () => {
  it("treats drafts as editable and published versions as read-only", () => {
    assert.equal(isDraftEditable("draft"), true);
    assert.equal(isDraftEditable("published"), true);
    assert.equal(isDraftEditable("disabled"), false);
    assert.equal(isPublishedVersionReadOnly(version()), true);
    assert.equal(isPublishedVersionReadOnly(null), false);
    assert.equal(
      canPublishDraft({ revision: 1, name: "prod-cluster" }, false),
      true,
    );
    assert.equal(
      canPublishDraft({ revision: 1, name: "prod-cluster" }, true),
      false,
    );
    assert.equal(canPublishDraft({ revision: 0, name: "x" }, false), false);
  });

  it("formats version pins as display name + version, never secrets", () => {
    const label = versionPinLabel({
      displayName: "prod-cluster",
      versionNumber: 3,
      digest: "sha256:abcdef0123456789ffff",
    });
    assert.match(label, /prod-cluster @ v3/);
    assert.match(label, /abcdef012345/);
    assert.doesNotMatch(label, /BEGIN|kubeconfig|token|secret/i);
    assert.equal(
      selectorOptionLabel(pin()),
      versionPinLabel({
        displayName: "prod-cluster",
        versionNumber: 3,
        digest: "sha256:abcdef0123456789",
      }),
    );
    const fromVersion = pinFromVersion(version());
    assert.equal(fromVersion.displayName, "restart-nginx");
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
});

describe("authorized-only selectors", () => {
  it("fails closed on 403 / problem+json and never invents foreign options", () => {
    const forbidden = authorizedSelectorOptions({
      statusCode: 403,
      problem: {
        type: "urn:flowforge:problem:forbidden",
        title: "Forbidden",
        status: 403,
        detail: "Cross-workspace resource.",
        instance: "/cluster-targets/authorized",
        code: "forbidden",
        request_id: "req-forbidden-16x",
      },
      items: [pin({ id: "99999999-9999-4999-8999-999999999999" })],
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
          instance: "/cluster-targets/authorized",
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

  it("accepts only pins with display name and version id", () => {
    const ok = authorizedSelectorOptions({ items: [pin()], statusCode: 200 });
    assert.equal(ok.closed, false);
    assert.equal(ok.options.length, 1);
    assert.equal(ok.options[0]?.displayName, "prod-cluster");

    const parsed = parseAuthorizedPins(
      {
        items: [
          {
            id: RESOURCE_ID,
            displayName: "prod-cluster",
            versionId: VERSION_ID,
            versionNumber: 1,
            digest: "sha256:aa",
          },
          { id: "not-a-uuid", displayName: "foreign", versionNumber: 1 },
        ],
      },
      "cluster_target",
    );
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.displayName, "prod-cluster");
  });
});

describe("RBAC-aware config nav", () => {
  it("hides config for viewers and shows it for editors/admins", () => {
    assert.equal(canSeeOpsConfigNav(["workflow.view", "execution.view"]), false);
    assert.equal(canSeeOpsConfigNav(["credential.view"]), true);
    assert.equal(canSeeOpsConfigNav(["workspace.administer"]), true);
    assert.equal(canSeeOpsConfigNav(null), true);
  });
});

describe("payload parsers", () => {
  it("reads camelCase and snake_case without requiring workspaceId", () => {
    const record = parseOpsConfigRecord({
      id: RESOURCE_ID,
      kind: "ssh_target",
      name: "edge",
      status: "draft",
      draft_revision: 4,
      spec: { hostname: "edge.example", secret: "nope" },
    });
    assert.equal(record?.draftRevision, 4);
    assert.equal(record?.spec.hostname, "edge.example");
    assert.equal(record && "secret" in record.spec, false);

    const draft = parseOpsConfigDraft({
      resourceId: RESOURCE_ID,
      kind: "policy",
      name: "prod-k8s",
      revision: 1,
      spec: { policyKind: "kubernetes", policyJson: { namespaces: ["app"] } },
    });
    assert.equal(draft?.revision, 1);
    assert.equal(draft?.spec.policyKind, "kubernetes");

    const published = parseOpsConfigVersion({
      id: VERSION_ID,
      resource_id: RESOURCE_ID,
      kind: "response_schema",
      name: "status-body",
      version_number: 1,
      digest: "sha256:ff",
      document: { schema: { type: "object" }, maxBytes: 1024 },
    });
    assert.equal(published?.versionNumber, 1);
    assert.equal(published?.spec.maxBytes, 1024);
  });
});
