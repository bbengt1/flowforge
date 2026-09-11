import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CSRF_HEADER } from "./session-contract.ts";
import type { CredentialRecord } from "./credential-types.ts";
import {
  EDITOR_CREDENTIAL_NEW_HREF,
  createdCredentialSelectable,
  inspectorCreatedCredentialPatch,
} from "./editor-credential.ts";
import {
  CREDENTIAL_KEK_ENV,
  CREDENTIAL_NDV_ADD,
  CREDENTIAL_NDV_ADD_ACTION_LABEL,
  CREDENTIAL_NDV_ADD_HELP,
  CREDENTIAL_NDV_ADD_HREF,
  CREDENTIAL_NDV_ADD_OPEN_LABEL,
  CREDENTIAL_NDV_ADD_SOURCES,
  CREDENTIAL_NDV_ADD_STRIP_STOP_HELP,
  CREDENTIAL_NDV_ADD_WIZARD_HELP,
  R53_EPIC,
  R53_KEEP_STORY_OPEN,
  R53_STORY,
  R5_GUARDRAILS,
  R5_LATER_STORY_NOTES,
  R5_SECURITY_LINE,
  SELECT_CREDENTIAL_NAME_PARAM,
  SELECT_CREDENTIAL_TYPE_PARAM,
  credentialNdvAddHref,
  credentialNdvAfterAdd,
  credentialNdvChromeOmitsSecretKeys,
  credentialNdvCreatedPatch,
  credentialNdvCsrfOnCreate,
  credentialNdvDoesNotMergeConfig,
  credentialNdvDoesNotReadKek,
  credentialNdvEditorReturnHref,
  credentialNdvEmbedUnchanged,
  credentialNdvHoldsSecurityLine,
  credentialNdvIsolationUseIsNotProduct,
  credentialNdvMustStopAfterStrip,
  credentialNdvPendingFromCreated,
  credentialNdvPickerSelection,
  credentialNdvQueryIsSecretFree,
  credentialNdvSecretsStayOutOfYamlSearchAnalytics,
  credentialNdvTypesUnchanged,
  credentialNdvUsesExistingCreate,
  credentialNdvWizardIsAddNdvIsEditPick,
  credentialNdvYamlRef,
  parseCredentialNdvCreated,
  stripCredentialNdvQuery,
} from "./credential-ndv-add.ts";

const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
const CREDENTIAL_ID = "33333333-3333-4333-8333-333333333333";
const EDITOR_PATH = `/workflows/${WORKFLOW_ID}`;

