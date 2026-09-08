import { CredentialVault } from "@/components/credentials/CredentialVault";

export const dynamic = "force-dynamic";

export default function CredentialsPage() {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-8 px-6 py-12">
      <header className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
          E4.1 · Chloe UI
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Credential vault
        </h1>
        <p className="max-w-3xl text-base leading-7 text-zinc-600">
          Workspace-scoped encrypted credentials. List and search by display
          name or tags only. The UI never persists or renders plaintext —
          create and rotate send secret fields once, then clear them. Jonny
          owns vault APIs and encryption; this operator is ready to retarget
          when that route map lands. Cookie session + CSRF and tenant/workbench
          identity match E2.3 / E2.1.
        </p>
      </header>
      <CredentialVault />
    </main>
  );
}
