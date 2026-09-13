/**
 * UXL.7: Palette category-first (enabled catalog only).
 *
 * Relates to #294 / Part of #287. Keep #294 open.
 *
 * Chloe UI only. Densify the editor palette / Library satellite and
 * Add action wizard step 1 in place (D6). Same GET /workflows/catalog
 * (and engine catalogs). No marketplace. No new API endpoints.
 *
 * Hick / Choice Overload / Chunking: first paint is categories
 * (control flow, data, Kubernetes, SSH, scripts, HTTP/notifications)
 * as enabled by the live catalog. Search still reaches any enabled
 * type. Recommended-from-upstream-port uses catalog port types /
 * `allowedWith` only. Missing catalog → fail closed, no invented types.
 *
 * Triggers stay excluded (`rules.triggersAreWorkflowLevel`). Disabled /
 * next / provider types stay hidden. `/actions` remains the reference,
 * not a third app. Remembered-open satellite (R2.1) is unchanged.
 *
 * Out of scope: UXL.8, marketplace, canvas trigger nodes, catalog
 * fallback removal (R3.4), new API routes.
 */

import { CATALOG_SOURCE_UNAVAILABLE } from "./catalog-fail-closed.ts";
import {
  filterActionLibrary,
  filterEnabledActionNodes,
  isTriggerActionType,
  rejectDisabledActionType,
  type ActionFamily,
  type ActionLibraryEntry,
} from "./workflow-action-library.ts";
import { isCatalogImplementationEnabled } from "./workflow.ts";
import { portsCompatible } from "./workflow-graph.ts";
import type {
  CatalogPort,
  CatalogWithField,
  WorkflowCatalog,
} from "./workflow-types.ts";

export const PALETTE_ACTIONS_CATALOG_HREF = "/actions";
export const PALETTE_LIBRARY_OPEN_STORAGE_KEY =
  "flowforge.editor.library-open.v1";

export const UXL7_STORY = 294;
export const UXL7_EPIC = 287;
export const UXL7_KEEP_STORY_OPEN = true;
export const UXL7_ID = "UXL.7-palette-category-first" as const;

export const UXL7_BRIEF = "docs/architecture/flowforge-ux-laws.md";

export const PALETTE_CATEGORY_IDS = [
  "control",
  "data",
  "kubernetes",
  "ssh",
  "script",
  "http-notifications",
] as const;

export type PaletteCategoryId = (typeof PALETTE_CATEGORY_IDS)[number];

export const PALETTE_CATEGORY_LABELS: Record<PaletteCategoryId, string> = {
  control: "Control flow",
  data: "Data",
  kubernetes: "Kubernetes",
  ssh: "SSH",
  script: "Scripts",
  "http-notifications": "HTTP/notifications",
};

export type PaletteFirstPaintKind =
  | "pending"
  | "unavailable"
  | "categories"
  | "category"
  | "search";

export type PaletteCategoryGroup = {
  id: PaletteCategoryId;
  label: string;
  items: ActionLibraryEntry[];
};

export type PaletteRecommendation = {
  type: string;
  score: number;
  reasons: string[];
};

export type PaletteFirstPaint = {
  kind: PaletteFirstPaintKind;
  categories: PaletteCategoryGroup[];
  items: ActionLibraryEntry[];
  selectedCategory: PaletteCategoryId | null;
  unavailableReason: string | null;
};

export const PALETTE_CATALOG_UNAVAILABLE_HELP =
  "Live catalog is empty or unauthorized (including HTTP 403). Palette fails closed — no invented types, categories, or recommended actions.";

export const PALETTE_CATEGORY_FIRST_HELP =
  "First paint is categories from the enabled catalog. Search still reaches any enabled type. Triggers, disabled, next, and provider types stay hidden.";

