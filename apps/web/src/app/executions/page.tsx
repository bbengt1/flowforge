import { Suspense } from "react";
import { ExecutionHistory } from "@/components/executions/ExecutionHistory";
import {
  PAGE_HEADER_CLASS,
  PAGE_SHELL_CLASS,
  TYPE_HEADING_CLASS,
} from "@/lib/aesthetic-usability-density";
import {
  FF_INBOX_EYEBROW_CLASS,
  FF_INBOX_HELP_CLASS,
  FF_INBOX_MUTED_CLASS,
} from "@/lib/vault-executions-visual";

export const dynamic = "force-dynamic";

export default function ExecutionsPage() {
  return (
    <main className={PAGE_SHELL_CLASS}>
      <header className={PAGE_HEADER_CLASS}>
        <p className={FF_INBOX_EYEBROW_CLASS}>
          R4.1 · Workspace inbox
        </p>
        <h1 className={TYPE_HEADING_CLASS}>Executions</h1>
        <p className={FF_INBOX_HELP_CLASS}>
          Operate workspace runs. Filter by status or workflow, then open a
          row into existing{" "}
          <code className="font-mono text-sm">/executions/{"{id}"}</code>{" "}
          detail — no hunting and no second graph on this inbox. Uses
          existing <code className="font-mono text-sm">GET /executions</code>{" "}
          <code className="font-mono text-sm">status</code>,{" "}
          <code className="font-mono text-sm">workflowId</code>, and{" "}
          <code className="font-mono text-sm">limit</code> only. Drafts never
          run (published <code className="font-mono text-sm">workflowVersionId</code>{" "}
          only). Secrets stay{" "}
          <code className="font-mono text-sm">[redacted]</code>.{" "}
          <code className="font-mono text-sm">indeterminate</code> stays loud
          (icon + text + explanation — never silent success). Cancel, retry,
          and emergency stop sit on the inbox row using the existing E5/E8/E9
          routes. Retry is shown only when{" "}
          <code className="font-mono text-sm">result.retry.allowed</code> is
          true. Artifacts stay on the detail page.
        </p>
      </header>
      <Suspense
        fallback={<p className={`text-sm ${FF_INBOX_MUTED_CLASS}`}>Loading executions inbox…</p>}
      >
        <ExecutionHistory />
      </Suspense>
    </main>
  );
}
