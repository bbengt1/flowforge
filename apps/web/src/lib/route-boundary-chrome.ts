/**
 * G.0.4 chrome copy + classes. Keep this file free of rewrite-embed
 * and editor imports so `error.tsx` / `global-error.tsx` stay light.
 *
 * Relates to #407 / Part of #402. Keep #402 open.
 */

import { EMBED_MOUNT_PREFIX } from "./embed-contract.ts";
import { maybeEmbedDeepLink } from "./embed-tenancy-contract.ts";

export const ROUTE_ERROR_HEADING = "Something went wrong";
export const ROUTE_ERROR_HELP =
  "This page failed to render. Try again. If it keeps failing, share the reference.";
export const ROUTE_ERROR_RETRY_LABEL = "Try again";
export const ROUTE_ERROR_DIGEST_LABEL = "Reference";

export const ROUTE_LOADING_LABEL = "Loading…";

export const ROUTE_NOT_FOUND_HEADING = "Page not found";
export const ROUTE_NOT_FOUND_HELP = "This route is not in FlowForge.";
export const ROUTE_NOT_FOUND_HOME_LABEL = "Back to workflows";
export const ROUTE_NOT_FOUND_HOME_HREF = "/workflows";

export const ROUTE_BOUNDARY_ATTR = "data-ff-route-boundary";
export const ROUTE_BOUNDARY_ERROR_VALUE = "error";
export const ROUTE_BOUNDARY_LOADING_VALUE = "loading";
export const ROUTE_BOUNDARY_NOT_FOUND_VALUE = "not-found";

/** Same layout as PAGE_SHELL_CLASS — inlined so error chrome does not import UXL.8. */
export const ROUTE_BOUNDARY_SHELL_CLASS =
  "mx-auto flex min-h-full w-full max-w-6xl flex-col gap-8 px-6 py-12";
export const ROUTE_BOUNDARY_HEADING_CLASS = "text-3xl font-semibold tracking-tight";
export const ROUTE_BOUNDARY_HELP_CLASS = "ff-shell-muted max-w-3xl text-sm leading-6";
export const ROUTE_BOUNDARY_PANEL_CLASS = "ff-shell-panel p-6";
export const ROUTE_BOUNDARY_ACTION_CLASS = "ff-overview-create";
export const ROUTE_BOUNDARY_SKELETON_CLASS = "ff-shell-panel h-24";

export function routeNotFoundHomeHref(embed: boolean): string {
  return maybeEmbedDeepLink(ROUTE_NOT_FOUND_HOME_HREF, embed);
}

export function routeErrorDigest(error: { digest?: string } | null | undefined): string {
  return error?.digest?.trim() ?? "";
}

export function embedWorkflowsHomeHref(): string {
  return `${EMBED_MOUNT_PREFIX}/workflows`;
}
