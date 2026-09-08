import { useState } from "react";
import type { Member, RoleCatalogEntry } from "@/lib/identity-types";

type MembersPanelProps = {
  members: Member[];
  roles: RoleCatalogEntry[];
  pending: boolean;
  canAdminister: boolean;
  onRefresh: () => void;
  onSave: (input: {
    userId: string;
    issuer: string;
    subject: string;
    displayName: string;
    roleKeys: string[];
  }) => Promise<void>;
  onRemove: (userId: string) => Promise<void>;
};

export function MembersPanel({
  members,
  roles,
  pending,
  canAdminister,
  onRefresh,
  onSave,
  onRemove,
}: MembersPanelProps) {
  const [userId, setUserId] = useState("");
  const [issuer, setIssuer] = useState("");
  const [subject, setSubject] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [roleKeys, setRoleKeys] = useState<string[]>(["viewer"]);

  function toggleRole(key: string) {
    setRoleKeys((current) =>
      current.includes(key)
        ? current.filter((item) => item !== key)
        : [...current, key],
    );
  }

  function applyMember(member: Member) {
    setUserId(member.user.id);
    setIssuer(member.user.issuer);
    setSubject(member.user.external_subject);
    setDisplayName(member.user.display_name ?? "");
    setRoleKeys(member.roles);
  }

  return (
    <section
      aria-labelledby="members-heading"
      className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 id="members-heading" className="text-lg font-semibold">
            Members
          </h2>
          <p className="mt-1 text-sm text-zinc-600">
            <code className="font-mono text-xs">GET|PUT /api/v1/workspace/members</code>{" "}
            and{" "}
            <code className="font-mono text-xs">
              DELETE /api/v1/workspace/members/{"{userID}"}
            </code>
            . Requires <code className="font-mono text-xs">workspace.administer</code>.
            Removing the last admin returns a conflict problem.
            {canAdminister
              ? " Current principal has workspace.administer."
              : " Current principal does not list workspace.administer — member calls may return a forbidden problem."}
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={pending}
          className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-60"
        >
          {pending ? "Loading…" : "Refresh members"}
        </button>
      </div>

      {members.length === 0 ? (
        <p className="mt-4 text-sm text-zinc-600">
          No members loaded. Current workspace must resolve and you need
          administer permission.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-zinc-100">
          {members.map((member) => (
            <li
              key={member.user.id}
              className="flex flex-col gap-3 py-3 sm:flex-row sm:items-start sm:justify-between"
            >
              <div>
                <p className="font-medium">
                  {member.user.display_name || member.user.external_subject}
                </p>
                <p className="font-mono text-xs text-zinc-500">
                  {member.user.issuer} · {member.user.external_subject}
                </p>
                <p className="mt-1 text-sm text-zinc-600">
                  roles {member.roles.join(", ") || "—"}
                </p>
                <p className="text-xs text-zinc-500">
                  {member.permissions.join(", ") || "no permissions"}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => applyMember(member)}
                  className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50"
                >
                  Edit roles
                </button>
                <button
                  type="button"
                  onClick={() => void onRemove(member.user.id)}
                  disabled={pending}
                  className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-sm text-red-900 hover:bg-red-100 disabled:opacity-60"
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <form
        className="mt-6 space-y-4 border-t border-zinc-100 pt-5"
        onSubmit={(event) => {
          event.preventDefault();
          void onSave({
            userId: userId.trim(),
            issuer: issuer.trim(),
            subject: subject.trim(),
            displayName: displayName.trim(),
            roleKeys,
          });
        }}
      >
        <h3 className="text-sm font-semibold">Add or update member</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm">
            <span className="font-medium">User ID (optional)</span>
            <input
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-mono text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
            />
          </label>
          <label className="text-sm">
            <span className="font-medium">Display name</span>
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
            />
          </label>
          <label className="text-sm">
            <span className="font-medium">Issuer</span>
            <input
              value={issuer}
              onChange={(event) => setIssuer(event.target.value)}
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-mono text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
            />
          </label>
          <label className="text-sm">
            <span className="font-medium">Subject</span>
            <input
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-mono text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
            />
          </label>
        </div>
        <fieldset>
          <legend className="text-sm font-medium">Roles</legend>
          <div className="mt-2 flex flex-wrap gap-3">
            {(roles.length ? roles : [{ key: "admin" }, { key: "viewer" }]).map(
              (role) => (
                <label key={role.key} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={roleKeys.includes(role.key)}
                    onChange={() => toggleRole(role.key)}
                  />
                  <span>{role.key}</span>
                </label>
              ),
            )}
          </div>
        </fieldset>
        <button
          type="submit"
          disabled={pending || roleKeys.length === 0}
          className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
        >
          Save member roles
        </button>
      </form>
    </section>
  );
}
