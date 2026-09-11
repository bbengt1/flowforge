"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { CredentialVaultListbox } from "@/components/credentials/CredentialVaultListbox";
import { SessionSetupHint } from "@/components/session/SessionSetupHint";
import { ProblemBanner } from "@/components/ProblemBanner";
import { getCredentialCatalog, listCredentials } from "@/lib/credential-client";
import { FALLBACK_CREDENTIAL_CATALOG } from "@/lib/credential-contract";
import {
  CREDENTIAL_VAULT_HELP,
  credentialVaultDisplay,
  credentialVaultHasActiveFilters,
  credentialVaultHref,
  isCredentialForbidden,
  parseCredentialVaultQuery,
} from "@/lib/credential-vault";
import {
  CREDENTIAL_STATUSES,
  type CredentialCatalog,
  type CredentialListQuery,
  type CredentialRecord,
} from "@/lib/credential-types";
import { emptyStoredIdentity, loadDevIdentity, subscribeDevIdentity } from "@/lib/dev-identity";
import { loadHeaderFallback, subscribeHeaderFallback } from "@/lib/header-fallback";
import { callIdentityProxy } from "@/lib/identity-client";
import { hasOperatorCaller, hasWorkspaceLookup } from "@/lib/identity-headers";
import type { CurrentWorkspace } from "@/lib/identity-types";
import type { ProblemDetails } from "@/lib/problem";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";
import { maybeEmbedDeepLink } from "@/lib/embed-tenancy-contract";
import { canSeeCredentialsNav } from "@/lib/workspace-nav";