function sampleRecord(
  overrides: Partial<CredentialRecord> = {},
): CredentialRecord {
  return {
    id: CREDENTIAL_ID,
    displayName: "edge-ssh",
    tags: ["edge"],
    type: "ssh_private_key",
    status: "active",
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

const RETURN_TO = {
  editorPath: EDITOR_PATH,
  workflowId: WORKFLOW_ID,
  nodeId: "ssh-run",
  field: "credentialId",
} as const;

describe("R5.3 NDV add credential without leaving the graph", () => {
  it("keeps #266 open and cites epic #231", () => {
    assert.equal(R53_STORY, 266);
    assert.equal(R53_EPIC, 231);
    assert.equal(R53_KEEP_STORY_OPEN, true);
    assert.equal(CREDENTIAL_NDV_ADD.migrateInPlace, true);
    assert.equal(CREDENTIAL_NDV_ADD.inheritR5SecurityLine, true);
    assert.equal(CREDENTIAL_NDV_ADD.addFromSelectedNodeNdv, true);
    assert.equal(CREDENTIAL_NDV_ADD.returnToEditorIsDefault, true);
    assert.equal(CREDENTIAL_NDV_ADD_HREF, EDITOR_CREDENTIAL_NEW_HREF);
    assert.equal(CREDENTIAL_NDV_ADD_ACTION_LABEL, "Add credential");
    assert.match(CREDENTIAL_NDV_ADD_OPEN_LABEL, /returns here/);
    assert.match(CREDENTIAL_NDV_ADD_HELP, /without abandoning the graph/);
    assert.match(CREDENTIAL_NDV_ADD_HELP, /display name/);
    assert.match(CREDENTIAL_NDV_ADD_HELP, /UUID/);
    assert.match(CREDENTIAL_NDV_ADD_HELP, /SecretField/);
    assert.match(CREDENTIAL_NDV_ADD_HELP, /CREDENTIAL_KEK/);
    assert.match(CREDENTIAL_NDV_ADD_HELP, /strip \+ stop/);
    assert.match(CREDENTIAL_NDV_ADD_WIZARD_HELP, /Guided add/);
    assert.match(CREDENTIAL_NDV_ADD_WIZARD_HELP, /return to the editor/);
    assert.equal(R5_SECURITY_LINE.noKekInBrowser, true);
    assert.equal(R5_SECURITY_LINE.displayNamePlusUuidOnly, true);
    assert.equal(R5_SECURITY_LINE.secretsNeverInYamlSearchOrAnalytics, true);
    assert.equal(R5_SECURITY_LINE.unexpectedPlaintextIsContractBug, true);
    assert.equal(R5_SECURITY_LINE.stripAndStop, true);
    assert.equal(R5_GUARDRAILS.csrfOnMutations, true);
    assert.match(R5_LATER_STORY_NOTES.r53, /#266/);
    assert.match(R5_LATER_STORY_NOTES.r53, /R5 security line/);
    assert.ok(
      CREDENTIAL_NDV_ADD_SOURCES.includes(
        "src/components/workflows/EditorInspector.tsx",
      ),
    );
  });

  it("adds from the selected-node NDV via the masked wizard without abandoning the graph", () => {
    assert.equal(CREDENTIAL_NDV_ADD.guidedMaskedWizard, true);
    assert.equal(CREDENTIAL_NDV_ADD.withoutAbandoningTheGraph, true);
    assert.equal(CREDENTIAL_NDV_ADD.returnToEditor, true);
    assert.equal(credentialNdvUsesExistingCreate(), true);
    const href = credentialNdvAddHref(RETURN_TO);
    assert.equal(href.startsWith(`${EDITOR_CREDENTIAL_NEW_HREF}?`), true);
    assert.match(href, /returnTo=/);
    assert.match(href, /node=ssh-run/);
    assert.match(href, /field=credentialId/);
    assert.doesNotMatch(href, /kubeconfig|privateKey|BEGIN|token=/);
    assert.equal(
      credentialNdvQueryIsSecretFree(href.slice(href.indexOf("?"))),
      true,
    );
    assert.equal(
      credentialNdvAddHref(RETURN_TO, true),
      `/embed/v1${href}`,
    );
  });

  it("after add, the NDV picker selects by display name and YAML stores UUID only", () => {
    const record = sampleRecord();
    assert.equal(CREDENTIAL_NDV_ADD.afterAddSelectsDisplayName, true);
    assert.equal(CREDENTIAL_NDV_ADD.yamlStoresUuidOnly, true);
    assert.deepEqual(credentialNdvAfterAdd(record), {
      displayName: "edge-ssh",
      credentialId: CREDENTIAL_ID,
    });
    assert.deepEqual(credentialNdvPickerSelection(record), {
      displayName: "edge-ssh",
      value: CREDENTIAL_ID,
      label: "edge-ssh (ssh_private_key)",
    });
    assert.deepEqual(credentialNdvYamlRef(record), {
      credentialId: CREDENTIAL_ID,
    });
    assert.equal("displayName" in credentialNdvYamlRef(record), false);
    assert.deepEqual(
      credentialNdvCreatedPatch("credentialId", CREDENTIAL_ID),
      { credentialId: CREDENTIAL_ID },
    );
    assert.deepEqual(
      inspectorCreatedCredentialPatch("credentialId", CREDENTIAL_ID),
      { credentialId: CREDENTIAL_ID },
    );
    assert.equal(createdCredentialSelectable(record), true);

    const returnHref = credentialNdvEditorReturnHref({
      ...RETURN_TO,
      credentialId: CREDENTIAL_ID,
      displayName: record.displayName,
      type: record.type,
    });
    assert.match(returnHref, new RegExp(`${SELECT_CREDENTIAL_NAME_PARAM}=edge-ssh`));
    assert.match(returnHref, new RegExp(`${SELECT_CREDENTIAL_TYPE_PARAM}=ssh_private_key`));
    assert.doesNotMatch(returnHref, /BEGIN|kubeconfig|CREDENTIAL_KEK/);
    const parsed = parseCredentialNdvCreated(
      returnHref.slice(returnHref.indexOf("?")),
    );
    assert.deepEqual(parsed, {
      credentialId: CREDENTIAL_ID,
      nodeId: "ssh-run",
      field: "credentialId",
      displayName: "edge-ssh",
      type: "ssh_private_key",
    });
    assert.deepEqual(credentialNdvPendingFromCreated(parsed!), {
      id: CREDENTIAL_ID,
      displayName: "edge-ssh",
      type: "ssh_private_key",
    });
    assert.equal(stripCredentialNdvQuery(returnHref), EDITOR_PATH);
    assert.equal(
      credentialNdvAfterAdd(sampleRecord({ displayName: "" })),
      null,
    );
    assert.equal(
      credentialNdvPickerSelection(sampleRecord({ status: "disabled" })),
      null,
    );
    assert.equal(
      parseCredentialNdvCreated({
        selectCredential: CREDENTIAL_ID,
        node: "ssh-run",
        field: "credentialId",
        selectCredentialName: "-----BEGIN RSA PRIVATE KEY-----",
        selectCredentialType: "not-a-type",
      }),
      {
        credentialId: CREDENTIAL_ID,
        nodeId: "ssh-run",
        field: "credentialId",
      },
    );
  });

  it("keeps the wizard as guided add and the NDV as edit/pick", () => {
    assert.equal(CREDENTIAL_NDV_ADD.wizardStaysGuidedAdd, true);
    assert.equal(CREDENTIAL_NDV_ADD.ndvStaysEditPick, true);
    assert.equal(CREDENTIAL_NDV_ADD.noSecretFieldInNdv, true);
    assert.equal(CREDENTIAL_NDV_ADD.noPlaintextInNdv, true);
    assert.equal(credentialNdvWizardIsAddNdvIsEditPick(), true);
  });

  it("inherits the R5 security line: no KEK, strip + stop, no secrets in YAML/search", () => {
    const record = sampleRecord();
    assert.equal(credentialNdvDoesNotReadKek(), true);
    assert.equal(CREDENTIAL_KEK_ENV, "CREDENTIAL_KEK");
    assert.equal(credentialNdvMustStopAfterStrip([]), false);
    assert.equal(credentialNdvMustStopAfterStrip(["kubeconfig"]), true);
    assert.match(CREDENTIAL_NDV_ADD_STRIP_STOP_HELP, /Stop/);
    assert.match(CREDENTIAL_NDV_ADD_STRIP_STOP_HELP, /do not paste/);
    assert.equal(
      credentialNdvChromeOmitsSecretKeys("-----BEGIN OPENSSH PRIVATE KEY-----"),
      false,
    );
    assert.equal(credentialNdvChromeOmitsSecretKeys("edge-ssh"), true);
    assert.equal(
      credentialNdvSecretsStayOutOfYamlSearchAnalytics(record),
      true,
    );
    assert.equal(credentialNdvHoldsSecurityLine(record), true);
    assert.equal(
      credentialNdvHoldsSecurityLine(record, ["token"]),
      true,
    );
    assert.equal(credentialNdvCsrfOnCreate(), true);
    assert.equal(CSRF_HEADER, "X-CSRF-Token");
    assert.equal(credentialNdvDoesNotMergeConfig(), true);
    assert.equal(credentialNdvTypesUnchanged(), true);
    assert.equal(credentialNdvIsolationUseIsNotProduct(), true);
    assert.equal(credentialNdvEmbedUnchanged(), true);
    assert.equal(CREDENTIAL_NDV_ADD.noNewApiRoutes, true);
    assert.equal(CREDENTIAL_NDV_ADD.noNewCredentialTypes, true);
  });

  it("keeps SecretField and KEK out of the NDV add chrome", () => {
    const inspectorPath = fileURLToPath(
      new URL("../components/workflows/EditorInspector.tsx", import.meta.url),
    );
    const wizardPath = fileURLToPath(
      new URL("../components/credentials/CredentialWizard.tsx", import.meta.url),
    );
    const dialogPath = fileURLToPath(
      new URL(
        "../components/credentials/CredentialWizardDialog.tsx",
        import.meta.url,
      ),
    );
    const operatorPath = fileURLToPath(
      new URL("../components/workflows/WorkflowOperator.tsx", import.meta.url),
    );
    const inspector = readFileSync(inspectorPath, "utf8");
    const wizard = readFileSync(wizardPath, "utf8");
    const dialog = readFileSync(dialogPath, "utf8");
    const operator = readFileSync(operatorPath, "utf8");
    assert.equal(inspector.includes("Add credential"), true);
    assert.equal(inspector.includes("SecretField"), false);
    assert.equal(inspector.includes("type=\"password\""), false);
    assert.match(inspector, /CREDENTIAL_NDV_ADD_HELP|credentialNdvAddHref/);
    assert.match(inspector, /CREDENTIAL_NDV_ADD_OPEN_LABEL|returns here/);
    assert.equal(wizard.includes("SecretField"), true);
    assert.match(wizard, /credentialNdvEditorReturnHref/);
    assert.match(wizard, /CREDENTIAL_NDV_ADD_STRIP_STOP_HELP|CREDENTIAL_VAULT_STRIP_STOP_HELP/);
    assert.match(dialog, /Masked credential wizard|guided/);
    assert.match(operator, /parseCredentialNdvCreated/);
    assert.match(operator, /credentialNdvPendingFromCreated/);
    assert.doesNotMatch(inspector, /process\.env/);
    assert.doesNotMatch(operator, /CREDENTIAL_KEK/);
  });
});
