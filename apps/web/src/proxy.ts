import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { applySecurityHeaders } from "@/lib/security-headers";

/**
 * Next.js 16 request interception (replaces middleware.ts).
 * next.config.ts already attaches the static header set to every path,
 * including /_next/static. This layer adds HSTS when the request is TLS
 * (direct HTTPS, X-Forwarded-Proto, or WEB_HSTS=1) and refreshes CSP from
 * runtime env such as WEB_CSP_CONNECT_SRC.
 */
export function proxy(request: NextRequest) {
  const response = NextResponse.next();
  applySecurityHeaders(response.headers, {
    protocol: request.nextUrl.protocol,
    forwardedProto: request.headers.get("x-forwarded-proto"),
  });
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
