import { CredentialDetail } from "@/components/credentials/CredentialDetail";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function CredentialDetailPage({ params }: PageProps) {
  const { id } = await params;
  return (
    <main className="mx-auto flex min-h-full w-full max-w-6xl flex-col gap-8 px-6 py-12">
      <header className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
          R5.2 · Credential operate
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Credential detail
        </h1>
        <p className="max-w-3xl text-base leading-7 text-zinc-600">
          Test, rotate, usage, and deletion-impact at operate density on
          existing vault routes. Disable and enable stay clear. After rotate,
          display-name + UUID only. Unexpected plaintext is a contract bug
          (strip + stop). The UI never reads{" "}
          <code className="font-mono text-sm">CREDENTIAL_KEK</code>.
        </p>
      </header>
      <CredentialDetail credentialId={id} />
    </main>
  );
}
