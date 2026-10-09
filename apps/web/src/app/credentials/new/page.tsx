import { CredentialWizard } from "@/components/credentials/CredentialWizard";
import {
  PAGE_HEADER_CLASS,
  PAGE_SHELL_CLASS,
  TYPE_HEADING_CLASS,
} from "@/lib/aesthetic-usability-density";
import { FF_VAULT_HELP_CLASS } from "@/lib/vault-executions-visual";
import { parseInspectorCredentialReturnTo } from "@/lib/editor-credential";
import { CREDENTIAL_NDV_ADD_WIZARD_HELP } from "@/lib/credential-ndv-add";
import { CREDENTIAL_NEW_PAGE_HELP } from "@/lib/credential-vault";

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
        <h1 className={TYPE_HEADING_CLASS}>
          New vault credential
        </h1>
        <p className={FF_VAULT_HELP_CLASS}>
          {CREDENTIAL_NEW_PAGE_HELP}
          {returnContext
            ? ` ${CREDENTIAL_NDV_ADD_WIZARD_HELP}`
            : ""}
        </p>
      </header>
      <CredentialWizard returnContext={returnContext} />
    </main>
  );
}
