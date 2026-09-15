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
  CREDENTIAL_VAULT_STRIP_STOP_HELP,
  credentialVaultDisplay,
  credentialVaultHasActiveFilters,
  credentialVaultHref,
  credentialVaultMustStopAfterStrip,
  isCredentialForbidden,
  parseCredentialVaultQuery,
} from "@/lib/credential-vault";
import {
  VAULT_EMPTY_ADD_LABEL,
  VAULT_EMPTY_HEADING,
  VAULT_EMPTY_HELP,
} from "@/lib/empty-states-teach-model";
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
import {
  FF_VAULT_CHIP_ACCENT_CLASS,
  FF_VAULT_CHIP_CLASS,
  FF_VAULT_CONTROL_CLASS,
  FF_VAULT_DANGER_CLASS,
  FF_VAULT_EMPTY_CLASS,
  FF_VAULT_GHOST_CLASS,
  FF_VAULT_LINK_CLASS,
  FF_VAULT_MUTED_CLASS,
  FF_VAULT_PANEL_CLASS,
  FF_VAULT_PRIMARY_CLASS,
  FF_VAULT_ROOT_CLASS,
  FF_VAULT_TITLE_CLASS,
  FF_VAULT_VALUE,
} from "@/lib/vault-executions-visual";

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
  const stopAfterStrip = credentialVaultMustStopAfterStrip(strippedKeys);
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
    <div
      data-uxl8="vault"
      data-ff-vault={FF_VAULT_VALUE}
      className={`${FF_VAULT_ROOT_CLASS} space-y-6`}
    >
      {!ready ? (
        <SessionSetupHint purpose="before listing credentials." />
      ) : null}

      {denied ? (
        <p className={`text-sm ${FF_VAULT_DANGER_CLASS}`}>
          This role cannot view credentials (
          <code className="font-mono text-xs">credential.view</code> missing).
        </p>
      ) : null}

      {problem ? <ProblemBanner problem={problem} /> : null}
      {lastRequestId && !problem ? (
        <p className={`font-mono text-xs ${FF_VAULT_MUTED_CLASS}`}>
          last request_id {lastRequestId}
        </p>
      ) : null}
      {credentialVaultMustStopAfterStrip(strippedKeys) ? (
        <p role="alert" className={`text-sm ${FF_VAULT_DANGER_CLASS}`}>
          {CREDENTIAL_VAULT_STRIP_STOP_HELP} Stripped keys:{" "}
          {strippedKeys.join(", ")}.
        </p>
      ) : null}

      <section className={FF_VAULT_PANEL_CLASS}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className={`text-lg ${FF_VAULT_TITLE_CLASS}`}>Workspace vault</h2>
            <p className={`mt-1 max-w-3xl text-sm ${FF_VAULT_MUTED_CLASS}`}>
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
                disabled={denied || !ready}
                className={FF_VAULT_GHOST_CLASS}
              >
                Clear filters
              </button>
            ) : null}
            <Link
              href={maybeEmbedDeepLink("/credentials/new", embed)}
              className={FF_VAULT_PRIMARY_CLASS}
            >
              Add credential
            </Link>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={pending || !ready || denied}
              className={FF_VAULT_GHOST_CLASS}
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
              disabled={denied || !ready}
              className={`mt-1 ${FF_VAULT_CONTROL_CLASS}`}
            />
          </label>

          <div>
            <p className="text-sm font-medium">Type</p>
            <div role="group" aria-label="Type" className="mt-2 flex flex-wrap gap-2">
              <FilterChip
                label="Any"
                active={!query.type}
                disabled={denied || !ready}
                onClick={() => replaceQuery({ ...query, type: "" })}
              />
              {catalog.types.map((item) => (
                <FilterChip
                  key={item.type}
                  label={item.displayName}
                  active={query.type === item.type}
                  disabled={denied || !ready}
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
                disabled={denied || !ready}
                onClick={() => replaceQuery({ ...query, status: "" })}
              />
              {CREDENTIAL_STATUSES.map((status) => (
                <FilterChip
                  key={status}
                  label={status === "disabled" ? "Disabled" : "Active"}
                  active={query.status === status}
                  disabled={denied || !ready}
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
                disabled={denied || !ready}
                className={`mt-1 ${FF_VAULT_CONTROL_CLASS}`}
              />
            </label>
          </form>
          <p className={`text-sm ${FF_VAULT_MUTED_CLASS}`} aria-live="polite">
            {pending
              ? "Loading credentials…"
              : stopAfterStrip
                ? "List stopped after unexpected plaintext"
                : `${visible.length} credential${visible.length === 1 ? "" : "s"}`}
          </p>
        </div>
      </section>

      {!ready || forbidden || denied || stopAfterStrip ? null : visible.length === 0 ? (
        <section
          data-uxl6={filtersActive ? "vault-filtered" : "vault-empty"}
          className={`${FF_VAULT_EMPTY_CLASS} p-8`}
        >
          <h2 className={`text-lg ${FF_VAULT_TITLE_CLASS}`}>
            {filtersActive
              ? "No credentials match this display name"
              : VAULT_EMPTY_HEADING}
          </h2>
          <p className={`mt-2 text-sm ${FF_VAULT_MUTED_CLASS}`}>
            {filtersActive
              ? "Clear the display-name search or type/status filters to see the rest of the vault. Secrets are never queried."
              : VAULT_EMPTY_HELP}
          </p>
          <p className="mt-4 flex flex-wrap justify-center gap-4">
            {filtersActive ? (
              <button
                type="button"
                onClick={() => replaceQuery({})}
                className={`text-sm font-medium ${FF_VAULT_LINK_CLASS}`}
              >
                Clear filters
              </button>
            ) : null}
            <Link
              href={maybeEmbedDeepLink("/credentials/new", embed)}
              className={`text-sm font-medium ${FF_VAULT_LINK_CLASS}`}
            >
              {VAULT_EMPTY_ADD_LABEL}
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
          ? `${FF_VAULT_CHIP_ACCENT_CLASS} disabled:opacity-60`
          : `${FF_VAULT_CHIP_CLASS} disabled:opacity-60`
      }
    >
      {label}
    </button>
  );
}
