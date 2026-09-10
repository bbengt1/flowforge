"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ProblemBanner } from "@/components/ProblemBanner";
import { loadDevIdentity } from "@/lib/dev-identity";
import {
  EMBED_ROUTES,
  parseCatalogFrameAncestors,
  type EmbedRouteId,
} from "@/lib/embed-contract";
import {
  PORTAL_ASSERTION_HELP,
  PORTAL_BOUNDARY,
  PORTAL_BOUNDARY_HELP,
  PORTAL_ENTRY_PATH,
  PORTAL_HELP,
  PORTAL_HOST_NAME,
  PORTAL_RBAC_HELP,
  PORTAL_ROLES,
  PORTAL_ROUTE_MAP_SOURCE,
  PORTAL_TENANCY_HELP,
  buildPortalEmbedSrc,
  mapPortalRoles,
  portalEntryRbac,
  portalHostDisplay,
  type PortalEntryRole,
  type PortalRole,
} from "@/lib/portal-adapter-contract";
import {
  deliverPortalAssertion,
  emptyPortalAssertionHolder,
  fetchPortalAdapter,
  mintPortalAssertion,
} from "@/lib/portal-embed-client";
import type { ProblemDetails } from "@/lib/problem";

const DEEP_LINK_OPTIONS = EMBED_ROUTES.filter(
  (route) => !route.standalone.includes("{"),
);

