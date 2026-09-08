import { IsolationExercise } from "@/components/isolation/IsolationExercise";
import { IsolationIdentityPanel } from "@/components/isolation/IsolationIdentityPanel";

export const dynamic = "force-dynamic";

export default function IsolationPage() {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-8 px-6 py-12">
      <header className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
          E2.2 · Chloe UI
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Workspace isolation
        </h1>
        <p className="max-w-3xl text-base leading-7 text-zinc-600">
          Negative operator surface for jonny&apos;s isolation hook API.
          Cross-workspace credential, artifact, cache, realtime, and record
          access must fail closed with visible problem details. This is not
          the product shell (E6). Workspace lookup stays tenant + workbench
          key — never a host-supplied workspace UUID.
        </p>
      </header>
      <IsolationIdentityPanel />
      <IsolationExercise />
    </main>
  );
}
