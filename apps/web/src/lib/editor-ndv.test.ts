import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  EDITOR_NDV,
  EDITOR_NDV_COLUMN_WIDTH,
  EDITOR_NDV_DEFAULT_OPEN,
  EDITOR_NDV_HEADING_ID,
  EDITOR_NDV_OPEN_STORAGE_KEY,
  EDITOR_NDV_PANELS,
  EDITOR_NDV_SATELLITE_ID,
  EDITOR_NDV_SATELLITE_LABEL,
  EDITOR_NDV_SATELLITE_WIDTH,
  EDITOR_NDV_SHELL_ID,
  R22_EPIC,
  R22_KEEP_STORY_OPEN,
  R22_STORY,
  ndvChromeMode,
  ndvConversationEyebrow,
  ndvConversationHelp,
  ndvConversationTitle,
  ndvEmbedPathUnchanged,
  ndvFocusesOnSelection,
  ndvForbidsBrandedLabel,
  ndvInspectorIsEdit,
  ndvSatelliteLabel,
  ndvWizardStaysAdd,
  ndvWorkflowTabsRemain,
  parseInspectorOpenPreference,
  readInspectorOpenPreference,
  rememberInspectorFocus,
  rememberInspectorOpen,
  rememberedInspectorOpen,
} from "./editor-ndv.ts";
import { EDITOR_INSPECTOR_OPEN_ON_FIRST_PAINT } from "./e12-accessibility-contract.ts";
import { EDITOR_CHROME } from "./editor-chrome.ts";
import { EDITOR_INSPECTOR } from "./editor-inspector.ts";
import { WORKFLOW_INSPECTOR_TABS } from "./editor-workflow-inspector.ts";

const here = dirname(fileURLToPath(import.meta.url));

function source(relative: string): string {
  return readFileSync(join(here, "..", relative), "utf8");
}

function mockSessionStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem(key: string) {
        return store.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        store.set(key, value);
      },
      removeItem(key: string) {
        store.delete(key);
      },
    },
  });
  return store;
}

