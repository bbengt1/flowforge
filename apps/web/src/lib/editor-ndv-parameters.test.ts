import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  EDITOR_NDV_PARAMETERS,
  NDV_PARAMETER_CONTROLS,
  NDV_PARAMETER_FAMILIES,
  NDV_PARAMETER_RAIL_SOURCES,
  R31_EPIC,
  R31_KEEP_STORY_OPEN,
  R31_STORY,
  formatNdvObjectLines,
  ndvHasTypeSpecificParameterEditors,
  ndvParameterControl,
  ndvParameterControlIsTyped,
  ndvParameterEditors,
  ndvParameterFamily,
  ndvParameterFields,
  ndvParameterPatchValue,
  ndvParameterSourceForbidsBareJsonPrimary,
  ndvParameterSourceForbidsExpressionLanguage,
  ndvParameterSourceForbidsSecretSurface,
  ndvParametersAreEdit,
  ndvParametersEmbedUnchanged,
  ndvParametersNeverGuessGraph,
  ndvParametersOwnedByCoreForm,
  ndvParametersOwnedByScriptPanel,
  ndvPrimaryEditorIsBareJson,
  ndvWizardRemainsAdd,
  parseNdvObjectLines,
  parseNdvResourceIdentity,
  parseNdvRetryPolicy,
  stringifyNdvScalar,
} from "./editor-ndv-parameters.ts";
import type { WizardConfigField } from "./workflow-action-wizard.ts";
import type { ActionLibraryEntry } from "./workflow-action-library.ts";

const here = dirname(fileURLToPath(import.meta.url));

function source(relative: string): string {
  return readFileSync(join(here, "..", relative), "utf8");
}

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

