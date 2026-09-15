"use client";

import { useWorkspace } from "@/components/shell/WorkspaceProvider";

type WorkspaceSwitcherProps = {
  compact?: boolean;
};

export function WorkspaceSwitcher({ compact = false }: WorkspaceSwitcherProps) {
  const {
    current,
    memberships,
    environment,
    roles,
    ready,
    switchWorkspace,
    embedLocked,
  } = useWorkspace();

  const roleLabel = roles[0] || (ready ? "member" : "no workspace");
  const workspaceName = current?.workspace.name || "No workspace";
  const tenantName = current?.tenant.name || current?.tenant.slug || "";

  const select = (
    <select
      className={
        compact
          ? "ff-shell-control w-full max-w-56 px-2 py-1.5 text-sm font-medium"
          : "ff-shell-control w-full px-2 py-1.5 text-sm font-medium"
      }
      value={
        current
          ? `${current.workspace.tenant_id}:${current.workspace.workbench_key}`
          : ""
      }
      disabled={embedLocked || memberships.length === 0}
      onChange={(event) => {
        const next = memberships.find((item) => {
          const key = `${item.workspace.tenant_id}:${item.workspace.workbench_key}`;
          return key === event.target.value;
        });
        if (next) {
          switchWorkspace(next);
        }
      }}
    >
      {memberships.length === 0 ? (
        <option value="">{ready ? workspaceName : "Select a workspace"}</option>
      ) : (
        memberships.map((item) => {
          const key = `${item.workspace.tenant_id}:${item.workspace.workbench_key}`;
          return (
            <option key={key} value={key}>
              {item.workspace.name} · {item.tenant.slug}
            </option>
          );
        })
      )}
    </select>
  );

  if (compact) {
    return (
      <label className="min-w-40 max-w-56" aria-label="Workspace switcher">
        <span className="sr-only">Current workspace</span>
        {select}
      </label>
    );
  }

  return (
    <section
      aria-label="Workspace switcher"
      className="ff-shell-panel px-3 py-2"
    >
      <p className="ff-nav-group-label text-[11px] font-medium tracking-wide uppercase">
        Workspace
      </p>
      <label className="mt-1 block">
        <span className="sr-only">Current workspace</span>
        {select}
      </label>
      <dl className="mt-2 grid grid-cols-2 gap-2 text-xs ff-shell-muted">
        <div>
          <dt>Role</dt>
          <dd className="font-medium text-[var(--ff-text)]">{roleLabel}</dd>
        </div>
        <div>
          <dt>Environment</dt>
          <dd className="font-mono font-medium text-[var(--ff-text)]">
            {environment || "—"}
          </dd>
        </div>
      </dl>
      {tenantName ? (
        <p className="mt-1 truncate text-[11px] ff-shell-muted">{tenantName}</p>
      ) : null}
      {embedLocked ? (
        <p className="mt-2 text-[11px] ff-shell-muted">
          Locked to the FlowForge-verified tenant/workbench.
        </p>
      ) : null}
    </section>
  );
}
