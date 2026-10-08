import { ScimTokensPage } from "@/components/scim-tokens/ScimTokensPage";

export const dynamic = "force-dynamic";

export default function ScimTokensRoute() {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-8 px-6 py-12">
      <ScimTokensPage />
    </main>
  );
}
