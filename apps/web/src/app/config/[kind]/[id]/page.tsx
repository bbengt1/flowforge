import { notFound } from "next/navigation";
import { ConfigDraftEditor } from "@/components/config/ConfigDraftEditor";
import { kindFromCollection } from "@/lib/ops-config-contract";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ kind: string; id: string }>;
};

export default async function ConfigDraftPage({ params }: PageProps) {
  const { kind: collection, id } = await params;
  const kind = kindFromCollection(collection);
  if (!kind) {
    notFound();
  }

  return (
    <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-8 px-6 py-12">
      <header className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
          E4.2 · Draft
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Edit draft
        </h1>
        <p className="max-w-3xl text-base leading-7 text-zinc-600">
          Save the mutable draft, publish an immutable revision, then compare
          or restore-as-new-draft. Published snapshots stay read-only.
        </p>
      </header>
      <ConfigDraftEditor kind={kind} resourceId={id} />
    </main>
  );
}
