import Link from "next/link";
import { getPublicSwaggerUrl } from "@/lib/config";

export function SiteHeader() {
  const swaggerUrl = getPublicSwaggerUrl();

  return (
    <header className="border-b border-zinc-200 bg-white/80">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-6 py-3">
        <Link href="/" className="text-sm font-semibold tracking-tight">
          FlowForge
        </Link>
        <nav aria-label="Operator" className="flex items-center gap-4">
          <Link
            href="/membership"
            className="text-sm text-zinc-600 underline decoration-zinc-300 underline-offset-2 hover:text-zinc-900 hover:decoration-zinc-600"
          >
            Membership
          </Link>
          <Link
            href="/isolation"
            className="text-sm text-zinc-600 underline decoration-zinc-300 underline-offset-2 hover:text-zinc-900 hover:decoration-zinc-600"
          >
            Isolation
          </Link>
          <a
            className="text-sm text-zinc-600 underline decoration-zinc-300 underline-offset-2 hover:text-zinc-900 hover:decoration-zinc-600"
            href={swaggerUrl}
          >
            OpenAPI / Swagger
          </a>
        </nav>
      </div>
    </header>
  );
}
