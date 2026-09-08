import Link from "next/link";
import {
  credentialHealthLabel,
  credentialPolicyLabel,
  credentialTypeLabel,
} from "@/lib/credential";
import type { CredentialRecord } from "@/lib/credential-types";

type CredentialCardProps = {
  credential: CredentialRecord;
};

export function CredentialCard({ credential }: CredentialCardProps) {
  return (
    <article className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">
            <Link
              href={`/credentials/${credential.id}`}
              className="underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-600"
            >
              {credential.displayName}
            </Link>
          </h3>
          <p className="mt-1 text-sm text-zinc-600">
            {credentialTypeLabel(credential.type)}
          </p>
        </div>
        <p className="font-mono text-xs text-zinc-500">{credential.status}</p>
      </div>

      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-zinc-500">Health</dt>
          <dd className="font-medium">
            <span aria-hidden="true" className="mr-1">
              {healthMark(credential.health)}
            </span>
            {credentialHealthLabel(credential.health)}
          </dd>
        </div>
        <div>
          <dt className="text-zinc-500">Policy</dt>
          <dd className="font-medium">
            <span aria-hidden="true" className="mr-1">
              {policyMark(credential.policyState)}
            </span>
            {credentialPolicyLabel(credential.policyState)}
          </dd>
        </div>
        <div>
          <dt className="text-zinc-500">Last test</dt>
          <dd className="font-mono text-xs">
            {credential.lastTestStatus ?? "untested"}
            {credential.lastTestedAt ? ` · ${credential.lastTestedAt}` : ""}
          </dd>
        </div>
        <div>
          <dt className="text-zinc-500">Last rotation</dt>
          <dd className="font-mono text-xs">{credential.rotatedAt ?? "—"}</dd>
        </div>
      </dl>

      {credential.tags.length ? (
        <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Tags">
          {credential.tags.map((tag) => (
            <li
              key={tag}
              className="rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-xs text-zinc-700"
            >
              {tag}
            </li>
          ))}
        </ul>
      ) : null}

      <p className="mt-3 text-xs text-zinc-500">
        Secret material is not shown. Cards list health and policy only.
      </p>
    </article>
  );
}

function healthMark(health: CredentialRecord["health"]): string {
  switch (health) {
    case "healthy":
      return "●";
    case "degraded":
      return "◐";
    case "failed":
      return "✕";
    default:
      return "○";
  }
}

function policyMark(state: CredentialRecord["policyState"]): string {
  return state === "allowed" ? "✓" : "!";
}
