import Link from "next/link";
import { credentialStatusLabel, credentialTypeLabel } from "@/lib/credential";
import type { CredentialCatalog, CredentialRecord } from "@/lib/credential-types";

type CredentialCardProps = {
  credential: CredentialRecord;
  catalog?: CredentialCatalog;
};

export function CredentialCard({ credential, catalog }: CredentialCardProps) {
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
            {credentialTypeLabel(credential.type, catalog)}
          </p>
        </div>
        <p className="font-mono text-xs text-zinc-500">
          {credentialStatusLabel(credential.status)}
        </p>
      </div>

      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-zinc-500">Last test</dt>
          <dd className="font-mono text-xs">
            {credential.lastTestStatus}
            {credential.lastTestedAt ? ` · ${credential.lastTestedAt}` : ""}
          </dd>
        </div>
        <div>
          <dt className="text-zinc-500">Last rotation</dt>
          <dd className="font-mono text-xs">{credential.rotatedAt ?? "—"}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-zinc-500">Fingerprint</dt>
          <dd className="break-all font-mono text-xs">
            {credential.fingerprint || "—"}
          </dd>
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
        Secret material is not shown. Cards list metadata only.
      </p>
    </article>
  );
}
