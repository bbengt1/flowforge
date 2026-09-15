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
  return null;
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

export type SessionPrincipal = {
  active: boolean;
  issuer: string;
  subject: string;
  displayName?: string;
};

/** Stamp the cookie-session principal onto tab identity so lookup is owned. */
export function stampSessionPrincipal(
  identity: DevIdentity,
  session: Pick<SessionPrincipal, "issuer" | "subject" | "displayName">,
): DevIdentity {
  return {
    ...identity,
    issuer: session.issuer.trim() || identity.issuer,
    subject: session.subject.trim() || identity.subject,
    displayName: session.displayName?.trim() || identity.displayName,
  };
}

export function clearWorkspaceLookup(identity: DevIdentity): DevIdentity {
  return {
    ...identity,
    tenantId: "",
    tenantSlug: "",
    workbenchKey: "",
  };
}

/**
 * A stored lookup without a matching session principal is leftover
 * from another sign-in in this tab. Header-fallback (no cookie
 * session) keeps the lookup.
 */
export function workspaceLookupBelongsToSession(
  identity: DevIdentity,
  session: SessionPrincipal,
): boolean {
  if (!session.active || !session.subject.trim()) {
    return true;
  }
  const storedSubject = identity.subject.trim();
  if (!storedSubject) {
    return false;
  }
  if (storedSubject !== session.subject.trim()) {
    return false;
  }
  const storedIssuer = identity.issuer.trim();
  const sessionIssuer = session.issuer.trim();
  if (storedIssuer && sessionIssuer && storedIssuer !== sessionIssuer) {
    return false;
  }
  return true;
}
