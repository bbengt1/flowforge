import type { PermissionMatrix } from "@/lib/identity-types";

const FAMILY_ORDER = [
  "view",
  "edit",
  "publish",
  "execute",
  "credential",
  "approval",
  "administration",
];

type PermissionMatrixTableProps = {
  matrix: PermissionMatrix | null;
  pending: boolean;
  onRefresh: () => void;
};

export function PermissionMatrixTable({
  matrix,
  pending,
  onRefresh,
}: PermissionMatrixTableProps) {
  const roles = matrix?.roles ?? [];
  const permissions = [...(matrix?.permissions ?? [])].sort((a, b) => {
    const family = FAMILY_ORDER.indexOf(a.family ?? "") - FAMILY_ORDER.indexOf(b.family ?? "");
    return family !== 0 ? family : a.key.localeCompare(b.key);
  });

  return (
    <section
      aria-labelledby="matrix-heading"
      className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 id="matrix-heading" className="text-lg font-semibold">
            Permission matrix
          </h2>
          <p className="mt-1 text-sm text-zinc-600">
            Read-only catalog from{" "}
            <code className="font-mono text-xs">GET /api/v1/permission-matrix</code>
            . Families: view, edit, publish, execute, credential, approval,
            administration.
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={pending}
          className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-60"
        >
          {pending ? "Loading…" : "Load matrix"}
        </button>
      </div>

      {permissions.length === 0 ? (
        <p className="mt-4 text-sm text-zinc-600">
          Load the matrix after setting issuer and subject.
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full border-collapse text-left text-sm">
            <caption className="sr-only">
              Role grants for each permission key
            </caption>
            <thead>
              <tr className="border-b border-zinc-200">
                <th scope="col" className="py-2 pr-3 font-medium">
                  Permission
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Family
                </th>
                {roles.map((role) => (
                  <th
                    key={role.key}
                    scope="col"
                    className="px-2 py-2 text-center font-medium"
                  >
                    {role.key}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {permissions.map((permission) => (
                <tr key={permission.key} className="border-b border-zinc-100">
                  <th
                    scope="row"
                    className="py-2 pr-3 font-mono text-xs font-normal"
                  >
                    {permission.key}
                  </th>
                  <td className="py-2 pr-3 text-zinc-600">
                    {permission.family ?? "—"}
                  </td>
                  {roles.map((role) => {
                    const granted = role.permissions?.includes(permission.key);
                    return (
                      <td key={role.key} className="px-2 py-2 text-center">
                        <span className="sr-only">
                          {granted ? "granted" : "denied"}
                        </span>
                        {granted ? "●" : "○"}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