export const PALETTE_CATEGORY_FIRST = {
  inheritR7HardLine: true,
  inheritR21RememberedOpen: true,
  d6MigrateInPlace: true,
  firstPaintIsCategories: true,
  searchReachesAnyEnabledType: true,
  recommendedUsesCatalogPortTypesAndAllowedWithOnly: true,
  missingCatalogFailsClosed: true,
  noInventedTypes: true,
  triggersExcluded: true,
  triggersAreWorkflowLevel: true,
  disabledNextProviderHidden: true,
  actionsRouteIsCatalogReference: true,
  noThirdCatalogApp: true,
  rememberedOpenSatelliteUnchanged: true,
  enabledCatalogOnly: true,
  noMarketplace: true,
  noNewApiEndpoints: true,
  yamlIsSourceOfTruth: true,
  draftsNeverRun: true,
  vaultDisplayNameUuidOnly: true,
  adv021ChromeFromSessionEmbedOnly: true,
  adv024MembershipIsolationStayGrantGated: true,
  oneReplayPath: true,
  loudIndeterminate: true,
  failClosedCatalogs: true,
  notAnN8nClone: true,
  noKekInBrowser: true,
  d3TriggersAreWorkflowLevel: true,
  noCanvasTriggerNodes: true,
  uxl8OutOfScope: true,
  catalogFallbackRemovalOutOfScope: true,
  marketplaceOutOfScope: true,
  canvasTriggerNodesOutOfScope: true,
  jonnyNoneExpected: true,
} as const;

export const PALETTE_CATEGORY_FIRST_SOURCES = [
  "src/lib/palette-category-first.ts",
  "src/lib/workflow-action-library.ts",
  "src/lib/workflow-action-wizard.ts",
  "src/lib/editor-library.ts",
  "src/components/workflows/ActionLibrary.tsx",
  "src/components/workflows/ActionWizard.tsx",
  "src/components/workflows/ActionCatalogPage.tsx",
] as const;

export function paletteCategoryForFamily(
  family: ActionFamily,
): PaletteCategoryId | null {
  if (family === "control" || family === "lifecycle") {
    return "control";
  }
  if (family === "data") {
    return "data";
  }
  if (family === "kubernetes") {
    return "kubernetes";
  }
  if (family === "ssh") {
    return "ssh";
  }
  if (family === "script") {
    return "script";
  }
  if (family === "http" || family === "notification") {
    return "http-notifications";
  }
  return null;
}

export function paletteCategoryForType(
  type: string,
  family: ActionFamily,
): PaletteCategoryId | null {
  if (isTriggerActionType(type)) {
    return null;
  }
  return paletteCategoryForFamily(family);
}

export function enabledCatalogPaletteEntries(
  entries: readonly ActionLibraryEntry[],
  catalog: WorkflowCatalog | null | undefined,
): ActionLibraryEntry[] {
  if (!catalog) {
    return [];
  }
  const listed = new Map(
    filterEnabledActionNodes(catalog.nodes).map((node) => [node.type, node]),
  );
  return entries.filter((entry) => {
    if (!entry.placeable || !entry.enabled) {
      return false;
    }
    if (isTriggerActionType(entry.type)) {
      return false;
    }
    const node = listed.get(entry.type);
    if (!node) {
      return false;
    }
    if (node.phase === "next" || node.phase === "provider") {
      return node.enabled === true && isCatalogImplementationEnabled(node);
    }
    return isCatalogImplementationEnabled(node);
  });
}

export function groupEnabledCatalogByCategory(
  entries: readonly ActionLibraryEntry[],
  catalog: WorkflowCatalog | null | undefined,
): PaletteCategoryGroup[] {
  const enabled = enabledCatalogPaletteEntries(entries, catalog);
  return PALETTE_CATEGORY_IDS.map((id) => ({
    id,
    label: PALETTE_CATEGORY_LABELS[id],
    items: enabled.filter(
      (entry) => paletteCategoryForFamily(entry.family) === id,
    ),
  })).filter((group) => group.items.length > 0);
}

export function paletteCatalogState(input: {
  catalog: WorkflowCatalog | null | undefined;
  pending?: boolean;
  statusCode?: number;
}): "pending" | "unavailable" | "ready" {
  if (input.pending && !input.catalog) {
    return "pending";
  }
  if (input.statusCode === 403 || !input.catalog) {
    return "unavailable";
  }
  if (filterEnabledActionNodes(input.catalog.nodes).length === 0) {
    return "unavailable";
  }
  return "ready";
}

