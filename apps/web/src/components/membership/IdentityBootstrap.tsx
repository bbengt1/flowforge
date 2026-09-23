import { Field as SharedField } from "@/components/a11y/Field";
import {
  hasCallerIdentity,
  hasWorkspaceLookup,
  type DevIdentity,
} from "@/lib/identity-headers";
import {
  LOCAL_SEED_DISPLAY_NAME,
  LOCAL_SEED_ISSUER,
  LOCAL_SEED_SUBJECT,
  LOCAL_SEED_TENANT_SLUG,
  LOCAL_SEED_WORKBENCH_KEY,
} from "@/lib/local-seed-example";
import {
  FF_SETTINGS_CONTROL_CLASS,
  FF_SETTINGS_EYEBROW_CLASS,
  FF_SETTINGS_GHOST_CLASS,
  FF_SETTINGS_MUTED_CLASS,
  FF_SETTINGS_PANEL_CLASS,
  FF_SETTINGS_SKIP_CLASS,
  FF_SETTINGS_TITLE_CLASS,
} from "@/lib/settings-wizard-visual";

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
      className={FF_SETTINGS_PANEL_CLASS}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className={FF_SETTINGS_EYEBROW_CLASS}>
            Workspace context
          </p>
          <h2 id="workspace-context-heading" className={`mt-1 text-lg ${FF_SETTINGS_TITLE_CLASS}`}>
            Tenant + workbench
          </h2>
          <p className={`mt-1 max-w-2xl text-sm leading-6 ${FF_SETTINGS_MUTED_CLASS}`}>
            Workspace lookup is tenant id <em>or</em> tenant slug plus workbench
            key — not a workspace UUID. Cookie session is the subject. These
            fields stay in this tab (
            <code className="font-mono text-xs">sessionStorage</code>
            ) and are not secrets. Labeled Example context is the compose
            localseed only — not production Settings copy.
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onExample}
              className={FF_SETTINGS_GHOST_CLASS}
            >
              Example context
            </button>
            <button
              type="button"
              onClick={onClear}
              className={FF_SETTINGS_GHOST_CLASS}
            >
              Clear
            </button>
          </div>
          <p className={`max-w-xs text-right text-xs leading-5 ${FF_SETTINGS_MUTED_CLASS}`}>
            Local-only compose localseed (
            <code className="font-mono">{LOCAL_SEED_ISSUER}</code>
            {" / "}
            <code className="font-mono">{LOCAL_SEED_SUBJECT}</code>
            {" / "}
            <code className="font-mono">{LOCAL_SEED_TENANT_SLUG}</code>
            {" / "}
            <code className="font-mono">{LOCAL_SEED_WORKBENCH_KEY}</code>
            ). Not production Settings copy.
          </p>
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
          placeholder={LOCAL_SEED_TENANT_SLUG}
          hint="Used with workbench key when tenant ID is empty."
          autoComplete="off"
        />
        <Field
          id="workbench-key"
          label="Workbench key"
          value={identity.workbenchKey}
          onChange={(value) => set("workbenchKey", value)}
          placeholder={LOCAL_SEED_WORKBENCH_KEY}
          hint="Combined with tenant id or slug. Workspace UUID is not a lookup field."
          autoComplete="off"
        />
      </div>

      <ul className={`mt-4 list-disc space-y-1 pl-5 text-sm ${FF_SETTINGS_MUTED_CLASS}`}>
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
        className={`${FF_SETTINGS_SKIP_CLASS} mt-5 border-dashed px-4 py-3`}
        open={headerFallback}
      >
        <summary className="cursor-pointer text-sm font-medium">
          Temporary local-dev header identity (not for production)
        </summary>
        <p className="mt-2 text-sm">
          Dual-gate until jonny&apos;s session API is the only subject path.
          When this is on <em>and</em> no cookie session is active, the UI
          sends <code className="font-mono text-xs">X-FlowForge-Issuer</code>{" "}
          / <code className="font-mono text-xs">X-FlowForge-Subject</code> as
          in E2.1. Do not put secrets here. This fallback will be removed.
          It is never rewrite login.
        </p>
        <SharedField
          id="identity-header-fallback"
          label="Enable header identity fallback for this tab"
          controlPlacement="before-label"
          className="mt-3 flex items-start gap-2 text-sm"
          labelClassName=""
        >
          <input
            type="checkbox"
            checked={headerFallback}
            onChange={(event) => onHeaderFallbackChange(event.target.checked)}
            className="mt-1"
          />
        </SharedField>
        {headerFallback ? (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field
              id="issuer"
              label="Issuer"
              value={identity.issuer}
              onChange={(value) => set("issuer", value)}
              placeholder={LOCAL_SEED_ISSUER}
              autoComplete="off"
            />
            <Field
              id="subject"
              label="Subject"
              value={identity.subject}
              onChange={(value) => set("subject", value)}
              placeholder={LOCAL_SEED_SUBJECT}
              autoComplete="off"
            />
            <Field
              id="display-name"
              label="Display name (optional)"
              value={identity.displayName}
              onChange={(value) => set("displayName", value)}
              placeholder={LOCAL_SEED_DISPLAY_NAME}
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
    <SharedField
      id={id}
      label={label}
      hint={hint}
      className="block text-sm"
      labelClassName={`font-medium ${FF_SETTINGS_TITLE_CLASS}`}
      hintClassName={`mt-1 block text-xs ${FF_SETTINGS_MUTED_CLASS}`}
    >
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        spellCheck={false}
        className={`mt-1 font-mono text-sm ${FF_SETTINGS_CONTROL_CLASS}`}
      />
    </SharedField>
  );
}
