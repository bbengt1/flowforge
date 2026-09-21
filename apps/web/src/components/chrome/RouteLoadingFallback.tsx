import {
  ROUTE_BOUNDARY_HELP_CLASS,
  ROUTE_BOUNDARY_LOADING_VALUE,
  ROUTE_BOUNDARY_SHELL_CLASS,
  ROUTE_BOUNDARY_SKELETON_CLASS,
  ROUTE_LOADING_LABEL,
} from "@/lib/route-boundary-chrome";

type RouteLoadingFallbackProps = {
  label?: string;
};

export function RouteLoadingFallback({
  label = ROUTE_LOADING_LABEL,
}: RouteLoadingFallbackProps) {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className={ROUTE_BOUNDARY_SHELL_CLASS}
      data-ff-route-boundary={ROUTE_BOUNDARY_LOADING_VALUE}
    >
      <p className={ROUTE_BOUNDARY_HELP_CLASS} role="status" aria-live="polite">
        {label}
      </p>
      <div className={ROUTE_BOUNDARY_SKELETON_CLASS} aria-hidden="true" />
    </main>
  );
}
