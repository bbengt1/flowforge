import { MembershipOperator } from "@/components/membership/MembershipOperator";
import { MEMBERSHIP_ADMIN_HELP } from "@/lib/membership-isolation-chrome";

export const dynamic = "force-dynamic";

export default function MembershipPage() {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-8 px-6 py-12">
      <header className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-zinc-500 uppercase">
          Grant-gated admin
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Workspace members
        </h1>
        <p className="max-w-3xl text-base leading-7 text-zinc-600">
          {MEMBERSHIP_ADMIN_HELP} Cookie session is preferred; trusted-dev
          header identity is a labeled local-dev fallback — never rewrite
          login. ADV-024 still requires{" "}
          <code className="font-mono text-sm">workspace.administer</code>{" "}
          or <code className="font-mono text-sm">platform.administer</code>.
        </p>
      </header>
      <MembershipOperator />
    </main>
  );
}
