import { Suspense } from "react";
import { WorkflowHome } from "@/components/home/WorkflowHome";
import {
  PAGE_HEADER_CLASS,
  PAGE_SHELL_CLASS,
  TYPE_EYEBROW_CLASS,
  TYPE_HEADING_CLASS,
  TYPE_PAGE_HELP_CLASS,
} from "@/lib/aesthetic-usability-density";
import { WORKFLOWS_HOME_PAGE_HELP } from "@/lib/explorer-home-copy";

export const dynamic = "force-dynamic";

export default function WorkflowsPage() {
  return (
    <main className={PAGE_SHELL_CLASS}>
      <header className={PAGE_HEADER_CLASS}>
        <p className={TYPE_EYEBROW_CLASS}>
          E6.1 · E10.1 · E10.2 · E10.3 · Chloe UI
        </p>
        <h1 className={TYPE_HEADING_CLASS}>Workflows</h1>
        <p className={TYPE_PAGE_HELP_CLASS}>{WORKFLOWS_HOME_PAGE_HELP}</p>
      </header>
      <Suspense
        fallback={<p className="text-sm" style={{ color: "var(--ff-muted)" }}>Loading workflow home…</p>}
      >
        <WorkflowHome />
      </Suspense>
    </main>
  );
}
