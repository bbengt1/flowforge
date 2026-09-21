import Link from "next/link";
import { headers } from "next/headers";
import { EMBED_MOUNT_HEADER } from "@/lib/embed-contract";
import {
  ROUTE_BOUNDARY_ACTION_CLASS,
  ROUTE_BOUNDARY_HEADING_CLASS,
  ROUTE_BOUNDARY_HELP_CLASS,
  ROUTE_BOUNDARY_NOT_FOUND_VALUE,
  ROUTE_BOUNDARY_PANEL_CLASS,
  ROUTE_BOUNDARY_SHELL_CLASS,
  ROUTE_NOT_FOUND_HEADING,
  ROUTE_NOT_FOUND_HELP,
  ROUTE_NOT_FOUND_HOME_LABEL,
  routeNotFoundHomeHref,
} from "@/lib/route-boundary-chrome";

type RouteNotFoundProps = {
  embed?: boolean;
};

export function RouteNotFound({ embed = false }: RouteNotFoundProps) {
  const homeHref = routeNotFoundHomeHref(embed);
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className={ROUTE_BOUNDARY_SHELL_CLASS}
      data-ff-route-boundary={ROUTE_BOUNDARY_NOT_FOUND_VALUE}
    >
      <section className={ROUTE_BOUNDARY_PANEL_CLASS}>
        <h1 className={ROUTE_BOUNDARY_HEADING_CLASS}>{ROUTE_NOT_FOUND_HEADING}</h1>
        <p className={`mt-3 ${ROUTE_BOUNDARY_HELP_CLASS}`}>{ROUTE_NOT_FOUND_HELP}</p>
        <p className="mt-6">
          <Link className={ROUTE_BOUNDARY_ACTION_CLASS} href={homeHref}>
            {ROUTE_NOT_FOUND_HOME_LABEL}
          </Link>
        </p>
      </section>
    </main>
  );
}

export async function AppRouteNotFound() {
  const headerList = await headers();
  return (
    <RouteNotFound embed={headerList.get(EMBED_MOUNT_HEADER) === "1"} />
  );
}
