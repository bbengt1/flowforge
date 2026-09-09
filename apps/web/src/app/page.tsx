import Link from "next/link";
import { ApiDocsLinks } from "@/components/ApiDocsLinks";
import { ApiHealthCard } from "@/components/ApiHealthCard";
import {
  getPublicHealthUrl,
  getPublicOpenApiJsonUrl,
  getPublicOpenApiYamlUrl,
  getPublicReadinessUrl,
  getPublicSwaggerUrl,
} from "@/lib/config";
import { checkApiHealth, checkApiReadiness } from "@/lib/health";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [health, readiness] = await Promise.all([
    checkApiHealth(),
    checkApiReadiness(),
  ]);

  return (
    <main className="mx-auto flex min-h-full w-full max-w-2xl flex-col gap-8 px-6 py-16">
      <header className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
          E1 foundation · E2 identity · E3 YAML · E4 vault · E4.2 config · E4.3
          approvals · E5 executions · E5.4 alerts · E6.1 shell · E5.3
          artifacts · E5.4 alerts/audit · E7.1 kubernetes targets
        </p>
        <h1 className="text-4xl font-semibold tracking-tight">FlowForge</h1>
        <p className="max-w-xl text-base leading-7 text-zinc-600">
          Workflow control plane UI. The persistent workspace shell is E6.1 —
          RBAC nav, search, and workflow home. Canvas + guided authoring are
          E6.2/E6.3. Execution history and graph replay are E6.4.
          Product contracts live in{" "}
          <code className="font-mono text-sm">docs/</code>. Exercise workspace
          membership and roles from the{" "}
          <Link
            className="underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-600"
            href="/membership"
          >
            membership operator
          </Link>
          , prove isolation fails closed on the{" "}
          <Link
            className="underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-600"
            href="/isolation"
          >
            isolation exercise
          </Link>
          , exercise YAML validate/normalize plus draft/publish/history on
          the{" "}
          <Link
            className="underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-600"
            href="/workflows"
          >
            workflow home
          </Link>
          , manage encrypted workspace credentials on the{" "}
          <Link
            className="underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-600"
            href="/credentials"
          >
            credential vault
          </Link>
          , or version targets, profiles, and related config on the{" "}
          <Link
            className="underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-600"
            href="/config"
          >
            operational config
          </Link>{" "}
          operator, review policy-bound approvals on the{" "}
          <Link
            className="underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-600"
            href="/approvals"
          >
            approvals queue
          </Link>
          , or inspect workspace execution history on the{" "}
          <Link
            className="underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-600"
            href="/executions"
          >
            executions
          </Link>{" "}
          operator, or browse operational{" "}
          <Link
            className="underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-600"
            href="/alerts"
          >
            alerts
          </Link>{" "}
          and append-only{" "}
          <Link
            className="underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-600"
            href="/audit"
          >
            audit
          </Link>
          .
        </p>
      </header>

      <ApiHealthCard
        initialHealth={health}
        initialReadiness={readiness}
        publicHealthUrl={getPublicHealthUrl()}
        publicReadinessUrl={getPublicReadinessUrl()}
      />

      <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Membership operator</h2>
        <p className="mt-1 text-sm text-zinc-600">
          Chloe&apos;s E2.1 / E2.3 UI for jonny&apos;s workspace identity
          contract: establish a cookie session, bootstrap a tenant/workspace,
          inspect roles and permissions, and manage members. CSRF-protected
          mutations and problem responses stay visible (title, detail, code,
          request_id).
        </p>
        <p className="mt-4">
          <Link
            className="text-sm font-medium text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
            href="/membership"
          >
            Open membership and roles
          </Link>
        </p>
      </section>

      <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Isolation exercise</h2>
        <p className="mt-1 text-sm text-zinc-600">
          Chloe&apos;s E2.2 UI for jonny&apos;s isolation hooks: attempt
          cross-workspace credential, artifact, cache, realtime, and record
          access and show the problem+json failure. Workspace UUID is never
          the lookup key.
        </p>
        <p className="mt-4">
          <Link
            className="text-sm font-medium text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
            href="/isolation"
          >
            Open isolation exercise
          </Link>
        </p>
      </section>

      <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Workflow home</h2>
        <p className="mt-1 text-sm text-zinc-600">
          Chloe&apos;s E6.1 home plus the existing E3.1–E3.3 YAML editor.
          Search and filter drafts at{" "}
          <code className="font-mono text-xs">/workflows</code>. The editor
          lives at{" "}
          <code className="font-mono text-xs">/workflows/{"{id}"}</code>.
          Create and import still{" "}
          <code className="font-mono text-xs">POST /workflows</code>.
        </p>
        <p className="mt-4">
          <Link
            className="text-sm font-medium text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
            href="/workflows"
          >
            Open workflow home
          </Link>
        </p>
      </section>

      <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Credential vault</h2>
        <p className="mt-1 text-sm text-zinc-600">
          Chloe&apos;s E4.1 UI stacked on jonny&apos;s #38 vault APIs.
          List metadata, add via a catalog-driven masked wizard, then
          rotate, test, use, disable, or delete with{" "}
          <code className="font-mono text-xs">{`{confirm:true}`}</code> after
          deletion-impact. Plaintext is never retained after submit.
        </p>
        <p className="mt-4">
          <Link
            className="text-sm font-medium text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
            href="/credentials"
          >
            Open credential vault
          </Link>
        </p>
      </section>

      <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Operational config</h2>
        <p className="mt-1 text-sm text-zinc-600">
          Chloe&apos;s E4.2 UI stacked on the #41 ops-config map on main.
          Drafts stay editable and save with body revision; publish mints an
          immutable pin. Select is POST (no authorized/compare/restore
          routes). E4.1 vault and E3 workflow surfaces stay intact.
        </p>
        <p className="mt-4">
          <Link
            className="text-sm font-medium text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
            href="/config"
          >
            Open targets / profiles / config
          </Link>
        </p>
      </section>

      <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Kubernetes targets and policy</h2>
        <p className="mt-1 text-sm text-zinc-600">
          Chloe&apos;s E7.1 UI on the existing E4.2{" "}
          <code className="font-mono text-xs">cluster-targets</code> and{" "}
          <code className="font-mono text-xs">policies</code> surfaces.
          Cluster targets bind a workspace vault credential by display name.
          Kubernetes policy allowlists namespaces, kinds, and verbs and can
          require approval. Selectors fail closed on 403. The UI never
          receives kubeconfigs. Relates to #70 / Part of #69 — retarget when
          jonny publishes the route map.
        </p>
        <p className="mt-4 flex flex-wrap gap-4">
          <Link
            className="text-sm font-medium text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
            href="/config/cluster-targets"
          >
            Open cluster targets
          </Link>
          <Link
            className="text-sm font-medium text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
            href="/config/policies"
          >
            Open policies
          </Link>
        </p>
      </section>

      <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Approvals</h2>
        <p className="mt-1 text-sm text-zinc-600">
          Chloe&apos;s E4.3 UI for the #44 policy-eval / approvals map.
          Pre-run evaluate + decide use CSRF. The requester cannot approve
          their own request. Target or policy publish invalidates prior
          approvals. Server recheck is authoritative.
        </p>
        <p className="mt-4">
          <Link
            className="text-sm font-medium text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
            href="/approvals"
          >
            Open approvals
          </Link>
        </p>
      </section>

      <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Execution history</h2>
        <p className="mt-1 text-sm text-zinc-600">
          Chloe&apos;s E5.1 list/detail plus E5.2 cancel/retry/status
          (Jonny&apos;s #53 map). Workspace and per-workflow lists; detail
          polls{" "}
          <code className="font-mono text-xs">GET /executions/{"{id}"}</code>{" "}
          for steps/jobs and CSRF cancel/retry. Never{" "}
          <code className="font-mono text-xs">/jobs/*</code>. Secrets show
          as <code className="font-mono text-xs">[redacted]</code>.{" "}
          <code className="font-mono text-xs">indeterminate</code> uses
          icon + text and is never silently retried. Relates to #47 /
          Part of #45.
        </p>
        <p className="mt-4">
          <Link
            className="text-sm font-medium text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
            href="/executions"
          >
            Open executions
          </Link>
        </p>
      </section>

      <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Alerts and audit</h2>
        <p className="mt-1 text-sm text-zinc-600">
          Chloe&apos;s E5.4 operator on jonny&apos;s #58 map: authorization,
          replay, policy, and redaction alerts plus append-only workspace
          audit. Alerts show identifiers only — never secrets. Audit is{" "}
          <code className="font-mono text-xs">GET /audit-events</code>, not
          the E2.2 isolation stub. No edit/delete on audit rows. Ack is CSRF
          + empty <code className="font-mono text-xs">{"{}"}</code> (
          <code className="font-mono text-xs">alert.ack</code>). Relates to
          #49 / Part of #45. E5.1–E5.3 execution/artifact surfaces stay
          intact.
        </p>
        <p className="mt-4 flex flex-wrap gap-4">
          <Link
            className="text-sm font-medium text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
            href="/alerts"
          >
            Open alerts
          </Link>
          <Link
            className="text-sm font-medium text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
            href="/audit"
          >
            Open audit
          </Link>
        </p>
      </section>

      <ApiDocsLinks
        swaggerUrl={getPublicSwaggerUrl()}
        openApiJsonUrl={getPublicOpenApiJsonUrl()}
        openApiYamlUrl={getPublicOpenApiYamlUrl()}
      />
    </main>
  );
}
