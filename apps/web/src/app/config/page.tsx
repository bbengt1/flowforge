import { ConfigHub } from "@/components/config/ConfigHub";
import { CONFIG_PAGE_HELP } from "@/lib/config-plain-copy";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<{ group?: string }>;
};

export default async function ConfigPage({ searchParams }: PageProps) {
  const { group } = await searchParams;
  return (
    <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-8 px-6 py-12">
      <header className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">
          Operational config
        </h1>
        <p className="max-w-3xl text-base leading-7 text-fg">
          {CONFIG_PAGE_HELP}
        </p>
      </header>
      <ConfigHub group={group} />
    </main>
  );
}
