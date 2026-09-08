"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import { IsolationExercise } from "@/components/isolation/IsolationExercise";
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
import { callIdentityProxy } from "@/lib/identity-client";
import { emptyDevIdentity, type DevIdentity } from "@/lib/identity-headers";
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

const EXAMPLE_IDENTITY: DevIdentity = {
  issuer: "https://flowforge.local",
  subject: "operator-chloe",
  displayName: "Chloe (dev)",
  tenantId: "",
  tenantSlug: "",
  workbenchKey: "",
};

export function MembershipOperator() {
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
  const [current, setCurrent] = useState<CurrentWorkspace | null>(null);
  const [members, setMembers] = useState<Member[]>([]);

  const [tenantSlug, setTenantSlug] = useState("acme");
  const [tenantName, setTenantName] = useState("Acme");
  const [workspaceName, setWorkspaceName] = useState("Operations");
  const [workspaceTenantId, setWorkspaceTenantId] = useState("");
  const [workspaceTenantSlug, setWorkspaceTenantSlug] = useState("");
  const [workspaceKey, setWorkspaceKey] = useState("ops");

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

  async function loadWorkspaces() {
    const data = await run<ItemList<Membership>>("workspaces", "/workspaces");
    if (data) {
      setMemberships(data.items ?? []);
    }
  }

  async function loadCurrent() {
    const data = await run<CurrentWorkspace>("workspace", "/workspace");
    if (data) {
      setCurrent(data);
    }
  }

  async function loadMembers() {
    const data = await run<ItemList<Member>>("members", "/workspace/members");
    if (data) {
      setMembers(data.items ?? []);
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
        onExample={() => updateIdentity({ ...EXAMPLE_IDENTITY })}
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
        <p className="text-sm text-zinc-600">
          Stale session — <a className="underline" href="#session">re-establish the cookie session</a>.
        </p>
      ) : null}
      {problem && isCsrfProblem(problem) ? (
        <p className="text-sm text-zinc-600">
          CSRF fail-closed. The mutation was not applied.
        </p>
      ) : null}
      {lastRequestId && !problem ? (
        <p className="font-mono text-xs text-zinc-500">
          last request_id {lastRequestId}
        </p>
      ) : null}

      <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Create tenant and workspace</h2>
        <p className="mt-1 text-sm text-zinc-600">
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
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-mono text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
            />
          </label>
          <label className="text-sm">
            <span className="font-medium">Tenant name</span>
            <input
              value={tenantName}
              onChange={(event) => setTenantName(event.target.value)}
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
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
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-mono text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
            />
          </label>
          <label className="text-sm">
            <span className="font-medium">Tenant slug</span>
            <input
              value={workspaceTenantSlug}
              onChange={(event) => setWorkspaceTenantSlug(event.target.value)}
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-mono text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
            />
          </label>
          <label className="text-sm">
            <span className="font-medium">Workbench key</span>
            <input
              value={workspaceKey}
              onChange={(event) => setWorkspaceKey(event.target.value)}
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-mono text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
            />
          </label>
          <label className="text-sm">
            <span className="font-medium">Workspace name</span>
            <input
              value={workspaceName}
              onChange={(event) => setWorkspaceName(event.target.value)}
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
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
      </section>

      <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Caller workspaces</h2>
            <p className="mt-1 text-sm text-zinc-600">
              <code className="font-mono text-xs">GET /api/v1/workspaces</code>{" "}
              lists memberships from server-side bindings. Selecting a row fills
              tenant + workbench key for the current workspace view.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadWorkspaces()}
            disabled={pending !== null}
            className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-60"
          >
            {pending === "workspaces" ? "Loading…" : "List workspaces"}
          </button>
        </div>
        {memberships.length === 0 ? (
          <p className="mt-4 text-sm text-zinc-600">No memberships loaded.</p>
        ) : (
          <ul className="mt-4 divide-y divide-zinc-100">
            {memberships.map((item) => (
              <li
                key={item.workspace.id}
                className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="font-medium">{item.workspace.name}</p>
                  <p className="font-mono text-xs text-zinc-500">
                    {item.tenant.slug} / {item.workspace.workbench_key}
                  </p>
                  <p className="mt-1 text-sm text-zinc-600">
                    {item.roles.join(", ") || "no roles"}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => selectMembership(item)}
                  className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50"
                >
                  Use tenant + workbench
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Current workspace</h2>
            <p className="mt-1 text-sm text-zinc-600">
              <code className="font-mono text-xs">GET /api/v1/workspace</code>{" "}
              resolves from tenant + workbench headers. Host-supplied workspace
              UUID is not sent.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadCurrent()}
            disabled={pending !== null}
            className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-60"
          >
            {pending === "workspace" ? "Loading…" : "Load current workspace"}
          </button>
        </div>
        {current ? (
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-zinc-500">Workspace</dt>
              <dd className="font-medium">{current.workspace.name}</dd>
              <dd className="font-mono text-xs text-zinc-500">
                {current.workspace.workbench_key}
              </dd>
            </div>
            <div>
              <dt className="text-zinc-500">Tenant</dt>
              <dd className="font-medium">{current.tenant.name}</dd>
              <dd className="font-mono text-xs text-zinc-500">
                {current.tenant.slug}
              </dd>
            </div>
            <div>
              <dt className="text-zinc-500">Principal</dt>
              <dd>
                {current.principal.display_name ||
                  current.principal.external_subject}
              </dd>
              <dd className="font-mono text-xs text-zinc-500">
                {current.principal.issuer}
              </dd>
            </div>
            <div>
              <dt className="text-zinc-500">Roles</dt>
              <dd>{current.roles.join(", ") || "—"}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-zinc-500">Permissions</dt>
              <dd className="font-mono text-xs leading-5">
                {current.permissions.join(", ") || "—"}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="mt-4 text-sm text-zinc-600">
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

      <PermissionMatrixTable
        matrix={matrix}
        pending={pending === "matrix" || pending === "roles"}
        onRefresh={() => void loadMatrix()}
      />

      <IsolationExercise />
    </div>
  );
}
