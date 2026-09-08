/** Shapes from jonny's E2.1 OpenAPI contract (PR #17). */

export type Tenant = {
  id: string;
  slug: string;
  name: string;
  status: string;
  created_at?: string;
  updated_at?: string;
};

export type Workspace = {
  id: string;
  tenant_id: string;
  workbench_key: string;
  name: string;
  status: string;
  created_at?: string;
  updated_at?: string;
};

export type User = {
  id: string;
  issuer: string;
  external_subject: string;
  display_name?: string;
  status: string;
};

export type Membership = {
  workspace: Workspace;
  tenant: Tenant;
  roles: string[];
  permissions: string[];
};

export type CurrentWorkspace = {
  workspace: Workspace;
  tenant: Tenant;
  principal: User;
  roles: string[];
  permissions: string[];
};

export type Member = {
  user: User;
  roles: string[];
  permissions: string[];
};

export type RoleCatalogEntry = {
  key: string;
  description?: string;
  permissions?: string[];
};

export type PermissionCatalogEntry = {
  key: string;
  family?: string;
};

export type PermissionMatrix = {
  permissions: PermissionCatalogEntry[];
  roles: RoleCatalogEntry[];
};

export type ItemList<T> = {
  items: T[];
};
