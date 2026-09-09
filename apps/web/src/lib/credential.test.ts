import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FALLBACK_CREDENTIAL_CATALOG,
  buildCreateCredentialBody,
  buildDeleteCredentialBody,
  buildRotateCredentialBody,
  credentialEventsPath,
  credentialListPath,
  emptySecretDraft,
  forgetSecretDraft,
  secretFieldsForType,
} from "./credential-contract.ts";
import {
  assertSecretFreeStorageValue,
  clearSecretDraftAfterSubmit,
  deletionConfirmationState,
  secretDraftIsCleared,
  filterCredentialList,
  isSecretFieldName,
  matchesCredentialSearch,
  sanitizeCatalog,
  sanitizeCredentialList,
  sanitizeCredentialRecord,
  sanitizeDeletionImpact,
  sanitizeEvents,
  sanitizeTestResponse,
  stripSecretFields,
} from "./credential.ts";
import type { CredentialRecord } from "./credential-types.ts";

const sample: CredentialRecord = {
  id: "11111111-1111-4111-8111-111111111111",
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
  permittedActions: ["view", "manage", "rotate", "test", "delete"],
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
    assert.equal(isSecretFieldName("credential"), false);
    assert.equal(isSecretFieldName("credentialId"), false);
    assert.equal(isSecretFieldName("lastTestStatus"), false);
    assert.equal(isSecretFieldName("fingerprint"), false);
    assert.equal(isSecretFieldName("tokenKind"), false);
    assert.equal(isSecretFieldName("tags"), false);
  });

  it("strips unexpected plaintext from API-shaped payloads", () => {
    const sanitized = sanitizeCredentialRecord({
      id: sample.id,
      displayName: "prod-k8s",
      type: "kubernetes",
      tags: ["prod"],
      status: "active",
      fingerprint: "sha256:abc",
      kubeconfig: "apiVersion: v1\nkind: Config",
      secret: { token: "super-secret-token" },
      metadata: {
        contextName: "ops",
        connectionString: "https://user:pass@k8s",
      },
    });
    assert.ok(sanitized.value);
    assert.equal(sanitized.value?.displayName, "prod-k8s");
    assert.equal(sanitized.value?.type, "kubernetes");
    assert.equal(sanitized.value?.metadata.contextName, "ops");
    assert.equal(sanitized.value?.metadata.connectionString, undefined);
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

  it("list path has no invented query params and never includes secret keys", () => {
    const path = credentialListPath();
    assert.equal(path, "/credentials");
    assert.doesNotMatch(path, /kubeconfig|privateKey|token=|secret=|\?/i);
    assert.equal(
      credentialEventsPath(sample.id),
      `/credentials/${sample.id}/events`,
    );
  });

  it("create/rotate builders send secrets once then forget them", () => {
    const draft = emptySecretDraft();
    draft.kubeconfig = "-----BEGIN FAKE-----";
    draft.token = "k8s-token-value";
    const body = buildCreateCredentialBody({
      displayName: " prod-k8s ",
      tags: [" Prod ", ""],
      type: "kubernetes",
      secret: draft,
      metadata: { contextName: "ops", kubeconfig: "must-not-copy" },
    });
    assert.equal(body.secret.kubeconfig, "-----BEGIN FAKE-----");
    assert.equal(body.secret.token, undefined);
    assert.equal(body.displayName, "prod-k8s");
    assert.deepEqual(body.tags, ["prod"]);
    assert.deepEqual(body.metadata, { contextName: "ops" });
    assert.equal("testOnCreate" in body, false);
    assert.equal("targetMetadata" in body, false);

    const forgotten = forgetSecretDraft(draft);
    assert.equal(draft.kubeconfig, "");
    assert.equal(draft.token, "");
    assert.equal(forgotten.kubeconfig, "");
    assert.equal(secretFieldsForType("ssh_private_key").includes("privateKey"), true);
    assert.equal(secretFieldsForType("provider").includes("token"), true);

    const rotateDraft = emptySecretDraft();
    rotateDraft.privateKey = "-----BEGIN OPENSSH PRIVATE KEY-----";
    const rotate = buildRotateCredentialBody("ssh_private_key", rotateDraft);
    assert.equal(rotate.secret.privateKey, "-----BEGIN OPENSSH PRIVATE KEY-----");
    assert.equal(rotate.secret.kubeconfig, undefined);
    assert.equal("testOnRotate" in rotate, false);
    clearSecretDraftAfterSubmit(rotateDraft);
    assert.equal(rotateDraft.privateKey, "");
    assert.equal(secretDraftIsCleared(rotateDraft), true);
    const testDraft = emptySecretDraft();
    testDraft.token = "rotate-then-test";
    assert.equal(secretDraftIsCleared(testDraft), false);
    assert.equal(secretDraftIsCleared(clearSecretDraftAfterSubmit(testDraft)), true);
    assert.doesNotMatch(credentialEventsPath(sample.id), /token=|secret=|kubeconfig/i);
    assert.deepEqual(buildDeleteCredentialBody(), { confirm: true });
  });

  it("delete-impact confirmation requires typed display name and blocks active executions", () => {
    const missing = deletionConfirmationState(null, "prod-k8s");
    assert.equal(missing.canProceed, false);

    const blocked = sanitizeDeletionImpact({
      credentialId: sample.id,
      displayName: "prod-k8s",
      status: "active",
      canDelete: true,
      drafts: [
        {
          kind: "draft",
          workflowId: sample.id,
          workflowName: "rollout",
        },
      ],
      versions: [],
      activeExecutions: [
        {
          kind: "execution",
          workflowId: sample.id,
          workflowName: "rollout",
          executionId: "33333333-3333-4333-8333-333333333333",
          executionStatus: "running",
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
      status: "active",
      can_delete: true,
      drafts: [
        {
          kind: "draft",
          workflow_id: sample.id,
          workflow_name: "rollout",
          workflow_slug: "rollout",
        },
      ],
      versions: [
        {
          kind: "version",
          workflow_id: sample.id,
          workflow_name: "rollout",
          version_id: "44444444-4444-4444-8444-444444444444",
          version_number: 2,
        },
      ],
      active_executions: [],
    }).value;
    assert.ok(ready);
    assert.equal(deletionConfirmationState(ready, "wrong").canProceed, false);
    assert.equal(deletionConfirmationState(ready, "prod-k8s").canProceed, true);
    assert.equal(ready.drafts[0]?.workflowName, "rollout");
    assert.equal(ready.versions[0]?.versionNumber, 2);
  });

  it("events sanitizer drops secret details and keeps redacted metadata", () => {
    const events = sanitizeEvents({
      items: [
        {
          id: "evt-1",
          credentialId: sample.id,
          eventType: "rotated",
          actorId: "operator-chloe",
          occurredAt: "2026-09-08T22:00:00.000Z",
          details: { outcome: "ok", token: "leaked" },
        },
      ],
    });
    assert.equal(events.value[0]?.eventType, "rotated");
    assert.equal(events.value[0]?.details.outcome, "ok");
    assert.equal(events.value[0]?.details.token, undefined);
    assert.ok(events.strippedKeys.some((key) => key.endsWith("token")));
  });

  it("test response uses result.reason/checkedAt and strips leaked secrets", () => {
    const tested = sanitizeTestResponse({
      result: {
        status: "passed",
        reason: "payload shape is valid",
        checkedAt: "2026-09-08T22:00:00.000Z",
        token: "should-be-stripped",
      },
      credential: {
        ...sample,
        secret: { kubeconfig: "nope" },
      },
    });
    assert.equal(tested.value.result.status, "passed");
    assert.equal(tested.value.result.reason, "payload shape is valid");
    assert.equal(tested.value.credential?.displayName, "prod-k8s");
    assert.equal(
      JSON.stringify(tested.value).includes("should-be-stripped"),
      false,
    );
    assert.ok(tested.strippedKeys.some((key) => key.includes("token")));
  });

  it("catalog sanitizer keeps field names only", () => {
    const catalog = sanitizeCatalog({
      types: FALLBACK_CREDENTIAL_CATALOG.types,
      secret: { token: "nope" },
    });
    assert.equal(catalog.value.types.length, 5);
    assert.equal(catalog.value.types[0]?.type, "kubernetes");
    assert.deepEqual(
      catalog.value.types.map((item) => item.type),
      ["kubernetes", "ssh_private_key", "token", "webhook_secret", "provider"],
    );
    assert.ok(catalog.strippedKeys.includes("secret"));
  });

  it("never treats secret maps as safe storage values", () => {
    const leaked = assertSecretFreeStorageValue({
      displayName: "prod-k8s",
      kubeconfig: "should-not-persist",
    });
    assert.ok(leaked.includes("kubeconfig"));
    const safe = stripSecretFields({
      q: "prod-k8s",
      type: "kubernetes",
    });
    assert.deepEqual(safe.strippedKeys, []);
  });
});
