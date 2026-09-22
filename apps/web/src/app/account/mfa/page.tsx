import { MfaAccountPanel } from "@/components/session/MfaAccountPanel";

export const dynamic = "force-dynamic";

export default function AccountMfaPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col px-6 py-12">
      <MfaAccountPanel />
    </div>
  );
}
