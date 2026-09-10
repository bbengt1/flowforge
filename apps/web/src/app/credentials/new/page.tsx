import { CredentialWizard } from "@/components/credentials/CredentialWizard";
import { parseInspectorCredentialReturnTo } from "@/lib/editor-credential";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function NewCredentialPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const returnContext = parseInspectorCredentialReturnTo(query);
  return (
    <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-8 px-6 py-12">
      <header className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
          E6.3 · Vault
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          New vault credential
        </h1>
        <p className="max-w-3xl text-base leading-7 text-zinc-600">
          Catalog-driven wizard: display name, type, masked secret fields,
          safe metadata, and optional expiresAt. After create the secret
          inputs are emptied and only metadata is kept.
          {returnContext
            ? " You will return to the workflow editor; the new display name is selected onto the node and YAML stores the UUID only."
            : ""}
        </p>
      </header>
      <CredentialWizard returnContext={returnContext} />
    </main>
  );
}
