import { IsolationExercise } from "@/components/isolation/IsolationExercise";
import { IsolationIdentityPanel } from "@/components/isolation/IsolationIdentityPanel";
import { ISOLATION_CHECK_HELP } from "@/lib/membership-isolation-chrome";

export const dynamic = "force-dynamic";

export default function IsolationPage() {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-8 px-6 py-12">
      <header className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-zinc-500 uppercase">
          Grant-gated check
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Isolation check
        </h1>
        <p className="max-w-3xl text-base leading-7 text-zinc-600">
          {ISOLATION_CHECK_HELP} Prefer the cookie session; workspace
          lookup stays tenant + workbench key — never a host-supplied
          workspace UUID. ADV-024 still requires{" "}
          <code className="font-mono text-sm">workspace.administer</code> or{" "}
          <code className="font-mono text-sm">platform.administer</code>.
        </p>
      </header>
      <IsolationIdentityPanel />
      <IsolationExercise />
    </main>
  );
}