export function PortalHost() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const pendingAssertion = useRef("");
  const [entryRole, setEntryRole] = useState<PortalEntryRole>("granted");
  const [portalRole, setPortalRole] = useState<PortalRole>("portal.viewer");
  const [tenant, setTenant] = useState("");
  const [workbench, setWorkbench] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [routeId, setRouteId] = useState<EmbedRouteId>("workflows");
  const [mounted, setMounted] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [status, setStatus] = useState("");
  const [tokenId, setTokenId] = useState("");
  const [rejectedAssertion, setRejectedAssertion] = useState(false);
  const [catalogNote, setCatalogNote] = useState("");
  const [hostAllowlist, setHostAllowlist] = useState<string[]>([]);

  const rbac = useMemo(() => portalEntryRbac(entryRole), [entryRole]);
  const mappedCaps = useMemo(
    () => mapPortalRoles([portalRole]).capabilities,
    [portalRole],
  );
  const display = useMemo(
    () =>
      portalHostDisplay({
        host: PORTAL_HOST_NAME,
        tenant,
        workbench,
        displayName,
      }),
    [tenant, workbench, displayName],
  );
  const embedSrc = useMemo(
    () => buildPortalEmbedSrc({ routeId, display }),
    [routeId, display],
  );

  useEffect(() => {
    let cancelled = false;
    void fetchPortalAdapter(loadDevIdentity()).then((result) => {
      if (cancelled) {
        return;
      }
      if (!result.ok) {
        setHostAllowlist([]);
        setCatalogNote(
          `GET /portal/adapter unavailable (${result.statusCode}). Using the published #129 capability map. postMessage stays fail-closed until frameAncestors loads.`,
        );
        return;
      }
      setHostAllowlist(parseCatalogFrameAncestors(result.data));
      setCatalogNote("GET /portal/adapter loaded. Roles map on the FlowForge side. frameAncestors is the shared host allowlist.");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function mintAndMount() {
    setPending(true);
    setProblem(null);
    setStatus("");
    setTokenId("");
    const identity = loadDevIdentity();
    const result = await mintPortalAssertion(
      rbac,
      {
        portalRoles: [portalRole],
        tenantId: tenant || identity.tenantId,
        workbenchKey: workbench || identity.workbenchKey,
        displayName: displayName || identity.displayName,
      },
      identity,
    );
    if (!result.ok) {
      setPending(false);
      setProblem(result.problem);
      return;
    }

    const built = buildPortalEmbedSrc({ routeId, display });
    setRejectedAssertion(built.rejectedAssertion);
    pendingAssertion.current = result.assertion;
    setMounted(true);
    setTokenId(result.tokenId);
    setStatus(
      `Assertion minted (${result.tokenId || "jti"}). It will be postMessaged on iframe load; the embed shell exchanges via POST /embed/exchange.`,
    );
    setPending(false);
  }

  function onFrameLoad() {
    const assertion = pendingAssertion.current;
    if (!assertion) {
      return;
    }
    const holder = emptyPortalAssertionHolder();
    holder.assertion = assertion;
    pendingAssertion.current = "";
    const delivered = deliverPortalAssertion(
      iframeRef.current?.contentWindow,
      holder,
      window.location.origin,
      hostAllowlist,
      window.location.origin,
    );
    setStatus(
      delivered.delivered
        ? "Assertion postMessaged into the iframe and forgotten. FlowForge exchange uses the verified session — not Portal RBAC."
        : "Iframe loaded but postMessage was skipped. The assertion was still forgotten.",
    );
  }

  return (
    <div className="flex min-h-full flex-col bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-6 py-6">
          <p className="text-sm font-medium tracking-wide text-indigo-800 uppercase">
            E11.3 · {PORTAL_HOST_NAME} · {PORTAL_ROUTE_MAP_SOURCE} ·{" "}
            {PORTAL_ENTRY_PATH}
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">
            Protected workflow surface
          </h1>
          <p className="max-w-3xl text-sm leading-6 text-slate-600">
            {PORTAL_BOUNDARY_HELP} {PORTAL_HELP} Relates to #123 / Part of #120 —
            keep #123 open.
          </p>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-6">
        {problem ? <ProblemBanner problem={problem} /> : null}
        {status ? (
          <p
            role="status"
            className="rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-950"
          >
            {status}
          </p>
        ) : null}

        <section className="rounded-2xl border border-slate-200 bg-white px-5 py-4 text-sm text-slate-700">
          <p className="text-xs font-medium tracking-wide text-indigo-800 uppercase">
            Published #129 map
          </p>
          <p className="mt-2">{catalogNote}</p>
          <p className="mt-2 font-mono text-xs text-slate-500">
            sharesDatabase={String(PORTAL_BOUNDARY.sharesDatabase)} ·
            sharesExecutor={String(PORTAL_BOUNDARY.sharesExecutor)} ·
            portalEntryIsAuthorization=
            {String(PORTAL_BOUNDARY.portalEntryIsAuthorization)}
          </p>
        </section>

        <section className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-slate-200 bg-white px-5 py-5">
            <h2 className="text-lg font-semibold tracking-tight">
              1. Portal entry RBAC
            </h2>
            <p className="mt-2 text-sm text-slate-600">{PORTAL_RBAC_HELP}</p>
            <fieldset className="mt-4 space-y-2">
              <legend className="sr-only">Portal entry</legend>
              {(["granted", "denied"] as const).map((role) => (
                <label key={role} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="portal-entry"
                    checked={entryRole === role}
                    onChange={() => setEntryRole(role)}
                  />
                  Portal entry {role}
                </label>
              ))}
            </fieldset>
            <p className="mt-3 text-xs text-slate-500">
              authorizesFlowForge = false · Portal admin ≠ FlowForge membership
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white px-5 py-5">
            <h2 className="text-lg font-semibold tracking-tight">
              2. Map roles
            </h2>
            <p className="mt-2 text-sm text-slate-600">{PORTAL_TENANCY_HELP}</p>
            <label className="mt-4 block text-sm font-medium">
              Portal role
              <select
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                value={portalRole}
                onChange={(event) =>
                  setPortalRole(event.target.value as PortalRole)
                }
              >
                {PORTAL_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
            </label>
            <p className="mt-2 text-xs text-slate-500">
              Mapped request (API still intersects the minting caller):{" "}
              {mappedCaps.length > 0 ? mappedCaps.join(", ") : "admin → full set if member"}
            </p>
            <label className="mt-3 block text-sm font-medium">
              Tenant (display)
              <input
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs"
                value={tenant}
                onChange={(event) => setTenant(event.target.value)}
                autoComplete="off"
              />
            </label>
            <label className="mt-3 block text-sm font-medium">
              Workbench (display)
              <input
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs"
                value={workbench}
                onChange={(event) => setWorkbench(event.target.value)}
                autoComplete="off"
              />
            </label>
            <label className="mt-3 block text-sm font-medium">
              Display name
              <input
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                autoComplete="off"
              />
            </label>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white px-5 py-5">
          <h2 className="text-lg font-semibold tracking-tight">
            3–5. Mint, mount, exchange
          </h2>
          <p className="mt-2 text-sm text-slate-600">{PORTAL_ASSERTION_HELP}</p>
          <label className="mt-4 block text-sm font-medium">
            Deep link
            <select
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              value={routeId}
              onChange={(event) =>
                setRouteId(event.target.value as EmbedRouteId)
              }
            >
              {DEEP_LINK_OPTIONS.map((route) => (
                <option key={route.id} value={route.id}>
                  {route.embed} — {route.description}
                </option>
              ))}
            </select>
          </label>
          <p className="mt-3 font-mono text-xs break-all text-slate-500">
            iframe src {embedSrc.src}
          </p>
          {rejectedAssertion ? (
            <p className="mt-2 text-sm text-amber-800">
              An assertion token was stripped from a host URL. It was never
              copied into the iframe src.
            </p>
          ) : null}
          {tokenId ? (
            <p className="mt-2 text-xs text-slate-500">
              Last mint jti {tokenId} (metadata only)
            </p>
          ) : null}
          <button
            type="button"
            className="mt-4 rounded-lg bg-indigo-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            disabled={pending}
            onClick={() => void mintAndMount()}
          >
            {pending ? "Minting…" : "Mint assertion and mount FlowForge"}
          </button>
        </section>

        {mounted ? (
          <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
            <iframe
              ref={iframeRef}
              title="FlowForge embed"
              src={embedSrc.src}
              className="h-[75vh] w-full border-0"
              onLoad={onFrameLoad}
            />
          </section>
        ) : (
          <p className="text-sm text-slate-600">
            FlowForge stays unmounted until Portal entry is granted and an
            assertion is minted. The iframe is not given a database, executor,
            or Portal role.
          </p>
        )}
      </div>
    </div>
  );
}
