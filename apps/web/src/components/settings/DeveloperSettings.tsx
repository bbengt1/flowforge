import Link from "next/link";
import {
  SETTINGS_DEVELOPER_HREF,
  WORKFLOWS_IMPORT_HREF,
} from "@/lib/editor-developer";
import { INVALID_WORKFLOW_YAML, STARTER_WORKFLOW_YAML } from "@/lib/workflow";
import {
  FF_SETTINGS_LINK_CLASS,
  FF_SETTINGS_MUTED_CLASS,
  FF_SETTINGS_NESTED_CLASS,
  FF_SETTINGS_PANEL_CLASS,
  FF_SETTINGS_TITLE_CLASS,
} from "@/lib/settings-wizard-visual";

export function DeveloperSettings() {
  return (
    <section
      id="developer"
      aria-labelledby="settings-developer-heading"
      className={FF_SETTINGS_PANEL_CLASS}
    >
      <h2 id="settings-developer-heading" className={`text-base ${FF_SETTINGS_TITLE_CLASS}`}>
        Developer
      </h2>
      <p className={`mt-2 max-w-3xl text-sm leading-6 ${FF_SETTINGS_MUTED_CLASS}`}>
        Starter and invalid YAML fixtures are not primary editor buttons. Load
        them from the YAML drawer’s <strong>Developer samples</strong>{" "}
        disclosure, or review the same documents here. Normalize lives in YAML
        mode and Commands — not next to Save draft. Import stays on{" "}
        <Link href={WORKFLOWS_IMPORT_HREF} className={FF_SETTINGS_LINK_CLASS}>
          Workflows home
        </Link>{" "}
        and still validates before create.
      </p>
      <p className={`mt-2 text-xs ${FF_SETTINGS_MUTED_CLASS}`}>
        Local seed Example workflows still open and save through the normal
        draft loop.
      </p>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <details className={`${FF_SETTINGS_NESTED_CLASS} p-3`}>
          <summary className={`cursor-pointer text-sm font-medium ${FF_SETTINGS_TITLE_CLASS}`}>
            Starter YAML
          </summary>
          <pre className={`mt-2 overflow-auto text-xs ${FF_SETTINGS_MUTED_CLASS}`}>
            {STARTER_WORKFLOW_YAML}
          </pre>
        </details>
        <details className={`${FF_SETTINGS_NESTED_CLASS} p-3`}>
          <summary className={`cursor-pointer text-sm font-medium ${FF_SETTINGS_TITLE_CLASS}`}>
            Invalid YAML
          </summary>
          <pre className={`mt-2 overflow-auto text-xs ${FF_SETTINGS_MUTED_CLASS}`}>
            {INVALID_WORKFLOW_YAML}
          </pre>
        </details>
      </div>
      <p className={`mt-3 text-xs ${FF_SETTINGS_MUTED_CLASS}`}>
        Permalink:{" "}
        <Link href={SETTINGS_DEVELOPER_HREF} className={`font-mono ${FF_SETTINGS_LINK_CLASS}`}>
          {SETTINGS_DEVELOPER_HREF}
        </Link>
      </p>
    </section>
  );
}
