import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  FLOWFORGE_ISSUER_HEADER,
  FLOWFORGE_SUBJECT_HEADER,
  FLOWFORGE_WORKSPACE_ID_HEADER,
} from "./identity-headers.ts";
import {
  fetchIdentityControlPlane,
  methodNotAllowedProblem,
  notFoundProblem,
  resolveIdentityProxyTarget,
} from "./identity-proxy.ts";
import { PROBLEM_JSON } from "./problem.ts";
import { REQUEST_ID_HEADER } from "./request-id.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("resolveIdentityProxyTarget", () => {
  it("maps the documented E2.1 routes onto /api/v1", () => {
    const cases: Array<[string, string[], string]> = [
      ["GET", ["permission-matrix"], "/api/v1/permission-matrix"],
      ["GET", ["roles"], "/api/v1/roles"],
      ["GET", ["permissions"], "/api/v1/permissions"],
      ["POST", ["tenants"], "/api/v1/tenants"],
      ["GET", ["workspaces"], "/api/v1/workspaces"],
      ["POST", ["workspaces"], "/api/v1/workspaces"],
      ["GET", ["workspace"], "/api/v1/workspace"],
      ["GET", ["workspace", "members"], "/api/v1/workspace/members"],
      ["PUT", ["workspace", "members"], "/api/v1/workspace/members"],
      [
        "DELETE",
        ["workspace", "members", "11111111-1111-1111-1111-111111111111"],
        "/api/v1/workspace/members/11111111-1111-1111-1111-111111111111",
      ],
    ];

    for (const [method, segments, apiPath] of cases) {
      const target = resolveIdentityProxyTarget(method, segments);
      assert.equal("apiPath" in target, true, `${method} ${segments.join("/")}`);
      if ("apiPath" in target) {
        assert.equal(target.apiPath, apiPath);
        assert.equal(target.method, method);
        assert.equal(
          target.instance,
          `/api/control-plane/${segments.join("/")}`,
        );
      }
    }
  });

  it("does not offer a workspace-id-only lookup path", () => {
    const unknown = [
      ["workspace", "11111111-1111-1111-1111-111111111111"],
      ["workspaces", "11111111-1111-1111-1111-111111111111"],
    ];
    for (const segments of unknown) {
      const target = resolveIdentityProxyTarget("GET", segments);
      assert.equal("status" in target, true);
      if ("status" in target) {
        assert.equal(target.status, 404);
      }
    }
  });

  it("rejects unknown paths and disallowed methods with problem codes", () => {
    const missing = resolveIdentityProxyTarget("GET", ["not-a-route"]);
    assert.equal("status" in missing, true);
    if ("status" in missing) {
      assert.equal(missing.status, 404);
      const problem = missing.problem("/api/control-plane/not-a-route", "id-16-characters");
      assert.equal(problem.code, "not-found");
    }

    const disallowed = resolveIdentityProxyTarget("DELETE", ["workspaces"]);
    assert.equal("status" in disallowed, true);
    if ("status" in disallowed) {
      assert.equal(disallowed.status, 405);
      const problem = disallowed.problem(
        "/api/control-plane/workspaces",
        "id-16-characters",
      );
      assert.equal(problem.code, "method-not-allowed");
    }
  });
});

describe("fetchIdentityControlPlane", () => {
  it("forwards identity headers and X-Request-ID, and preserves problem+json", async () => {
    const seen: { url?: string; headers?: Headers; method?: string } = {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.method = init?.method;
      seen.headers = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          type: "urn:flowforge:problem:unauthenticated",
          title: "Unauthenticated",
          status: 401,
          detail: "Authentication is required.",
          instance: "/api/v1/workspaces",
          code: "unauthenticated",
          request_id: "echoed-request-16",
        }),
        {
          status: 401,
          headers: {
            "Content-Type": PROBLEM_JSON,
            [REQUEST_ID_HEADER]: "echoed-request-16",
          },
        },
      );
    }) as typeof fetch;

    const result = await fetchIdentityControlPlane({
      method: "GET",
      apiPath: "/api/v1/workspaces",
      instance: "/api/control-plane/workspaces",
      requestId: "caller-request-16",
      identityHeaders: new Headers({
        [FLOWFORGE_ISSUER_HEADER]: "https://host.example",
        [FLOWFORGE_SUBJECT_HEADER]: "operator-1",
        [FLOWFORGE_WORKSPACE_ID_HEADER]: "11111111-1111-1111-1111-111111111111",
        Authorization: "Bearer secret",
      }),
    });

    assert.equal(seen.method, "GET");
    assert.match(seen.url ?? "", /\/api\/v1\/workspaces$/);
    assert.equal(seen.headers?.get(FLOWFORGE_ISSUER_HEADER), "https://host.example");
    assert.equal(seen.headers?.get(FLOWFORGE_SUBJECT_HEADER), "operator-1");
    assert.equal(seen.headers?.get(FLOWFORGE_WORKSPACE_ID_HEADER), null);
    assert.equal(seen.headers?.get("Authorization"), null);
    assert.equal(seen.headers?.get(REQUEST_ID_HEADER), "caller-request-16");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 401);
      assert.equal(result.problem.title, "Unauthenticated");
      assert.equal(result.problem.detail, "Authentication is required.");
      assert.equal(result.problem.code, "unauthenticated");
      assert.equal(result.problem.request_id, "echoed-request-16");
      assert.equal(result.requestId, "echoed-request-16");
    }
  });

  it("returns 204 success without requiring a JSON body", async () => {
    globalThis.fetch = (async () =>
      new Response(null, {
        status: 204,
        headers: { [REQUEST_ID_HEADER]: "delete-request-16x" },
      })) as typeof fetch;

    const result = await fetchIdentityControlPlane({
      method: "DELETE",
      apiPath: "/api/v1/workspace/members/11111111-1111-1111-1111-111111111111",
      instance: "/api/control-plane/workspace/members/11111111-1111-1111-1111-111111111111",
      requestId: "delete-request-16x",
      identityHeaders: new Headers({
        [FLOWFORGE_ISSUER_HEADER]: "https://host.example",
        [FLOWFORGE_SUBJECT_HEADER]: "operator-1",
      }),
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.statusCode, 204);
      assert.equal(result.body, null);
    }
  });
});

describe("identity proxy problem helpers", () => {
  it("includes title, detail, code, and request_id", () => {
    const notFound = notFoundProblem("/api/control-plane/missing", "req-id-16charsxx");
    assert.equal(notFound.title, "Not Found");
    assert.equal(notFound.code, "not-found");
    assert.equal(notFound.request_id, "req-id-16charsxx");
    assert.match(notFound.detail, /does not exist/);

    const method = methodNotAllowedProblem(
      "/api/control-plane/workspaces",
      "req-id-16charsxx",
      "DELETE",
      "GET, POST",
    );
    assert.equal(method.title, "Method Not Allowed");
    assert.equal(method.code, "method-not-allowed");
    assert.match(method.detail, /DELETE/);
    assert.match(method.detail, /GET, POST/);
  });
});
