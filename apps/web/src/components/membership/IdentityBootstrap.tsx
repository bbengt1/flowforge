import {
  hasCallerIdentity,
  hasWorkspaceLookup,
  type DevIdentity,
} from "@/lib/identity-headers";

type IdentityBootstrapProps = {
  identity: DevIdentity;
  onChange: (next: DevIdentity) => void;
  onExample: () => void;
  onClear: () => void;
  headerFallback: boolean;
  onHeaderFallbackChange: (enabled: boolean) => void;
  sessionActive: boolean;
};

export function IdentityBootstrap({
  identity,
  onChange,
  onExample,
  onClear,
  headerFallback,
  onHeaderFallbackChange,
  sessionActive,
}: IdentityBootstrapProps) {
  function set(field: keyof DevIdentity, value: string) {
    onChange({ ...identity, [field]: value });
  }

  return (
    <section
      aria-labelledby="workspace-context-heading"
      className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
            Workspace context
          </p>
          <h2 id="workspace-context-heading" className="mt-1 text-lg font-semibold">
            Tenant + workbench
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-zinc-600">
            Workspace lookup is tenant id <em>or</em> tenant slug plus workbench
            key — not a workspace UUID. Cookie session is the subject. These
            fields stay in this tab (
            <code className="font-mono text-xs">sessionStorage</code>
            ) and are not secrets.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onExample}
            className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-100"
          >
            Example context
          </button>
          <button
            type="button"
            onClick={onClear}
            className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50"
          >
            Clear
          </button>
        </div>
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <Field
          id="tenant-id"
          label="Tenant ID"
          value={identity.tenantId}
          onChange={(value) => set("tenantId", value)}
          placeholder="uuid from create tenant"
          autoComplete="off"
        />
        <Field
          id="tenant-slug"
          label="Tenant slug"
          value={identity.tenantSlug}
          onChange={(value) => set("tenantSlug", value)}
          placeholder="acme"
          hint="Used with workbench key when tenant ID is empty."
          autoComplete="off"
        />
        <Field
          id="workbench-key"
          label="Workbench key"
          value={identity.workbenchKey}
          onChange={(value) => set("workbenchKey", value)}
          placeholder="ops"
          hint="Combined with tenant id or slug. Workspace UUID is not a lookup field."
          autoComplete="off"
        />
      </div>

      <ul className="mt-4 list-disc space-y-1 pl-5 text-sm text-zinc-600">
        <li>
          Current workspace lookup:{" "}
          {hasWorkspaceLookup(identity)
            ? "tenant + workbench key ready"
            : "needs tenant id or slug plus workbench key"}
          .
        </li>
        <li>
          Subject:{" "}
          {sessionActive
            ? "cookie session preferred — issuer/subject headers are not sent"
            : headerFallback
              ? hasCallerIdentity(identity)
                ? "temporary header identity ready"
                : "header fallback needs issuer and subject"
              : "establish a cookie session, or enable the temporary header fallback"}
          .
        </li>
      </ul>

      <details
        className="mt-5 rounded-xl border border-dashed border-amber-300 bg-amber-50/60 px-4 py-3"
        open={headerFallback}
      >
        <summary className="cursor-pointer text-sm font-medium text-amber-950">
          Temporary local-dev header identity (not for production)
        </summary>
        <p className="mt-2 text-sm text-amber-950/80">
          Dual-gate until jonny&apos;s session API is the only subject path.
          When this is on <em>and</em> no cookie session is active, the UI
          sends <code className="font-mono text-xs">X-FlowForge-Issuer</code>{" "}
          / <code className="font-mono text-xs">X-FlowForge-Subject</code> as
          in E2.1. Do not put secrets here. This fallback will be removed.
        </p>
        <label className="mt-3 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={headerFallback}
            onChange={(event) => onHeaderFallbackChange(event.target.checked)}
            className="mt-1"
          />
          <span>Enable header identity fallback for this tab</span>
        </label>
        {headerFallback ? (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field
              id="issuer"
              label="Issuer"
              value={identity.issuer}
              onChange={(value) => set("issuer", value)}
              placeholder="https://flowforge.local"
              autoComplete="off"
            />
            <Field
              id="subject"
              label="Subject"
              value={identity.subject}
              onChange={(value) => set("subject", value)}
              placeholder="operator-chloe"
              autoComplete="off"
            />
            <Field
              id="display-name"
              label="Display name (optional)"
              value={identity.displayName}
              onChange={(value) => set("displayName", value)}
              placeholder="Chloe (dev)"
              autoComplete="off"
            />
          </div>
        ) : null}
      </details>
    </section>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  placeholder,
  hint,
  autoComplete,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
  autoComplete?: string;
}) {
  return (
    <label htmlFor={id} className="block text-sm">
      <span className="font-medium text-zinc-800">{label}</span>
      <input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        spellCheck={false}
        className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono text-sm text-zinc-900 outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
      />
      {hint ? <span className="mt-1 block text-xs text-zinc-500">{hint}</span> : null}
    </label>
  );
}
