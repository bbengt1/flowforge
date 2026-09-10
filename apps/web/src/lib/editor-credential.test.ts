import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EDITOR_CREDENTIAL,
  EDITOR_CREDENTIAL_NEW_HREF,
  EDITOR_CREDENTIAL_VAULT_HREF,
  INSPECTOR_CREDENTIAL_RAIL_SOURCES,
  INSPECTOR_CREDENTIAL_WIZARD_SOURCES,
  UX7_EPIC,
  UX7_KEEP_STORY_OPEN,
  UX7_STORY,
  createdCredentialSelectable,
  credentialEmbedRoutesUnchanged,
  editorPathForWorkflow,
  inspectorAddCredentialHref,
  inspectorCreatedCredentialPatch,
  inspectorCredentialQueryIsSecretFree,
  inspectorEditorReturnHref,
  inspectorRailForbidsSecretSurface,
  parseInspectorCreatedCredential,
  parseInspectorCredentialReturnTo,
  stripInspectorCredentialQuery,
  vaultHomeHref,
} from "./editor-credential.ts";
import {
  EDITOR_INSPECTOR,
  INSPECTOR_NO_SECRET_SURFACE_HELP,
} from "./editor-inspector.ts";
import {
  clearSecretDraftAfterSubmit,
  secretDraftIsCleared,
  stripSecretFields,
} from "./credential.ts";
import { emptySecretDraft, forgetSecretDraft } from "./credential-contract.ts";
import type { CredentialRecord } from "./credential-types.ts";

const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
const CREDENTIAL_ID = "33333333-3333-4333-8333-333333333333";
const EDITOR_PATH = `/workflows/${WORKFLOW_ID}`;

function record(
  overrides: Partial<CredentialRecord> = {},
): CredentialRecord {
  return {
    id: CREDENTIAL_ID,
    type: "ssh_private_key",
    displayName: "edge-ssh",
    status: "active",
    tags: ["edge"],
    metadata: {},
    fingerprint: "sha256:abc",
    encryptionVersion: 1,
    keyReference: "env:CREDENTIAL_KEK",
    lastTestStatus: "untested",
    useCount: 0,
    permittedActions: ["view", "use"],
    ...overrides,
  };
}

