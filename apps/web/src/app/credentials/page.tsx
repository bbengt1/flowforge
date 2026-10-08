import { Suspense } from "react";
import { CredentialVault } from "@/components/credentials/CredentialVault";
import {
  PAGE_HEADER_CLASS,
  PAGE_SHELL_CLASS,
  TYPE_HEADING_CLASS,
} from "@/lib/aesthetic-usability-density";
import { CREDENTIAL_VAULT_PAGE_HELP } from "@/lib/credential-vault";
import {
  FF_VAULT_HELP_CLASS,
  FF_VAULT_MUTED_CLASS,
} from "@/lib/vault-executions-visual";

export const dynamic = "force-dynamic";

export default function CredentialsPage() {
  return (
    <main className={PAGE_SHELL_CLASS}>
      <header className={PAGE_HEADER_CLASS}>
        <h1 className={TYPE_HEADING_CLASS}>
          Credential vault
        </h1>
        <p className={FF_VAULT_HELP_CLASS}>{CREDENTIAL_VAULT_PAGE_HELP}</p>
      </header>
      <Suspense
        fallback={<p className={`text-sm ${FF_VAULT_MUTED_CLASS}`}>Loading credential vault…</p>}
      >
        <CredentialVault />
      </Suspense>
    </main>
  );
}