describe("R3.1 NDV type-specific parameter editors", () => {
  it("keeps #246 open and cites epic #229", () => {
    assert.equal(R31_STORY, 246);
    assert.equal(R31_EPIC, 229);
    assert.equal(R31_KEEP_STORY_OPEN, true);
    assert.equal(EDITOR_NDV_PARAMETERS.keep246Open, true);
    assert.equal(EDITOR_NDV_PARAMETERS.fieldPathMappingIsR32, true);
    assert.equal(EDITOR_NDV_PARAMETERS.validationPolicyIsR33, true);
    assert.equal(EDITOR_NDV_PARAMETERS.catalogFallbackRemovalIsR34, true);
  });

  it("keeps the wizard as guided add and the NDV as edit", () => {
    assert.equal(EDITOR_NDV_PARAMETERS.wizardIsAdd, true);
    assert.equal(EDITOR_NDV_PARAMETERS.inspectorIsEdit, true);
    assert.equal(ndvWizardRemainsAdd(), true);
    assert.equal(ndvParametersAreEdit(), true);
    assert.equal(EDITOR_NDV_PARAMETERS.displayNameCredentialsOnly, true);
    assert.equal(EDITOR_NDV_PARAMETERS.noSecretField, true);
    assert.equal(EDITOR_NDV_PARAMETERS.noExpressionLanguage, true);
    assert.equal(EDITOR_NDV_PARAMETERS.noNewCredentialTypes, true);
    assert.equal(EDITOR_NDV_PARAMETERS.noAppsApiChanges, true);
    assert.equal(ndvParametersEmbedUnchanged(), true);
  });

  it("classifies cataloged core / Kubernetes / SSH / script / HTTP families", () => {
    assert.deepEqual([...NDV_PARAMETER_FAMILIES], [
      "core",
      "kubernetes",
      "ssh",
      "script",
      "http",
    ]);
    assert.equal(ndvParameterFamily("flow.condition"), "core");
    assert.equal(ndvParameterFamily("data.set"), "core");
    assert.equal(ndvParameterFamily("kubernetes.apply"), "kubernetes");
    assert.equal(ndvParameterFamily("kubernetes.rolloutStatus"), "kubernetes");
    assert.equal(ndvParameterFamily("ssh.run"), "ssh");
    assert.equal(ndvParameterFamily("script.python"), "script");
    assert.equal(ndvParameterFamily("http.request"), "http");
    assert.equal(ndvParameterFamily("notification.email"), "http");
    assert.equal(ndvParameterFamily("workflow.call"), "unknown");
    assert.equal(ndvHasTypeSpecificParameterEditors("kubernetes.get"), true);
    assert.equal(ndvHasTypeSpecificParameterEditors("workflow.call"), false);
    assert.equal(ndvParametersOwnedByCoreForm("data.map"), true);
    assert.equal(ndvParametersOwnedByCoreForm("ssh.run"), false);
    assert.equal(ndvParametersOwnedByScriptPanel("script.python"), true);
    assert.equal(ndvParametersOwnedByScriptPanel("http.request"), false);
  });

  it("exposes type-specific with fields and drops pins, credentials, and secrets", () => {
    const kubernetes = ndvParameterFields(
      entry("kubernetes.apply"),
      "kubernetes.apply",
    );
    assert.ok(kubernetes.some((item) => item.name === "namespace"));
    assert.ok(kubernetes.some((item) => item.name === "manifests"));
    assert.ok(kubernetes.some((item) => item.name === "dryRun"));
    assert.equal(
      kubernetes.some((item) => item.name === "clusterTargetId"),
      false,
    );
    assert.equal(kubernetes.some((item) => item.name === "kubeconfig"), false);

    const ssh = ndvParameterFields(entry("ssh.run"), "ssh.run");
    assert.ok(ssh.some((item) => item.name === "timeoutSeconds"));
    assert.ok(ssh.some((item) => item.name === "parameters"));
    assert.equal(ssh.some((item) => item.name === "sshTargetId"), false);
    assert.equal(ssh.some((item) => item.name === "commandProfileId"), false);
    assert.equal(ssh.some((item) => item.name === "credentialId"), false);
    assert.equal(ssh.some((item) => item.name === "privateKey"), false);

    const http = ndvParameterFields(entry("http.request"), "http.request");
    assert.ok(http.some((item) => item.name === "method"));
    assert.ok(http.some((item) => item.name === "path"));
    assert.ok(http.some((item) => item.name === "timeoutSeconds"));
    assert.equal(http.some((item) => item.name === "connectionId"), false);
    assert.equal(http.some((item) => item.name === "responseSchemaRef"), false);

    assert.deepEqual(ndvParameterFields(entry("data.set"), "data.set"), []);
    assert.deepEqual(
      ndvParameterFields(entry("script.python"), "script.python"),
      [],
    );
    assert.deepEqual(
      ndvParameterFields(entry("workflow.call"), "workflow.call"),
      [],
    );
  });

  it("maps cataloged object fields to typed editors instead of bare JSON", () => {
    assert.ok(!NDV_PARAMETER_CONTROLS.includes("json" as never));
    assert.equal(ndvParameterControlIsTyped("json"), false);
    assert.equal(ndvParameterControlIsTyped("object-lines"), true);
    assert.equal(
      ndvParameterControl(field("parameters", { kind: "object", control: "json" }), "ssh"),
      "object-lines",
    );
    assert.equal(
      ndvParameterControl(field("retryPolicy", { kind: "object", control: "text" }), "ssh"),
      "retry-policy",
    );
    assert.equal(
      ndvParameterControl(field("resource", { kind: "object", control: "text" }), "kubernetes"),
      "resource-identity",
    );
    assert.equal(
      ndvParameterControl(field("dryRun", { control: "enum", enumValues: ["client", "server"] })),
      "enum",
    );
    assert.equal(
      ndvParameterControl(field("timeoutSeconds", { kind: "integer", control: "number" })),
      "number",
    );
    const editors = ndvParameterEditors(
      [
        field("parameters", { kind: "object", control: "json" }),
        field("retryPolicy", { kind: "object", control: "text" }),
        field("kubeconfig"),
      ],
      "ssh",
    );
    assert.deepEqual(
      editors.map((item) => [item.name, item.control]),
      [
        ["parameters", "object-lines"],
        ["retryPolicy", "retry-policy"],
      ],
    );
    assert.equal(ndvPrimaryEditorIsBareJson(editors), false);
    assert.equal(EDITOR_NDV_PARAMETERS.beyondBareJson, true);
    assert.equal(EDITOR_NDV_PARAMETERS.typeSpecificEditors, true);
  });

  it("round-trips object-lines, retry policy, and resource identity without JSON blobs", () => {
    assert.equal(
      formatNdvObjectLines({ service: "api", replicas: 2 }),
      "service=api\nreplicas=2",
    );
    assert.deepEqual(parseNdvObjectLines("service=api\npassword=hunter2\n"), {
      service: "api",
    });
    assert.deepEqual(parseNdvRetryPolicy({ maxAttempts: 2 }), { maxAttempts: 2 });
    assert.deepEqual(parseNdvRetryPolicy("nope"), { maxAttempts: 0 });
    assert.deepEqual(parseNdvResourceIdentity({ kind: "Deployment", name: "web" }), {
      kind: "Deployment",
      name: "web",
    });
    assert.equal(stringifyNdvScalar({ not: "json" }), "");
    assert.deepEqual(
      ndvParameterPatchValue({ name: "parameters", control: "object-lines" }, "env=prod"),
      { env: "prod" },
    );
    assert.deepEqual(
      ndvParameterPatchValue({ name: "retryPolicy", control: "retry-policy" }, { maxAttempts: 1 }),
      { maxAttempts: 1 },
    );
  });

  it("never projects a guessed graph from invalid YAML", () => {
    assert.equal(EDITOR_NDV_PARAMETERS.invalidYamlNeverGuessesGraph, true);
    assert.equal(
      ndvParametersNeverGuessGraph({
        errors: [
          {
            path: "spec.nodes[0].id",
            code: "invalid-id",
            message: "Node IDs must be DNS labels.",
          },
        ],
        summary: {
          apiVersion: "flowforge/v1",
          name: "broken",
          triggers: [],
          nodes: [{ id: "Bad_ID", type: "ssh.run", name: "Run" }],
          edges: [],
          outputs: [],
        },
        yaml: "kind: NotAWorkflow\n",
      }),
      true,
    );
  });

  it("wires type-specific editors into the NDV Parameters panel", () => {
    const inspector = source("components/workflows/EditorInspector.tsx");
    const nodeInspector = source("components/workflows/NodeInspector.tsx");
    const editors = source("components/workflows/NdvParameterEditors.tsx");
    assert.match(inspector, /data-ndv-panel="parameters"/);
    assert.match(inspector, /engineCatalog=\{engineCatalog\}/);
    assert.match(nodeInspector, /NdvParameterEditors/);
    assert.match(nodeInspector, /ndvParameterFamily/);
    assert.match(editors, /data-ndv-parameter-family/);
    assert.match(editors, /retry-policy|object-lines|resource-identity/);
    assert.match(inspector, /data-ndv-panel="parameters"[\s\S]*ScriptAuthoringPanel/);
    assert.doesNotMatch(
      inspector,
      /withFields\.length > 0 \? \([\s\S]*InspectorWithField/,
    );
    assert.equal(inspector.includes("SecretField"), false);
    assert.equal(editors.includes("SecretField"), false);
    assert.equal(ndvParameterSourceForbidsSecretSurface(editors), true);
    assert.equal(ndvParameterSourceForbidsExpressionLanguage(editors), true);
    assert.equal(ndvParameterSourceForbidsBareJsonPrimary(editors), true);
    assert.equal(ndvParameterSourceForbidsBareJsonPrimary(nodeInspector), true);
    for (const relative of NDV_PARAMETER_RAIL_SOURCES) {
      const text = source(relative.replace("src/", ""));
      assert.equal(ndvParameterSourceForbidsSecretSurface(text), true, relative);
      assert.equal(text.includes("SecretField"), false, relative);
    }
  });
});
