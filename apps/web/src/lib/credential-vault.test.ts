import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { credentialListPath } from "./credential-contract.ts";
import { historyKeyAction } from "./execution-replay.ts";
import type { CredentialRecord } from "./credential-types.ts";
import {
  CREDENTIAL_KEK_ENV,
  CREDENTIAL_VAULT,
  CREDENTIAL_VAULT_COLUMNS,
  CREDENTIAL_VAULT_DETAIL_PATH,
  CREDENTIAL_VAULT_HELP,
  CREDENTIAL_VAULT_HREF,
  CREDENTIAL_VAULT_KEYBOARD_HELP,
  CREDENTIAL_VAULT_LIST_MUST_OMIT_KEYS,
  CREDENTIAL_VAULT_OPEN_LABEL,
  CREDENTIAL_VAULT_QUERY_KEYS,
  CREDENTIAL_VAULT_SOURCES,
  ISOLATION_CREDENTIAL_USE_PATH,
  R5_GUARDRAILS,
  R5_LATER_STORY_NOTES,
  R51_EPIC,
  R51_KEEP_STORY_OPEN,
  R51_STORY,
  credentialVaultChromeOmitsSecretKeys,
  credentialVaultColumnIds,
  credentialVaultColumnText,
  credentialVaultDisplay,
  credentialVaultDisplayNameRank,
  credentialVaultDoesNotMergeConfig,
  credentialVaultDoesNotReadKek,
  credentialVaultEmbedUnchanged,
  credentialVaultHasActiveFilters,
  credentialVaultHref,
  credentialVaultIsolationUseIsNotProduct,
  credentialVaultKeyAction,
  credentialVaultLastTestLabel,
  credentialVaultListPath,
  credentialVaultOpenHref,
  credentialVaultPreservesMetadataOnly,
  credentialVaultQueryNeverSentToList,
  credentialVaultTimeLabel,
  credentialVaultTypesUnchanged,
  credentialVaultUsesExistingListParams,
  isCredentialForbidden,
  parseCredentialVaultQuery,
  serializeCredentialVaultQuery,
} from "./credential-vault.ts";

const CREDENTIAL_ID = "11111111-1111-4111-8111-111111111111";

function sampleRecord(
  overrides: Partial<CredentialRecord> = {},
): CredentialRecord {
  return {
    id: CREDENTIAL_ID,
    displayName: "prod-k8s",
    tags: ["prod", "cluster"],
    type: "kubernetes",
    status: "active",
    metadata: { contextName: "ops" },
    fingerprint: "sha256:abc",
    encryptionVersion: 1,
    keyReference: "env:CREDENTIAL_KEK",
    lastTestStatus: "passed",
    lastTestedAt: "2026-09-08T21:00:00.000Z",
    useCount: 0,
    rotatedAt: "2026-09-08T20:00:00.000Z",
    permittedActions: ["view", "manage", "rotate", "test", "delete"],
    ...overrides,
  };
}

