import { ConfigHub } from "@/components/config/ConfigHub";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<{ group?: string }>;
};

export default async function ConfigPage({ searchParams }: PageProps) {
  const { group } = await searchParams;
  return (
    <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-8 px-6 py-12">
      <header className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
          E4.2 · Chloe UI
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Operational config
        </h1>
        <p className="max-w-3xl text-base leading-7 text-zinc-600">
          Workspace-scoped targets, profiles, connections, templates, schemas,
          and policies. Drafts are editable; publish creates an immutable
          revision that workflows pin by display name + version. Credentials
          stay in the E4.1 vault. The typed client is a #36 contract adapter
          until jonny&apos;s route map lands on main.
        </p>
      </header>
      <ConfigHub group={group} />
    </main>
  );
}
