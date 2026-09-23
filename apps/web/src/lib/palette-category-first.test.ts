import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ACTIONS_CATALOG_HREF,
  EDITOR_LIBRARY,
  EDITOR_LIBRARY_DEFAULT_OPEN,
  EDITOR_LIBRARY_OPEN_ON_FIRST_PAINT,
  EDITOR_LIBRARY_OPEN_STORAGE_KEY,
  R21_KEEP_STORY_OPEN,
  R21_STORY,
  actionsCommandIsCatalogReference,
  actionsEmbedRouteUnchanged,
  actionsNavIsCatalogReference,
} from "./editor-library.ts";
import { adaptActionLibrary } from "./workflow-action-library.ts";
import { recommendActions } from "./workflow-action-wizard.ts";
import type { ActionLibraryEntry } from "./workflow-action-library.ts";
import type { WorkflowCatalog } from "./workflow-types.ts";
import {
  PALETTE_CATEGORY_FIRST,
  PALETTE_CATEGORY_FIRST_HELP,
  PALETTE_CATEGORY_IDS,
  PALETTE_CATEGORY_LABELS,
  PALETTE_CATALOG_UNAVAILABLE_HELP,
  UXL7_BRIEF,
  UXL7_EPIC,
  UXL7_ID,
  UXL7_KEEP_STORY_OPEN,
  UXL7_STORY,
  actionsRemainsCatalogReference,
  catalogEntryAcceptsUpstreamPort,
  enabledCatalogPaletteEntries,
  paletteCategoryFirstHoldsHardLines,
  paletteExcludesHardLineTypes,
  paletteFirstPaint,
  paletteFirstPaintIsCategories,
  paletteMissingCatalogFailsClosed,
  paletteSurfacesUseCategoryFirst,
  recommendFromUpstreamPort,
  rememberedOpenLibraryUnchanged,
} from "./palette-category-first.ts";

const here = dirname(fileURLToPath(import.meta.url));

function source(relative: string): string {
  return readFileSync(join(here, "..", "..", relative), "utf8");
}

const liveCatalog: WorkflowCatalog = {
  apiVersion: "flowforge/v1",
  rules: { triggersAreWorkflowLevel: true },
  triggers: [
    { type: "manual", phase: "core", title: "Manual" },
    { type: "webhook", phase: "core", title: "Webhook" },
  ],
  nodes: [
    {
      type: "flow.condition",
      phase: "core",
      title: "Condition",
      inputs: [{ name: "value", kind: "any" }],
      allowedWith: [{ name: "op", kind: "enum", required: true }],
    },
    {
      type: "flow.delay",
      phase: "core",
      title: "Delay",
      inputs: [{ name: "input", kind: "any" }],
    },
    {
      type: "data.set",
      phase: "core",
      title: "Set data",
      outputs: [{ name: "result", kind: "object" }],
      allowedWith: [{ name: "value", kind: "object", required: true }],
    },
    {
      type: "kubernetes.apply",
      phase: "core",
      title: "Apply",
      inputs: [{ name: "parameters", kind: "object" }],
    },
    {
      type: "ssh.run",
      phase: "core",
      title: "Run SSH",
      inputs: [{ name: "parameters", kind: "object" }],
    },
    {
      type: "script.python",
      phase: "core",
      title: "Python",
      inputs: [{ name: "input", kind: "object" }],
    },
    {
      type: "http.request",
      phase: "core",
      title: "HTTP request",
      inputs: [{ name: "body", kind: "object" }],
    },
    {
      type: "notification.email",
      phase: "core",
      title: "Email",
      inputs: [{ name: "body", kind: "object" }],
    },
    { type: "manual", phase: "core", title: "Manual" },
    { type: "workflow.call", phase: "next", title: "Call" },
    { type: "provider.slack", phase: "provider", title: "Slack" },
    {
      type: "flow.hidden",
      phase: "core",
      title: "Hidden",
      enabled: false,
    },
  ],
};

const library = adaptActionLibrary(liveCatalog);

function entry(type: string): ActionLibraryEntry {
  const found = library.find((item) => item.type === type);
  assert.ok(found, `missing ${type}`);
  return found;
}