export function CredentialVault() {
  const identity = useSyncExternalStore(
    subscribeDevIdentity,
    loadDevIdentity,
    emptyStoredIdentity,
  );
  const session = useSyncExternalStore(
    subscribeSession,
    getSessionSnapshot,
    getSessionSnapshot,
  );
  const headerFallback = useSyncExternalStore(
    subscribeHeaderFallback,
    loadHeaderFallback,
    () => false,
  );
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const embed = pathname.startsWith("/embed/v1");
  const query = useMemo(
    () => parseCredentialVaultQuery(searchParams.toString()),
    [searchParams],
  );

  const [items, setItems] = useState<CredentialRecord[]>([]);
  const [catalog, setCatalog] = useState<CredentialCatalog>(
    FALLBACK_CREDENTIAL_CATALOG,
  );
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [pending, setPending] = useState(false);
  const [lastRequestId, setLastRequestId] = useState<string | null>(null);
  const [strippedKeys, setStrippedKeys] = useState<string[]>([]);
  const [permissions, setPermissions] = useState<string[] | null>(null);

  const ready =
    hasOperatorCaller(session.active, identity, headerFallback) &&
    hasWorkspaceLookup(identity);

  const denied = ready && permissions != null && !canSeeCredentialsNav(permissions);
  const forbidden = isCredentialForbidden(problem);
  const filtersActive = credentialVaultHasActiveFilters(query);
  const visible = useMemo(
    () =>
      forbidden || denied
        ? []
        : credentialVaultDisplay(items, query, catalog, embed),
    [items, query, catalog, embed, forbidden, denied],
  );

  function replaceQuery(next: CredentialListQuery) {
    router.replace(credentialVaultHref(next, embed), { scroll: false });
  }

  async function refresh() {
    setPending(true);
    setProblem(null);
    const [list, catalogResult, workspace] = await Promise.all([
      listCredentials(identity),
      getCredentialCatalog(identity),
      callIdentityProxy<CurrentWorkspace>("/workspace", identity),
    ]);
    setLastRequestId(list.requestId);
    setPending(false);
    if (workspace.ok) {
      setPermissions(workspace.data.permissions ?? []);
    } else if (workspace.statusCode === 403 || workspace.statusCode === 401) {
      setPermissions([]);
    }
    if (!list.ok) {
      setProblem(list.problem);
      if (isCredentialForbidden(list.problem)) {
        setItems([]);
      }
      return;
    }
    setItems(list.items);
    setStrippedKeys(list.strippedKeys);
    if (catalogResult.ok) {
      setCatalog(catalogResult.catalog);
    }
  }

  useEffect(() => {
    if (!ready) {
      return;
    }
    const timer = window.setTimeout(() => {
      void refresh();
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh closes over identity
  }, [ready, identity]);

  return (
    <div className="space-y-6">
      {!ready ? (
        <SessionSetupHint purpose="before listing credentials." />
      ) : null}

      {denied ? (
        <p className="text-sm text-zinc-600">
          This role cannot view credentials (
          <code className="font-mono text-xs">credential.view</code> missing).
        </p>
      ) : null}

      {problem ? <ProblemBanner problem={problem} /> : null}
      {lastRequestId && !problem ? (
        <p className="font-mono text-xs text-zinc-500">
          last request_id {lastRequestId}
        </p>
      ) : null}
      {strippedKeys.length ? (
        <p role="status" className="text-sm text-amber-900">
          Unexpected secret fields were stripped from the API response:{" "}
          {strippedKeys.join(", ")}. Treat this as a backend contract bug.
        </p>
      ) : null}

      <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Workspace vault</h2>
            <p className="mt-1 max-w-3xl text-sm text-zinc-600">
              {CREDENTIAL_VAULT_HELP}{" "}
              List is{" "}
              <code className="font-mono text-xs">GET /credentials</code>.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {filtersActive ? (
              <button
                type="button"
                onClick={() => replaceQuery({})}
                disabled={denied}
                className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-60"
              >
                Clear filters
              </button>
            ) : null}
            <Link
              href={maybeEmbedDeepLink("/credentials/new", embed)}
              className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-900"
            >
              Add credential
            </Link>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={pending || !ready || denied}
              className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-60"
            >
              {pending ? "Loading…" : "Refresh"}
            </button>
          </div>
        </div>

        <div className="mt-4 space-y-4">
          <label className="block text-sm">
            <span className="font-medium">Display name</span>
            <input
              value={query.q ?? ""}
              onChange={(event) =>
                replaceQuery({ ...query, q: event.target.value })
              }
              placeholder="Find by display name"
              autoComplete="off"
              disabled={denied}
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20 disabled:opacity-60"
            />
          </label>

          <div>
            <p className="text-sm font-medium">Type</p>
            <div role="group" aria-label="Type" className="mt-2 flex flex-wrap gap-2">
              <FilterChip
                label="Any"
                active={!query.type}
                disabled={denied}
                onClick={() => replaceQuery({ ...query, type: "" })}
              />
              {catalog.types.map((item) => (
                <FilterChip
                  key={item.type}
                  label={item.displayName}
                  active={query.type === item.type}
                  disabled={denied}
                  onClick={() =>
                    replaceQuery({
                      ...query,
                      type: item.type,
                    })
                  }
                />
              ))}
            </div>
          </div>

          <div>
            <p className="text-sm font-medium">Status</p>
            <div
              role="group"
              aria-label="Status"
              className="mt-2 flex flex-wrap gap-2"
            >
              <FilterChip
                label="Any"
                active={!query.status}
                disabled={denied}
                onClick={() => replaceQuery({ ...query, status: "" })}
              />
              {CREDENTIAL_STATUSES.map((status) => (
                <FilterChip
                  key={status}
                  label={status === "disabled" ? "Disabled" : "Active"}
                  active={query.status === status}
                  disabled={denied}
                  onClick={() => replaceQuery({ ...query, status })}
                />
              ))}
            </div>
          </div>

          <form
            className="grid gap-3 sm:grid-cols-1"
            onSubmit={(event) => event.preventDefault()}
          >
            <label className="text-sm">
              <span className="font-medium">Exact tag</span>
              <input
                value={query.tag ?? ""}
                onChange={(event) =>
                  replaceQuery({ ...query, tag: event.target.value })
                }
                autoComplete="off"
                disabled={denied}
                className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20 disabled:opacity-60"
              />
            </label>
          </form>
          <p className="text-sm text-zinc-500" aria-live="polite">
            {pending
              ? "Loading credentials…"
              : `${visible.length} credential${visible.length === 1 ? "" : "s"}`}
          </p>
        </div>
      </section>

      {forbidden || denied ? null : visible.length === 0 ? (
        <section className="rounded-2xl border border-dashed border-zinc-300 bg-white/60 p-8 text-center">
          <h2 className="text-lg font-semibold">
            {filtersActive
              ? "No credentials match this display name"
              : "No credentials yet"}
          </h2>
          <p className="mt-2 text-sm text-zinc-600">
            {filtersActive
              ? "Clear the display-name search or type/status filters to see the rest of the vault. Secrets are never queried."
              : "Add a workspace credential to use from workflows. Secrets stay on the control plane after submit."}
          </p>
          <p className="mt-4 flex flex-wrap justify-center gap-4">
            {filtersActive ? (
              <button
                type="button"
                onClick={() => replaceQuery({})}
                className="text-sm font-medium text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
              >
                Clear filters
              </button>
            ) : null}
            <Link
              href={maybeEmbedDeepLink("/credentials/new", embed)}
              className="text-sm font-medium text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
            >
              Open the add-credential wizard
            </Link>
          </p>
        </section>
      ) : (
        <CredentialVaultListbox rows={visible} />
      )}
    </div>
  );
}

function FilterChip({
  label,
  active,
  disabled,
  onClick,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={
        active
          ? "rounded-full border border-teal-800 bg-teal-50 px-3 py-1 text-xs font-semibold text-teal-950 disabled:opacity-60"
          : "rounded-full border border-zinc-300 bg-white px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
      }
    >
      {label}
    </button>
  );
}
