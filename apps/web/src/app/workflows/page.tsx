import { Suspense } from "react";
import { WorkflowHome } from "@/components/home/WorkflowHome";
import {
  PAGE_HEADER_CLASS,
  PAGE_SHELL_CLASS,
  TYPE_EYEBROW_CLASS,
  TYPE_HEADING_CLASS,
  TYPE_PAGE_HELP_CLASS,
} from "@/lib/aesthetic-usability-density";

export const dynamic = "force-dynamic";

export default function WorkflowsPage() {
  return (
    <main className={PAGE_SHELL_CLASS}>
      <header className={PAGE_HEADER_CLASS}>
        <p className={TYPE_EYEBROW_CLASS}>
          E6.1 · E10.1 · E10.2 · E10.3 · Chloe UI
        </p>
        <h1 className={TYPE_HEADING_CLASS}>Workflows</h1>
        <p className={TYPE_PAGE_HELP_CLASS}>
          Product home for drafts and published versions. The left rail
          lists Unfiled and this workspace&apos;s folders; the main list
          is the selected folder. Unfiled is always in the rail and is
          not a persisted folder. Empty home
          teaches Create, Import YAML, or a reviewed template — each
          creates a draft — plus optional New folder. Empty folder
          offers create here, move, or delete when the folder has no
          workflows and no child folders. Unfiled-empty points at the
          tree or those empty-home verbs. Drafts do not run. The Overview
          card list is the primary browse surface (O.1 / #325 —{" "}
          <strong>keep #325 open</strong>): name, last updated/created,
          published badge, and kebab. Cards show folder path pills
          joined from{" "}
          <code className="font-mono text-sm">GET /workflow-folders</code>{" "}
          ancestry (O.2 / #326 — <strong>keep #326 open</strong>).
          Unfiled has no path pills and is not a persisted folder.
          The compact Finder rail uses disclosure and folder icons
          and stays a non-recursive{" "}
          <code className="font-mono text-sm">?folderId=</code> filter —
          not Miller columns, not primary browse.
          Scan ends remain activation (published version active for webhook
          or schedule) and last run (waiting or indeterminate when those
          joins already exist). Create and import use{" "}
          <code className="font-mono text-sm">POST /workflows</code>. The
          canvas + YAML editor is a standalone surface at{" "}
          <code className="font-mono text-sm">/workflows/{"{id}"}</code>
          — not a second list. Activation opens{" "}
          <code className="font-mono text-sm">/workflows/{"{id}"}#activation</code>.
          Published workflows can start from home with typed input and an
          idempotency key. Webhook and schedule triggers are still
          configured from home when the role can see them. Last run
          opens <code className="font-mono text-sm">/executions/{"{id}"}</code>{" "}
          or the workspace history filtered by{" "}
          <code className="font-mono text-sm">workflowId</code>.
        </p>
      </header>
      <Suspense
        fallback={<p className="text-sm text-zinc-600">Loading workflow home…</p>}
      >
        <WorkflowHome />
      </Suspense>
    </main>
  );
}
