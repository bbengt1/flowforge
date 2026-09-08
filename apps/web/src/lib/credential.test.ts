import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCreateCredentialBody,
  buildRotateCredentialBody,
  credentialListSearch,
  emptySecretDraft,
  forgetSecretDraft,
  secretFieldsForType,
} from "./credential-contract.ts";
import {
  assertSecretFreeStorageValue,
  clearSecretDraftAfterSubmit,
  deletionConfirmationState,
  filterCredentialList,
  isSecretFieldName,
  matchesCredentialSearch,
  sanitizeAuditEvents,
  sanitizeCredentialList,
  sanitizeCredentialRecord,
  sanitizeDeletionImpact,
  stripSecretFields,
} from "./credential.ts";
import type { CredentialRecord } from "./credential-types.ts";

const sample: CredentialRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  displayName: "prod-k8s",
  tags: ["prod", "cluster"],
  type: "kubernetes_target",
  status: "active",
  health: "healthy",
  policyState: "allowed",
  permittedActions: ["view", "edit", "rotate", "test", "delete"],
  allowedUse: ["credential.use"],
  targetMetadata: { clusterName: "ops", apiServerHost: "k8s.example.test" },
};

describe("credential secret hygiene", () => {
  it("treats secret-bearing keys as bugs to strip and keeps metadata keys", () => {
    assert.equal(isSecretFieldName("kubeconfig"), true);
    assert.equal(isSecretFieldName("privateKey"), true);
    assert.equal(isSecretFieldName("api_key"), true);
    assert.equal(isSecretFieldName("webhookSecret"), true);
    assert.equal(isSecretFieldName("ciphertext"), true);
    assert.equal(isSecretFieldName("dek_envelope"), true);
    assert.equal(isSecretFieldName("displayName"), false);
    assert.equal(isSecretFieldName("credentialId"), false);
    assert.equal(isSecretFieldName("lastTestStatus"), false);
    assert.equal(isSecretFieldName("tags"), false);
  });

  it("strips unexpected plaintext from API-shaped payloads", () => {
    const sanitized = sanitizeCredentialRecord({
      id: sample.id,
      displayName: "prod-k8s",
      type: "kubernetes_target",
      tags: ["prod"],
      status: "active",
      kubeconfig: "apiVersion: v1\nkind: Config",
      secret: { token: "super-secret-token" },
      targetMetadata: {
        clusterName: "ops",
        connectionString: "https://user:pass@k8s",
      },
    });
    assert.ok(sanitized.value);
    assert.equal(sanitized.value?.displayName, "prod-k8s");
    assert.equal(sanitized.value?.targetMetadata.clusterName, "ops");
    assert.ok(sanitized.strippedKeys.includes("kubeconfig"));
    assert.ok(sanitized.strippedKeys.includes("secret"));
    assert.ok(
      sanitized.strippedKeys.some((key) => key.includes("connectionString")),
    );
    assert.equal(
      JSON.stringify(sanitized.value).includes("super-secret-token"),
      false,
    );
    assert.equal(JSON.stringify(sanitized.value).includes("kind: Config"), false);
  });

  it("list/search matches display name and tags only", () => {
    const leaked: CredentialRecord = {
      ...sample,
      displayName: "edge-ssh",
      tags: ["edge"],
      type: "ssh_private_key",
    };
    const items = sanitizeCredentialList({
      items: [
        sample,
        leaked,
        {
          id: "22222222-2222-4222-8222-222222222222",
          displayName: "webhook",
          type: "webhook_secret",
          tags: ["hooks"],
          token: "should-not-match-search",
        },
      ],
    }).value;

    assert.equal(items.length, 3);
    assert.deepEqual(
      filterCredentialList(items, { q: "prod" }).map((item) => item.displayName),
      ["prod-k8s"],
    );
    assert.deepEqual(
      filterCredentialList(items, { q: "edge" }).map((item) => item.displayName),
      ["edge-ssh"],
    );
    assert.deepEqual(
      filterCredentialList(items, { q: "should-not-match-search" }).map(
        (item) => item.displayName,
      ),
      [],
    );
    assert.equal(matchesCredentialSearch(sample, { tag: "cluster" }), true);
    assert.equal(matchesCredentialSearch(sample, { type: "token" }), false);
  });

  it("list search query string never includes secret keys", () => {
    const path = credentialListSearch({
      q: "prod-k8s",
      type: "kubernetes_target",
      tag: "prod",
      status: "active",
    });
    assert.equal(
      path,
      "/credentials?q=prod-k8s&type=kubernetes_target&tag=prod&status=active",
    );
    assert.doesNotMatch(path, /kubeconfig|privateKey|token=|secret=/i);
  });

  it("create/rotate builders send secrets once then forget them", () => {
    const draft = emptySecretDraft();
    draft.kubeconfig = "-----BEGIN FAKE-----";
    draft.token = "k8s-token-value";
    const body = buildCreateCredentialBody({
      displayName: " prod-k8s ",
      tags: [" prod ", ""],
      type: "kubernetes_target",
      secret: draft,
      testOnCreate: true,
    });
    assert.equal(body.secret.kubeconfig, "-----BEGIN FAKE-----");
    assert.equal(body.displayName, "prod-k8s");
    assert.deepEqual(body.tags, ["prod"]);

    const forgotten = forgetSecretDraft(draft);
    assert.equal(draft.kubeconfig, "");
    assert.equal(draft.token, "");
    assert.equal(forgotten.kubeconfig, "");
    assert.equal(secretFieldsForType("ssh_private_key").includes("privateKey"), true);

    const rotateDraft = emptySecretDraft();
    rotateDraft.privateKey = "-----BEGIN OPENSSH PRIVATE KEY-----";
    const rotate = buildRotateCredentialBody("ssh_private_key", rotateDraft, true);
    assert.equal(rotate.secret.privateKey, "-----BEGIN OPENSSH PRIVATE KEY-----");
    assert.equal(rotate.secret.kubeconfig, undefined);
    clearSecretDraftAfterSubmit(rotateDraft);
    assert.equal(rotateDraft.privateKey, "");
  });

  it("delete-impact confirmation requires typed display name and blocks active executions", () => {
    const missing = deletionConfirmationState(null, "prod-k8s");
    assert.equal(missing.canProceed, false);

    const blocked = sanitizeDeletionImpact({
      credentialId: sample.id,
      displayName: "prod-k8s",
      canDelete: true,
      affectedDrafts: [{ workflowId: sample.id, name: "rollout" }],
      affectedVersions: [],
      activeExecutions: [
        {
          executionId: "33333333-3333-4333-8333-333333333333",
          workflowName: "rollout",
          status: "running",
        },
      ],
    }).value;
    assert.ok(blocked);
    assert.equal(blocked.canDelete, false);
    const blockedState = deletionConfirmationState(blocked, "prod-k8s");
    assert.equal(blockedState.canProceed, false);
    assert.match(blockedState.blockingReason ?? "", /Active executions/);

    const ready = sanitizeDeletionImpact({
      credential_id: sample.id,
      display_name: "prod-k8s",
      can_delete: true,
      affected_drafts: [{ workflow_id: sample.id, name: "rollout", slug: "rollout" }],
      affected_versions: [
        {
          workflow_id: sample.id,
          version_id: "44444444-4444-4444-8444-444444444444",
          name: "rollout",
          version_number: 2,
        },
      ],
      active_executions: [],
    }).value;
    assert.ok(ready);
    assert.equal(deletionConfirmationState(ready, "wrong").canProceed, false);
    assert.equal(deletionConfirmationState(ready, "prod-k8s").canProceed, true);
    assert.equal(ready.affectedDrafts[0]?.name, "rollout");
    assert.equal(ready.affectedVersions[0]?.versionNumber, 2);
  });

  it("audit sanitizer drops secret details and keeps redacted metadata", () => {
    const events = sanitizeAuditEvents({
      items: [
        {
          id: "evt-1",
          eventType: "credential.rotated",
          actorDisplayName: "Chloe",
          occurredAt: "2026-09-08T22:00:00.000Z",
          detailsRedacted: { outcome: "ok", token: "leaked" },
        },
      ],
    });
    assert.equal(events.value[0]?.eventType, "credential.rotated");
    assert.equal(events.value[0]?.detailsRedacted?.outcome, "ok");
    assert.equal(events.value[0]?.detailsRedacted?.token, undefined);
    assert.ok(events.strippedKeys.some((key) => key.endsWith("token")));
  });

  it("never treats secret maps as safe storage values", () => {
    const leaked = assertSecretFreeStorageValue({
      displayName: "prod-k8s",
      kubeconfig: "should-not-persist",
    });
    assert.ok(leaked.includes("kubeconfig"));
    const safe = stripSecretFields({
      q: "prod-k8s",
      type: "kubernetes_target",
    });
    assert.deepEqual(safe.strippedKeys, []);
  });
});