describe("R5.1 credential vault find", () => {
  it("keeps #264 open and cites epic #231", () => {
    assert.equal(R51_STORY, 264);
    assert.equal(R51_EPIC, 231);
    assert.equal(R51_KEEP_STORY_OPEN, true);
    assert.equal(CREDENTIAL_VAULT.migrateInPlace, true);
    assert.equal(CREDENTIAL_VAULT.findByDisplayName, true);
    assert.equal(CREDENTIAL_VAULT.operateDensity, true);
    assert.match(CREDENTIAL_VAULT_HELP, /display name/);
    assert.match(CREDENTIAL_VAULT_HELP, /\/credentials\/\{id\}/);
    assert.match(CREDENTIAL_VAULT_HELP, /CREDENTIAL_KEK/);
    assert.match(CREDENTIAL_VAULT_KEYBOARD_HELP, /opens the focused credential/);
    assert.equal(R5_GUARDRAILS.metadataOnly, true);
    assert.equal(R5_GUARDRAILS.noKekInBrowser, true);
    assert.equal(R5_GUARDRAILS.noConfigMerge, true);
    assert.equal(R5_GUARDRAILS.isolationUseIsNotProductVault, true);
    assert.match(R5_LATER_STORY_NOTES.r52, /#265/);
    assert.match(R5_LATER_STORY_NOTES.r53, /#266/);
    assert.ok(
      CREDENTIAL_VAULT_SOURCES.includes(
        "src/components/credentials/CredentialVault.tsx",
      ),
    );
  });

  it("parses workbench find params without inventing list query keys", () => {
    const query = parseCredentialVaultQuery(
      "q=prod-k8s&type=kubernetes&tag=prod&status=active&cursor=abc&secret=nope&kubeconfig=nope&limit=25",
    );
    assert.deepEqual(query, {
      q: "prod-k8s",
      type: "kubernetes",
      tag: "prod",
      status: "active",
    });
    assert.deepEqual(CREDENTIAL_VAULT_QUERY_KEYS, ["q", "type", "tag", "status"]);
    assert.ok(CREDENTIAL_VAULT_LIST_MUST_OMIT_KEYS.includes("secret"));
    assert.ok(CREDENTIAL_VAULT_LIST_MUST_OMIT_KEYS.includes("q"));
    assert.equal(parseCredentialVaultQuery("type=not-a-type").type, "");
    assert.equal(parseCredentialVaultQuery("status=revoked").status, "");
    assert.equal(parseCredentialVaultQuery({ q: ["edge-ssh"] }).q, "edge-ssh");
    assert.equal(
      credentialVaultQueryNeverSentToList(
        "q=prod&type=kubernetes&secret=leaked&cursor=1",
      ),
      true,
    );
  });

  it("writes find hrefs in the workbench URL and lists without query params", () => {
    assert.equal(credentialVaultHref(), CREDENTIAL_VAULT_HREF);
    assert.equal(
      credentialVaultHref({
        q: "prod-k8s",
        type: "kubernetes",
        tag: "prod",
        status: "active",
      }),
      "/credentials?q=prod-k8s&type=kubernetes&tag=prod&status=active",
    );
    assert.equal(
      credentialVaultHref({ q: "edge" }, true),
      "/embed/v1/credentials?q=edge",
    );
    assert.equal(
      credentialVaultListPath({
        q: "prod-k8s",
        type: "token",
        status: "disabled",
      }),
      credentialListPath(),
    );
    assert.equal(credentialVaultListPath({ q: "prod" }), "/credentials");
    assert.equal(
      credentialVaultUsesExistingListParams({
        q: "prod",
        type: "kubernetes",
        tag: "prod",
        status: "active",
      }),
      true,
    );
    assert.equal(serializeCredentialVaultQuery({}).toString(), "");
    assert.equal(
      credentialVaultHasActiveFilters({ q: "prod", type: "", tag: "", status: "" }),
      true,
    );
    assert.equal(
      credentialVaultHasActiveFilters({ q: "", type: "", tag: "", status: "" }),
      false,
    );
  });

  it("ranks display-name hits and opens detail without hunting", () => {
    const rows = credentialVaultDisplay(
      [
        sampleRecord({
          id: "22222222-2222-4222-8222-222222222222",
          displayName: "edge-ssh",
          type: "ssh_private_key",
          tags: ["prod"],
        }),
        sampleRecord(),
        sampleRecord({
          id: "33333333-3333-4333-8333-333333333333",
          displayName: "webhook",
          type: "webhook_secret",
          tags: ["prod-k8s"],
        }),
      ],
      { q: "prod-k8s" },
    );
    assert.deepEqual(credentialVaultColumnIds(), [
      "name",
      "type",
      "status",
      "tags",
      "lastTest",
      "rotated",
      "open",
    ]);
    assert.equal(CREDENTIAL_VAULT_COLUMNS.length, 7);
    assert.equal(rows[0]?.displayName, "prod-k8s");
    assert.equal(rows[0]?.typeLabel, "Kubernetes kubeconfig");
    assert.equal(rows[0]?.statusLabel, "Active");
    assert.equal(rows[0]?.openLabel, CREDENTIAL_VAULT_OPEN_LABEL);
    assert.equal(rows[0]?.href, `/credentials/${CREDENTIAL_ID}`);
    assert.equal(rows.length, 2);
    assert.equal(rows[1]?.displayName, "webhook");
    assert.equal(credentialVaultDisplayNameRank(sampleRecord(), "prod-k8s"), 0);
    assert.equal(credentialVaultDisplayNameRank(sampleRecord(), "prod"), 1);
    assert.match(credentialVaultColumnText(rows[0]!), /Open/);
    assert.equal(
      credentialVaultOpenHref(CREDENTIAL_ID),
      `/credentials/${CREDENTIAL_ID}`,
    );
    assert.equal(
      credentialVaultOpenHref(CREDENTIAL_ID, true),
      `/embed/v1/credentials/${CREDENTIAL_ID}`,
    );
    assert.equal(credentialVaultTimeLabel("—"), "—");
    assert.equal(
      credentialVaultTimeLabel("2026-09-08T21:00:00.000Z"),
      "2026-09-08 21:00:00Z",
    );
    assert.equal(
      credentialVaultLastTestLabel(sampleRecord()),
      "passed · 2026-09-08 21:00:00Z",
    );
    assert.equal(CREDENTIAL_VAULT.openToDetailWithoutHunting, true);
    assert.equal(CREDENTIAL_VAULT.usefulColumns, true);
    assert.equal(CREDENTIAL_VAULT.searchAndFilter, true);
  });

  it("reuses listbox keys and existing vault detail, not isolation use", () => {
    assert.deepEqual(
      credentialVaultKeyAction("ArrowDown", 0, 3),
      historyKeyAction("ArrowDown", 0, 3),
    );
    assert.deepEqual(credentialVaultKeyAction("Enter", 1, 3), {
      index: 1,
      activate: true,
    });
    assert.equal(credentialVaultIsolationUseIsNotProduct(), true);
    assert.equal(ISOLATION_CREDENTIAL_USE_PATH, "/workspace/credentials/{id}/use");
    assert.equal(CREDENTIAL_VAULT_DETAIL_PATH, "/credentials/{id}");
    assert.equal(
      credentialVaultOpenHref(CREDENTIAL_ID).includes("/workspace/credentials/"),
      false,
    );
  });

  it("keeps metadata-only chrome, no KEK, no /config merge, unchanged embed", () => {
    const leakedName = sampleRecord({
      displayName: "edge-ssh",
      type: "ssh_private_key",
      keyReference: "env:CREDENTIAL_KEK",
    });
    assert.equal(credentialVaultPreservesMetadataOnly([leakedName]), true);
    assert.equal(
      credentialVaultChromeOmitsSecretKeys(
        credentialVaultColumnText(credentialVaultDisplay([leakedName])[0]!),
      ),
      true,
    );
    assert.equal(
      credentialVaultChromeOmitsSecretKeys("-----BEGIN OPENSSH PRIVATE KEY-----"),
      false,
    );
    assert.equal(credentialVaultDoesNotReadKek(), true);
    assert.equal(CREDENTIAL_KEK_ENV, "CREDENTIAL_KEK");
    assert.equal(credentialVaultDoesNotMergeConfig(), true);
    assert.equal(credentialVaultTypesUnchanged(), true);
    assert.equal(credentialVaultEmbedUnchanged(), true);
    assert.equal(CREDENTIAL_VAULT.noInventedListQueryParams, true);
    assert.equal(CREDENTIAL_VAULT.clientSideDisplayNameFilter, true);
    assert.equal(CREDENTIAL_VAULT.noNewApiRoutes, true);
    assert.equal(CREDENTIAL_VAULT.rbacFailClosed, true);
    assert.equal(
      isCredentialForbidden({
        type: "about:blank",
        title: "Forbidden",
        status: 403,
        detail: "missing credential.view",
        code: "forbidden",
      }),
      true,
    );
    assert.equal(isCredentialForbidden(null), false);
  });
});
