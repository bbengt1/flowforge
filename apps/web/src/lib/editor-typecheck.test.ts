import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { IdentityClientResult } from "./identity-client.ts";
import type { DevIdentity } from "./identity-headers.ts";
import {
  TYPECHECK_COPY,
  TYPECHECK_DEBOUNCE_MS,
  createTypecheckDebouncer,
  parseTypecheckResponse,
  typecheckErrorsByNode,
  typecheckOutcome,
  typecheckSummary,
  typecheckView,
  typecheckWorkflowDraft,
  workflowDraftTypecheckPath,
  workflowTypecheckQueryKey,
} from "./editor-typecheck.ts";

const ok = (data: unknown): IdentityClientResult<unknown> => ({
  ok: true,
  statusCode: 200,
  requestId: "r",
  data,
});

const fail = (statusCode: number, code: string, retryAfterSeconds?: number): IdentityClientResult<unknown> => ({
  ok: false,
  statusCode,
  requestId: "r",
  problem: {
    type: `urn:flowforge:problem:${code}`,
    title: code,
    status: statusCode,
    detail: "d",
    instance: "/api/v1/x",
    code,
    request_id: "r",
  },
  ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
});

const errorBody = {
  ok: false,
  catalogRevision: 1,
  draftRevision: 4,
  expressions: [],
  errors: [
    { path: "nodes[1].with.expr", nodeId: "check", code: "expression-ref-not-ancestor", message: "Reference is not an ancestor." },
    { path: "nodes[1].with.when", nodeId: "check", code: "expression-type", message: "Wrong type." },
    { path: "nodes[2].with.expr", nodeId: "map", code: "expression-cost", message: "Too costly." },
    { path: "spec", code: "workflow-invalid", message: "Invalid." },
  ],
};

class FakeTimers {
  now = 0;
  private next = 1;
  private pending = new Map<number, { at: number; fn: () => void }>();
  set = (fn: () => void, ms: number) => {
    const id = this.next++;
    this.pending.set(id, { at: this.now + ms, fn });
    return id;
  };
  clear = (handle: unknown) => {
    this.pending.delete(handle as number);
  };
  advance(ms: number) {
    this.now += ms;
    for (const [id, t] of [...this.pending]) {
      if (t.at <= this.now) {
        this.pending.delete(id);
        t.fn();
      }
    }
  }
}

describe("typecheck debounce", () => {
  it("defaults to 1.5s and never goes under 1s", () => {
    assert.equal(TYPECHECK_DEBOUNCE_MS, 1500);
    assert.equal(createTypecheckDebouncer(() => {}).delayMs, 1500);
    assert.equal(createTypecheckDebouncer(() => {}, { delayMs: 10 }).delayMs, 1000);
  });

  it("collapses a burst into one trailing call with the last value", () => {
    const timers = new FakeTimers();
    const fired: number[] = [];
    const d = createTypecheckDebouncer<number>((v) => fired.push(v), { timers });
    for (let rev = 1; rev <= 30; rev++) {
      d.request(rev);
      timers.advance(100);
    }
    assert.deepEqual(fired, []);
    timers.advance(1400);
    assert.deepEqual(fired, [30]);
  });

  it("does not fire before the window and cancel drops the pending call", () => {
    const timers = new FakeTimers();
    const fired: number[] = [];
    const d = createTypecheckDebouncer<number>((v) => fired.push(v), { timers });
    d.request(1);
    timers.advance(1499);
    assert.deepEqual(fired, []);
    timers.advance(1);
    assert.deepEqual(fired, [1]);
    d.request(2);
    d.cancel();
    timers.advance(5000);
    assert.deepEqual(fired, [1]);
  });
});

describe("typecheck outcome: unavailable is never a pass", () => {
  it("429 is unavailable and keeps Retry-After", () => {
    const o = typecheckOutcome(fail(429, "rate-limited", 12));
    assert.deepEqual(o, { kind: "unavailable", statusCode: 429, retryAfterSeconds: 12 });
    const v = typecheckView({ outcome: o, pending: false, savedRevision: 4, dirty: false });
    assert.equal(v.state, "unavailable");
    assert.equal(typecheckSummary(v), TYPECHECK_COPY.unavailable);
  });

  it("503 (limiter missing, rate store down, network) is unavailable", () => {
    for (const code of ["dependency-unavailable", "control-plane-unreachable"]) {
      assert.equal(typecheckOutcome(fail(503, code)).kind, "unavailable");
    }
    assert.equal(typecheckOutcome(fail(500, "internal")).kind, "unavailable");
  });

  it("thrown transport errors are unavailable", async () => {
    const identity = {} as DevIdentity;
    const outcome = await typecheckWorkflowDraft(identity, "wf", (async () => {
      throw new TypeError("network");
    }) as never);
    assert.equal(outcome.kind, "unavailable");
  });

  it("403/404 are refused, not passed", () => {
    assert.equal(typecheckOutcome(fail(403, "forbidden")).kind, "refused");
    assert.equal(typecheckOutcome(fail(404, "not-found")).kind, "refused");
  });

  it("a malformed 200 is not trusted as a pass", () => {
    assert.equal(typecheckOutcome(ok({ ok: true })).kind, "unavailable");
    assert.equal(
      typecheckOutcome(ok({ ok: true, draftRevision: 1, errors: [{ code: "x", message: "y" }] })).kind,
      "unavailable",
    );
    assert.equal(parseTypecheckResponse(null), null);
  });

  it("POSTs with no body through the proxy (CSRF path) to the typecheck route", async () => {
    const calls: unknown[][] = [];
    const outcome = await typecheckWorkflowDraft({} as DevIdentity, "wf-1", (async (...args: unknown[]) => {
      calls.push(args);
      return ok({ ok: true, catalogRevision: 1, draftRevision: 2, expressions: [], errors: [] });
    }) as never);
    assert.deepEqual(outcome, { kind: "passed", draftRevision: 2 });
    assert.equal(calls[0][0], workflowDraftTypecheckPath("wf-1"));
    assert.equal(calls[0][0], "/workflows/wf-1/draft/typecheck");
    const init = calls[0][2] as { method: string; body?: unknown; omitCsrf?: boolean };
    assert.equal(init.method, "POST");
    assert.equal(init.body, undefined);
    assert.notEqual(init.omitCsrf, true);
  });
});

