import Link from "next/link";
import { OperatorNav } from "@/components/OperatorNav";

export function SiteHeader() {
  return (
    <header className="border-b border-zinc-200 bg-white/80">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-6 py-3">
        <Link href="/workflows" className="text-sm font-semibold tracking-tight">
          FlowForge
        </Link>
        <OperatorNav />
      </div>
    </header>
  );
}
