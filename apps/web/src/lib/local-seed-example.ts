import type { DevIdentity } from "./identity-headers.ts";

/**
 * Compose localseed values (#191 / `internal/localseed`).
 * UI placeholders and labeled "Example context" prefills only — not an
 * API contract and not used in production fail-closed paths.
 *
 * R7.3 / #278 (keep #278 open): stays labeled and local-only. Do not
 * promote into production Settings copy. Trusted-dev header fallback
 * is never rewrite login. Seed crypto/defaults stay unchanged.
 */
export const LOCAL_SEED_ISSUER = "https://idp.example";
export const LOCAL_SEED_SUBJECT = "admin-1";
export const LOCAL_SEED_DISPLAY_NAME = "Admin (local seed)";
export const LOCAL_SEED_TENANT_SLUG = "local";
export const LOCAL_SEED_TENANT_NAME = "Local demo";
export const LOCAL_SEED_WORKBENCH_KEY = "default";
export const LOCAL_SEED_WORKSPACE_NAME = "Local workbench";

export const LOCAL_SEED_EXAMPLE_IDENTITY: DevIdentity = {
  issuer: LOCAL_SEED_ISSUER,
  subject: LOCAL_SEED_SUBJECT,
  displayName: LOCAL_SEED_DISPLAY_NAME,
  tenantId: "",
  tenantSlug: LOCAL_SEED_TENANT_SLUG,
  workbenchKey: LOCAL_SEED_WORKBENCH_KEY,
};