describe("typecheck stale results", () => {
  const passed = typecheckOutcome(ok({ ok: true, catalogRevision: 1, draftRevision: 4, expressions: [], errors: [] }));

  it("a pass for the saved revision is a pass", () => {
    assert.equal(typecheckView({ outcome: passed, pending: false, savedRevision: 4, dirty: false }).state, "passed");
  });

  it("a pass while the buffer has unsaved changes is stale", () => {
    const v = typecheckView({ outcome: passed, pending: false, savedRevision: 4, dirty: true });
    assert.deepEqual(v, { state: "stale", reason: "unsaved" });
    assert.equal(typecheckSummary(v), TYPECHECK_COPY.staleUnsaved);
  });

  it("a fail while the buffer has unsaved changes is stale (mutes node badges)", () => {
    const failed = typecheckOutcome(ok(errorBody));
    const v = typecheckView({ outcome: failed, pending: false, savedRevision: 4, dirty: true });
    assert.deepEqual(v, { state: "stale", reason: "unsaved" });
    assert.equal(typecheckSummary(v), TYPECHECK_COPY.staleUnsaved);
  });

  it("a late response for an older revision is stale, pass or fail", () => {
    assert.deepEqual(
      typecheckView({ outcome: passed, pending: false, savedRevision: 5, dirty: false }),
      { state: "stale", reason: "revision" },
    );
    const failed = typecheckOutcome(ok(errorBody));
    assert.equal(typecheckView({ outcome: failed, pending: false, savedRevision: 5, dirty: false }).state, "stale");
  });

  it("pending shows checking; query keys differ per revision", () => {
    assert.equal(typecheckView({ outcome: passed, pending: true, savedRevision: 4, dirty: false }).state, "checking");
    assert.notDeepEqual(workflowTypecheckQueryKey("s", "wf", 4), workflowTypecheckQueryKey("s", "wf", 5));
  });
});

describe("typecheck per-node mapping", () => {
  it("groups errors by nodeId and keeps nodeless errors at workflow level", () => {
    const outcome = typecheckOutcome(ok(errorBody));
    assert.equal(outcome.kind, "failed");
    if (outcome.kind !== "failed") return;
    const { byNode, workflow } = typecheckErrorsByNode(outcome.errors);
    assert.deepEqual([...byNode.keys()], ["check", "map"]);
    assert.equal(byNode.get("check")?.length, 2);
    assert.equal(byNode.get("map")?.[0].code, "expression-cost");
    assert.equal(workflow.length, 1);
    assert.equal(workflow[0].code, "workflow-invalid");
    const v = typecheckView({ outcome, pending: false, savedRevision: 4, dirty: false });
    assert.equal(typecheckSummary(v), "4 expression problems in the saved draft.");
  });

  it("drops unknown fields so nothing extra can be rendered", () => {
    const parsed = parseTypecheckResponse({
      ...errorBody,
      errors: [{ ...errorBody.errors[0], source: "input.secret", value: "x" }],
    });
    assert.deepEqual(Object.keys(parsed!.errors[0]).sort(), ["code", "message", "nodeId", "path"]);
  });
});

describe("typecheck path encoding", () => {
  it("encodeURIComponent-encodes workflowId in the typecheck URL", () => {
    assert.equal(
      workflowDraftTypecheckPath("wf-1"),
      "/workflows/wf-1/draft/typecheck",
    );
    assert.equal(
      workflowDraftTypecheckPath("wf/with spaces"),
      "/workflows/wf%2Fwith%20spaces/draft/typecheck",
    );
    assert.equal(
      workflowDraftTypecheckPath("a+b?c=d#e"),
      "/workflows/a%2Bb%3Fc%3Dd%23e/draft/typecheck",
    );
  });

  it("POSTs the encoded path through the proxy", async () => {
    const calls: unknown[][] = [];
    const id = "team/wf 1";
    await typecheckWorkflowDraft({} as DevIdentity, id, (async (...args: unknown[]) => {
      calls.push(args);
      return ok({ ok: true, catalogRevision: 1, draftRevision: 2, expressions: [], errors: [] });
    }) as never);
    assert.equal(calls[0][0], workflowDraftTypecheckPath(id));
    assert.equal(calls[0][0], "/workflows/team%2Fwf%201/draft/typecheck");
  });
});
