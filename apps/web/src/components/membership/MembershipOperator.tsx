"use client";

import Link from "next/link";
import { useCallback, useState, useSyncExternalStore } from "react";
import { useEmbedMode } from "@/components/embed/EmbedMode";
import { CollectionLoadMore } from "@/components/CollectionLoadMore";
import { ProblemBanner } from "@/components/ProblemBanner";
import { IdentityBootstrap } from "@/components/membership/IdentityBootstrap";
import { MembersPanel } from "@/components/membership/MembersPanel";
import { PermissionMatrixTable } from "@/components/membership/PermissionMatrixTable";
import { SessionExpiryBanner } from "@/components/session/SessionExpiryBanner";
import { SessionPanel } from "@/components/session/SessionPanel";
import {
  clearDevIdentity,
  emptyStoredIdentity,
  loadDevIdentity,
  saveDevIdentity,
  subscribeDevIdentity,
} from "@/lib/dev-identity";
import {
  loadHeaderFallback,
  setHeaderFallback,
  subscribeHeaderFallback,
} from "@/lib/header-fallback";
import {
  COLLECTION_PAGE_DEFAULT_LIMIT,
  openCollectionPath,
  readCollectionPageFields,
} from "@/lib/collection-page";
import { callIdentityProxy } from "@/lib/identity-client";
import { emptyDevIdentity, type DevIdentity } from "@/lib/identity-headers";
import {
  LOCAL_SEED_EXAMPLE_IDENTITY,
  LOCAL_SEED_TENANT_NAME,
  LOCAL_SEED_TENANT_SLUG,
  LOCAL_SEED_WORKBENCH_KEY,
  LOCAL_SEED_WORKSPACE_NAME,
} from "@/lib/local-seed-example";
import { embedDeepLink } from "@/lib/embed-tenancy-contract";
import {
  ISOLATION_CHECK_HELP,
  ISOLATION_CHECK_HREF,
} from "@/lib/membership-isolation-chrome";
import { isCsrfProblem, isStaleSessionProblem } from "@/lib/session";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";
import type {
  CurrentWorkspace,
  ItemList,
  Member,
  Membership,
  PermissionMatrix,
  RoleCatalogEntry,
  Tenant,
  Workspace,
} from "@/lib/identity-types";
import type { ProblemDetails } from "@/lib/problem";

