import { NextResponse } from "next/server";
import {
  fetchIdentityControlPlane,
  resolveIdentityProxyTarget,
  withRequestSearch,
} from "@/lib/identity-proxy";
import { PROBLEM_JSON } from "@/lib/problem";
import { REQUEST_ID_HEADER, resolveRequestId } from "@/lib/request-id";

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
  });

  const headers = new Headers();
  headers.set(REQUEST_ID_HEADER, result.requestId);

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

  return problemResponse(result.problem, result.statusCode, result.requestId);
}

function problemResponse(
  problem: unknown,
  status: number,
  requestId: string,
): NextResponse {
  const headers = new Headers();
  headers.set(REQUEST_ID_HEADER, requestId);
  headers.set("Content-Type", PROBLEM_JSON);
  return new NextResponse(JSON.stringify(problem), { status, headers });
}
