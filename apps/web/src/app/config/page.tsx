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
          and policies against the #41 map on main. Drafts save with body{" "}
          <code className="font-mono text-xs">revision</code>; publish creates
          an immutable pin. Select is POST. Credentials stay in the E4.1 vault.
        </p>
      </header>
      <ConfigHub group={group} />
    </main>
  );
}
