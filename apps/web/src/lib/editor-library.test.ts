import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ACTIONS_CATALOG_HREF,
  EDITOR_LIBRARY,
  EDITOR_LIBRARY_COLUMN_WIDTH,
  EDITOR_LIBRARY_DEFAULT_OPEN,
  EDITOR_LIBRARY_OPEN_ON_FIRST_PAINT,
  EDITOR_LIBRARY_OPEN_STORAGE_KEY,
  EDITOR_LIBRARY_SATELLITE_ID,
  EDITOR_LIBRARY_SATELLITE_WIDTH,
  R21_EPIC,
  R21_KEEP_STORY_OPEN,
  R21_STORY,
  UX3_EPIC,
  UX3_KEEP_STORY_OPEN,
  UX3_STORY,
  actionsCommandIsCatalogReference,
  actionsEmbedRouteUnchanged,
  actionsNavIsCatalogReference,
  canvasAddAffordance,
  catalogLibraryFailsClosed,
  libraryChromeMode,
  parseLibraryOpenPreference,
  readLibraryOpenPreference,
  rememberLibraryOpen,
  rememberedLibraryOpen,
} from "./editor-library.ts";
import { EDITOR_CHROME } from "./editor-chrome.ts";
import { sanitizeSearchSource } from "./workspace-search.ts";
import { adaptActionLibrary, rejectDisabledActionType } from "./workflow-action-library.ts";
import { WORKSPACE_NAV_ITEMS } from "./workspace-nav.ts";
import type { WorkflowCatalog } from "./workflow-types.ts";

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

const enabledCatalog: WorkflowCatalog = {
  apiVersion: "flowforge/v1",
  rules: { triggersAreWorkflowLevel: true },
  triggers: [{ type: "manual", phase: "core" }],
  nodes: [
    { type: "data.set", phase: "core", title: "Set data", enabled: true },
    { type: "workflow.call", phase: "next", title: "Call", enabled: false },
    { type: "manual", phase: "core", title: "Manual" },
  ],
};

describe("UX.3 editor library drawer", () => {
  it("keeps #198 open and cites epic #195", () => {
    assert.equal(UX3_STORY, 198);
    assert.equal(UX3_EPIC, 195);
    assert.equal(UX3_KEEP_STORY_OPEN, true);
  });

  it("opens the existing library from + and the wizard from Add action", () => {
    assert.equal(EDITOR_LIBRARY.plusOpensLibrary, true);
    assert.equal(EDITOR_LIBRARY.addActionOpensWizard, true);
    assert.equal(EDITOR_LIBRARY.dragInsertDefaultsAllowed, true);
    assert.deepEqual(
      canvasAddAffordance({
        invalid: false,
        nodeCount: 0,
        selectedKind: "workflow",
      }),
      { emptyPlus: true, selectedPlus: false, addAction: true },
    );
    assert.deepEqual(
      canvasAddAffordance({
        invalid: false,
        nodeCount: 2,
        selectedKind: "node",
      }),
      { emptyPlus: false, selectedPlus: true, addAction: true },
    );
    assert.deepEqual(
      canvasAddAffordance({
        invalid: true,
        nodeCount: 0,
        selectedKind: "workflow",
      }),
      { emptyPlus: false, selectedPlus: false, addAction: false },
    );
    assert.deepEqual(
      canvasAddAffordance({
        invalid: false,
        readOnly: true,
        nodeCount: 0,
        selectedKind: "node",
      }),
      { emptyPlus: false, selectedPlus: false, addAction: false },
    );
  });

  it("keeps /actions as the catalog reference and does not add a third app", () => {
    assert.equal(EDITOR_LIBRARY.actionsRouteIsCatalogReference, true);
    assert.equal(EDITOR_LIBRARY.noThirdCatalogApp, true);
    assert.equal(actionsNavIsCatalogReference(), true);
    assert.equal(actionsCommandIsCatalogReference(), true);
    assert.equal(actionsEmbedRouteUnchanged(), true);
    assert.equal(ACTIONS_CATALOG_HREF, "/actions");
    const actions = WORKSPACE_NAV_ITEMS.filter((item) => item.id === "actions");
    assert.equal(actions.length, 1);
    assert.equal(actions[0]?.placeholder, undefined);
  });

  it("still lists enabled catalog actions only and excludes triggers", () => {
    assert.equal(EDITOR_LIBRARY.enabledCatalogOnly, true);
    assert.equal(EDITOR_LIBRARY.triggersExcluded, true);
    assert.equal(catalogLibraryFailsClosed(enabledCatalog), true);
    const library = adaptActionLibrary(enabledCatalog);
    assert.equal(library.some((item) => item.type === "data.set"), true);
    assert.equal(library.some((item) => item.type === "manual"), false);
    assert.equal(library.some((item) => item.type === "workflow.call"), false);
    assert.equal(rejectDisabledActionType("manual", enabledCatalog).ok, false);
  });

  it("palette search still strips unexpected secret fields", () => {
    assert.equal(EDITOR_LIBRARY.paletteSearchStripsSecrets, true);
    const stripped: string[] = [];
    const cleaned = sanitizeSearchSource(
      {
        type: "ssh.run",
        title: "Run SSH",
        secret: "super-secret-value",
        token: "tok-live",
        kubeconfig: "apiVersion: v1",
      },
      stripped,
    );
    const json = JSON.stringify(cleaned);
    assert.equal(json.includes("super-secret-value"), false);
    assert.equal(json.includes("tok-live"), false);
    assert.equal(json.includes("apiVersion: v1"), false);
    assert.ok(stripped.length > 0);
  });

  it("403 / empty catalog fail closed without an invented integration toggle", () => {
    assert.equal(EDITOR_LIBRARY.catalog403FailsClosed, true);
    assert.equal(EDITOR_LIBRARY.emptyCatalogFailsClosed, true);
    assert.equal(EDITOR_LIBRARY.noIntegrationActionsEnabledToggle, true);
    assert.equal(
      "INTEGRATION_ACTIONS_ENABLED" in EDITOR_LIBRARY,
      false,
    );
    assert.equal(
      rejectDisabledActionType("http.request", {
        apiVersion: "flowforge/v1",
        rules: { integrationActionsEnabled: false },
        integrationGate: { enabled: false },
        triggers: [],
        nodes: [{ type: "http.request", phase: "core" }],
      }).ok,
      false,
    );
    const empty = adaptActionLibrary({
      apiVersion: "flowforge/v1",
      triggers: [],
      nodes: [],
    });
    assert.equal(empty.some((item) => item.type === "manual"), false);
    assert.equal(rejectDisabledActionType("workflow.call", { nodes: [] }).ok, false);
  });
});

