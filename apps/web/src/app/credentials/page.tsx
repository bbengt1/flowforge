import { Suspense } from "react";
import { CredentialVault } from "@/components/credentials/CredentialVault";

export const dynamic = "force-dynamic";

export default function CredentialsPage() {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-6xl flex-col gap-8 px-6 py-12">
      <header className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
          R5.1 · Vault find
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Credential vault
        </h1>
        <p className="max-w-3xl text-base leading-7 text-zinc-600">
          Find credentials by display name. Filter by
          type, tag, or status, then open a row into existing{" "}
          <code className="font-mono text-sm">/credentials/{"{id}"}</code>{" "}
          detail — no hunting. List is metadata only.{" "}
          <code className="font-mono text-sm">GET /credentials</code> has no
          query params; search stays in the browser. Unexpected plaintext is a
          contract bug (strip + stop). The UI never reads{" "}
          <code className="font-mono text-sm">CREDENTIAL_KEK</code>.
        </p>
      </header>
      <Suspense
        fallback={<p className="text-sm text-zinc-600">Loading credential vault…</p>}
      >
        <CredentialVault />
      </Suspense>
    </main>
  );
}
