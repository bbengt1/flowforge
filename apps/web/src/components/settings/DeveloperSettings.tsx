import Link from "next/link";
import {
  SETTINGS_DEVELOPER_HREF,
  WORKFLOWS_IMPORT_HREF,
} from "@/lib/editor-developer";
import { INVALID_WORKFLOW_YAML, STARTER_WORKFLOW_YAML } from "@/lib/workflow";

export function DeveloperSettings() {
  return (
    <section
      id="developer"
      aria-labelledby="settings-developer-heading"
      className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm"
    >
      <h2 id="settings-developer-heading" className="text-base font-semibold">
        Developer
      </h2>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-600">
        Starter and invalid YAML fixtures are not primary editor buttons. Load
        them from the YAML drawer’s <strong>Developer samples</strong>{" "}
        disclosure, or review the same documents here. Normalize lives in YAML
        mode and Commands — not next to Save draft. Import stays on{" "}
        <Link href={WORKFLOWS_IMPORT_HREF} className="text-teal-800 underline">
          Workflows home
        </Link>{" "}
        and still validates before create.
      </p>
      <p className="mt-2 text-xs text-zinc-500">
        Local seed Example workflows still open and save through the normal
        draft loop.
      </p>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <details className="rounded-xl border border-zinc-200 bg-zinc-50 p-3">
          <summary className="cursor-pointer text-sm font-medium text-zinc-800">
            Starter YAML
          </summary>
          <pre className="mt-2 overflow-auto text-xs text-zinc-700">
            {STARTER_WORKFLOW_YAML}
          </pre>
        </details>
        <details className="rounded-xl border border-zinc-200 bg-zinc-50 p-3">
          <summary className="cursor-pointer text-sm font-medium text-zinc-800">
            Invalid YAML
          </summary>
          <pre className="mt-2 overflow-auto text-xs text-zinc-700">
            {INVALID_WORKFLOW_YAML}
          </pre>
        </details>
      </div>
      <p className="mt-3 text-xs text-zinc-500">
        Permalink:{" "}
        <Link href={SETTINGS_DEVELOPER_HREF} className="font-mono underline">
          {SETTINGS_DEVELOPER_HREF}
        </Link>
      </p>
    </section>
  );
}