describe("UXL.7 palette category-first", () => {
  it("keeps #294 open and cites epic #287", () => {
    assert.equal(UXL7_STORY, 294);
    assert.equal(UXL7_EPIC, 287);
    assert.equal(UXL7_KEEP_STORY_OPEN, true);
    assert.equal(UXL7_ID, "UXL.7-palette-category-first");
    assert.equal(UXL7_BRIEF, "docs/internal/flowforge-ux-laws.md");
    assert.equal(PALETTE_CATEGORY_FIRST.firstPaintIsCategories, true);
    assert.equal(PALETTE_CATEGORY_FIRST.jonnyNoneExpected, true);
    assert.equal(PALETTE_CATEGORY_FIRST.d6MigrateInPlace, true);
    assert.equal(PALETTE_CATEGORY_FIRST.uxl8OutOfScope, true);
    assert.match(PALETTE_CATEGORY_FIRST_HELP, /first paint is categories/i);
    const frontend = readFileSync(
      join(here, "..", "..", "..", "..", "docs/reference/frontend-ui.md"),
      "utf8",
    );
    assert.match(frontend, /category-first/i);
  });

  it("first paint is categories from the enabled live catalog only", () => {
    const paint = paletteFirstPaint({
      entries: library,
      catalog: liveCatalog,
    });
    assert.equal(paletteFirstPaintIsCategories(paint), true);
    assert.deepEqual(
      paint.categories.map((group) => group.id),
      [
        "control",
        "data",
        "kubernetes",
        "ssh",
        "script",
        "http-notifications",
      ],
    );
    assert.deepEqual(
      paint.categories.map((group) => group.label),
      PALETTE_CATEGORY_IDS.map((id) => PALETTE_CATEGORY_LABELS[id]),
    );
    assert.equal(
      paint.categories.find((group) => group.id === "control")?.items.some(
        (item) => item.type === "flow.condition",
      ),
      true,
    );
    assert.equal(
      paint.categories
        .find((group) => group.id === "http-notifications")
        ?.items.some((item) => item.type === "http.request"),
      true,
    );
    assert.equal(
      paint.categories
        .find((group) => group.id === "http-notifications")
        ?.items.some((item) => item.type === "notification.email"),
      true,
    );
    assert.equal(paint.items.length, 0);
    assert.equal(
      enabledCatalogPaletteEntries(library, liveCatalog).some(
        (item) => item.type === "flow.hidden",
      ),
      false,
    );
  });

  it("search still reaches any enabled type and category drill shows that group", () => {
    const search = paletteFirstPaint({
      entries: library,
      catalog: liveCatalog,
      query: "python",
    });
    assert.equal(search.kind, "search");
    assert.equal(search.items.some((item) => item.type === "script.python"), true);
    assert.equal(search.items.some((item) => item.type === "kubernetes.apply"), false);

    const drilled = paletteFirstPaint({
      entries: library,
      catalog: liveCatalog,
      selectedCategory: "kubernetes",
    });
    assert.equal(drilled.kind, "category");
    assert.deepEqual(
      drilled.items.map((item) => item.type),
      ["kubernetes.apply"],
    );
  });

  it("hides triggers, disabled, next, and provider types", () => {
    assert.equal(PALETTE_CATEGORY_FIRST.triggersExcluded, true);
    assert.equal(PALETTE_CATEGORY_FIRST.disabledNextProviderHidden, true);
    assert.equal(paletteExcludesHardLineTypes(library, liveCatalog), true);
    const enabled = enabledCatalogPaletteEntries(library, liveCatalog);
    assert.equal(enabled.some((item) => item.type === "manual"), false);
    assert.equal(enabled.some((item) => item.type === "webhook"), false);
    assert.equal(enabled.some((item) => item.type === "workflow.call"), false);
    assert.equal(enabled.some((item) => item.type === "provider.slack"), false);
    assert.equal(enabled.some((item) => item.type === "flow.hidden"), false);
    const paint = paletteFirstPaint({
      entries: library,
      catalog: liveCatalog,
      query: "manual webhook slack call hidden",
    });
    assert.equal(paint.items.length, 0);
  });

  it("recommended-from-upstream-port uses catalog ports / allowedWith only", () => {
    const upstream = { type: "data.set", port: { name: "result", kind: "object" } };
    const recommended = recommendFromUpstreamPort({
      entries: library,
      catalog: liveCatalog,
      upstream,
    });
    assert.equal(recommended.some((item) => item.type === "kubernetes.apply"), true);
    assert.equal(recommended.some((item) => item.type === "data.set"), true);
    assert.ok(
      recommended.every((item) =>
        catalogEntryAcceptsUpstreamPort(liveCatalog, item.type, upstream.port),
      ),
    );
    assert.ok(
      recommended.every((item) =>
        item.reasons.some((reason) => /upstream/i.test(reason)),
      ),
    );

    const { recommended: ranked, visible } = recommendActions({
      entries: library,
      catalog: liveCatalog,
      upstream,
      permissions: ["workflow.execute", "kubernetes.apply"],
      enabledTargetKinds: ["cluster_target"],
    });
    assert.equal(visible.some((item) => item.type === "workflow.call"), false);
    const apply = ranked.find((item) => item.type === "kubernetes.apply");
    assert.ok(apply);
    assert.ok(apply.score >= 5);

    assert.deepEqual(
      recommendFromUpstreamPort({
        entries: library,
        catalog: liveCatalog,
      }),
      [],
    );
    assert.equal(
      catalogEntryAcceptsUpstreamPort(liveCatalog, "invented.action", upstream.port),
      false,
    );
  });

  it("missing, empty, and 403 catalogs fail closed without invented types", () => {
    assert.equal(paletteMissingCatalogFailsClosed(null), true);
    assert.equal(paletteMissingCatalogFailsClosed(undefined), true);
    assert.equal(
      paletteMissingCatalogFailsClosed(
        { apiVersion: "flowforge/v1", triggers: [], nodes: [] },
        403,
      ),
      true,
    );
    const empty = paletteFirstPaint({
      entries: adaptActionLibrary({
        apiVersion: "flowforge/v1",
        triggers: [],
        nodes: [],
      }),
      catalog: { apiVersion: "flowforge/v1", triggers: [], nodes: [] },
    });
    assert.equal(empty.kind, "unavailable");
    assert.equal(empty.categories.length, 0);
    assert.equal(empty.items.length, 0);
    assert.equal(empty.unavailableReason, PALETTE_CATALOG_UNAVAILABLE_HELP);
    assert.deepEqual(
      recommendFromUpstreamPort({
        entries: adaptActionLibrary(null),
        catalog: null,
        upstream: { type: "data.set", port: { name: "result", kind: "object" } },
      }),
      [],
    );
    const fallback = adaptActionLibrary(null);
    assert.equal(enabledCatalogPaletteEntries(fallback, null).length, 0);
    assert.equal(
      recommendActions({
        entries: fallback,
        catalog: null,
        upstream: { type: "data.set", port: { name: "result", kind: "object" } },
      }).recommended.length,
      0,
    );
    const pending = paletteFirstPaint({
      entries: fallback,
      catalog: null,
      pending: true,
    });
    assert.equal(pending.kind, "pending");
    assert.equal(pending.categories.length, 0);
    assert.ok(entry("flow.condition"));
  });

  it("keeps /actions as the catalog reference and remembered-open satellite", () => {
    assert.equal(
      actionsRemainsCatalogReference({
        href: ACTIONS_CATALOG_HREF,
        navIsReference: actionsNavIsCatalogReference(),
        commandIsReference: actionsCommandIsCatalogReference(),
        embedUnchanged: actionsEmbedRouteUnchanged(),
        noThirdApp: EDITOR_LIBRARY.noThirdCatalogApp,
      }),
      true,
    );
    assert.equal(
      rememberedOpenLibraryUnchanged({
        rememberedOpen: EDITOR_LIBRARY.rememberedOpen,
        persistentSatellite: EDITOR_LIBRARY.persistentSatellite,
        hiddenOnFirstPaint: EDITOR_LIBRARY.hiddenOnFirstPaint,
        openOnFirstPaint: EDITOR_LIBRARY_OPEN_ON_FIRST_PAINT,
        defaultOpen: EDITOR_LIBRARY_DEFAULT_OPEN,
        storageKey: EDITOR_LIBRARY_OPEN_STORAGE_KEY,
        r21Story: R21_STORY,
        r21KeepOpen: R21_KEEP_STORY_OPEN,
      }),
      true,
    );
    assert.equal(PALETTE_CATEGORY_FIRST.noThirdCatalogApp, true);
    assert.equal(PALETTE_CATEGORY_FIRST.noNewApiEndpoints, true);
    const actions = source("src/components/workflows/ActionCatalogPage.tsx");
    assert.match(actions, /Catalog reference/);
    assert.match(actions, /ActionLibrary/);
    assert.doesNotMatch(actions, /marketplace/i);
  });

  it("library and wizard step 1 use the same category-first first paint", () => {
    const librarySource = source("src/components/workflows/ActionLibrary.tsx");
    const wizard = source("src/components/workflows/ActionWizard.tsx");
    assert.equal(paletteSurfacesUseCategoryFirst(librarySource), true);
    assert.equal(paletteSurfacesUseCategoryFirst(wizard), true);
    assert.match(librarySource, /data-uxl7-paint/);
    assert.match(wizard, /data-uxl7-paint/);
    assert.doesNotMatch(
      librarySource,
      /ACTION_FAMILY_ORDER\.map\(\(family\) => \{\s*const items = visible\.filter/,
    );
  });

  it("holds hard lines and does not reopen R2.1 / D3 / fail-closed catalogs", () => {
    assert.equal(paletteCategoryFirstHoldsHardLines(), true);
    assert.equal(PALETTE_CATEGORY_FIRST.failClosedCatalogs, true);
    assert.equal(PALETTE_CATEGORY_FIRST.d3TriggersAreWorkflowLevel, true);
    assert.equal(PALETTE_CATEGORY_FIRST.noKekInBrowser, true);
    assert.equal(PALETTE_CATEGORY_FIRST.notAnN8nClone, true);
    assert.equal(PALETTE_CATEGORY_FIRST.inheritR21RememberedOpen, true);
  });
});
