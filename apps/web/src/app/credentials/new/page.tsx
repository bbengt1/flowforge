import { CredentialWizard } from "@/components/credentials/CredentialWizard";
import {
  PAGE_HEADER_CLASS,
  PAGE_SHELL_CLASS,
  TYPE_EYEBROW_CLASS,
  TYPE_HEADING_CLASS,
  TYPE_PAGE_HELP_CLASS,
} from "@/lib/aesthetic-usability-density";
import { parseInspectorCredentialReturnTo } from "@/lib/editor-credential";
import { CREDENTIAL_NDV_ADD_WIZARD_HELP } from "@/lib/credential-ndv-add";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function NewCredentialPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const returnContext = parseInspectorCredentialReturnTo(query);
  return (
    <main className={PAGE_SHELL_CLASS}>
      <header className={PAGE_HEADER_CLASS}>
        <p className={TYPE_EYEBROW_CLASS}>
          E6.3 · Vault
        </p>
        <h1 className={TYPE_HEADING_CLASS}>
          New vault credential
        </h1>
        <p className={TYPE_PAGE_HELP_CLASS}>
          Catalog-driven wizard: display name, type, masked secret fields,
          safe metadata, and optional expiresAt. After create the secret
          inputs are emptied and only metadata is kept.
          {returnContext
            ? ` ${CREDENTIAL_NDV_ADD_WIZARD_HELP}`
            : ""}
        </p>
      </header>
      <CredentialWizard returnContext={returnContext} />
    </main>
  );
}