describe("UX.7 inspector add credential", () => {
  it("keeps #202 open and cites epic #195", () => {
    assert.equal(UX7_STORY, 202);
    assert.equal(UX7_EPIC, 195);
    assert.equal(UX7_KEEP_STORY_OPEN, true);
  });

  it("picks display names from GET /credentials and adds via the masked wizard", () => {
    assert.equal(EDITOR_CREDENTIAL.pickFromGetCredentials, true);
    assert.equal(EDITOR_CREDENTIAL.addOpensMaskedWizard, true);
    assert.equal(EDITOR_CREDENTIAL.wizardIsModalOrReturnToEditor, true);
    assert.equal(EDITOR_INSPECTOR.noCredentialFromInspectorModal, false);
    assert.equal(EDITOR_CREDENTIAL.vaultHomeRemainsCredentials, true);
    assert.equal(vaultHomeHref(), EDITOR_CREDENTIAL_VAULT_HREF);
    assert.equal(vaultHomeHref(true), "/embed/v1/credentials");
  });

  it("builds a /credentials/new return-to-editor href without secrets", () => {
    const href = inspectorAddCredentialHref({
      editorPath: EDITOR_PATH,
      workflowId: WORKFLOW_ID,
      nodeId: "ssh-run",
      field: "credentialId",
    });
    assert.equal(href.startsWith(`${EDITOR_CREDENTIAL_NEW_HREF}?`), true);
    assert.match(href, /returnTo=/);
    assert.match(href, /node=ssh-run/);
    assert.match(href, /field=credentialId/);
    assert.doesNotMatch(href, /kubeconfig|privateKey|BEGIN|token=/);
    assert.equal(inspectorCredentialQueryIsSecretFree(href.slice(href.indexOf("?"))), true);
    const parsed = parseInspectorCredentialReturnTo(new URLSearchParams(href.split("?")[1]));
    assert.deepEqual(parsed, {
      editorPath: EDITOR_PATH,
      workflowId: WORKFLOW_ID,
      nodeId: "ssh-run",
      field: "credentialId",
    });
  });

  it("rejects secret-shaped or off-editor return query values", () => {
    assert.equal(
      parseInspectorCredentialReturnTo({
        returnTo: "/credentials",
        node: "ssh-run",
        field: "credentialId",
      }),
      null,
    );
    assert.equal(
      parseInspectorCredentialReturnTo({
        returnTo: EDITOR_PATH,
        node: "ssh-run",
        field: "kubeconfig",
      }),
      null,
    );
    assert.equal(
      parseInspectorCredentialReturnTo({
        returnTo: EDITOR_PATH,
        node: "-----BEGIN RSA PRIVATE KEY-----",
        field: "credentialId",
      }),
      null,
    );
    assert.equal(editorPathForWorkflow("not-a-path"), `/workflows/not-a-path`);
    assert.equal(editorPathForWorkflow("-----BEGIN RSA PRIVATE KEY-----"), null);
  });

  it("after create, the new display name can be selected as a UUID onto with", () => {
    assert.equal(EDITOR_CREDENTIAL.afterCreateSelectsDisplayName, true);
    assert.equal(EDITOR_CREDENTIAL.yamlStoresUuidOnly, true);
    assert.equal(createdCredentialSelectable(record()), true);
    assert.equal(
      createdCredentialSelectable(record({ type: "token" }), ["ssh_private_key"]),
      false,
    );
    assert.equal(createdCredentialSelectable(record({ displayName: "" })), false);
    assert.equal(createdCredentialSelectable(record({ status: "disabled" })), false);
    assert.deepEqual(
      inspectorCreatedCredentialPatch("credentialId", CREDENTIAL_ID),
      { credentialId: CREDENTIAL_ID },
    );
    assert.deepEqual(
      inspectorCreatedCredentialPatch("kubeconfig", CREDENTIAL_ID),
      {},
    );
    assert.deepEqual(
      inspectorCreatedCredentialPatch("credentialId", "-----BEGIN"),
      {},
    );
    const returnHref = inspectorEditorReturnHref({
      editorPath: EDITOR_PATH,
      workflowId: WORKFLOW_ID,
      nodeId: "ssh-run",
      field: "credentialId",
      credentialId: CREDENTIAL_ID,
    });
    assert.deepEqual(
      parseInspectorCreatedCredential(returnHref.slice(returnHref.indexOf("?"))),
      {
        credentialId: CREDENTIAL_ID,
        nodeId: "ssh-run",
        field: "credentialId",
      },
    );
    assert.equal(
      stripInspectorCredentialQuery(returnHref),
      EDITOR_PATH,
    );
  });

  it("create/rotate still submit once and clear fields; unexpected secret keys stripped", () => {
    assert.equal(EDITOR_CREDENTIAL.createRotateSubmitOnceAndClear, true);
    assert.equal(EDITOR_CREDENTIAL.unexpectedSecretKeysStripped, true);
    const draft = emptySecretDraft();
    draft.kubeconfig = "apiVersion: v1";
    draft.privateKey = "-----BEGIN";
    const cleared = clearSecretDraftAfterSubmit(draft);
    assert.equal(secretDraftIsCleared(cleared), true);
    assert.equal(secretDraftIsCleared(forgetSecretDraft(draft)), true);
    const stripped = stripSecretFields({
      id: CREDENTIAL_ID,
      displayName: "edge-ssh",
      token: "echoed-secret",
      kubeconfig: "apiVersion: v1",
    });
    assert.ok(stripped.strippedKeys.includes("token"));
    assert.ok(stripped.strippedKeys.includes("kubeconfig"));
    assert.equal(
      JSON.stringify(stripped.value).includes("echoed-secret"),
      false,
    );
  });

  it("keeps SecretField, plaintext, and rotate UI out of the inspector rail", () => {
    assert.equal(EDITOR_CREDENTIAL.noSecretFieldInRail, true);
    assert.equal(EDITOR_CREDENTIAL.noPlaintextInRail, true);
    assert.equal(EDITOR_CREDENTIAL.noRotateUiInRail, true);
    assert.equal(EDITOR_INSPECTOR.noSecretFieldInRail, true);
    assert.match(INSPECTOR_NO_SECRET_SURFACE_HELP, /SecretField/);
    const here = dirname(fileURLToPath(import.meta.url));
    for (const relative of INSPECTOR_CREDENTIAL_RAIL_SOURCES) {
      const source = readFileSync(join(here, "..", "..", relative), "utf8");
      assert.equal(inspectorRailForbidsSecretSurface(source), true, relative);
      assert.equal(source.includes("SecretField"), false, relative);
      assert.equal(source.includes('type="password"'), false, relative);
      assert.equal(source.includes("rotateCredential"), false, relative);
    }
    const inspector = readFileSync(
      join(here, "..", "components/workflows/EditorInspector.tsx"),
      "utf8",
    );
    assert.equal(inspector.includes("Add credential"), true);
    assert.equal(inspector.includes("SecretField"), false);
    const wizard = readFileSync(
      join(here, "..", "components/credentials/CredentialWizard.tsx"),
      "utf8",
    );
    assert.equal(wizard.includes("SecretField"), true);
    assert.equal(
      INSPECTOR_CREDENTIAL_WIZARD_SOURCES.includes(
        "src/components/credentials/SecretField.tsx",
      ),
      true,
    );
  });

  it("leaves /credentials as the vault home and does not add embed routes", () => {
    assert.equal(EDITOR_CREDENTIAL.vaultHomeRemainsCredentials, true);
    assert.equal(EDITOR_CREDENTIAL.noAppsApiChanges, true);
    assert.equal(credentialEmbedRoutesUnchanged(), true);
    assert.equal(EDITOR_CREDENTIAL.noSecretsInYamlSearchOrAnalytics, true);
    assert.equal(EDITOR_CREDENTIAL.displayNamePlusUuidOnly, true);
  });
});
