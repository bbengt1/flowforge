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
  fetchIdentityControlPlaneStream,
  methodNotAllowedProblem,
  notFoundProblem,
  pickConditionalHeaders,
  pickSessionCredentialHeaders,
  resolveIdentityProxyTarget,
  sanitizeContentDisposition,
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
  it("maps the documented E2.1, E2.2, E2.3, E3.1, and E3.2 routes onto /api/v1", () => {
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
      ["GET", ["workflows"], "/api/v1/workflows"],
      ["POST", ["workflows"], "/api/v1/workflows"],
      [
        "GET",
        ["workflows", "11111111-1111-4111-8111-111111111111"],
        "/api/v1/workflows/11111111-1111-4111-8111-111111111111",
      ],
      [
        "GET",
        ["workflows", "11111111-1111-4111-8111-111111111111", "draft"],
        "/api/v1/workflows/11111111-1111-4111-8111-111111111111/draft",
      ],
      [
        "PUT",
        ["workflows", "11111111-1111-4111-8111-111111111111", "draft"],
        "/api/v1/workflows/11111111-1111-4111-8111-111111111111/draft",
      ],
      [
        "POST",
        ["workflows", "11111111-1111-4111-8111-111111111111", "publish"],
        "/api/v1/workflows/11111111-1111-4111-8111-111111111111/publish",
      ],
      [
        "POST",
        ["workflows", "11111111-1111-4111-8111-111111111111", "compare"],
        "/api/v1/workflows/11111111-1111-4111-8111-111111111111/compare",
      ],
      [
        "GET",
        ["workflows", "11111111-1111-4111-8111-111111111111", "versions"],
        "/api/v1/workflows/11111111-1111-4111-8111-111111111111/versions",
      ],
      [
        "GET",
        [
          "workflows",
          "11111111-1111-4111-8111-111111111111",
          "versions",
          "22222222-2222-4222-8222-222222222222",
        ],
        "/api/v1/workflows/11111111-1111-4111-8111-111111111111/versions/22222222-2222-4222-8222-222222222222",
      ],
      [
        "GET",
        [
          "workflows",
          "11111111-1111-4111-8111-111111111111",
          "versions",
          "22222222-2222-4222-8222-222222222222",
          "export",
        ],
        "/api/v1/workflows/11111111-1111-4111-8111-111111111111/versions/22222222-2222-4222-8222-222222222222/export",
      ],
      [
        "POST",
        [
          "workflows",
          "11111111-1111-4111-8111-111111111111",
          "versions",
          "22222222-2222-4222-8222-222222222222",
          "restore",
        ],
        "/api/v1/workflows/11111111-1111-4111-8111-111111111111/versions/22222222-2222-4222-8222-222222222222/restore",
      ],
      [
        "POST",
        ["workflows", "11111111-1111-4111-8111-111111111111", "executions"],
        "/api/v1/workflows/11111111-1111-4111-8111-111111111111/executions",
      ],
      [
        "GET",
        ["workflows", "11111111-1111-4111-8111-111111111111", "executions"],
        "/api/v1/workflows/11111111-1111-4111-8111-111111111111/executions",
      ],
      [
        "GET",
        [
          "workflows",
          "11111111-1111-4111-8111-111111111111",
          "executions",
          "33333333-3333-4333-8333-333333333333",
        ],
        "/api/v1/workflows/11111111-1111-4111-8111-111111111111/executions/33333333-3333-4333-8333-333333333333",
      ],
      ["GET", ["credentials", "catalog"], "/api/v1/credentials/catalog"],
      ["GET", ["credentials"], "/api/v1/credentials"],
      ["POST", ["credentials"], "/api/v1/credentials"],
      [
        "GET",
        ["credentials", "11111111-1111-4111-8111-111111111111"],
        "/api/v1/credentials/11111111-1111-4111-8111-111111111111",
      ],
      [
        "PATCH",
        ["credentials", "11111111-1111-4111-8111-111111111111"],
        "/api/v1/credentials/11111111-1111-4111-8111-111111111111",
      ],
      [
        "DELETE",
        ["credentials", "11111111-1111-4111-8111-111111111111"],
        "/api/v1/credentials/11111111-1111-4111-8111-111111111111",
      ],
      [
        "POST",
        ["credentials", "11111111-1111-4111-8111-111111111111", "rotate"],
        "/api/v1/credentials/11111111-1111-4111-8111-111111111111/rotate",
      ],
      [
        "POST",
        ["credentials", "11111111-1111-4111-8111-111111111111", "test"],
        "/api/v1/credentials/11111111-1111-4111-8111-111111111111/test",
      ],
      [
        "POST",
        ["credentials", "11111111-1111-4111-8111-111111111111", "use"],
        "/api/v1/credentials/11111111-1111-4111-8111-111111111111/use",
      ],
      [
        "GET",
        ["credentials", "11111111-1111-4111-8111-111111111111", "events"],
        "/api/v1/credentials/11111111-1111-4111-8111-111111111111/events",
      ],
      [
        "GET",
        [
          "credentials",
          "11111111-1111-4111-8111-111111111111",
          "deletion-impact",
        ],
        "/api/v1/credentials/11111111-1111-4111-8111-111111111111/deletion-impact",
      ],
      ["GET", ["ops-config", "catalog"], "/api/v1/ops-config/catalog"],
      ["POST", ["ops-config", "select"], "/api/v1/ops-config/select"],
      ["GET", ["kubernetes", "catalog"], "/api/v1/kubernetes/catalog"],
      ["GET", ["cluster-targets"], "/api/v1/cluster-targets"],
      ["POST", ["cluster-targets"], "/api/v1/cluster-targets"],
      [
        "GET",
        ["ssh-targets", "11111111-1111-4111-8111-111111111111"],
        "/api/v1/ssh-targets/11111111-1111-4111-8111-111111111111",
      ],
      [
        "PUT",
        ["command-profiles", "11111111-1111-4111-8111-111111111111", "draft"],
        "/api/v1/command-profiles/11111111-1111-4111-8111-111111111111/draft",
      ],
      [
        "PUT",
        ["runtime-profiles", "11111111-1111-4111-8111-111111111111", "draft"],
        "/api/v1/runtime-profiles/11111111-1111-4111-8111-111111111111/draft",
      ],
      [
        "POST",
        ["connections", "11111111-1111-4111-8111-111111111111", "publish"],
        "/api/v1/connections/11111111-1111-4111-8111-111111111111/publish",
      ],
      [
        "POST",
        ["recipient-lists", "11111111-1111-4111-8111-111111111111", "select"],
        "/api/v1/recipient-lists/11111111-1111-4111-8111-111111111111/select",
      ],
      [
        "POST",
        ["policies", "11111111-1111-4111-8111-111111111111", "disable"],
        "/api/v1/policies/11111111-1111-4111-8111-111111111111/disable",
      ],
      [
        "POST",
        ["policies", "11111111-1111-4111-8111-111111111111", "enable"],
        "/api/v1/policies/11111111-1111-4111-8111-111111111111/enable",
      ],
      [
        "GET",
        ["message-templates", "11111111-1111-4111-8111-111111111111", "versions"],
        "/api/v1/message-templates/11111111-1111-4111-8111-111111111111/versions",
      ],
      [
        "GET",
        [
          "response-schemas",
          "11111111-1111-4111-8111-111111111111",
          "versions",
          "22222222-2222-4222-8222-222222222222",
        ],
        "/api/v1/response-schemas/11111111-1111-4111-8111-111111111111/versions/22222222-2222-4222-8222-222222222222",
      ],
      [
        "GET",
        [
          "workflows",
          "11111111-1111-4111-8111-111111111111",
          "versions",
          "22222222-2222-4222-8222-222222222222",
          "pins",
        ],
        "/api/v1/workflows/11111111-1111-4111-8111-111111111111/versions/22222222-2222-4222-8222-222222222222/pins",
      ],
      ["GET", ["approvals"], "/api/v1/approvals"],
      ["POST", ["approvals"], "/api/v1/approvals"],
      ["GET", ["approvals", "catalog"], "/api/v1/approvals/catalog"],
      [
        "GET",
        ["approvals", "11111111-1111-4111-8111-111111111111"],
        "/api/v1/approvals/11111111-1111-4111-8111-111111111111",
      ],
      [
        "POST",
        ["approvals", "11111111-1111-4111-8111-111111111111", "decide"],
        "/api/v1/approvals/11111111-1111-4111-8111-111111111111/decide",
      ],
      [
        "GET",
        ["approvals", "11111111-1111-4111-8111-111111111111", "events"],
        "/api/v1/approvals/11111111-1111-4111-8111-111111111111/events",
      ],
      ["POST", ["policy", "evaluate"], "/api/v1/policy/evaluate"],
      ["GET", ["executions"], "/api/v1/executions"],
      [
        "GET",
        ["executions", "33333333-3333-4333-8333-333333333333"],
        "/api/v1/executions/33333333-3333-4333-8333-333333333333",
      ],
      [
        "GET",
        ["executions", "33333333-3333-4333-8333-333333333333", "steps"],
        "/api/v1/executions/33333333-3333-4333-8333-333333333333/steps",
      ],
      [
        "GET",
        [
          "executions",
          "33333333-3333-4333-8333-333333333333",
          "steps",
          "44444444-4444-4444-8444-444444444444",
        ],
        "/api/v1/executions/33333333-3333-4333-8333-333333333333/steps/44444444-4444-4444-8444-444444444444",
      ],
      [
        "GET",
        ["executions", "33333333-3333-4333-8333-333333333333", "jobs"],
        "/api/v1/executions/33333333-3333-4333-8333-333333333333/jobs",
      ],
      [
        "GET",
        ["executions", "33333333-3333-4333-8333-333333333333", "audit-events"],
        "/api/v1/executions/33333333-3333-4333-8333-333333333333/audit-events",
      ],
      [
        "POST",
        ["executions", "33333333-3333-4333-8333-333333333333", "cancel"],
        "/api/v1/executions/33333333-3333-4333-8333-333333333333/cancel",
      ],
      [
        "POST",
        [
          "workflows",
          "11111111-1111-4111-8111-111111111111",
          "executions",
          "33333333-3333-4333-8333-333333333333",
          "cancel",
        ],
        "/api/v1/workflows/11111111-1111-4111-8111-111111111111/executions/33333333-3333-4333-8333-333333333333/cancel",
      ],
      [
        "POST",
        ["executions", "33333333-3333-4333-8333-333333333333", "retry"],
        "/api/v1/executions/33333333-3333-4333-8333-333333333333/retry",
      ],
      [
        "POST",
        [
          "executions",
          "33333333-3333-4333-8333-333333333333",
          "steps",
          "44444444-4444-4444-8444-444444444444",
          "retry",
        ],
        "/api/v1/executions/33333333-3333-4333-8333-333333333333/steps/44444444-4444-4444-8444-444444444444/retry",
      ],
      [
        "GET",
        ["executions", "33333333-3333-4333-8333-333333333333", "artifacts"],
        "/api/v1/executions/33333333-3333-4333-8333-333333333333/artifacts",
      ],
      [
        "GET",
        [
          "executions",
          "33333333-3333-4333-8333-333333333333",
          "steps",
          "44444444-4444-4444-8444-444444444444",
          "logs",
        ],
        "/api/v1/executions/33333333-3333-4333-8333-333333333333/steps/44444444-4444-4444-8444-444444444444/logs",
      ],
      [
        "GET",
        ["artifacts", "77777777-7777-4777-8777-777777777777"],
        "/api/v1/artifacts/77777777-7777-4777-8777-777777777777",
      ],
      [
        "POST",
        ["artifacts", "77777777-7777-4777-8777-777777777777", "downloads"],
        "/api/v1/artifacts/77777777-7777-4777-8777-777777777777/downloads",
      ],
      [
        "GET",
        ["artifact-downloads", "88888888-8888-4888-8888-888888888888"],
        "/api/v1/artifact-downloads/88888888-8888-4888-8888-888888888888",
      ],
      ["GET", ["audit-events"], "/api/v1/audit-events"],
      ["GET", ["alerts"], "/api/v1/alerts"],
      [
        "GET",
        ["alerts", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
        "/api/v1/alerts/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      ],
      [
        "POST",
        ["alerts", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "ack"],
        "/api/v1/alerts/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/ack",
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

  it("retargets E7.1 cluster-target and kubernetes policy paths through the adapter", () => {
    const list = resolveIdentityProxyTarget("GET", ["cluster-targets"]);
    assert.equal("apiPath" in list, true);
    if ("apiPath" in list) {
      assert.equal(list.apiPath, "/api/v1/cluster-targets");
    }
    const select = resolveIdentityProxyTarget("POST", [
      "cluster-targets",
      "11111111-1111-4111-8111-111111111111",
      "select",
    ]);
    assert.equal("apiPath" in select, true);
    if ("apiPath" in select) {
      assert.equal(
        select.apiPath,
        "/api/v1/cluster-targets/11111111-1111-4111-8111-111111111111/select",
      );
    }
    const policyDraft = resolveIdentityProxyTarget("PUT", [
      "policies",
      "11111111-1111-4111-8111-111111111111",
      "draft",
    ]);
    assert.equal("apiPath" in policyDraft, true);
    if ("apiPath" in policyDraft) {
      assert.equal(
        policyDraft.apiPath,
        "/api/v1/policies/11111111-1111-4111-8111-111111111111/draft",
      );
    }
    const authorized = resolveIdentityProxyTarget("GET", [
      "cluster-targets",
      "authorized",
    ]);
    assert.equal("status" in authorized, true);
    if ("status" in authorized) {
      assert.equal(authorized.status, 404);
    }
  });

  it("does not treat reserved ops-config actions as resource ids", () => {
    const unknown = resolveIdentityProxyTarget("GET", [
      "cluster-targets",
      "publish",
    ]);
    assert.equal("status" in unknown, true);
    if ("status" in unknown) {
      assert.equal(unknown.status, 404);
    }
    const catalogWrite = resolveIdentityProxyTarget("POST", [
      "ops-config",
      "catalog",
    ]);
    assert.equal("status" in catalogWrite, true);
    if ("status" in catalogWrite) {
      assert.equal(catalogWrite.status, 405);
    }
    const retiredAuthorized = resolveIdentityProxyTarget("GET", [
      "cluster-targets",
      "authorized",
    ]);
    assert.equal("status" in retiredAuthorized, true);
    if ("status" in retiredAuthorized) {
      assert.equal(retiredAuthorized.status, 404);
    }
    const retiredCompare = resolveIdentityProxyTarget("POST", [
      "recipient-lists",
      "11111111-1111-4111-8111-111111111111",
      "compare",
    ]);
    assert.equal("status" in retiredCompare, true);
    if ("status" in retiredCompare) {
      assert.equal(retiredCompare.status, 404);
    }
    const retiredRestore = resolveIdentityProxyTarget("POST", [
      "policies",
      "11111111-1111-4111-8111-111111111111",
      "versions",
      "22222222-2222-4222-8222-222222222222",
      "restore",
    ]);
    assert.equal("status" in retiredRestore, true);
    if ("status" in retiredRestore) {
      assert.equal(retiredRestore.status, 404);
    }
    const invented = resolveIdentityProxyTarget("GET", ["targets"]);
    assert.equal("status" in invented, true);
    if ("status" in invented) {
      assert.equal(invented.status, 404);
    }
  });

  it("allowlists E4.3 approval routes and rejects retired approve/reject paths", () => {
    const getDecide = resolveIdentityProxyTarget("GET", [
      "approvals",
      "11111111-1111-4111-8111-111111111111",
      "decide",
    ]);
    assert.equal("status" in getDecide, true);
    if ("status" in getDecide) {
      assert.equal(getDecide.status, 405);
    }
    const retiredApprove = resolveIdentityProxyTarget("POST", [
      "approvals",
      "11111111-1111-4111-8111-111111111111",
      "approve",
    ]);
    assert.equal("status" in retiredApprove, true);
    if ("status" in retiredApprove) {
      assert.equal(retiredApprove.status, 404);
    }
    const retiredReject = resolveIdentityProxyTarget("POST", [
      "approvals",
      "11111111-1111-4111-8111-111111111111",
      "reject",
    ]);
    assert.equal("status" in retiredReject, true);
    if ("status" in retiredReject) {
      assert.equal(retiredReject.status, 404);
    }
    const executionApprovals = resolveIdentityProxyTarget("GET", [
      "workflows",
      "11111111-1111-4111-8111-111111111111",
      "executions",
      "22222222-2222-4222-8222-222222222222",
      "approvals",
    ]);
    assert.equal("status" in executionApprovals, true);
    if ("status" in executionApprovals) {
      assert.equal(executionApprovals.status, 404);
    }
    const getEvaluate = resolveIdentityProxyTarget("GET", ["policy", "evaluate"]);
    assert.equal("status" in getEvaluate, true);
    if ("status" in getEvaluate) {
      assert.equal(getEvaluate.status, 405);
    }
  });

  it("allowlists E5.1 execution query GETs and does not invent routes", () => {
    const listWrite = resolveIdentityProxyTarget("POST", ["executions"]);
    assert.equal("status" in listWrite, true);
    if ("status" in listWrite) {
      assert.equal(listWrite.status, 405);
    }
    const inventedEvents = resolveIdentityProxyTarget("GET", [
      "executions",
      "33333333-3333-4333-8333-333333333333",
      "events",
    ]);
    assert.equal("status" in inventedEvents, true);
    if ("status" in inventedEvents) {
      assert.equal(inventedEvents.status, 404);
    }
    const inventedReplay = resolveIdentityProxyTarget("GET", [
      "executions",
      "33333333-3333-4333-8333-333333333333",
      "replay",
    ]);
    assert.equal("status" in inventedReplay, true);
    if ("status" in inventedReplay) {
      assert.equal(inventedReplay.status, 404);
    }
    const workerClaim = resolveIdentityProxyTarget("POST", ["jobs", "claim"]);
    assert.equal("status" in workerClaim, true);
    if ("status" in workerClaim) {
      assert.equal(workerClaim.status, 404);
    }
    const workerHeartbeat = resolveIdentityProxyTarget("POST", [
      "jobs",
      "33333333-3333-4333-8333-333333333333",
      "heartbeat",
    ]);
    assert.equal("status" in workerHeartbeat, true);
    if ("status" in workerHeartbeat) {
      assert.equal(workerHeartbeat.status, 404);
    }
    const retryGet = resolveIdentityProxyTarget("GET", [
      "executions",
      "33333333-3333-4333-8333-333333333333",
      "retry",
    ]);
    assert.equal("status" in retryGet, true);
    if ("status" in retryGet) {
      assert.equal(retryGet.status, 405);
    }
    const cancelGet = resolveIdentityProxyTarget("GET", [
      "executions",
      "33333333-3333-4333-8333-333333333333",
      "cancel",
    ]);
    assert.equal("status" in cancelGet, true);
    if ("status" in cancelGet) {
      assert.equal(cancelGet.status, 405);
    }
    const nestedArtifactGet = resolveIdentityProxyTarget("GET", [
      "executions",
      "33333333-3333-4333-8333-333333333333",
      "artifacts",
      "77777777-7777-4777-8777-777777777777",
    ]);
    assert.equal("status" in nestedArtifactGet, true);
    if ("status" in nestedArtifactGet) {
      assert.equal(nestedArtifactGet.status, 404);
    }
    const nestedDownload = resolveIdentityProxyTarget("POST", [
      "executions",
      "33333333-3333-4333-8333-333333333333",
      "artifacts",
      "77777777-7777-4777-8777-777777777777",
      "download",
    ]);
    assert.equal("status" in nestedDownload, true);
    if ("status" in nestedDownload) {
      assert.equal(nestedDownload.status, 404);
    }
    const singularDownload = resolveIdentityProxyTarget("POST", [
      "artifacts",
      "77777777-7777-4777-8777-777777777777",
      "download",
    ]);
    assert.equal("status" in singularDownload, true);
    if ("status" in singularDownload) {
      assert.equal(singularDownload.status, 404);
    }
    const downloadGet = resolveIdentityProxyTarget("GET", [
      "artifacts",
      "77777777-7777-4777-8777-777777777777",
      "downloads",
    ]);
    assert.equal("status" in downloadGet, true);
    if ("status" in downloadGet) {
      assert.equal(downloadGet.status, 405);
    }
    const streamPost = resolveIdentityProxyTarget("POST", [
      "artifact-downloads",
      "88888888-8888-4888-8888-888888888888",
    ]);
    assert.equal("status" in streamPost, true);
    if ("status" in streamPost) {
      assert.equal(streamPost.status, 405);
    }
    const reservedAsId = resolveIdentityProxyTarget("GET", [
      "executions",
      "steps",
    ]);
    assert.equal("status" in reservedAsId, true);
    if ("status" in reservedAsId) {
      assert.equal(reservedAsId.status, 404);
    }
    const isolationStub = resolveIdentityProxyTarget("GET", [
      "workspace",
      "audit-events",
    ]);
    assert.equal("apiPath" in isolationStub, true);
    if ("apiPath" in isolationStub) {
      assert.equal(isolationStub.apiPath, "/api/v1/workspace/audit-events");
    }
    const productAudit = resolveIdentityProxyTarget("GET", ["audit-events"]);
    assert.equal("apiPath" in productAudit, true);
    if ("apiPath" in productAudit) {
      assert.equal(productAudit.apiPath, "/api/v1/audit-events");
    }
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const mutateList = resolveIdentityProxyTarget(method, ["audit-events"]);
      assert.equal("status" in mutateList, true, method);
      if ("status" in mutateList) {
        assert.equal(mutateList.status, 405);
      }
      const mutateRow = resolveIdentityProxyTarget(method, [
        "audit-events",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      ]);
      assert.equal("status" in mutateRow, true, `${method} row`);
      if ("status" in mutateRow) {
        // #58 has no GET /audit-events/{id}; the row is unknown (404).
        assert.equal(mutateRow.status, 404);
      }
    }
    const inventAlertWrite = resolveIdentityProxyTarget("POST", ["alerts"]);
    assert.equal("status" in inventAlertWrite, true);
    if ("status" in inventAlertWrite) {
      assert.equal(inventAlertWrite.status, 405);
    }
    const catalog = resolveIdentityProxyTarget("GET", ["alerts", "catalog"]);
    assert.equal("status" in catalog, true);
    if ("status" in catalog) {
      assert.equal(catalog.status, 404);
    }
    const resolve = resolveIdentityProxyTarget("POST", [
      "alerts",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "resolve",
    ]);
    assert.equal("status" in resolve, true);
    if ("status" in resolve) {
      assert.equal(resolve.status, 404);
    }
    const auditRowGet = resolveIdentityProxyTarget("GET", [
      "audit-events",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ]);
    assert.equal("status" in auditRowGet, true);
    if ("status" in auditRowGet) {
      assert.equal(auditRowGet.status, 404);
    }
  });

  it("does not treat reserved credential actions as vault ids", () => {
    const unknown = resolveIdentityProxyTarget("GET", ["credentials", "rotate"]);
    assert.equal("status" in unknown, true);
    if ("status" in unknown) {
      assert.equal(unknown.status, 404);
    }
    const inventedAudit = resolveIdentityProxyTarget("GET", [
      "credentials",
      "11111111-1111-4111-8111-111111111111",
      "audit",
    ]);
    assert.equal("status" in inventedAudit, true);
    if ("status" in inventedAudit) {
      assert.equal(inventedAudit.status, 404);
    }
    const listWrite = resolveIdentityProxyTarget("DELETE", ["credentials"]);
    assert.equal("status" in listWrite, true);
    if ("status" in listWrite) {
      assert.equal(listWrite.status, 405);
    }
  });

  it("does not treat reserved E3.1 paths as workflow ids", () => {
    const unknown = [
      ["workflows", "draft"],
      ["workflows", "not-a-uuid", "draft"],
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
    const catalogAsId = resolveIdentityProxyTarget("GET", [
      "workflows",
      "catalog",
    ]);
    assert.equal("apiPath" in catalogAsId, true);
    if ("apiPath" in catalogAsId) {
      assert.equal(catalogAsId.apiPath, "/api/v1/workflows/catalog");
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

  it("forwards If-Match on draft PUT", async () => {
    const seen: { headers?: Headers } = {};
    globalThis.fetch = (async (_input, init) => {
      seen.headers = new Headers(init?.headers);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await fetchIdentityControlPlane({
      method: "PUT",
      apiPath: "/api/v1/workflows/11111111-1111-4111-8111-111111111111/draft",
      instance: "/api/control-plane/workflows/11111111-1111-4111-8111-111111111111/draft",
      requestId: "draft-if-match-16x",
      identityHeaders: new Headers({
        "If-Match": "2",
        Authorization: "Bearer secret",
      }),
      body: JSON.stringify({ revision: 2, definitionYaml: "kind: Workflow" }),
      contentType: "application/json",
    });

    assert.equal(seen.headers?.get("If-Match"), "2");
    assert.equal(seen.headers?.get("Authorization"), null);
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

  it("streams artifact-download bytes without JSON-parsing the body", async () => {
    const seen: { url?: string; accept?: string | null } = {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.accept = new Headers(init?.headers).get("Accept");
      return new Response(new Uint8Array([4, 5, 6]), {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": 'attachment; filename="plan.json"',
          "Cache-Control": "no-store",
          [REQUEST_ID_HEADER]: "stream-request-16",
        },
      });
    }) as typeof fetch;

    const result = await fetchIdentityControlPlaneStream({
      method: "GET",
      apiPath: "/api/v1/artifact-downloads/88888888-8888-4888-8888-888888888888",
      instance:
        "/api/control-plane/artifact-downloads/88888888-8888-4888-8888-888888888888",
      requestId: "caller-stream-16xx",
      identityHeaders: new Headers({
        Cookie: "ff_session=opaque",
        Authorization: "Bearer secret",
      }),
    });

    assert.match(seen.url ?? "", /\/artifact-downloads\/88888888-8888-4888-8888-888888888888$/);
    assert.match(seen.accept ?? "", /octet-stream/);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.statusCode, 200);
      assert.equal(result.contentType, "application/octet-stream");
      assert.equal(result.cacheControl, "no-store");
      assert.equal(new Uint8Array(result.body)[0], 4);
      assert.equal(result.body.byteLength, 3);
    }
    assert.equal(
      sanitizeContentDisposition('attachment; filename="https://bucket.example/x"'),
      "attachment",
    );
  });
});

describe("pickConditionalHeaders", () => {
  it("forwards If-Match and never Authorization", () => {
    const forwarded = pickConditionalHeaders(
      new Headers({
        "If-Match": " 3 ",
        Authorization: "Bearer secret",
      }),
    );
    assert.equal(forwarded.get("If-Match"), "3");
    assert.equal(forwarded.get("Authorization"), null);
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
