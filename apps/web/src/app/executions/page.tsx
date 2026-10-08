import { Suspense } from "react";
import { ExecutionHistory } from "@/components/executions/ExecutionHistory";
import {
  PAGE_HEADER_CLASS,
  PAGE_SHELL_CLASS,
  TYPE_HEADING_CLASS,
} from "@/lib/aesthetic-usability-density";
import { EXECUTIONS_PAGE_HELP } from "@/lib/execution-inbox";
import {
  FF_INBOX_HELP_CLASS,
  FF_INBOX_MUTED_CLASS,
} from "@/lib/vault-executions-visual";

export const dynamic = "force-dynamic";

export default function ExecutionsPage() {
  return (
    <main className={PAGE_SHELL_CLASS}>
      <header className={PAGE_HEADER_CLASS}>
        <h1 className={TYPE_HEADING_CLASS}>Executions</h1>
        <p className={FF_INBOX_HELP_CLASS}>{EXECUTIONS_PAGE_HELP}</p>
      </header>
      <Suspense
        fallback={<p className={`text-sm ${FF_INBOX_MUTED_CLASS}`}>Loading runs…</p>}
      >
        <ExecutionHistory />
      </Suspense>
    </main>
  );
}
