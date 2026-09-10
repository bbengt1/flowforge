import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EDITOR_INSPECTOR,
  INSPECTOR_EDIT_PERMISSION,
  INSPECTOR_HTTP_403_HELP,
  INSPECTOR_METADATA_ONLY_HELP,
  INSPECTOR_MISSING_EDIT_HELP,
  INSPECTOR_NO_SECRET_SURFACE_HELP,
  INSPECTOR_RAIL_SOURCES,
  UX4_EPIC,
  UX4_KEEP_STORY_OPEN,
  UX4_STORY,
  canEditInspector,
  failClosedCredentialOptions,
  failClosedSelectorOptions,
  inspectorCredentialFields,
  inspectorCredentialRefValue,
  inspectorCredentialTypes,
  inspectorEditConstraint,
  inspectorFocus,
  inspectorPinField,
  inspectorPinKinds,
  inspectorShowsCoreWith,
  inspectorSourceForbidsSecretSurface,
  inspectorValidationLinks,
  inspectorWithFields,
  isInspectorSecretSurfaceName,
  sanitizeInspectorWithPatch,
} from "./editor-inspector.ts";
import { ACTION_WIZARD_STEPS } from "./workflow-action-wizard.ts";
import type { WizardConfigField } from "./workflow-action-wizard.ts";
import type { ActionLibraryEntry } from "./workflow-action-library.ts";

function field(
  name: string,
  extras: Partial<WizardConfigField> = {},
): WizardConfigField {
  return {
    name,
    kind: "string",
    required: false,
    control: "text",
    description: name,
    defaultValue: "",
    inferred: false,
    ...extras,
  };
}

function entry(
  type: string,
  extras: Partial<ActionLibraryEntry> = {},
): ActionLibraryEntry {
  return {
    type,
    name: type,
    description: type,
    phase: "core",
    family: "other",
    enabled: true,
    placeable: true,
    inputs: [],
    outputs: [],
    requiredWith: [],
    allowedWith: [],
    policy: null,
    bounds: null,
    redaction: null,
    source: "catalog",
    ...extras,
  };
}