describe("R2.2 NDV inspector satellite", () => {
  it("keeps #235 open and cites epic #228", () => {
    assert.equal(R22_STORY, 235);
    assert.equal(R22_EPIC, 228);
    assert.equal(R22_KEEP_STORY_OPEN, true);
  });

  it("defaults the inspector open and never hide-by-default only", () => {
    assert.equal(EDITOR_INSPECTOR_OPEN_ON_FIRST_PAINT, true);
    assert.equal(EDITOR_NDV_DEFAULT_OPEN, true);
    assert.equal(EDITOR_NDV.hiddenOnFirstPaint, false);
    assert.equal(EDITOR_NDV.rememberedOpen, true);
    assert.equal(EDITOR_NDV.persistentSatellite, true);
    assert.equal(EDITOR_NDV.defaultOpen, true);
    assert.equal(EDITOR_NDV.selectedNodeFocusesShell, true);
    assert.equal(EDITOR_NDV.columnWidth, "20rem");
    assert.equal(EDITOR_NDV_COLUMN_WIDTH, "20rem");
    assert.equal(EDITOR_NDV.satelliteWidth, "2.75rem");
    assert.equal(EDITOR_NDV_SATELLITE_WIDTH, "2.75rem");
    assert.equal(EDITOR_NDV_SATELLITE_ID, "editor-inspector-satellite");
    assert.equal(EDITOR_NDV_SHELL_ID, "editor-ndv-shell");
    assert.equal(EDITOR_NDV_HEADING_ID, "ndv-shell-heading");
    assert.equal(EDITOR_CHROME.yamlHiddenOnFirstPaint, true);
    assert.equal(ndvChromeMode(true), "drawer");
    assert.equal(ndvChromeMode(false), "satellite");
  });

  it("keeps wizard as guided add and the inspector as edit", () => {
    assert.equal(EDITOR_NDV.wizardIsAdd, true);
    assert.equal(EDITOR_NDV.inspectorIsEdit, true);
    assert.equal(ndvWizardStaysAdd(), true);
    assert.equal(ndvInspectorIsEdit(), true);
    assert.equal(EDITOR_INSPECTOR.wizardIsAdd, true);
    assert.equal(EDITOR_INSPECTOR.inspectorIsEdit, true);
  });

  it("exposes parameters, with, pins, and credential display-name — not mapping depth", () => {
    assert.deepEqual([...EDITOR_NDV_PANELS], [
      "parameters",
      "pins",
      "credentials",
      "last-run",
    ]);
    assert.equal(EDITOR_NDV.parametersWithPinsCredentialDisplayName, true);
    assert.equal(EDITOR_NDV.noSecretFieldInRail, true);
    assert.equal(EDITOR_NDV.noExpressionLanguage, true);
    assert.equal(EDITOR_NDV.noBrandedNdvInUi, true);
    assert.equal(EDITOR_NDV.deepMappingIsR3, true);
    assert.equal(EDITOR_INSPECTOR.noSecretFieldInRail, true);
    assert.equal(EDITOR_INSPECTOR.displayNamePlusUuidOnly, true);
    assert.equal(ndvFocusesOnSelection("node"), true);
    assert.equal(ndvFocusesOnSelection("edge"), true);
    assert.equal(ndvFocusesOnSelection("workflow"), false);
    assert.equal(ndvConversationEyebrow("node"), "This step");
    assert.equal(ndvConversationTitle("node", { name: "Deploy", id: "apply" }), "Deploy");
    assert.equal(ndvConversationTitle("node", { id: "apply" }), "apply");
    assert.equal(ndvConversationTitle("edge"), "Port compatibility");
    assert.equal(ndvConversationTitle("workflow"), "Workflow");
    assert.match(ndvConversationHelp("node"), /SecretField/);
    assert.match(ndvConversationHelp("node"), /expression language/);
    assert.match(ndvConversationHelp("node"), /edits this step/);
    assert.match(ndvConversationHelp("workflow"), /Triggers, versions, and pins/);
  });

  it("keeps workflow Triggers/Versions/Pins tabs and the embed path", () => {
    assert.equal(EDITOR_NDV.workflowTabsRemain, true);
    assert.equal(ndvWorkflowTabsRemain(), true);
    assert.deepEqual([...WORKFLOW_INSPECTOR_TABS], [
      "triggers",
      "versions",
      "pins",
    ]);
    assert.equal(EDITOR_NDV.embedPathUnchanged, true);
    assert.equal(ndvEmbedPathUnchanged(), true);
    assert.equal(EDITOR_NDV.noAppsApiChanges, true);
  });

  it("remembers open/closed as a non-secret 1/0 flag", () => {
    const store = mockSessionStorage();
    assert.equal(parseInspectorOpenPreference(undefined), null);
    assert.equal(parseInspectorOpenPreference("yes"), null);
    assert.equal(parseInspectorOpenPreference("1"), true);
    assert.equal(parseInspectorOpenPreference("0"), false);
    assert.equal(rememberedInspectorOpen(null), true);
    assert.equal(rememberedInspectorOpen(false), false);
    assert.equal(readInspectorOpenPreference(), true);

    rememberInspectorOpen(false);
    assert.equal(store.get(EDITOR_NDV_OPEN_STORAGE_KEY), "0");
    assert.equal(readInspectorOpenPreference(), false);

    rememberInspectorOpen(true);
    assert.equal(store.get(EDITOR_NDV_OPEN_STORAGE_KEY), "1");
    assert.equal(readInspectorOpenPreference(), true);
    assert.equal(EDITOR_NDV.preferenceStoresOpenFlagOnly, true);
    assert.equal(
      store.get(EDITOR_NDV_OPEN_STORAGE_KEY)?.includes("secret"),
      false,
    );
  });

  it("focusing a node or edge opens the remembered inspector shell", () => {
    const store = mockSessionStorage({ [EDITOR_NDV_OPEN_STORAGE_KEY]: "0" });
    assert.equal(readInspectorOpenPreference(), false);
    rememberInspectorFocus({ kind: "workflow" });
    assert.equal(store.get(EDITOR_NDV_OPEN_STORAGE_KEY), "0");
    rememberInspectorFocus({ kind: "node" });
    assert.equal(store.get(EDITOR_NDV_OPEN_STORAGE_KEY), "1");
    rememberInspectorOpen(false);
    rememberInspectorFocus({ kind: "edge" });
    assert.equal(store.get(EDITOR_NDV_OPEN_STORAGE_KEY), "1");
  });

  it("wires the same editor routes to remembered-open plus a satellite", () => {
    const chrome = source("components/workflows/EditorChrome.tsx");
    const operator = source("components/workflows/WorkflowOperator.tsx");
    const inspector = source("components/workflows/EditorInspector.tsx");
    const nodeInspector = source("components/workflows/NodeInspector.tsx");
    assert.match(chrome, /data-editor-inspector="satellite"/);
    assert.match(chrome, /EDITOR_NDV_SATELLITE_WIDTH/);
    assert.match(chrome, /EDITOR_NDV_SATELLITE_ID/);
    assert.match(chrome, /EDITOR_NDV_COLUMN_WIDTH/);
    assert.match(operator, /readInspectorOpenPreference/);
    assert.match(operator, /rememberInspectorOpen/);
    assert.match(operator, /subscribeInspectorOpenPreference/);
    assert.match(operator, /rememberInspectorFocus/);
    assert.doesNotMatch(operator, /setInspectorOpen/);
    assert.match(inspector, /data-ndv-shell="node"/);
    assert.match(inspector, /data-ndv-panel="parameters"/);
    assert.match(inspector, /data-ndv-panel="pins"/);
    assert.match(inspector, /data-ndv-panel="credentials"/);
    assert.match(inspector, /data-ndv-panel="last-run"/);
    assert.match(inspector, /EDITOR_NDV_SHELL_ID|editor-ndv-shell/);
    assert.match(nodeInspector, /Parameters/);
    assert.match(inspector, /Add action stays[\s\S]*guided wizard/);
    assert.match(nodeInspector, /No expression language/);
    assert.equal(ndvSatelliteLabel(), "Inspector");
    assert.equal(EDITOR_NDV_SATELLITE_LABEL, "Inspector");
    assert.equal(ndvForbidsBrandedLabel(chrome), true);
    assert.equal(ndvForbidsBrandedLabel(inspector), true);
    assert.equal(ndvForbidsBrandedLabel(nodeInspector), true);
    assert.equal(inspector.includes("SecretField"), false);
    assert.equal(nodeInspector.includes("SecretField"), false);
    assert.equal(inspector.includes('type="password"'), false);
  });
});
