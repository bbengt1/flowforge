import { notFound } from "next/navigation";
import { ConfigPublishedDetail } from "@/components/config/ConfigPublishedDetail";
import { CONFIG_VERSION_PAGE_HELP } from "@/lib/config-plain-copy";
import { kindFromCollection } from "@/lib/ops-config-contract";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ kind: string; id: string; versionId: string }>;
};

export default async function ConfigVersionPage({ params }: PageProps) {
  const { kind: collection, id, versionId } = await params;
  const kind = kindFromCollection(collection);
  if (!kind) {
    notFound();
  }

  return (
    <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-8 px-6 py-12">
      <header className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">
          Published version
        </h1>
        <p className="max-w-3xl text-base leading-7 text-fg">
          {CONFIG_VERSION_PAGE_HELP}
        </p>
      </header>
      <ConfigPublishedDetail
        kind={kind}
        resourceId={id}
        versionId={versionId}
      />
    </main>
  );
}
