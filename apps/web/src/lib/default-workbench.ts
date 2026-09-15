/**
 * Post-login default workbench (#369).
 *
 * B.3 create-or-binds localseed `local` / `default` for the first
 * admin. After standalone Login the cookie session can list
 * memberships without a prior workspace lookup. Chrome binds that
 * default (or the sole membership) so the switcher is not an empty
 * Select-a-workspace dead end. Embed stays ADV-021 / verified-tenancy
 * only — this helper is not a session bind and not a new session type.
 */

import {
  LOCAL_SEED_TENANT_SLUG,
  LOCAL_SEED_WORKBENCH_KEY,
} from "./local-seed-example.ts";
import type { DevIdentity } from "./identity-headers.ts";
import type { Membership } from "./identity-types.ts";

export const DEFAULT_WORKBENCH_STORY = 369;

export function isDefaultWorkbench(membership: Membership): boolean {
  return (
    membership.tenant.slug === LOCAL_SEED_TENANT_SLUG &&
    membership.workspace.workbench_key === LOCAL_SEED_WORKBENCH_KEY
  );
}

/** Prefer B.3 / localseed local/default; otherwise the only membership. */
export function pickDefaultWorkbench(
  memberships: readonly Membership[],
): Membership | null {
  if (memberships.length === 0) {
    return null;
  }
  const preferred = memberships.find(isDefaultWorkbench);
  if (preferred) {
    return preferred;
  }
  if (memberships.length === 1) {
    return memberships[0];
  }
  return memberships[0];
}

export function workspaceLookupFromMembership(
  membership: Membership,
): Pick<DevIdentity, "tenantId" | "tenantSlug" | "workbenchKey"> {
  return {
    tenantId: membership.workspace.tenant_id,
    tenantSlug: membership.tenant.slug,
    workbenchKey: membership.workspace.workbench_key,
  };
}
