import { Suspense } from "react";
import { CredentialVault } from "@/components/credentials/CredentialVault";
import {
  PAGE_HEADER_CLASS,
  PAGE_SHELL_CLASS,
  TYPE_HEADING_CLASS,
} from "@/lib/aesthetic-usability-density";
import {
  FF_VAULT_EYEBROW_CLASS,
  FF_VAULT_HELP_CLASS,
  FF_VAULT_MUTED_CLASS,
} from "@/lib/vault-executions-visual";

export const dynamic = "force-dynamic";

export default function CredentialsPage() {
  return (
    <main className={PAGE_SHELL_CLASS}>
      <header className={PAGE_HEADER_CLASS}>
        <p className={FF_VAULT_EYEBROW_CLASS}>
          R5.1 · Vault find
        </p>
        <h1 className={TYPE_HEADING_CLASS}>
          Credential vault
        </h1>
        <p className={FF_VAULT_HELP_CLASS}>
          Find credentials by display name. Filter by
          type, tag, or status, then open a row into existing{" "}
          <code className="font-mono text-sm">/credentials/{"{id}"}</code>{" "}
          detail — no hunting. Empty vault adds via the masked wizard;
          selectors stay display name + UUID. No sample secrets. List is
          metadata only.{" "}
          <code className="font-mono text-sm">GET /credentials</code> has no
          query params; search stays in the browser. Unexpected plaintext is a
          contract bug (strip + stop).
        </p>
      </header>
      <Suspense
        fallback={<p className={`text-sm ${FF_VAULT_MUTED_CLASS}`}>Loading credential vault…</p>}
      >
        <CredentialVault />
      </Suspense>
    </main>
  );
}
