"use client";

import { useWorkspace } from "@/components/shell/WorkspaceProvider";

export function WorkspaceSwitcher() {
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

  return (
    <section
      aria-label="Workspace switcher"
      className="rounded-xl border border-zinc-200 bg-white px-3 py-2"
    >
      <p className="text-[11px] font-medium tracking-wide text-teal-800 uppercase">
        Workspace
      </p>
      <label className="mt-1 block">
        <span className="sr-only">Current workspace</span>
        <select
          className="w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm font-medium text-zinc-900"
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
      </label>
      <dl className="mt-2 grid grid-cols-2 gap-2 text-xs text-zinc-600">
        <div>
          <dt className="text-zinc-500">Role</dt>
          <dd className="font-medium text-zinc-800">{roleLabel}</dd>
        </div>
        <div>
          <dt className="text-zinc-500">Environment</dt>
          <dd className="font-mono font-medium text-zinc-800">
            {environment || "—"}
          </dd>
        </div>
      </dl>
      {tenantName ? (
        <p className="mt-1 truncate text-[11px] text-zinc-500">{tenantName}</p>
      ) : null}
      {embedLocked ? (
        <p className="mt-2 text-[11px] text-zinc-500">
          Locked to the FlowForge-verified tenant/workbench.
        </p>
      ) : null}
    </section>
  );
}
