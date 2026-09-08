import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  FLOWFORGE_ISSUER_HEADER,
  FLOWFORGE_SUBJECT_HEADER,
  FLOWFORGE_TENANT_SLUG_HEADER,
  FLOWFORGE_WORKBENCH_KEY_HEADER,
  FLOWFORGE_WORKSPACE_ID_HEADER,
} from "./identity-headers.ts";
import {
  fetchIdentityControlPlane,
  methodNotAllowedProblem,
  notFoundProblem,
  pickSessionCredentialHeaders,
  resolveIdentityProxyTarget,
  withRequestSearch,
} from "./identity-proxy.ts";
import { PROBLEM_JSON } from "./problem.ts";
import { REQUEST_ID_HEADER } from "./request-id.ts";
import { CSRF_HEADER } from "./session-contract.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("resolveIdentityProxyTarget", () => {
  it("maps the documented E2.1, E2.2, E2.3, and E3.1 routes onto /api/v1", () => {
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
      ["GET", ["workspace", "records"], "/api/v1/workspace/records"],
      ["POST", ["workspace", "records"], "/api/v1/workspace/records"],
      [
        "GET",
        ["workspace", "records", "22222222-2222-2222-2222-222222222222"],
        "/api/v1/workspace/records/22222222-2222-2222-2222-222222222222",
      ],
      [
        "POST",
        [
          "workspace",
          "credentials",
          "22222222-2222-2222-2222-222222222222",
          "use",
        ],
        "/api/v1/workspace/credentials/22222222-2222-2222-2222-222222222222/use",
      ],
      [
        "GET",
        ["workspace", "artifacts", "22222222-2222-2222-2222-222222222222"],
        "/api/v1/workspace/artifacts/22222222-2222-2222-2222-222222222222",
      ],
      ["GET", ["workspace", "jobs"], "/api/v1/workspace/jobs"],
      ["POST", ["workspace", "jobs"], "/api/v1/workspace/jobs"],
      ["GET", ["workspace", "cache", "job-1"], "/api/v1/workspace/cache/job-1"],
      ["PUT", ["workspace", "cache", "job-1"], "/api/v1/workspace/cache/job-1"],
      [
        "POST",
        [
          "workspace",
          "realtime",
          "channels",
          "22222222-2222-2222-2222-222222222222",
          "subscribe",
        ],
        "/api/v1/workspace/realtime/channels/22222222-2222-2222-2222-222222222222/subscribe",
      ],
      ["GET", ["workspace", "audit-events"], "/api/v1/workspace/audit-events"],
      ["GET", ["session"], "/api/v1/session"],
      ["POST", ["session"], "/api/v1/session"],
      ["POST", ["session", "refresh"], "/api/v1/session/refresh"],
      ["POST", ["session", "logout"], "/api/v1/session/logout"],
      ["GET", ["session", "audit-events"], "/api/v1/session/audit-events"],
      ["GET", ["workflows", "catalog"], "/api/v1/workflows/catalog"],
      ["POST", ["workflows", "validate"], "/api/v1/workflows/validate"],
      ["POST", ["workflows", "normalize"], "/api/v1/workflows/normalize"],
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

  it("appends inbound query strings for kind= list hooks", () => {
    assert.equal(
      withRequestSearch(
        "/api/v1/workspace/records",
        "http://localhost/api/control-plane/workspace/records?kind=credential",
      ),
      "/api/v1/workspace/records?kind=credential",
    );
    assert.equal(
      withRequestSearch("/api/v1/workspace/jobs", "http://localhost/api/control-plane/workspace/jobs"),
      "/api/v1/workspace/jobs",
    );
  });

  it("does not offer draft persistence or unknown workflow paths", () => {
    const unknown = [
      ["workflows"],
      ["workflows", "draft"],
      ["workflows", "11111111-1111-4111-8111-111111111111", "draft"],
    ];
    for (const segments of unknown) {
      const target = resolveIdentityProxyTarget("PUT", segments);
      assert.equal("status" in target, true, segments.join("/"));
      if ("status" in target) {
        assert.equal(target.status, 404);
      }
    }
    const catalogWrite = resolveIdentityProxyTarget("POST", [
      "workflows",
      "catalog",
    ]);
    assert.equal("status" in catalogWrite, true);
    if ("status" in catalogWrite) {
      assert.equal(catalogWrite.status, 405);
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

    const deleteSession = resolveIdentityProxyTarget("DELETE", ["session"]);
    assert.equal("status" in deleteSession, true);
    if ("status" in deleteSession) {
      assert.equal(deleteSession.status, 405);
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

  it("preserves invalid-workflow errors[] on problem+json", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          type: "urn:flowforge:problem:invalid-workflow",
          title: "Invalid Workflow",
          status: 400,
          detail: "The workflow definition is not valid.",
          instance: "/api/v1/workflows/validate",
          code: "invalid-workflow",
          request_id: "wf-proxy-error-16",
          errors: [
            {
              path: "spec.nodes[0].id",
              line: 8,
              column: 5,
              code: "invalid-id",
              message: "Node IDs must be DNS labels.",
            },
          ],
        }),
        {
          status: 400,
          headers: {
            "Content-Type": PROBLEM_JSON,
            [REQUEST_ID_HEADER]: "wf-proxy-error-16",
          },
        },
      )) as typeof fetch;

    const result = await fetchIdentityControlPlane({
      method: "POST",
      apiPath: "/api/v1/workflows/validate",
      instance: "/api/control-plane/workflows/validate",
      requestId: "wf-proxy-error-16",
      identityHeaders: new Headers(),
      body: JSON.stringify({ definitionYaml: "kind: Workflow" }),
      contentType: "application/json",
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.problem.code, "invalid-workflow");
      assert.equal(result.problem.errors?.[0]?.path, "spec.nodes[0].id");
      assert.equal(result.problem.errors?.[0]?.line, 8);
      assert.equal(result.problem.errors?.[0]?.code, "invalid-id");
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

  it("forwards a mismatched Workspace-ID only with tenant + workbench", async () => {
    const seen: { headers?: Headers } = {};
    globalThis.fetch = (async (_input, init) => {
      seen.headers = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          type: "urn:flowforge:problem:forbidden",
          title: "Forbidden",
          status: 403,
          detail: "Host-supplied workspace identity does not match the server-derived workspace.",
          instance: "/api/v1/workspace/artifacts/22222222-2222-2222-2222-222222222222",
          code: "forbidden",
          request_id: "mismatch-request16",
        }),
        {
          status: 403,
          headers: {
            "Content-Type": PROBLEM_JSON,
            [REQUEST_ID_HEADER]: "mismatch-request16",
          },
        },
      );
    }) as typeof fetch;

    const result = await fetchIdentityControlPlane({
      method: "GET",
      apiPath: "/api/v1/workspace/artifacts/22222222-2222-2222-2222-222222222222",
      instance:
        "/api/control-plane/workspace/artifacts/22222222-2222-2222-2222-222222222222",
      requestId: "mismatch-request16",
      identityHeaders: new Headers({
        [FLOWFORGE_ISSUER_HEADER]: "https://host.example",
        [FLOWFORGE_SUBJECT_HEADER]: "operator-1",
        [FLOWFORGE_TENANT_SLUG_HEADER]: "acme",
        [FLOWFORGE_WORKBENCH_KEY_HEADER]: "ops",
        [FLOWFORGE_WORKSPACE_ID_HEADER]: "33333333-3333-3333-3333-333333333333",
      }),
    });

    assert.equal(
      seen.headers?.get(FLOWFORGE_WORKSPACE_ID_HEADER),
      "33333333-3333-3333-3333-333333333333",
    );
    assert.equal(seen.headers?.get(FLOWFORGE_TENANT_SLUG_HEADER), "acme");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 403);
      assert.equal(result.problem.code, "forbidden");
      assert.equal(result.problem.request_id, "mismatch-request16");
    }
  });

  it("forwards Cookie and CSRF, rewrites Set-Cookie, and never forwards Authorization", async () => {
    const seen: { headers?: Headers } = {};
    globalThis.fetch = (async (_input, init) => {
      seen.headers = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          issuer: "https://idp",
          subject: "operator-chloe",
          expires_at: "2026-09-08T21:00:00.000Z",
          csrf_token: "csrf-json",
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            [REQUEST_ID_HEADER]: "session-request16",
            [CSRF_HEADER]: "csrf-header",
            "Set-Cookie":
              "ff_session=opaque; Domain=api.example.test; HttpOnly; Secure; Path=/api/v1; SameSite=Lax",
          },
        },
      );
    }) as typeof fetch;

    const result = await fetchIdentityControlPlane({
      method: "GET",
      apiPath: "/api/v1/session",
      instance: "/api/control-plane/session",
      requestId: "session-request16",
      requestSecure: false,
      identityHeaders: new Headers({
        Cookie: "ff_session=opaque",
        [CSRF_HEADER]: "csrf-from-browser",
        Authorization: "Bearer secret",
      }),
    });

    assert.equal(seen.headers?.get("Cookie"), "ff_session=opaque");
    assert.equal(seen.headers?.get(CSRF_HEADER), "csrf-from-browser");
    assert.equal(seen.headers?.get("Authorization"), null);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.csrfToken, "csrf-header");
      assert.equal(result.setCookies.length, 1);
      assert.match(result.setCookies[0] ?? "", /ff_session=opaque/);
      assert.match(result.setCookies[0] ?? "", /Path=\/api\/v1/);
      assert.match(result.setCookies[0] ?? "", /SameSite=Lax/);
      assert.doesNotMatch(result.setCookies[0] ?? "", /Domain=/);
      assert.doesNotMatch(result.setCookies[0] ?? "", /Secure/);
    }
  });
});

describe("pickSessionCredentialHeaders", () => {
  it("copies only Cookie and CSRF", () => {
    const forwarded = pickSessionCredentialHeaders(
      new Headers({
        Cookie: "ff_session=opaque",
        [CSRF_HEADER]: "csrf",
        Authorization: "Bearer secret",
      }),
    );
    assert.equal(forwarded.get("Cookie"), "ff_session=opaque");
    assert.equal(forwarded.get(CSRF_HEADER), "csrf");
    assert.equal(forwarded.get("Authorization"), null);
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
