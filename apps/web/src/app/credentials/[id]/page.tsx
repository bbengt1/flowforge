import { CredentialDetail } from "@/components/credentials/CredentialDetail";
import {
  PAGE_HEADER_CLASS,
  PAGE_SHELL_CLASS,
  TYPE_HEADING_CLASS,
} from "@/lib/aesthetic-usability-density";
import { CREDENTIAL_DETAIL_PAGE_HELP } from "@/lib/credential-detail";
import { FF_VAULT_HELP_CLASS } from "@/lib/vault-executions-visual";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function CredentialDetailPage({ params }: PageProps) {
  const { id } = await params;
  return (
    <main className={PAGE_SHELL_CLASS}>
      <header className={PAGE_HEADER_CLASS}>
        <h1 className={TYPE_HEADING_CLASS}>
          Credential detail
        </h1>
        <p className={FF_VAULT_HELP_CLASS}>{CREDENTIAL_DETAIL_PAGE_HELP}</p>
      </header>
      <CredentialDetail credentialId={id} />
    </main>
  );
}
