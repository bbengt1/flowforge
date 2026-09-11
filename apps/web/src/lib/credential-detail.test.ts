import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  credentialDeletionImpactPath,
  credentialDisablePath,
  credentialEnablePath,
  credentialRotatePath,
  credentialTestPath,
  credentialUsagePath,
  emptySecretDraft,
} from "./credential-contract.ts";
import { clearSecretDraftAfterSubmit } from "./credential.ts";
import type {
  CredentialDeletionImpact,
  CredentialRecord,
  CredentialUsage,
} from "./credential-types.ts";
import {
  CREDENTIAL_DETAIL,
  CREDENTIAL_DETAIL_CHROME_OMIT_KEYS,
  CREDENTIAL_DETAIL_DISABLE_ENABLE_HELP,
  CREDENTIAL_DETAIL_HELP,
  CREDENTIAL_DETAIL_HREF,
  CREDENTIAL_DETAIL_OPERATE_ROUTES,
  CREDENTIAL_DETAIL_ROTATE_HELP,
  CREDENTIAL_DETAIL_SECTIONS,
  CREDENTIAL_DETAIL_SOURCES,
  CREDENTIAL_DETAIL_STRIP_STOP_HELP,
  CREDENTIAL_KEK_ENV,
  R52_EPIC,
  R52_KEEP_STORY_OPEN,
  R52_STORY,
  R5_GUARDRAILS,
  R5_LATER_STORY_NOTES,
  R5_SECURITY_LINE,
  credentialDetailAfterMutate,
  credentialDetailCanConfirmDelete,
  credentialDetailChromeOmitsSecretKeys,
  credentialDetailCsrfOnMutations,
  credentialDetailDisableEnableLabel,
  credentialDetailDoesNotMergeConfig,
  credentialDetailDoesNotReadKek,
  credentialDetailEmbedUnchanged,
  credentialDetailHeaderMeta,
  credentialDetailHeaderOmitsKek,
  credentialDetailHoldsSecurityLine,
  credentialDetailHref,
  credentialDetailIdentityIsDisplayNameAndUuid,
  credentialDetailIdentityText,
  credentialDetailImpactDisplay,
  credentialDetailIsolationUseIsNotProduct,
  credentialDetailListHref,
  credentialDetailMustStopAfterStrip,
  credentialDetailRotateNeverSurfacesPlaintext,
  credentialDetailSecretsStayOutOfYamlSearchAnalytics,
  credentialDetailSectionIds,
  credentialDetailTestDisplay,
  credentialDetailTypesUnchanged,
  credentialDetailUsageDisplay,
  credentialDetailUsesExistingRoutes,
} from "./credential-detail.ts";
import { CSRF_HEADER } from "./session-contract.ts";

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
    lastTestReason: "payload shape is valid",
    useCount: 3,
    rotatedAt: "2026-09-08T20:00:00.000Z",
    expiresAt: "2026-12-31T23:59:59.000Z",
    permittedActions: ["view", "manage", "rotate", "test", "delete", "disable"],
    ...overrides,
  };
}

function sampleUsage(
  overrides: Partial<CredentialUsage> = {},
): CredentialUsage {
  return {
    credentialId: CREDENTIAL_ID,
    useCount: 3,
    lastUsedAt: "2026-09-08T22:00:00.000Z",
    lastUsedBy: "operator-chloe",
    drafts: [
      {
        kind: "draft",
        workflowId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        workflowName: "deploy-edge",
        workflowSlug: "deploy-edge",
      },
    ],
    versions: [
      {
        kind: "version",
        workflowId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        workflowName: "deploy-edge",
        versionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        versionNumber: 4,
      },
    ],
    executions: [
      {
        kind: "execution",
        workflowId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        workflowName: "deploy-edge",
        executionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        executionStatus: "succeeded",
      },
    ],
    ...overrides,
  };
}

function sampleImpact(
  overrides: Partial<CredentialDeletionImpact> = {},
): CredentialDeletionImpact {
  return {
    credentialId: CREDENTIAL_ID,
    displayName: "prod-k8s",
    status: "active",
    canDelete: true,
    drafts: sampleUsage().drafts,
    versions: sampleUsage().versions,
    activeExecutions: [],
    ...overrides,
  };
}

