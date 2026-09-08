import { NextResponse } from "next/server";
import { fetchControlPlane } from "@/lib/control-plane";
import { PROBLEM_JSON } from "@/lib/problem";
import { REQUEST_ID_HEADER, resolveRequestId } from "@/lib/request-id";

type ForwardTarget = {
  path: string;
  instance: string;
};

export async function forwardControlPlane(
  request: Request,
  target: ForwardTarget,
): Promise<NextResponse> {
  const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
  const result = await fetchControlPlane(target.path, {
    requestId,
    instance: target.instance,
  });

  const headers = new Headers();
  headers.set(REQUEST_ID_HEADER, result.requestId);

  if (result.ok) {
    headers.set("Content-Type", result.contentType || "application/json");
    return new NextResponse(JSON.stringify(result.body), {
      status: result.statusCode,
      headers,
    });
  }

  headers.set("Content-Type", PROBLEM_JSON);
  return new NextResponse(JSON.stringify(result.problem), {
    status: result.statusCode,
    headers,
  });
}
