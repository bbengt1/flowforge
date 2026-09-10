"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useWorkspace } from "@/components/shell/WorkspaceProvider";
import {
  PRODUCT_HOME_HREF,
  SETTINGS_HREF,
  shouldLandOnWorkflowsHome,
} from "@/lib/product-home";
import { canSeeWorkflowsNav } from "@/lib/workspace-nav";

export function ProductHomeLanding() {
  const router = useRouter();
  const { ready, permissions } = useWorkspace();
  const landOnWorkflows = ready && shouldLandOnWorkflowsHome(permissions);
  const denied =
    ready && permissions != null && !canSeeWorkflowsNav(permissions);

  useEffect(() => {
    if (landOnWorkflows) {
      router.replace(PRODUCT_HOME_HREF);
    }
  }, [landOnWorkflows, router]);

  return (
    <main className="mx-auto flex min-h-full w-full max-w-2xl flex-col gap-6 px-6 py-16">
      <header className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
          UX.8 · Product home
        </p>
        <h1 className="text-4xl font-semibold tracking-tight">FlowForge</h1>
        <p className="max-w-xl text-base leading-7 text-zinc-600">
          {denied
            ? "Workflows are hidden for this workspace role. Health and OpenAPI live under Settings."
            : "Opening the workflow list. Health and OpenAPI live under Settings."}
        </p>
      </header>
      <p className="flex flex-wrap gap-4">
        {denied ? null : (
          <Link
            href={PRODUCT_HOME_HREF}
            className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-900"
          >
            {landOnWorkflows ? "Opening workflows…" : "Open workflows"}
          </Link>
        )}
        <Link
          href={SETTINGS_HREF}
          className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50"
        >
          Settings
        </Link>
      </p>
    </main>
  );
}
