import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { applySecurityHeaders, createScriptNonce } from "@/lib/security-headers";

/**
 * Next.js 16 request interception (replaces middleware.ts).
 *
 * Generates a per-request CSP nonce and puts Content-Security-Policy on
 * both the request (so Next.js stamps nonce= on bootstrap/RSC scripts)
 * and the response. next.config.ts attaches the non-CSP header set,
 * including on /_next/static. HSTS is added only when the request is TLS.
 */
export function proxy(request: NextRequest) {
  const nonce = createScriptNonce();
  const headerOptions = {
    nonce,
    protocol: request.nextUrl.protocol,
    forwardedProto: request.headers.get("x-forwarded-proto"),
  };

  const requestHeaders = new Headers(request.headers);
  applySecurityHeaders(requestHeaders, headerOptions);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  applySecurityHeaders(response.headers, headerOptions);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
