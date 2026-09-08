import { CredentialDetail } from "@/components/credentials/CredentialDetail";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function CredentialDetailPage({ params }: PageProps) {
  const { id } = await params;
  return (
    <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-8 px-6 py-12">
      <header className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
          E4.1 · Credential detail
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Credential metadata
        </h1>
        <p className="max-w-3xl text-base leading-7 text-zinc-600">
          Edit safe metadata, review usage, rotate or replace the secret,
          disable, test, and confirm deletion impact. Plaintext is never
          returned after create or rotate.
        </p>
      </header>
      <CredentialDetail credentialId={id} />
    </main>
  );
}
