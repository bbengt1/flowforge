import { notFound } from "next/navigation";
import { ConfigDraftEditor } from "@/components/config/ConfigDraftEditor";
import { CONFIG_NEW_PAGE_HELP } from "@/lib/config-plain-copy";
import { kindFromCollection } from "@/lib/ops-config-contract";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ kind: string }>;
};

export default async function ConfigCreatePage({ params }: PageProps) {
  const { kind: collection } = await params;
  const kind = kindFromCollection(collection);
  if (!kind) {
    notFound();
  }

  return (
    <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-8 px-6 py-12">
      <header className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">
          Create {kind.replaceAll("_", " ")}
        </h1>
        <p className="max-w-3xl text-base leading-7 text-fg">
          {CONFIG_NEW_PAGE_HELP}
        </p>
      </header>
      <ConfigDraftEditor kind={kind} />
    </main>
  );
}
