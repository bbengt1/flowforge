import { CredentialWizard } from "@/components/credentials/CredentialWizard";

export const dynamic = "force-dynamic";

export default function NewCredentialPage() {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-8 px-6 py-12">
      <header className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
          E4.1 · Add credential
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          New vault credential
        </h1>
        <p className="max-w-3xl text-base leading-7 text-zinc-600">
          Display name, type, masked secret fields, target metadata, ownership,
          allowed use, and optional test. After a successful create the secret
          inputs are emptied and only metadata is kept.
        </p>
      </header>
      <CredentialWizard />
    </main>
  );
}
