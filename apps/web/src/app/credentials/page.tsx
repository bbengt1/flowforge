import { CredentialVault } from "@/components/credentials/CredentialVault";

export const dynamic = "force-dynamic";

export default function CredentialsPage() {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-8 px-6 py-12">
      <header className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
          E6.3 · Vault
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Credential vault
        </h1>
        <p className="max-w-3xl text-base leading-7 text-zinc-600">
          Workspace-scoped encrypted credentials against jonny&apos;s #38
          contract. List is metadata only; filter by display name or tags in
          the browser. Create and rotate send <code>secret</code> once, then
          clear it. The UI never reads <code>CREDENTIAL_KEK</code>. Cookie
          session + CSRF and tenant/workbench identity match E2.3 / E2.1.
        </p>
      </header>
      <CredentialVault />
    </main>
  );
}
