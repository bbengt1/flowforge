/**
 * E8.1 SSH target + command-profile types (Chloe UI).
 * Secret-free. Credentials stay in the E4.1 vault by display name/id.
 * Contract-fallback until jonny posts the engine route map.
 * Relates to #82 / Part of #81. Keep #82 open.
 */

export const SSH_POLICY_KIND = "ssh" as const;
export const SSH_CREDENTIAL_TYPE = "ssh_private_key" as const;
export const SSH_CREDENTIAL_TYPE_ALIAS = "ssh" as const;
export const SSH_DEFAULT_PORT = 22;

export const SSH_ACTION_TYPES = ["ssh.run"] as const;
export type SshActionType = (typeof SSH_ACTION_TYPES)[number];

export const SSH_PARAMETER_TYPES = [
  "string",
  "integer",
  "boolean",
  "enum",
] as const;
export type SshParameterType = (typeof SSH_PARAMETER_TYPES)[number];

/** Denied in MVP. Never expose enabling toggles. */
export const SSH_DENIED_FEATURES = [
  "password authentication",
  "agent forwarding",
  "port forwarding",
  "proxy commands",
  "host-key auto-acceptance",
] as const;

export const SSH_TEMPLATE_FORBIDDEN_TOKENS = ["$()", "`", "${", "{{"] as const;

export const SSH_SECRET_FIELD_NAMES = [
  "privateKey",
  "passphrase",
  "password",
  "hostPrivateKey",
] as const;

export type SshParameterConstraint = {
  name: string;
  type: SshParameterType;
  required: boolean;
  description?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  enum?: string[];
};

export type SshTargetSpec = {
  credentialId: string;
  hostname: string;
  hostKeyFingerprint: string;
  port?: number;
  allowedAddresses?: string[];
  policyId?: string;
};

export type SshCommandProfileSpec = {
  parameterSchema: Record<string, unknown>;
  template: string;
  retrySafe?: boolean;
  policyId?: string;
};

export type SshCatalogSource = "ops-config-catalog" | "contract-fallback";

export type SshEngineCatalog = {
  source: SshCatalogSource;
  credentialType: string;
  allowedCredentialTypes: string[];
  credentialSecretFields: string[];
  defaultPort: number;
  authMethods: readonly string[];
  denied: readonly string[];
  templateForbidden: readonly string[];
  parameterTypes: readonly string[];
  retrySafeExposed: boolean;
  allowedPorts?: number[];
  notes?: string;
};
