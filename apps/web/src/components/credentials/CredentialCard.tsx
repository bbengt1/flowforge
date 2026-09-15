import Link from "next/link";
import { credentialStatusLabel, credentialTypeLabel } from "@/lib/credential";
import type { CredentialCatalog, CredentialRecord } from "@/lib/credential-types";
import {
  FF_VAULT_LINK_CLASS,
  FF_VAULT_MUTED_CLASS,
  FF_VAULT_PANEL_CLASS,
  FF_VAULT_TITLE_CLASS,
  FF_VAULT_UUID_CLASS,
} from "@/lib/vault-executions-visual";

type CredentialCardProps = {
  credential: CredentialRecord;
  catalog?: CredentialCatalog;
};

export function CredentialCard({ credential, catalog }: CredentialCardProps) {
  return (
    <article className={FF_VAULT_PANEL_CLASS}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className={`text-base ${FF_VAULT_TITLE_CLASS}`}>
            <Link
              href={`/credentials/${credential.id}`}
              className={FF_VAULT_LINK_CLASS}
            >
              {credential.displayName}
            </Link>
          </h3>
          <p className={`mt-1 text-sm ${FF_VAULT_MUTED_CLASS}`}>
            {credentialTypeLabel(credential.type, catalog)}
          </p>
          <p className={`mt-1 ${FF_VAULT_UUID_CLASS}`}>{credential.id}</p>
        </div>
        <p className={`font-mono text-xs ${FF_VAULT_MUTED_CLASS}`}>
          {credentialStatusLabel(credential.status)}
        </p>
      </div>

      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className={FF_VAULT_MUTED_CLASS}>Last test</dt>
          <dd className="font-mono text-xs">
            {credential.lastTestStatus}
            {credential.lastTestedAt ? ` · ${credential.lastTestedAt}` : ""}
          </dd>
        </div>
        <div>
          <dt className={FF_VAULT_MUTED_CLASS}>Last rotation</dt>
          <dd className="font-mono text-xs">{credential.rotatedAt ?? "—"}</dd>
        </div>
      </dl>

      {credential.tags.length ? (
        <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Tags">
          {credential.tags.map((tag) => (
            <li
              key={tag}
              className={`rounded-full border border-[color:var(--ff-border)] px-2 py-0.5 text-xs ${FF_VAULT_MUTED_CLASS}`}
            >
              {tag}
            </li>
          ))}
        </ul>
      ) : null}

      <p className={`mt-3 text-xs ${FF_VAULT_MUTED_CLASS}`}>
        Secret material is not shown. Cards list display name + UUID only.
      </p>
    </article>
  );
}
