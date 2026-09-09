import Link from "next/link";

export const dynamic = "force-dynamic";

export default function ActionsPage() {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-6 px-6 py-12">
      <header className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
          E6.1 · Placeholder
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Actions</h1>
        <p className="text-base leading-7 text-zinc-600">
          The action library and add-action wizard land in E6.2. Until then,
          place core nodes from the workflow editor catalog. Search in the
          workspace shell already indexes core action types.
        </p>
      </header>
      <p>
        <Link
          href="/workflows"
          className="text-sm font-medium text-teal-800 underline"
        >
          Back to workflow home
        </Link>
      </p>
    </main>
  );
}