export function MembershipOperator() {
  const embed = useEmbedMode();
  const isolationHref = embed
    ? embedDeepLink(ISOLATION_CHECK_HREF)
    : ISOLATION_CHECK_HREF;
  const identity = useSyncExternalStore(
    subscribeDevIdentity,
    loadDevIdentity,
    emptyStoredIdentity,
  );
  const session = useSyncExternalStore(
    subscribeSession,
    getSessionSnapshot,
    getSessionSnapshot,
  );
  const headerFallback = useSyncExternalStore(
    subscribeHeaderFallback,
    loadHeaderFallback,
    () => false,
  );
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [lastRequestId, setLastRequestId] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const [matrix, setMatrix] = useState<PermissionMatrix | null>(null);
  const [roles, setRoles] = useState<RoleCatalogEntry[]>([]);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [workspaceNext, setWorkspaceNext] = useState("");
  const [memberNext, setMemberNext] = useState("");
  const [current, setCurrent] = useState<CurrentWorkspace | null>(null);
  const [members, setMembers] = useState<Member[]>([]);

  const [tenantSlug, setTenantSlug] = useState(LOCAL_SEED_TENANT_SLUG);
  const [tenantName, setTenantName] = useState(LOCAL_SEED_TENANT_NAME);
  const [workspaceName, setWorkspaceName] = useState(LOCAL_SEED_WORKSPACE_NAME);
  const [workspaceTenantId, setWorkspaceTenantId] = useState("");
  const [workspaceTenantSlug, setWorkspaceTenantSlug] = useState(
    LOCAL_SEED_TENANT_SLUG,
  );
  const [workspaceKey, setWorkspaceKey] = useState(LOCAL_SEED_WORKBENCH_KEY);

  const updateIdentity = useCallback((next: DevIdentity) => {
    saveDevIdentity(next);
  }, []);

  async function run<T>(
    label: string,
    path: string,
    init: { method?: string; body?: unknown } = {},
  ) {
    setPending(label);
    setProblem(null);
    const result = await callIdentityProxy<T>(path, identity, init);
    setLastRequestId(result.requestId);
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return null;
    }
    return result.data;
  }

  async function loadMatrix() {
    const data = await run<PermissionMatrix>("matrix", "/permission-matrix");
    if (data) {
      setMatrix(data);
    }
    const roleList = await run<ItemList<RoleCatalogEntry>>("roles", "/roles");
    if (roleList) {
      setRoles(roleList.items ?? []);
    }
  }

  async function loadWorkspaces(cursor = "") {
    const opened = openCollectionPath("/workspaces", {
      limit: COLLECTION_PAGE_DEFAULT_LIMIT,
      cursor,
    });
    if (!opened.ok) {
      setProblem(opened.problem);
      return;
    }
    const data = await run<ItemList<Membership>>("workspaces", opened.path);
    if (data) {
      const page = readCollectionPageFields(data);
      const rows = data.items ?? [];
      setMemberships((current) =>
        cursor ? mergeMemberships(current, rows) : rows,
      );
      setWorkspaceNext(page.next);
    }
  }

  async function loadCurrent() {
    const data = await run<CurrentWorkspace>("workspace", "/workspace");
    if (data) {
      setCurrent(data);
    }
  }

  async function loadMembers(cursor = "") {
    const opened = openCollectionPath("/workspace/members", {
      limit: COLLECTION_PAGE_DEFAULT_LIMIT,
      cursor,
    });
    if (!opened.ok) {
      setProblem(opened.problem);
      return;
    }
    const data = await run<ItemList<Member>>("members", opened.path);
    if (data) {
      const page = readCollectionPageFields(data);
      const rows = data.items ?? [];
      setMembers((current) => (cursor ? mergeMembers(current, rows) : rows));
      setMemberNext(page.next);
    }
  }

  async function createTenant() {
    const data = await run<Tenant>("create-tenant", "/tenants", {
      method: "POST",
      body: { slug: tenantSlug.trim(), name: tenantName.trim() },
    });
    if (!data) {
      return;
    }
    const next = {
      ...identity,
      tenantId: data.id,
      tenantSlug: data.slug,
    };
    updateIdentity(next);
    setWorkspaceTenantId(data.id);
    setWorkspaceTenantSlug(data.slug);
  }

  async function createWorkspace() {
    const body: Record<string, string> = {
      workbench_key: workspaceKey.trim(),
      name: workspaceName.trim(),
    };
    if (workspaceTenantId.trim()) {
      body.tenant_id = workspaceTenantId.trim();
    }
    if (workspaceTenantSlug.trim()) {
      body.tenant_slug = workspaceTenantSlug.trim();
    }
    const data = await run<Workspace>("create-workspace", "/workspaces", {
      method: "POST",
      body,
    });
    if (!data) {
      return;
    }
    updateIdentity({
      ...identity,
      tenantId: data.tenant_id,
      workbenchKey: data.workbench_key,
      tenantSlug: workspaceTenantSlug.trim() || identity.tenantSlug,
    });
    await loadWorkspaces();
  }

  async function saveMember(input: {
    userId: string;
    issuer: string;
    subject: string;
    displayName: string;
    roleKeys: string[];
  }) {
    const body: Record<string, unknown> = { role_keys: input.roleKeys };
    if (input.userId) {
      body.user_id = input.userId;
    }
    if (input.issuer) {
      body.issuer = input.issuer;
    }
    if (input.subject) {
      body.external_subject = input.subject;
    }
    if (input.displayName) {
      body.display_name = input.displayName;
    }
    const data = await run<Member>("put-member", "/workspace/members", {
      method: "PUT",
      body,
    });
    if (data) {
      await loadMembers();
    }
  }

  async function removeMember(userId: string) {
    const data = await run<unknown>(
      "delete-member",
      `/workspace/members/${encodeURIComponent(userId)}`,
      { method: "DELETE" },
    );
    if (data !== null) {
      await loadMembers();
      await loadCurrent();
    }
  }

  function selectMembership(item: Membership) {
    updateIdentity({
      ...identity,
      tenantId: item.tenant.id,
      tenantSlug: item.tenant.slug,
      workbenchKey: item.workspace.workbench_key,
    });
    setWorkspaceTenantId(item.tenant.id);
    setWorkspaceTenantSlug(item.tenant.slug);
    setWorkspaceKey(item.workspace.workbench_key);
    setCurrent({
      workspace: item.workspace,
      tenant: item.tenant,
      principal: current?.principal ?? {
        id: "",
        issuer: identity.issuer,
        external_subject: identity.subject,
        display_name: identity.displayName,
        status: "active",
      },
      roles: item.roles,
      permissions: item.permissions,
    });
  }

  const canAdminister =
    current?.permissions.includes("workspace.administer") ?? false;

  return (
    <div className="space-y-6">
      <SessionPanel />
      <SessionExpiryBanner />
      <IdentityBootstrap
        identity={identity}
        onChange={updateIdentity}
        onExample={() => updateIdentity({ ...LOCAL_SEED_EXAMPLE_IDENTITY })}
        onClear={() => {
          clearDevIdentity();
          setHeaderFallback(false);
          updateIdentity(emptyDevIdentity());
          setMatrix(null);
          setRoles([]);
          setMemberships([]);
          setCurrent(null);
          setMembers([]);
          setProblem(null);
        }}
        headerFallback={headerFallback}
        onHeaderFallbackChange={setHeaderFallback}
        sessionActive={session.active}
      />

      {problem ? <ProblemBanner problem={problem} /> : null}
      {problem && isStaleSessionProblem(problem) ? (
        <p className="text-sm text-muted-foreground">
          Stale session — <a className="underline" href="#session">re-establish the cookie session</a>.
        </p>
      ) : null}
      {problem && isCsrfProblem(problem) ? (
        <p className="text-sm text-muted-foreground">
          CSRF fail-closed. The mutation was not applied.
        </p>
      ) : null}
      {lastRequestId && !problem ? (
        <p className="font-mono text-xs text-muted-foreground">
          last request_id {lastRequestId}
        </p>
      ) : null}

      <details className="rounded-2xl border border-border bg-card p-6 shadow-sm">
        <summary className="cursor-pointer text-lg font-semibold">
          Create tenant or workspace
        </summary>
        <p className="mt-2 text-sm text-muted-foreground">
          Platform-admin bootstrap — not a product-home action.{" "}
          <code className="font-mono text-xs">POST /api/v1/tenants</code> then{" "}
          <code className="font-mono text-xs">POST /api/v1/workspaces</code>.
          Create binds the caller as <code className="font-mono text-xs">admin</code>.
          Body <code className="font-mono text-xs">id</code> /{" "}
          <code className="font-mono text-xs">workspace_id</code> are rejected by
          the API and are not sent.
        </p>

        <form
          className="mt-5 grid gap-4 sm:grid-cols-3"
          onSubmit={(event) => {
            event.preventDefault();
            void createTenant();
          }}
        >
          <label className="text-sm">
            <span className="font-medium">Tenant slug</span>
            <input
              value={tenantSlug}
              onChange={(event) => setTenantSlug(event.target.value)}
              className="mt-1 w-full rounded-lg border border-border px-3 py-2 font-mono text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
            />
          </label>
          <label className="text-sm">
            <span className="font-medium">Tenant name</span>
            <input
              value={tenantName}
              onChange={(event) => setTenantName(event.target.value)}
              className="mt-1 w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
            />
          </label>
          <div className="flex items-end">
            <button
              type="submit"
              disabled={pending !== null || !tenantSlug.trim() || !tenantName.trim()}
              className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-2 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
            >
              {pending === "create-tenant" ? "Creating…" : "Create tenant"}
            </button>
          </div>
        </form>

        <form
          className="mt-5 grid gap-4 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            void createWorkspace();
          }}
        >
          <label className="text-sm">
            <span className="font-medium">Tenant ID</span>
            <input
              value={workspaceTenantId}
              onChange={(event) => setWorkspaceTenantId(event.target.value)}
              className="mt-1 w-full rounded-lg border border-border px-3 py-2 font-mono text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
            />
          </label>
          <label className="text-sm">
            <span className="font-medium">Tenant slug</span>
            <input
              value={workspaceTenantSlug}
              onChange={(event) => setWorkspaceTenantSlug(event.target.value)}
              className="mt-1 w-full rounded-lg border border-border px-3 py-2 font-mono text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
            />
          </label>
          <label className="text-sm">
            <span className="font-medium">Workbench key</span>
            <input
              value={workspaceKey}
              onChange={(event) => setWorkspaceKey(event.target.value)}
              className="mt-1 w-full rounded-lg border border-border px-3 py-2 font-mono text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
            />
          </label>
          <label className="text-sm">
            <span className="font-medium">Workspace name</span>
            <input
              value={workspaceName}
              onChange={(event) => setWorkspaceName(event.target.value)}
              className="mt-1 w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
            />
          </label>
          <div>
            <button
              type="submit"
              disabled={
                pending !== null ||
                !workspaceKey.trim() ||
                (!workspaceTenantId.trim() && !workspaceTenantSlug.trim())
              }
              className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-2 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
            >
              {pending === "create-workspace" ? "Creating…" : "Create workspace"}
            </button>
          </div>
        </form>
      </details>

      <section className="rounded-2xl border border-border bg-card p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Caller workspaces</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              <code className="font-mono text-xs">GET /api/v1/workspaces</code>{" "}
              lists memberships from server-side bindings. Selecting a row fills
              tenant + workbench key for the current workspace view.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadWorkspaces()}
            disabled={pending !== null}
            className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground hover:bg-card disabled:opacity-60"
          >
            {pending === "workspaces" ? "Loading…" : "List workspaces"}
          </button>
        </div>
        {memberships.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">No memberships loaded.</p>
        ) : (
          <ul className="mt-4 divide-y divide-border">
            {memberships.map((item) => (
              <li
                key={item.workspace.id}
                className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="font-medium">{item.workspace.name}</p>
                  <p className="font-mono text-xs text-muted-foreground">
                    {item.tenant.slug} / {item.workspace.workbench_key}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {item.roles.join(", ") || "no roles"}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => selectMembership(item)}
                  className="rounded-lg border border-border bg-card px-3 py-1.5 text-sm hover:bg-background"
                >
                  Use tenant + workbench
                </button>
              </li>
            ))}
          </ul>
        )}
        <CollectionLoadMore
          next={workspaceNext}
          pending={pending !== null}
          onLoadMore={() => void loadWorkspaces(workspaceNext)}
          label="Load more workspaces"
        />
      </section>

      <section className="rounded-2xl border border-border bg-card p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Current workspace</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              <code className="font-mono text-xs">GET /api/v1/workspace</code>{" "}
              resolves from tenant + workbench headers. Host-supplied workspace
              UUID is not sent.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadCurrent()}
            disabled={pending !== null}
            className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground hover:bg-card disabled:opacity-60"
          >
            {pending === "workspace" ? "Loading…" : "Load current workspace"}
          </button>
        </div>
        {current ? (
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">Workspace</dt>
              <dd className="font-medium">{current.workspace.name}</dd>
              <dd className="font-mono text-xs text-muted-foreground">
                {current.workspace.workbench_key}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Tenant</dt>
              <dd className="font-medium">{current.tenant.name}</dd>
              <dd className="font-mono text-xs text-muted-foreground">
                {current.tenant.slug}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Principal</dt>
              <dd>
                {current.principal.display_name ||
                  current.principal.external_subject}
              </dd>
              <dd className="font-mono text-xs text-muted-foreground">
                {current.principal.issuer}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Roles</dt>
              <dd>{current.roles.join(", ") || "—"}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-muted-foreground">Permissions</dt>
              <dd className="font-mono text-xs leading-5">
                {current.permissions.join(", ") || "—"}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">
            Set tenant + workbench key, then load the current workspace.
          </p>
        )}
      </section>

      <MembersPanel
        members={members}
        roles={roles}
        pending={pending !== null}
        canAdminister={canAdminister}
        onRefresh={() => void loadMembers()}
        onSave={saveMember}
        onRemove={removeMember}
      />
      <CollectionLoadMore
        next={memberNext}
        pending={pending !== null}
        onLoadMore={() => void loadMembers(memberNext)}
        label="Load more members"
      />

      <PermissionMatrixTable
        matrix={matrix}
        pending={pending === "matrix" || pending === "roles"}
        onRefresh={() => void loadMatrix()}
      />

      <p className="text-sm text-muted-foreground">
        <Link href={isolationHref} className="text-accent-text underline">
          Isolation check
        </Link>
        {" — "}
        {ISOLATION_CHECK_HELP}
      </p>
    </div>
  );
}

function mergeMemberships(
  current: Membership[],
  page: Membership[],
): Membership[] {
  const seen = new Set(current.map((item) => item.workspace.id));
  const next = [...current];
  for (const item of page) {
    if (!seen.has(item.workspace.id)) {
      seen.add(item.workspace.id);
      next.push(item);
    }
  }
  return next;
}

function mergeMembers(current: Member[], page: Member[]): Member[] {
  const seen = new Set(current.map((item) => item.user.id));
  const next = [...current];
  for (const item of page) {
    if (!seen.has(item.user.id)) {
      seen.add(item.user.id);
      next.push(item);
    }
  }
  return next;
}
