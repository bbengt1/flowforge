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
          Product home for drafts and published versions. The default
          chrome is a Windows Explorer shell (X.1 / #380 —{" "}
          <strong>keep #380 open</strong>; Part of #379 —{" "}
          <strong>keep #379 open</strong>): left folder tree with
          disclosure and folder icons (Unfiled is virtual), right
          content pane for the selected folder only, and a breadcrumb
          from ancestry. Overview cards are demoted from the primary
          layout; dense content-pane rows are the default. Right-click
          a folder, workflow, or empty pane for grant-gated Explorer
          menus (X.2 / #381 — <strong>keep #381 open</strong>; Part of
          #379 — <strong>keep #379 open</strong>) wired to the existing
          create / rename / delete / Move… / import verbs. Dense rows
          use single-click select and double-click / Enter open
          (X.3 / #382 — <strong>keep #382 open</strong>; Part of #379
          — <strong>keep #379 open</strong>): a workflow opens the
          editor; a folder child expands and selects that folder in
          the tree and content pane. Right-click selects the target
          so X.2 menus stay. Viewers get
          Open / select only. Unfiled cannot be renamed or deleted.
          Folder delete stays disabled when the folder is not empty.
          Empty folder and empty Unfiled teaching states sit on
          Explorer chrome (X.4 / #383 —{" "}
          <strong>keep #383 open</strong>; Part of #379 —{" "}
          <strong>keep #379 open</strong>): a real folder teaches
          create here / move (delete only when empty); Unfiled stays
          virtual and never looks deletable or renamable. Drafts do
          not run stays loud on empty/home create surfaces. Empty
          pane still right-clicks to New folder / Create / Import.
          The left rail
          lists Unfiled and this workspace&apos;s folders; the main list
          is the selected folder. Unfiled is always in the rail and is
          not a persisted folder.           Empty home
          teaches Create, Import YAML, or a reviewed template — each
          creates a draft — plus optional New folder. Empty folder
          offers create here, move, or delete when the folder has no
          workflows and no child folders. Unfiled-empty points at the
          tree or those empty-home verbs. Those empty states carry
          F.5 / O.3 teaching onto Explorer tree + pane chrome; Overview
          card chrome (O.3 / #327 —{" "}
          <strong>keep #327 open</strong>) remains the teaching
          contract, not dense-list empty chrome.
          Drafts do not run.           Dark Overview card rows use V.1 tokens (V.3 / #359 —{" "}
          <strong>keep #359 open</strong>). The Overview
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
          The same Overview cards + compact Finder rail mount on{" "}
          <code className="font-mono text-sm">/embed/v1/workflows</code>{" "}
          after <code className="font-mono text-sm">session.embed</code>{" "}
          (O.4 / #328 — <strong>keep #328 open</strong>). The same
          Explorer chrome — tree + content pane + breadcrumb, grant-gated
          right-click menus, dense select/open, and empty / Unfiled
          teaching — mounts on that embed surface after{" "}
          <code className="font-mono text-sm">session.embed</code>{" "}
          (X.5 / #384 — <strong>keep #384 open</strong>; Part of #379 —{" "}
          <strong>keep #379 open</strong>). Missing{" "}
          <code className="font-mono text-sm">session.embed</code> is an
          ADV-021 alert. Host query is display-only. Viewers are
          select/open only. Wizard, Login, and Change-password never
          mount on embed. The tree comes from the API, not{" "}
          <code className="font-mono text-sm">localStorage</code>. No
          second tree.
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
        fallback={<p className="text-sm" style={{ color: "var(--ff-muted)" }}>Loading workflow home…</p>}
      >
        <WorkflowHome />
      </Suspense>
    </main>
  );
}
