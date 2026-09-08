import { MembershipOperator } from "@/components/membership/MembershipOperator";

export const dynamic = "force-dynamic";

export default function MembershipPage() {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-8 px-6 py-12">
      <header className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
          E2.1 / E2.3 · Chloe UI
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Membership and roles
        </h1>
        <p className="max-w-3xl text-base leading-7 text-zinc-600">
          Minimal operator surface for jonny&apos;s workspace identity API. It
          exercises cookie session bootstrap, tenant/workspace membership,
          roles, and the permission matrix, plus the E2.2 negative isolation
          exercises. This is not the product shell (E6). Cookie session is
          preferred; header identity is a temporary local-dev fallback.
        </p>
      </header>
      <MembershipOperator />
    </main>
  );
}
