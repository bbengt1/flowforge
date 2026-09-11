/**
 * R3.4: live catalogs are the source of truth for Kubernetes, SSH,
 * script, and HTTP node/engine contracts. Empty or unauthorized
 * catalog responses fail closed — the UI must not invent node types,
 * allowedWith, ports, or config fields.
 *
 * Relates to #249 / Part of #229. Keep #249 open.
 *
 * Chloe UI only. Reuses existing catalog clients. No new API routes,
 * node types, marketplace, or SecretField.
 */

export const R34_STORY = 249;
export const R34_EPIC = 229;
export const R34_KEEP_STORY_OPEN = true;

export const CATALOG_SOURCE_UNAVAILABLE = "unavailable" as const;
export type UnavailableCatalogSource = typeof CATALOG_SOURCE_UNAVAILABLE;

/**
 * Legacy invented-contract marker. K8s / SSH / script / HTTP adapters
 * must not emit this — those fallbacks are deleted. Core/trigger
 * adapters may still use it.
 */
export const CATALOG_SOURCE_CONTRACT_FALLBACK = "contract-fallback" as const;

export const ENGINE_CATALOG_UNAVAILABLE_HELP =
  "Live catalog is empty or unauthorized (including HTTP 403). UI fails closed — no invented node types, allowedWith, ports, or config fields.";

export const EDITOR_ENGINE_CATALOG = {
  liveCatalogSourceOfTruth: true,
  emptyFailsClosed: true,
  catalog403FailsClosed: true,
  noInventedNodeTypes: true,
  noInventedAllowedWith: true,
  noInventedPorts: true,
  noInventedConfigFields: true,
  noInventedToggles: true,
  noMarketplace: true,
  noNewNodeTypes: true,
  noNewApiRoutes: true,
  yamlSourceOfTruth: true,
  draftsNeverExecute: true,
  vaultDisplayNamePlusUuidOnly: true,
  noSecretFieldInNdv: true,
  keep249Open: true,
} as const;

export function isInventedCatalogSource(
  source: string | undefined | null,
): boolean {
  return (
    source == null ||
    source === CATALOG_SOURCE_UNAVAILABLE ||
    source === CATALOG_SOURCE_CONTRACT_FALLBACK
  );
}

export function isLiveCatalogSource(
  source: string | undefined | null,
): boolean {
  return !isInventedCatalogSource(source);
}

export function catalogNodeTypes(
  nodes: readonly { type?: string }[] | null | undefined,
): string[] {
  return (nodes ?? [])
    .map((item) => String(item.type ?? "").trim())
    .filter(Boolean);
}