describe("R2.1 remembered-open library satellite", () => {
  it("keeps #234 open and cites epic #228", () => {
    assert.equal(R21_STORY, 234);
    assert.equal(R21_EPIC, 228);
    assert.equal(R21_KEEP_STORY_OPEN, true);
  });

  it("defaults the palette open and never hide-by-default only", () => {
    assert.equal(EDITOR_LIBRARY_OPEN_ON_FIRST_PAINT, true);
    assert.equal(EDITOR_LIBRARY_DEFAULT_OPEN, true);
    assert.equal(EDITOR_LIBRARY.hiddenOnFirstPaint, false);
    assert.equal(EDITOR_LIBRARY.rememberedOpen, true);
    assert.equal(EDITOR_LIBRARY.persistentSatellite, true);
    assert.equal(EDITOR_LIBRARY.defaultOpen, true);
    assert.equal(EDITOR_LIBRARY.staysOpenAcrossInserts, true);
    assert.equal(EDITOR_LIBRARY.columnWidth, "18rem");
    assert.equal(EDITOR_LIBRARY_COLUMN_WIDTH, "18rem");
    assert.equal(EDITOR_LIBRARY.satelliteWidth, "2.75rem");
    assert.equal(EDITOR_LIBRARY_SATELLITE_WIDTH, "2.75rem");
    assert.equal(EDITOR_LIBRARY_SATELLITE_ID, "editor-library-satellite");
    assert.equal(EDITOR_CHROME.yamlHiddenOnFirstPaint, true);
    assert.equal(EDITOR_CHROME.libraryHiddenOnFirstPaint, false);
    assert.equal(libraryChromeMode(true), "drawer");
    assert.equal(libraryChromeMode(false), "satellite");
  });

  it("remembers open/closed as a non-secret 1/0 flag", () => {
    const store = mockSessionStorage();
    assert.equal(parseLibraryOpenPreference(undefined), null);
    assert.equal(parseLibraryOpenPreference("yes"), null);
    assert.equal(parseLibraryOpenPreference("1"), true);
    assert.equal(parseLibraryOpenPreference("0"), false);
    assert.equal(rememberedLibraryOpen(null), true);
    assert.equal(rememberedLibraryOpen(false), false);
    assert.equal(readLibraryOpenPreference(), true);

    rememberLibraryOpen(false);
    assert.equal(store.get(EDITOR_LIBRARY_OPEN_STORAGE_KEY), "0");
    assert.equal(readLibraryOpenPreference(), false);

    rememberLibraryOpen(true);
    assert.equal(store.get(EDITOR_LIBRARY_OPEN_STORAGE_KEY), "1");
    assert.equal(readLibraryOpenPreference(), true);
    assert.equal(EDITOR_LIBRARY.preferenceStoresOpenFlagOnly, true);
    assert.equal(store.get(EDITOR_LIBRARY_OPEN_STORAGE_KEY)?.includes("secret"), false);
  });

  it("wires the same editor routes to remembered-open plus a satellite", () => {
    const chrome = source("components/workflows/EditorChrome.tsx");
    const operator = source("components/workflows/WorkflowOperator.tsx");
    assert.match(chrome, /data-editor-library="satellite"/);
    assert.match(chrome, /EDITOR_LIBRARY_SATELLITE_WIDTH/);
    assert.match(chrome, /EDITOR_LIBRARY_SATELLITE_ID/);
    assert.match(operator, /readLibraryOpenPreference/);
    assert.match(operator, /rememberLibraryOpen/);
    assert.match(operator, /subscribeLibraryOpenPreference/);
    assert.doesNotMatch(operator, /setLibraryOpen/);
    assert.match(operator, /insertLibraryNode/);
    assert.doesNotMatch(
      operator,
      /function insertLibraryNode[\s\S]*rememberLibraryOpen\(false\)/,
    );
    assert.equal(actionsEmbedRouteUnchanged(), true);
  });
});
