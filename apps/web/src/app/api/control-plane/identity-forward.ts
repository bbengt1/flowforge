import { NextResponse } from "next/server";
import { proxyCsrfDenial } from "@/lib/csrf";
import {
  fetchIdentityControlPlane,
  resolveIdentityProxyTarget,
  withRequestSearch,
} from "@/lib/identity-proxy";
import { PROBLEM_JSON } from "@/lib/problem";
import { REQUEST_ID_HEADER, resolveRequestId } from "@/lib/request-id";
import { requestIsSecure } from "@/lib/session-cookies";
import { CSRF_HEADER } from "@/lib/session-contract";

export async function forwardIdentityControlPlane(
  request: Request,
  segments: string[],
): Promise<NextResponse> {
  const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
  const target = resolveIdentityProxyTarget(request.method, segments);

  if ("status" in target) {
    const problem = target.problem(
      `/api/control-plane/${segments.join("/")}`,
      requestId,
    );
    return problemResponse(problem, target.status, requestId);
  }

  const csrfDenial = proxyCsrfDenial({
    method: request.method,
    proxyPath: target.instance,
    cookieHeader: request.headers.get("cookie"),
    csrfHeader: request.headers.get(CSRF_HEADER),
    requestId,
  });
  if (csrfDenial) {
    return problemResponse(csrfDenial, csrfDenial.status, requestId);
  }

  const body =
    request.method === "GET" || request.method === "HEAD"
      ? null
      : await request.text();

  const result = await fetchIdentityControlPlane({
    method: target.method,
    apiPath: withRequestSearch(target.apiPath, request.url),
    instance: target.instance,
    requestId,
    identityHeaders: request.headers,
    body,
    contentType: request.headers.get("content-type"),
    requestSecure: requestIsSecure(request),
  });

  const headers = new Headers();
  headers.set(REQUEST_ID_HEADER, result.requestId);
  applySessionResponseHeaders(headers, result);

  if (result.ok) {
    if (result.statusCode === 204) {
      return new NextResponse(null, { status: 204, headers });
    }
    headers.set("Content-Type", result.contentType || "application/json");
    return new NextResponse(JSON.stringify(result.body), {
      status: result.statusCode,
      headers,
    });
  }

  return problemResponse(
    result.problem,
    result.statusCode,
    result.requestId,
    result,
  );
}

function applySessionResponseHeaders(
  headers: Headers,
  result: { setCookies: string[]; csrfToken: string | null },
) {
  for (const cookie of result.setCookies) {
    headers.append("Set-Cookie", cookie);
  }
  if (result.csrfToken) {
    headers.set(CSRF_HEADER, result.csrfToken);
  }
}

function problemResponse(
  problem: unknown,
  status: number,
  requestId: string,
  result?: { setCookies: string[]; csrfToken: string | null },
): NextResponse {
  const headers = new Headers();
  headers.set(REQUEST_ID_HEADER, requestId);
  headers.set("Content-Type", PROBLEM_JSON);
  if (result) {
    applySessionResponseHeaders(headers, result);
  }
  return new NextResponse(JSON.stringify(problem), { status, headers });
}
