"use client";

import {
  ROUTE_BOUNDARY_ACTION_CLASS,
  ROUTE_BOUNDARY_ERROR_VALUE,
  ROUTE_BOUNDARY_HEADING_CLASS,
  ROUTE_BOUNDARY_HELP_CLASS,
  ROUTE_BOUNDARY_PANEL_CLASS,
  ROUTE_BOUNDARY_SHELL_CLASS,
  ROUTE_ERROR_DIGEST_LABEL,
  ROUTE_ERROR_HEADING,
  ROUTE_ERROR_HELP,
  ROUTE_ERROR_RETRY_LABEL,
  routeErrorDigest,
} from "@/lib/route-boundary-chrome";

type RouteErrorPanelProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export function RouteErrorPanel({ error, reset }: RouteErrorPanelProps) {
  const digest = routeErrorDigest(error);
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className={ROUTE_BOUNDARY_SHELL_CLASS}
      data-ff-route-boundary={ROUTE_BOUNDARY_ERROR_VALUE}
    >
      <section className={ROUTE_BOUNDARY_PANEL_CLASS} role="alert">
        <h1 className={ROUTE_BOUNDARY_HEADING_CLASS}>{ROUTE_ERROR_HEADING}</h1>
        <p className={`mt-3 ${ROUTE_BOUNDARY_HELP_CLASS}`}>{ROUTE_ERROR_HELP}</p>
        {digest ? (
          <p className={`mt-3 font-mono text-xs ${ROUTE_BOUNDARY_HELP_CLASS}`}>
            <span className="opacity-70">{ROUTE_ERROR_DIGEST_LABEL} </span>
            <span className="break-all">{digest}</span>
          </p>
        ) : null}
        <p className="mt-6">
          <button
            type="button"
            className={ROUTE_BOUNDARY_ACTION_CLASS}
            onClick={() => {
              reset();
            }}
          >
            {ROUTE_ERROR_RETRY_LABEL}
          </button>
        </p>
      </section>
    </main>
  );
}