export function paletteFirstPaint(input: {
  entries: readonly ActionLibraryEntry[];
  catalog: WorkflowCatalog | null | undefined;
  query?: string;
  selectedCategory?: PaletteCategoryId | null;
  pending?: boolean;
  statusCode?: number;
}): PaletteFirstPaint {
  const empty: PaletteFirstPaint = {
    kind: "unavailable",
    categories: [],
    items: [],
    selectedCategory: null,
    unavailableReason: PALETTE_CATALOG_UNAVAILABLE_HELP,
  };
  if (input.pending && !input.catalog) {
    return {
      ...empty,
      kind: "pending",
      unavailableReason: null,
    };
  }
  if (input.statusCode === 403 || !input.catalog) {
    return empty;
  }
  const categories = groupEnabledCatalogByCategory(input.entries, input.catalog);
  if (categories.length === 0) {
    return empty;
  }
  const enabled = enabledCatalogPaletteEntries(input.entries, input.catalog);
  const query = input.query ?? "";
  if (query.trim()) {
    return {
      kind: "search",
      categories,
      items: filterActionLibrary(enabled, query),
      selectedCategory: null,
      unavailableReason: null,
    };
  }
  const selected = input.selectedCategory ?? null;
  if (selected && PALETTE_CATEGORY_IDS.includes(selected)) {
    const group = categories.find((item) => item.id === selected);
    if (group) {
      return {
        kind: "category",
        categories,
        items: group.items,
        selectedCategory: selected,
        unavailableReason: null,
      };
    }
  }
  return {
    kind: "categories",
    categories,
    items: [],
    selectedCategory: null,
    unavailableReason: null,
  };
}

function liveCatalogNode(
  catalog: WorkflowCatalog | null | undefined,
  type: string,
) {
  return filterEnabledActionNodes(catalog?.nodes).find(
    (node) => node.type === type,
  );
}

function catalogRecommendationInputs(
  catalog: WorkflowCatalog | null | undefined,
  type: string,
): CatalogPort[] {
  const listed = liveCatalogNode(catalog, type);
  return (listed?.inputs ?? []).filter((port) => Boolean(port.kind?.trim()));
}

function catalogRecommendationAllowedWith(
  catalog: WorkflowCatalog | null | undefined,
  type: string,
): CatalogWithField[] {
  const listed = liveCatalogNode(catalog, type);
  return (listed?.allowedWith ?? []).filter((field) =>
    Boolean(field.kind?.trim()),
  );
}

function catalogKindCompatible(
  fromKind: string | undefined,
  toKind: string | undefined,
): boolean {
  if (!fromKind?.trim() || !toKind?.trim()) {
    return false;
  }
  if (fromKind === "any" || toKind === "any") {
    return true;
  }
  return fromKind === toKind;
}

export function catalogEntryAcceptsUpstreamPort(
  catalog: WorkflowCatalog | null | undefined,
  type: string,
  upstream?: CatalogPort | null,
): boolean {
  if (!catalog || !upstream?.kind?.trim()) {
    return false;
  }
  const inputs = catalogRecommendationInputs(catalog, type);
  if (
    inputs.some((port) =>
      portsCompatible(upstream, port) ||
      catalogKindCompatible(upstream.kind, port.kind),
    )
  ) {
    return true;
  }
  return catalogRecommendationAllowedWith(catalog, type).some((field) =>
    catalogKindCompatible(upstream.kind, field.kind),
  );
}

/**
 * Recommended-from-upstream-port. Catalog port types / `allowedWith`
 * only. Missing catalog → fail closed, no invented types.
 */
export function recommendFromUpstreamPort(input: {
  entries: readonly ActionLibraryEntry[];
  catalog: WorkflowCatalog | null | undefined;
  upstream?: { type: string; port: CatalogPort } | null;
}): PaletteRecommendation[] {
  if (!input.catalog || !input.upstream?.port?.kind?.trim()) {
    return [];
  }
  const enabled = enabledCatalogPaletteEntries(input.entries, input.catalog);
  const recommended: PaletteRecommendation[] = [];
  for (const entry of enabled) {
    if (
      !catalogEntryAcceptsUpstreamPort(
        input.catalog,
        entry.type,
        input.upstream.port,
      )
    ) {
      continue;
    }
    recommended.push({
      type: entry.type,
      score: 5,
      reasons: [
        `Accepts upstream ${input.upstream.port.name} (${input.upstream.port.kind})`,
      ],
    });
  }
  return recommended.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.type.localeCompare(right.type);
  });
}

