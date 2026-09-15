import { NextResponse } from "next/server";
import { cookieHasSession, proxyCsrfDenial } from "@/lib/csrf";
import {
  isBootstrapWizardMutation,
  shouldExpireStaleWizardCookies,
} from "@/lib/first-run-bootstrap";
import {
  fetchIdentityControlPlane,
  fetchIdentityControlPlaneStream,
  isArtifactDownloadStreamTarget,
  resolveIdentityProxyTarget,
  sanitizeContentDisposition,
  withRequestSearch,
} from "@/lib/identity-proxy";
import { PROBLEM_JSON } from "@/lib/problem";
import { REQUEST_ID_HEADER, resolveRequestId } from "@/lib/request-id";
import {
  expireSessionCookies,
  headersWithoutSessionCookies,
  requestIsSecure,
} from "@/lib/session-cookies";
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

  const wizardPost = isBootstrapWizardMutation(request.method, target.instance);
  const stripUnhydratedWizardCookie =
    wizardPost &&
    cookieHasSession(request.headers.get("cookie")) &&
    !request.headers.get(CSRF_HEADER)?.trim();
  const identityHeaders = stripUnhydratedWizardCookie
    ? headersWithoutSessionCookies(request.headers)
    : request.headers;

  const apiPath = withRequestSearch(target.apiPath, request.url);

  if (isArtifactDownloadStreamTarget(request.method, segments)) {
    const streamed = await fetchIdentityControlPlaneStream({
      method: target.method,
      apiPath,
      instance: target.instance,
      requestId,
      identityHeaders,
      requestSecure: requestIsSecure(request),
    });
    const headers = new Headers();
    headers.set(REQUEST_ID_HEADER, streamed.requestId);
    applySessionResponseHeaders(headers, streamed);
    if (!streamed.ok) {
      return problemResponse(
        streamed.problem,
        streamed.statusCode,
        streamed.requestId,
        streamed,
      );
    }
    headers.set("Cache-Control", "no-store");
    headers.set("Content-Type", streamed.contentType || "application/octet-stream");
    const disposition = sanitizeContentDisposition(streamed.contentDisposition);
    if (disposition) {
      headers.set("Content-Disposition", disposition);
    }
    return new NextResponse(streamed.body, {
      status: streamed.statusCode,
      headers,
    });
  }

  const body =
    request.method === "GET" || request.method === "HEAD"
      ? null
      : await request.text();

  const result = await fetchIdentityControlPlane({
    method: target.method,
    apiPath,
    instance: target.instance,
    requestId,
    identityHeaders,
    body,
    contentType: request.headers.get("content-type"),
    requestSecure: requestIsSecure(request),
  });

  const headers = new Headers();
  headers.set(REQUEST_ID_HEADER, result.requestId);
  applySessionResponseHeaders(headers, result);
  expireWizardCookies(
    headers,
    request,
    target.instance,
    result.statusCode,
    stripUnhydratedWizardCookie,
  );

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
    {
      request,
      proxyPath: target.instance,
      stripUnhydratedWizardCookie,
    },
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

function expireWizardCookies(
  headers: Headers,
  request: Request,
  proxyPath: string,
  statusCode: number,
  stripUnhydratedWizardCookie: boolean,
) {
  if (
    !shouldExpireStaleWizardCookies({
      method: request.method,
      path: proxyPath,
      statusCode,
      strippedUnhydratedCookie: stripUnhydratedWizardCookie,
    })
  ) {
    return;
  }
  for (const cookie of expireSessionCookies({
    requestSecure: requestIsSecure(request),
  })) {
    headers.append("Set-Cookie", cookie);
  }
}

function problemResponse(
  problem: unknown,
  status: number,
  requestId: string,
  result?: { setCookies: string[]; csrfToken: string | null },
  wizard?: {
    request: Request;
    proxyPath: string;
    stripUnhydratedWizardCookie: boolean;
  },
): NextResponse {
  const headers = new Headers();
  headers.set(REQUEST_ID_HEADER, requestId);
  headers.set("Content-Type", PROBLEM_JSON);
  if (result) {
    applySessionResponseHeaders(headers, result);
  }
  if (wizard) {
    expireWizardCookies(
      headers,
      wizard.request,
      wizard.proxyPath,
      status,
      wizard.stripUnhydratedWizardCookie,
    );
  }
  return new NextResponse(JSON.stringify(problem), { status, headers });
}