describe("UX.4 selected-node inspector", () => {
  it("keeps #199 open and cites epic #195", () => {
    assert.equal(UX4_STORY, 199);
    assert.equal(UX4_EPIC, 195);
    assert.equal(UX4_KEEP_STORY_OPEN, true);
    assert.equal(INSPECTOR_EDIT_PERMISSION, "workflow.edit");
  });

  it("keeps the wizard as guided add and the inspector as edit", () => {
    assert.equal(EDITOR_INSPECTOR.wizardIsAdd, true);
    assert.equal(EDITOR_INSPECTOR.inspectorIsEdit, true);
    assert.deepEqual(EDITOR_INSPECTOR.wizardSteps, ACTION_WIZARD_STEPS);
    assert.deepEqual(ACTION_WIZARD_STEPS, [
      "type",
      "target",
      "configure",
      "connect",
      "review",
    ]);
    assert.equal(
      EDITOR_INSPECTOR.noCredentialFromInspectorModal,
      false,
      "UX.7 opens the existing masked wizard; the rail itself stays secret-free",
    );
    assert.equal(EDITOR_INSPECTOR.displayNamePlusUuidOnly, true);
    assert.equal(EDITOR_INSPECTOR.noSecretFieldInRail, true);
    assert.equal(EDITOR_INSPECTOR.noPlaintextInRail, true);
    assert.equal(EDITOR_INSPECTOR.noRotateUiInNodeInspector, true);
    assert.match(INSPECTOR_NO_SECRET_SURFACE_HELP, /SecretField/);
  });

  it("enables pin and credential selects only with workflow.edit and a callable session", () => {
    assert.equal(EDITOR_INSPECTOR.credentialSelectEnabledWhenWorkflowEdit, true);
    assert.equal(canEditInspector(["workflow.view", "workflow.edit"], true), true);
    assert.equal(canEditInspector(["workflow.view"], true), false);
    assert.equal(canEditInspector(["workflow.edit"], false), false);
    assert.equal(canEditInspector(null, true), false);
    assert.equal(inspectorEditConstraint(["workflow.view"], true), INSPECTOR_MISSING_EDIT_HELP);
    assert.ok(inspectorEditConstraint(["workflow.edit"], false));
    assert.equal(inspectorEditConstraint(["workflow.edit"], true), null);
    assert.equal(EDITOR_INSPECTOR.missingPermissionExplainsConstraint, true);
  });

  it("stores UUIDs, shows metadata only, and empties selectors on HTTP 403", () => {
    assert.equal(EDITOR_INSPECTOR.metadataOnly, true);
    assert.equal(EDITOR_INSPECTOR.yamlStoresUuids, true);
    assert.equal(EDITOR_INSPECTOR.secretsNeverShown, true);
    assert.equal(EDITOR_INSPECTOR.http403EmptiesSelectors, true);
    assert.match(INSPECTOR_METADATA_ONLY_HELP, /UUIDs/);
    assert.match(INSPECTOR_HTTP_403_HELP, /403/);
    const pins = failClosedSelectorOptions({
      items: [
        {
          kind: "ssh_target",
          resourceId: "11111111-1111-4111-8111-111111111111",
          versionId: "22222222-2222-4222-8222-222222222222",
          versionNumber: 1,
          digest: "sha256:abc",
          name: "edge",
          slug: "edge",
        },
      ],
      statusCode: 403,
    });
    assert.deepEqual(pins.options, []);
    assert.equal(pins.closed, true);
    const credentials = failClosedCredentialOptions({
      items: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          type: "token",
          displayName: "Deploy token",
          status: "active",
        },
      ],
      statusCode: 403,
    });
    assert.deepEqual(credentials.options, []);
    assert.equal(credentials.closed, true);
  });

  it("reuses existing pin and credential contracts per action type", () => {
    assert.deepEqual(inspectorPinKinds("kubernetes.apply"), ["cluster_target"]);
    assert.deepEqual(inspectorPinKinds("ssh.run"), ["ssh_target", "command_profile"]);
    assert.deepEqual(inspectorPinKinds("script.evaluate"), ["runtime_profile"]);
    assert.deepEqual(inspectorPinKinds("http.request"), ["connection", "response_schema"]);
    assert.equal(inspectorPinField("ssh_target"), "sshTargetId");
    assert.equal(inspectorPinField("connection"), "connectionId");
    assert.deepEqual(inspectorCredentialTypes("ssh.run"), ["ssh_private_key"]);
    assert.deepEqual(inspectorCredentialTypes("kubernetes.apply"), ["kubernetes"]);
    assert.deepEqual(
      inspectorCredentialFields(
        entry("ssh.run", {
          requiredWith: ["sshTargetId"],
          allowedWith: [{ name: "credentialId", kind: "string", required: false }],
        }),
        "ssh.run",
      ),
      ["credentialId"],
    );
    assert.deepEqual(
      inspectorCredentialFields(
        entry("http.request", {
          requiredWith: ["connectionId"],
          allowedWith: [],
        }),
        "http.request",
      ),
      [],
    );
    assert.equal(inspectorShowsCoreWith("data.set"), true);
    assert.equal(inspectorShowsCoreWith("ssh.run"), false);
  });

  it("keeps type-specific with fields and drops selector/credential pins", () => {
    const fields = inspectorWithFields(
      [
        field("timeoutSeconds", { control: "number" }),
        field("sshTargetId", { selectorKind: "ssh_target" }),
        field("credentialId"),
        field("namespace"),
      ],
      "ssh.run",
    );
    assert.deepEqual(
      fields.map((item) => item.name),
      ["timeoutSeconds", "namespace"],
    );
    assert.deepEqual(
      inspectorWithFields(
        [
          field("timeoutSeconds"),
          field("kubeconfig"),
          field("privateKey"),
          field("token"),
          field("password"),
        ],
        "ssh.run",
      ).map((item) => item.name),
      ["timeoutSeconds"],
    );
  });

  it("never writes secret material — only display-name UUIDs in YAML", () => {
    assert.equal(isInspectorSecretSurfaceName("kubeconfig"), true);
    assert.equal(isInspectorSecretSurfaceName("privateKey"), true);
    assert.equal(isInspectorSecretSurfaceName("token"), true);
    assert.equal(isInspectorSecretSurfaceName("credentialId"), false);
    assert.equal(
      inspectorCredentialRefValue("33333333-3333-4333-8333-333333333333"),
      "33333333-3333-4333-8333-333333333333",
    );
    assert.equal(inspectorCredentialRefValue("-----BEGIN RSA PRIVATE KEY-----"), null);
    assert.equal(inspectorCredentialRefValue("not-a-uuid"), null);
    assert.deepEqual(
      sanitizeInspectorWithPatch({
        credentialId: "33333333-3333-4333-8333-333333333333",
        kubeconfig: "apiVersion: v1",
        token: "tok-live",
        timeoutSeconds: 30,
        parameters: { password: "hunter2", retries: 1 },
      }),
      {
        credentialId: "33333333-3333-4333-8333-333333333333",
        timeoutSeconds: 30,
        parameters: { retries: 1 },
      },
    );
  });

  it("keeps SecretField, plaintext, and rotate UI out of the inspector rail", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const relative of INSPECTOR_RAIL_SOURCES) {
      const source = readFileSync(join(here, "..", "..", relative), "utf8");
      assert.equal(
        inspectorSourceForbidsSecretSurface(source),
        true,
        relative,
      );
      assert.equal(source.includes("SecretField"), false, relative);
      assert.equal(source.includes('type="password"'), false, relative);
    }
  });

  it("focuses workflow triggers, edge ports, or the selected node", () => {
    assert.equal(inspectorFocus({ kind: "workflow" }), "workflow");
    assert.equal(inspectorFocus({ kind: "edge" }), "edge");
    assert.equal(inspectorFocus({ kind: "node" }), "node");
    assert.equal(inspectorFocus(null), "workflow");
    assert.equal(EDITOR_INSPECTOR.workflowSelectionShowsTriggers, true);
    assert.equal(EDITOR_INSPECTOR.triggersAreNotCanvasNodes, true);
    assert.equal(EDITOR_INSPECTOR.edgeSelectionExplainsPortCompatibility, true);
  });

  it("still links validation errors to a node or YAML path", () => {
    assert.equal(EDITOR_INSPECTOR.validationErrorsLinkToNodeOrYaml, true);
    const links = inspectorValidationLinks(
      [
        { path: "metadata.name", code: "invalid-id", message: "bad name" },
        { path: "spec.nodes[0].with.op", code: "unknown-field", message: "bad op" },
        { path: "spec.edges[0]", code: "incompatible-ports", message: "seed.result" },
      ],
      [{ id: "seed" }],
      [{ from: "seed.result", to: "stop.in" }],
    );
    assert.equal(links.workflow.length, 1);
    assert.equal(links.node.length, 1);
    assert.equal(links.edge.length, 1);
    assert.deepEqual(links.nodeIds, ["seed"]);
    assert.ok(links.yamlPaths.includes("spec.nodes[0].with.op"));
    assert.ok(links.yamlPaths.includes("metadata.name"));
  });
});