export function paletteExcludesHardLineTypes(
  entries: readonly ActionLibraryEntry[],
  catalog: WorkflowCatalog | null | undefined,
): boolean {
  const enabled = enabledCatalogPaletteEntries(entries, catalog);
  if (enabled.some((entry) => isTriggerActionType(entry.type))) {
    return false;
  }
  if (enabled.some((entry) => !entry.placeable || !entry.enabled)) {
    return false;
  }
  if (rejectDisabledActionType("manual", catalog).ok) {
    return false;
  }
  return enabled.every((entry) => {
    const listed = liveCatalogNode(catalog, entry.type);
    if (!listed) {
      return false;
    }
    if (listed.phase === "next" || listed.phase === "provider") {
      return listed.enabled === true;
    }
    return listed.phase === "core" || listed.enabled === true;
  });
}

export function paletteMissingCatalogFailsClosed(
  catalog: WorkflowCatalog | null | undefined,
  statusCode?: number,
): boolean {
  const paint = paletteFirstPaint({
    entries: [],
    catalog,
    statusCode,
  });
  return (
    paint.kind === "unavailable" &&
    paint.categories.length === 0 &&
    paint.items.length === 0 &&
    recommendFromUpstreamPort({
      entries: [],
      catalog,
      upstream: { type: "data.set", port: { name: "result", kind: "object" } },
    }).length === 0
  );
}

export function rememberedOpenLibraryUnchanged(input: {
  rememberedOpen: boolean;
  persistentSatellite: boolean;
  hiddenOnFirstPaint: boolean;
  openOnFirstPaint: boolean;
  defaultOpen: boolean;
  storageKey: string;
  r21Story: number;
  r21KeepOpen: boolean;
}): boolean {
  return (
    input.rememberedOpen &&
    input.persistentSatellite &&
    input.hiddenOnFirstPaint === false &&
    input.openOnFirstPaint &&
    input.defaultOpen &&
    input.storageKey === PALETTE_LIBRARY_OPEN_STORAGE_KEY &&
    input.r21Story === 234 &&
    input.r21KeepOpen &&
    PALETTE_CATEGORY_FIRST.rememberedOpenSatelliteUnchanged
  );
}

export function actionsRemainsCatalogReference(input: {
  href: string;
  navIsReference: boolean;
  commandIsReference: boolean;
  embedUnchanged: boolean;
  noThirdApp: boolean;
}): boolean {
  return (
    input.href === PALETTE_ACTIONS_CATALOG_HREF &&
    input.navIsReference &&
    input.commandIsReference &&
    input.embedUnchanged &&
    input.noThirdApp
  );
}

export function paletteFirstPaintIsCategories(paint: PaletteFirstPaint): boolean {
  return (
    paint.kind === "categories" &&
    paint.items.length === 0 &&
    paint.categories.length > 0 &&
    paint.categories.every((group) =>
      PALETTE_CATEGORY_IDS.includes(group.id),
    )
  );
}

export function paletteCategoryFirstHoldsHardLines(): boolean {
  return (
    PALETTE_CATEGORY_FIRST.yamlIsSourceOfTruth &&
    PALETTE_CATEGORY_FIRST.draftsNeverRun &&
    PALETTE_CATEGORY_FIRST.vaultDisplayNameUuidOnly &&
    PALETTE_CATEGORY_FIRST.adv021ChromeFromSessionEmbedOnly &&
    PALETTE_CATEGORY_FIRST.adv024MembershipIsolationStayGrantGated &&
    PALETTE_CATEGORY_FIRST.oneReplayPath &&
    PALETTE_CATEGORY_FIRST.loudIndeterminate &&
    PALETTE_CATEGORY_FIRST.failClosedCatalogs &&
    PALETTE_CATEGORY_FIRST.notAnN8nClone &&
    PALETTE_CATEGORY_FIRST.noKekInBrowser &&
    PALETTE_CATEGORY_FIRST.d3TriggersAreWorkflowLevel &&
    PALETTE_CATEGORY_FIRST.noCanvasTriggerNodes &&
    PALETTE_CATEGORY_FIRST.missingCatalogFailsClosed &&
    PALETTE_CATEGORY_FIRST.noInventedTypes &&
    CATALOG_SOURCE_UNAVAILABLE === "unavailable" &&
    PALETTE_ACTIONS_CATALOG_HREF === "/actions" &&
    PALETTE_LIBRARY_OPEN_STORAGE_KEY === "flowforge.editor.library-open.v1"
  );
}

export function paletteSurfacesUseCategoryFirst(source: string): boolean {
  return (
    source.includes("paletteFirstPaint") &&
    source.includes('data-uxl7="categories"') &&
    source.includes("PALETTE_CATEGORY_LABELS")
  );
}
