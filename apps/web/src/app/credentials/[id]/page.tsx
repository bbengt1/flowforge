import { CredentialDetail } from "@/components/credentials/CredentialDetail";
import {
  PAGE_HEADER_CLASS,
  PAGE_SHELL_CLASS,
  TYPE_HEADING_CLASS,
} from "@/lib/aesthetic-usability-density";
import {
  FF_VAULT_EYEBROW_CLASS,
  FF_VAULT_HELP_CLASS,
} from "@/lib/vault-executions-visual";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function CredentialDetailPage({ params }: PageProps) {
  const { id } = await params;
  return (
    <main className={PAGE_SHELL_CLASS}>
      <header className={PAGE_HEADER_CLASS}>
        <p className={FF_VAULT_EYEBROW_CLASS}>
          R5.2 · Credential operate
        </p>
        <h1 className={TYPE_HEADING_CLASS}>
          Credential detail
        </h1>
        <p className={FF_VAULT_HELP_CLASS}>
          Test, rotate, usage, and deletion-impact at operate density on
          existing vault routes. Disable and enable stay clear. After rotate,
          display-name + UUID only. Unexpected plaintext is a contract bug
          (strip + stop).
        </p>
      </header>
      <CredentialDetail credentialId={id} />
    </main>
  );
}
