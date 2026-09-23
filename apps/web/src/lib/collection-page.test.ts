import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COLLECTION_PAGE_DEFAULT_LIMIT,
  COLLECTION_PAGE_INVALID_DETAIL,
  appendCollectionItems,
  appendCollectionPageQuery,
  collectionPageHasNext,
  invalidCollectionPageProblem,
  openCollectionPath,
  parseCollectionPage,
  readCollectionPageFields,
  scrubCollectionPageProblem,
  validateCollectionPageQuery,
} from "./collection-page.ts";
import { parseApprovalList } from "./approval.ts";
import { parseAlertList } from "./alert.ts";
import { parseExecutionList } from "./execution.ts";

const SECRET_Q = "sk-sample";
const ECHOED = "cursor-token-should-not-echo";

describe("collection page helper", () => {
  it("parses the page object and never yields null items", () => {
    const page = parseCollectionPage(
      { items: null, limit: 25, cursor: "", next: "n1" },
      (item) => item,
    );
    assert.deepEqual(page.items, []);
    assert.equal(page.limit, 25);
    assert.equal(page.cursor, "");
    assert.equal(page.next, "n1");

    const filled = parseCollectionPage(
      {
        items: [{ id: "a" }, { id: "" }, null],
        limit: 50,
        cursor: "c0",
        next: "",
      },
      (item) => {
        if (!item || typeof item !== "object") {
          return null;
        }
        const id = (item as { id?: string }).id ?? "";
        return id ? { id } : null;
      },
    );
    assert.deepEqual(filled.items, [{ id: "a" }]);
    assert.equal(filled.cursor, "c0");
    assert.equal(collectionPageHasNext(filled), false);
    assert.equal(collectionPageHasNext({ next: "n1" }), true);
  });

  it("accepts a bare array and an items-only body from older clients", () => {
    const fromArray = parseCollectionPage(["one"], (item) =>
      typeof item === "string" ? item : null,
    );
    assert.deepEqual(fromArray.items, ["one"]);
    assert.equal(fromArray.limit, COLLECTION_PAGE_DEFAULT_LIMIT);
    assert.equal(fromArray.cursor, "");
    assert.equal(fromArray.next, "");

    const legacy = readCollectionPageFields({ items: [{ id: "a" }] });
    assert.equal(legacy.limit, COLLECTION_PAGE_DEFAULT_LIMIT);
    assert.equal(legacy.next, "");
  });

  it("keeps list parsers working when the body is a page object", () => {
    const execution = {
      id: "33333333-3333-4333-8333-333333333333",
      workflowId: "11111111-1111-4111-8111-111111111111",
      workflowVersionId: "22222222-2222-4222-8222-222222222222",
      status: "succeeded",
    };
    const executions = parseExecutionList({
      items: [execution],
      limit: 50,
      cursor: "",
      next: "exec-next",
    });
    assert.equal(executions.length, 1);
    assert.equal(executions[0]?.status, "succeeded");
    assert.equal(
      readCollectionPageFields({
        items: [execution],
        limit: 50,
        cursor: "",
        next: "exec-next",
      }).next,
      "exec-next",
    );

    const approval = parseApprovalList({
      items: [
        {
          id: "44444444-4444-4444-8444-444444444444",
          workflowId: "11111111-1111-4111-8111-111111111111",
          workflowVersionId: "22222222-2222-4222-8222-222222222222",
          status: "pending",
          nodeId: "approve",
          nodeName: "Approve",
          operation: "workflow.execute",
        },
      ],
      limit: 50,
      cursor: "",
      next: "",
    });
    assert.equal(approval.length, 1);

    const alerts = parseAlertList({
      items: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          kind: "authorization",
          severity: "high",
          status: "open",
          action: "deny",
          code: "denied",
          outcome: "denied",
        },
      ],
      limit: 10,
      cursor: "a0",
      next: "a1",
    });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]?.kind, "authorization");
  });

  it("appends limit, cursor, and q without putting secrets in the query", () => {
    const opened = appendCollectionPageQuery("/workflows?folderId=unfiled", {
      q: "Deploy",
      limit: 50,
      cursor: "page-2",
    });
    assert.equal(opened.ok, true);
    if (opened.ok) {
      const params = new URLSearchParams(opened.path.split("?")[1]);
      assert.equal(params.get("folderId"), "unfiled");
      assert.equal(params.get("q"), "Deploy");
      assert.equal(params.get("limit"), "50");
      assert.equal(params.get("cursor"), "page-2");
    }

    const stripped = appendCollectionPageQuery(
      "/credentials?secret=hunter2&kubeconfig=leak",
      { q: "prod" },
    );
    assert.equal(stripped.ok, true);
    if (stripped.ok) {
      assert.equal(stripped.path, "/credentials?q=prod");
      assert.doesNotMatch(stripped.path, /hunter2|leak|secret|kubeconfig/);
    }
  });

  it("fail-closes bad limit, cursor, and q without echoing them", () => {
    for (const input of [
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { q: "a".repeat(201) },
      { q: "line\nbreak" },
      { q: SECRET_Q },
      { cursor: `Bearer ${ECHOED}` },
      { cursor: ECHOED.padEnd(3000, "x") },
    ]) {
      const validated = validateCollectionPageQuery(input);
      assert.equal(validated.ok, false);
      if (!validated.ok) {
        assert.equal(validated.detail, COLLECTION_PAGE_INVALID_DETAIL);
        assert.equal(validated.detail.includes(SECRET_Q), false);
        assert.equal(validated.detail.includes(ECHOED), false);
      }
      const opened = openCollectionPath("/workflows", input);
      assert.equal(opened.ok, false);
      if (!opened.ok) {
        assert.equal(opened.problem.detail, COLLECTION_PAGE_INVALID_DETAIL);
        assert.equal(opened.problem.instance.includes("?"), false);
        assert.equal(JSON.stringify(opened.problem).includes(SECRET_Q), false);
        assert.equal(JSON.stringify(opened.problem).includes(ECHOED), false);
      }
    }

    const local = invalidCollectionPageProblem(
      `/workflows?q=${encodeURIComponent(SECRET_Q)}`,
    );
    assert.equal(local.detail, COLLECTION_PAGE_INVALID_DETAIL);
    assert.equal(local.instance, "/workflows");
    assert.equal(local.instance.includes(SECRET_Q), false);
  });

  it("scrubs a 400 that echoes cursor or q", () => {
    const problem = scrubCollectionPageProblem({
      type: "urn:flowforge:problem:invalid-request",
      title: "Invalid Request",
      status: 400,
      detail: `bad cursor ${ECHOED} and q ${SECRET_Q}`,
      instance: `/api/v1/workflows?cursor=${ECHOED}&q=deploy&folderId=unfiled`,
      code: "invalid-request",
      request_id: "req-16",
    });
    assert.equal(problem.detail, COLLECTION_PAGE_INVALID_DETAIL);
    assert.equal(problem.detail.includes(ECHOED), false);
    assert.equal(problem.request_id, "req-16");
    assert.equal(problem.instance.includes(ECHOED), false);
    assert.match(problem.instance, /folderId=unfiled/);
    const forbidden = scrubCollectionPageProblem({
      type: "urn:flowforge:problem:forbidden",
      title: "Forbidden",
      status: 403,
      detail: "execution.view is required.",
      instance: "/api/v1/executions",
      code: "forbidden",
      request_id: "req-17",
    });
    assert.equal(forbidden.detail, "execution.view is required.");
  });

  it("walks pages until next is empty and dedupes by id", () => {
    const first = { items: [{ id: "a" }], limit: 1, cursor: "", next: "n1" };
    const second = { items: [{ id: "a" }, { id: "b" }], limit: 1, cursor: "n1", next: "" };
    const page = parseCollectionPage(first, (item) =>
      item && typeof item === "object" ? (item as { id: string }) : null,
    );
    assert.equal(collectionPageHasNext(page), true);
    const follow = appendCollectionPageQuery("/executions?status=failed&limit=1", {
      limit: page.limit,
      cursor: page.next,
    });
    assert.equal(follow.ok, true);
    if (follow.ok) {
      assert.match(follow.path, /cursor=n1/);
      assert.match(follow.path, /status=failed/);
      assert.match(follow.path, /limit=1/);
    }
    const more = parseCollectionPage(second, (item) =>
      item && typeof item === "object" ? (item as { id: string }) : null,
    );
    const merged = appendCollectionItems(page.items, more.items);
    assert.deepEqual(merged.map((item) => item.id), ["a", "b"]);
    assert.equal(collectionPageHasNext(more), false);
  });
});