describe("R5.2 credential detail operate density", () => {
  it("keeps #265 open and cites epic #231", () => {
    assert.equal(R52_STORY, 265);
    assert.equal(R52_EPIC, 231);
    assert.equal(R52_KEEP_STORY_OPEN, true);
    assert.equal(CREDENTIAL_DETAIL.operateDensity, true);
    assert.equal(CREDENTIAL_DETAIL.migrateInPlace, true);
    assert.equal(CREDENTIAL_DETAIL.inheritR5SecurityLine, true);
    assert.equal(CREDENTIAL_DETAIL_HREF, "/credentials/{id}");
    assert.match(CREDENTIAL_DETAIL_HELP, /operate/);
    assert.match(CREDENTIAL_DETAIL_HELP, /test/);
    assert.match(CREDENTIAL_DETAIL_HELP, /rotate/);
    assert.match(CREDENTIAL_DETAIL_HELP, /usage/);
    assert.match(CREDENTIAL_DETAIL_HELP, /deletion-impact/);
    assert.match(CREDENTIAL_DETAIL_HELP, /CREDENTIAL_KEK/);
    assert.match(CREDENTIAL_DETAIL_HELP, /strip \+ stop/);
    assert.match(CREDENTIAL_DETAIL_HELP, /CSRF/);
    assert.match(CREDENTIAL_DETAIL_ROTATE_HELP, /display-name \+ UUID only/);
    assert.match(CREDENTIAL_DETAIL_DISABLE_ENABLE_HELP, /Disable and enable/);
    assert.equal(R5_SECURITY_LINE.noKekInBrowser, true);
    assert.equal(R5_SECURITY_LINE.displayNamePlusUuidOnly, true);
    assert.equal(R5_SECURITY_LINE.secretsNeverInYamlSearchOrAnalytics, true);
    assert.equal(R5_SECURITY_LINE.unexpectedPlaintextIsContractBug, true);
    assert.equal(R5_SECURITY_LINE.stripAndStop, true);
    assert.equal(R5_GUARDRAILS.csrfOnMutations, true);
    assert.match(R5_LATER_STORY_NOTES.r52, /#265/);
    assert.match(R5_LATER_STORY_NOTES.r53, /#266/);
    assert.ok(
      CREDENTIAL_DETAIL_SOURCES.includes(
        "src/components/credentials/CredentialDetail.tsx",
      ),
    );
  });

  it("exposes test, rotate, usage, and deletion-impact on existing vault routes", () => {
    assert.deepEqual(credentialDetailSectionIds(), [
      "test",
      "rotate",
      "usage",
      "deletionImpact",
      "disableEnable",
    ]);
    assert.equal(CREDENTIAL_DETAIL_SECTIONS.length, 5);
    assert.equal(CREDENTIAL_DETAIL.testAtOperateDensity, true);
    assert.equal(CREDENTIAL_DETAIL.rotateAtOperateDensity, true);
    assert.equal(CREDENTIAL_DETAIL.usageAtOperateDensity, true);
    assert.equal(CREDENTIAL_DETAIL.deletionImpactAtOperateDensity, true);
    assert.equal(CREDENTIAL_DETAIL.autoLoadUsageAndDeletionImpact, true);
    assert.equal(CREDENTIAL_DETAIL.disableEnableRemainClear, true);
    assert.equal(credentialDetailUsesExistingRoutes(CREDENTIAL_ID), true);
    assert.equal(
      CREDENTIAL_DETAIL_OPERATE_ROUTES.test,
      "/credentials/{id}/test",
    );
    assert.equal(
      credentialTestPath(CREDENTIAL_ID),
      `/credentials/${CREDENTIAL_ID}/test`,
    );
    assert.equal(
      credentialRotatePath(CREDENTIAL_ID),
      `/credentials/${CREDENTIAL_ID}/rotate`,
    );
    assert.equal(
      credentialUsagePath(CREDENTIAL_ID),
      `/credentials/${CREDENTIAL_ID}/usage`,
    );
    assert.equal(
      credentialDeletionImpactPath(CREDENTIAL_ID),
      `/credentials/${CREDENTIAL_ID}/deletion-impact`,
    );
    assert.equal(
      credentialDisablePath(CREDENTIAL_ID),
      `/credentials/${CREDENTIAL_ID}/disable`,
    );
    assert.equal(
      credentialEnablePath(CREDENTIAL_ID),
      `/credentials/${CREDENTIAL_ID}/enable`,
    );
    assert.equal(
      credentialDetailHref(CREDENTIAL_ID),
      `/credentials/${CREDENTIAL_ID}`,
    );
    assert.equal(
      credentialDetailHref(CREDENTIAL_ID, true),
      `/embed/v1/credentials/${CREDENTIAL_ID}`,
    );
    assert.equal(credentialDetailListHref(), "/credentials");
    assert.equal(credentialDetailListHref(true), "/embed/v1/credentials");
  });

  it("shows last test, usage, and deletion-impact without hunting", () => {
    const test = credentialDetailTestDisplay(
      {
        status: "failed",
        reason: "kubeconfig missing cluster",
        checkedAt: "2026-09-11T12:00:00.000Z",
      },
      sampleRecord(),
    );
    assert.equal(test.status, "failed");
    assert.equal(test.reason, "kubeconfig missing cluster");
    assert.equal(test.checkedAt, "2026-09-11 12:00:00Z");
    assert.match(test.label, /failed/);

    const fromRecord = credentialDetailTestDisplay(null, sampleRecord());
    assert.equal(fromRecord.status, "passed");
    assert.equal(fromRecord.reason, "payload shape is valid");

    const usage = credentialDetailUsageDisplay(sampleUsage());
    assert.equal(usage.useCount, 3);
    assert.equal(usage.lastUsedBy, "operator-chloe");
    assert.equal(usage.drafts[0], "deploy-edge (deploy-edge)");
    assert.equal(usage.versions[0], "deploy-edge v4");
    assert.match(usage.executions[0] ?? "", /succeeded/);

    const impact = credentialDetailImpactDisplay(sampleImpact());
    assert.equal(impact.canDelete, true);
    assert.equal(impact.displayName, "prod-k8s");
    assert.equal(impact.activeExecutions.length, 0);
    assert.equal(
      credentialDetailCanConfirmDelete(sampleImpact(), "prod-k8s"),
      true,
    );
    assert.equal(
      credentialDetailCanConfirmDelete(sampleImpact(), "wrong"),
      false,
    );
    assert.equal(credentialDetailCanConfirmDelete(null, "prod-k8s"), false);

    const blocked = credentialDetailImpactDisplay(
      sampleImpact({
        canDelete: false,
        blockReason: "Active executions still reference this credential.",
        activeExecutions: sampleUsage().executions,
      }),
    );
    assert.equal(blocked.canDelete, false);
    assert.match(blocked.blockReason, /Active executions/);
  });

  it("keeps disable/enable explicit and CSRF on mutations", () => {
    assert.equal(credentialDetailDisableEnableLabel("active"), "Disable");
    assert.equal(credentialDetailDisableEnableLabel("disabled"), "Enable");
    assert.equal(credentialDetailCsrfOnMutations(), true);
    assert.equal(CSRF_HEADER, "X-CSRF-Token");
    assert.match(CREDENTIAL_DETAIL_DISABLE_ENABLE_HELP, /not a cryptic toggle/);
  });

  it("returns display-name + UUID only after mutate and never surfaces rotate plaintext", () => {
    const record = sampleRecord();
    const identity = credentialDetailAfterMutate(record);
    assert.deepEqual(identity, {
      id: CREDENTIAL_ID,
      displayName: "prod-k8s",
    });
    assert.equal(credentialDetailIdentityIsDisplayNameAndUuid(identity), true);
    assert.equal(
      credentialDetailIdentityText(identity),
      `prod-k8s (${CREDENTIAL_ID})`,
    );
    assert.equal("keyReference" in identity, false);
    assert.equal("secret" in identity, false);

    const draft = emptySecretDraft();
    draft.kubeconfig = "apiVersion: v1\nkind: Config\n";
    const leftover = emptySecretDraft();
    leftover.kubeconfig = "apiVersion: v1\nkind: Config\n";
    const cleared = clearSecretDraftAfterSubmit(draft);
    assert.equal(
      credentialDetailRotateNeverSurfacesPlaintext({
        record,
        draft: cleared,
      }),
      true,
    );
    assert.equal(
      credentialDetailRotateNeverSurfacesPlaintext({
        record,
        strippedKeys: ["secret"],
        draft: cleared,
      }),
      true,
    );
    assert.equal(
      credentialDetailRotateNeverSurfacesPlaintext({
        record,
        draft: leftover,
      }),
      false,
    );
  });

  it("inherits the R5 security line: no KEK, strip + stop, no secrets in YAML/search", () => {
    const record = sampleRecord();
    assert.equal(credentialDetailDoesNotReadKek(), true);
    assert.equal(CREDENTIAL_KEK_ENV, "CREDENTIAL_KEK");
    assert.ok(CREDENTIAL_DETAIL_CHROME_OMIT_KEYS.includes("keyReference"));
    assert.ok(CREDENTIAL_DETAIL_CHROME_OMIT_KEYS.includes("CREDENTIAL_KEK"));
    assert.equal(credentialDetailHeaderOmitsKek(record), true);
    const header = credentialDetailHeaderMeta(record);
    assert.equal(header.identity.displayName, "prod-k8s");
    assert.doesNotMatch(
      JSON.stringify(header),
      /keyReference|CREDENTIAL_KEK/,
    );
    assert.equal(credentialDetailMustStopAfterStrip([]), false);
    assert.equal(credentialDetailMustStopAfterStrip(["kubeconfig"]), true);
    assert.match(CREDENTIAL_DETAIL_STRIP_STOP_HELP, /Stop/);
    assert.match(CREDENTIAL_DETAIL_STRIP_STOP_HELP, /do not paste/);
    assert.equal(
      credentialDetailChromeOmitsSecretKeys("-----BEGIN OPENSSH PRIVATE KEY-----"),
      false,
    );
    assert.equal(
      credentialDetailChromeOmitsSecretKeys("prod-k8s passed"),
      true,
    );
    assert.equal(
      credentialDetailSecretsStayOutOfYamlSearchAnalytics(
        record,
        sampleUsage(),
        sampleImpact(),
      ),
      true,
    );
    assert.equal(credentialDetailHoldsSecurityLine(record), true);
    assert.equal(
      credentialDetailHoldsSecurityLine(record, ["token"], emptySecretDraft()),
      true,
    );
    assert.equal(credentialDetailDoesNotMergeConfig(), true);
    assert.equal(credentialDetailTypesUnchanged(), true);
    assert.equal(credentialDetailIsolationUseIsNotProduct(), true);
    assert.equal(credentialDetailEmbedUnchanged(), true);
    assert.equal(CREDENTIAL_DETAIL.noNewApiRoutes, true);
    assert.equal(CREDENTIAL_DETAIL.noNewCredentialTypes, true);
  });

  it("keeps keyReference and rotate plaintext out of detail chrome source", () => {
    const detailPath = fileURLToPath(
      new URL("../components/credentials/CredentialDetail.tsx", import.meta.url),
    );
    const source = readFileSync(detailPath, "utf8");
    assert.equal(source.includes("record.keyReference"), false);
    assert.doesNotMatch(source, /key reference/i);
    assert.match(source, /rotateCredential/);
    assert.match(source, /testCredential/);
    assert.match(source, /getCredentialUsage/);
    assert.match(source, /getCredentialDeletionImpact/);
    assert.match(source, /credentialDetailAfterMutate/);
    assert.match(source, /credentialDetailMustStopAfterStrip/);
    assert.match(source, /CREDENTIAL_DETAIL_HELP/);
    assert.doesNotMatch(source, /process\.env/);
  });
});
