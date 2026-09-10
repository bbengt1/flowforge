import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  ADV013_EMBED_ORIGIN,
  ADV013_EVIL_ORIGIN,
  ADV013_PORTAL_ORIGIN,
} from "./adv013-cross-origin-contract.ts";
import { exchangeEmbedAssertion } from "./embed-client.ts";
import {
  EMBED_EXCHANGE_PATH,
  EMBED_MOUNT_PREFIX,
  assertionFromURL,
  parseEmbedHostDisplay,
} from "./embed-contract.ts";
import { clearDevIdentity } from "./dev-identity.ts";
import { clearEmbedVerified } from "./embed-tenancy-client.ts";
import {
  E12_CHLOE_CHECKLIST,
  E12_CHLOE_EPIC,
  E12_CHLOE_HARNESS,
  E12_CHLOE_HITS,
  E12_CHLOE_ID,
  E12_CHLOE_RULES,
  E12_CHLOE_SKIP,
  E12_CHLOE_STORY,
  e12ChloeAcceptHostAssertion,
  e12ChloeApprovalBanner,
  e12ChloeApprovalDecide,
  e12ChloeExchangeBody,
  e12ChloeFormAssertion,
  e12ChloeHostAssertionMessage,
  e12ChloeHostQueryIsNotChrome,
  e12ChloeIframeSrc,
  e12ChloeMissingSessionChromeMessage,
  e12ChloeReplayBanner,
  e12ChloeReplayProblem,
  e12ChloeSampleAssertion,
  e12ChloeSessionChrome,
  e12ChloeSessionChip,
  e12ChloeSessionExpiryBanner,
} from "./e12-chloe-ui-contract.ts";
import type { ApprovalBinding, ApprovalRequest } from "./approval-types.ts";
import { problemBannerHeading } from "./problem.ts";
import { emptyBrowserSession } from "./session.ts";
import { loadCurrentSession } from "./session-client.ts";
import {
  SESSION_EMBED_CHROME_SOURCE,
  sessionEmbedChromeFromHostDisplay,
} from "./session-embed-contract.ts";
import { clearSession, getSessionSnapshot, setActiveSession } from "./session-store.ts";

const originalFetch = globalThis.fetch;
const SAMPLE_JWS = e12ChloeSampleAssertion();

const memory = new Map<string, string>();
const sessionShim = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => {
    memory.set(key, value);
  },
  removeItem: (key: string) => {
    memory.delete(key);
  },
  clear: () => memory.clear(),
  key: (index: number) => [...memory.keys()][index] ?? null,
  get length() {
    return memory.size;
  },
};
Object.defineProperty(globalThis, "sessionStorage", {
  value: sessionShim,
  configurable: true,
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearSession();
  memory.clear();
  clearDevIdentity();
  clearEmbedVerified();
});

const GET_SESSION = {
  session: {
    id: "sess-e12",
    idle_expires_at: "2026-09-10T21:00:00.000Z",
    absolute_expires_at: "2026-09-11T07:00:00.000Z",
    embed: {
      mode: "embed",
      sdk: "embed.v1",
      tenantId: "ten-1",
      tenantSlug: "acme",
      tenantName: "Acme",
      workbenchKey: "ops",
      workspaceId: "ws-1",
      workspaceName: "Ops",
      capabilities: ["workflow.view"],
    },
  },
  principal: {
    issuer: "https://portal.test:8443",
    external_subject: "ada",
    display_name: "Ada",
  },
  csrf_token: "csrf-e12",
};

function binding(overrides: Partial<ApprovalBinding> = {}): ApprovalBinding {
  return {
    workflowVersionId: "11111111-1111-4111-8111-111111111111",
    workflowVersionDigest: "sha256:aaaa",
    targetId: "33333333-3333-4333-8333-333333333333",
    targetKind: "cluster_target",
    targetName: "prod",
    targetVersionId: "",
    targetDigest: "",
    policyResourceId: "44444444-4444-4444-8444-444444444444",
    policyRevisionId: "44444444-4444-4444-8444-444444444444",
    policyRevisionNumber: 1,
    policyDigest: "sha256:policy1",
    operation: "workflow.execute",
    nodeId: "",
    nodeName: "",
    expiresAt: "2099-01-01T00:00:00Z",
    bindingFingerprint: "fp-1",
    ...overrides,
  };
}

function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    status: "pending",
    binding: overrides.binding ?? binding(),
    validity: {
      current: true,
      reason: "pending",
      changedFields: [],
      currentBinding: null,
    },
    requestedBy: "operator",
    requestedAt: "2026-09-09T00:00:00Z",
    decidedBy: "",
    decidedAt: "",
    note: "",
    workflowId: "77777777-7777-4777-8777-777777777777",
    workflowName: "rollout",
    executionId: "",
    executionStatus: "",
    approverRole: "approver",
    permittedActions: ["approve", "reject"],
    ...overrides,
  };
}

describe("E12.1 Chloe UI checklist", () => {
  it("cites #182 / #181 and keeps the issue open", () => {
    assert.equal(E12_CHLOE_ID, "E12.1-chloe-ui");
    assert.equal(E12_CHLOE_STORY, 182);
    assert.equal(E12_CHLOE_EPIC, 181);
    assert.equal(E12_CHLOE_RULES.keep182Open, true);
    assert.equal(E12_CHLOE_HARNESS.evidenceDir, "docs/reference/e12-security-evidence");
    assert.deepEqual([...E12_CHLOE_CHECKLIST], [
      "iframe-embed-v1-body-only-exchange",
      "postmessage-or-form-assertion",
      "replay-same-assertion-409",
      "session-chrome-from-get-session",
      "host-query-not-chrome",
      "existing-expired-revoked-session-chrome",
      "expired-approval-banner-decide-disabled",
    ]);
    const ids = E12_CHLOE_HITS.map((hit) => hit.id);
    assert.deepEqual(ids, [
      "embed-exchange-replay",
      "session-chrome",
      "expired-approval",
    ]);
    assert.ok(E12_CHLOE_SKIP.includes("ssrf"));
    assert.ok(E12_CHLOE_SKIP.includes("fencing"));
    assert.equal(E12_CHLOE_RULES.noNewOperatorScreens, true);
  });

  it("frames /embed/v1 without putting the assertion in the URL", () => {
    const framed = e12ChloeIframeSrc();
    assert.equal(framed.mount, EMBED_MOUNT_PREFIX);
    assert.ok(framed.src.startsWith(`${ADV013_EMBED_ORIGIN}/embed/v1/`));
    assert.equal(framed.src.includes("assertion="), false);
    assert.equal(framed.assertionFromUrl, null);
    assert.equal(assertionFromURL(framed.src), null);
    assert.equal(framed.displayOnly, true);

    const leaked = e12ChloeIframeSrc({
      leakedSearch: "?assertion=eyJhbGciOiJFZERTQSJ9.e30.sig&tenant=evil",
    });
    assert.equal(leaked.rejectedAssertion, true);
    assert.equal(leaked.src.includes("assertion="), false);
    assert.equal(e12ChloeHostQueryIsNotChrome("?tenant=evil&workbench=prod"), true);
  });

  it("accepts body-only postMessage or form assertions from an allowlisted host", () => {
    const message = e12ChloeHostAssertionMessage(SAMPLE_JWS);
    const allowlist = [ADV013_PORTAL_ORIGIN];
    const posted = e12ChloeAcceptHostAssertion(
      message,
      ADV013_PORTAL_ORIGIN,
      allowlist,
    );
    assert.equal(posted.accepted, true);
    assert.equal(posted.via, "postMessage");
    assert.equal(posted.assertion, SAMPLE_JWS);

    const hostile = e12ChloeAcceptHostAssertion(
      message,
      ADV013_EVIL_ORIGIN,
      allowlist,
    );
    assert.equal(hostile.accepted, false);

    const form = e12ChloeFormAssertion(SAMPLE_JWS);
    assert.equal(form.via, "form");
    assert.equal(form.body.assertion, SAMPLE_JWS);
    assert.equal(form.body.sdk, "embed.v1");
    assert.equal("workspaceId" in form.body, false);

    const exchange = e12ChloeExchangeBody(SAMPLE_JWS);
    assert.equal(exchange.path, EMBED_EXCHANGE_PATH);
    assert.equal(exchange.credentials, "include");
    assert.equal(exchange.assertionIn, "body");
    assert.equal(exchange.assertionInUrl, false);
  });

  it("exchanges once in the iframe then replays the same assertion as 409", async () => {
    const framed = e12ChloeIframeSrc();
    const received = e12ChloeAcceptHostAssertion(
      e12ChloeHostAssertionMessage(SAMPLE_JWS),
      ADV013_PORTAL_ORIGIN,
      [ADV013_PORTAL_ORIGIN],
    );
    assert.equal(received.accepted, true);
    assert.equal(framed.src.includes("assertion="), false);

    let exchanges = 0;
    const seenBodies: unknown[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/embed/exchange")) {
        exchanges += 1;
        seenBodies.push(JSON.parse(String(init?.body)));
        if (exchanges === 1) {
          return new Response(
            JSON.stringify({
              ...GET_SESSION,
              workspace: {
                id: "ws-1",
                tenant_id: "ten-1",
                workbench_key: "ops",
                name: "Ops",
                status: "active",
              },
              tenant: { id: "ten-1", slug: "acme", name: "Acme", status: "active" },
              capabilities: ["workflow.view"],
            }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify(e12ChloeReplayProblem("req-replay-2")), {
          status: 409,
          headers: { "Content-Type": "application/problem+json" },
        });
      }
      if (url.endsWith("/session")) {
        return new Response(JSON.stringify(GET_SESSION), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("nope", { status: 500 });
    }) as typeof fetch;

    const firstHolder = { assertion: received.assertion };
    const first = await exchangeEmbedAssertion(firstHolder);
    assert.equal(first.ok, true);
    assert.equal(firstHolder.assertion, "");
    assert.equal((seenBodies[0] as { assertion: string }).assertion, SAMPLE_JWS);
    assert.equal("workspaceId" in (seenBodies[0] as object), false);

    const chrome = getSessionSnapshot();
    assert.equal(chrome.active, true);
    assert.equal(chrome.embedChrome?.source, SESSION_EMBED_CHROME_SOURCE);
    assert.equal(chrome.embedChrome?.tenantSlug, "acme");
    assert.equal(chrome.embedChrome?.workbenchKey, "ops");
    assert.equal(chrome.embedChrome?.displayName, "Ada");
    const verified = e12ChloeSessionChrome(GET_SESSION);
    assert.equal(verified.source, SESSION_EMBED_CHROME_SOURCE);
    assert.equal(verified.fromHostQuery, false);
    assert.equal(verified.chip, "Verified · acme / ops · Ops · Ada");

    const replayHolder = { assertion: SAMPLE_JWS };
    const replay = await exchangeEmbedAssertion(replayHolder);
    assert.equal(replay.ok, false);
    if (!replay.ok) {
      assert.equal(replay.statusCode, 409);
      const banner = e12ChloeReplayBanner(replay.problem);
      assert.equal(banner.status, 409);
      assert.equal(banner.heading, "Conflict (409)");
      assert.match(banner.detail, /single-use|already used/);
      assert.equal(problemBannerHeading(replay.problem), "Conflict (409)");
    }
    assert.equal(replayHolder.assertion, "");
    assert.equal(exchanges, 2);
  });

  it("drives EmbedChrome from GET /session and ignores host query", async () => {
    const hostileSearch = "?tenant=evil&workbench=prod&host=https://evil.test&displayName=Hostile";
    assert.equal(e12ChloeHostQueryIsNotChrome(hostileSearch), true);
    assert.equal(
      sessionEmbedChromeFromHostDisplay(
        parseEmbedHostDisplay(new URLSearchParams(hostileSearch.slice(1))),
      ),
      null,
    );

    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith("/session")) {
        return new Response(JSON.stringify(GET_SESSION), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("nope", { status: 500 });
    }) as typeof fetch;

    const loaded = await loadCurrentSession();
    assert.equal(loaded.ok, true);
    const snapshot = getSessionSnapshot();
    assert.equal(snapshot.embedChrome?.source, "get-session");
    assert.equal(snapshot.embedChrome?.tenantSlug, "acme");
    assert.notEqual(snapshot.embedChrome?.tenantSlug, "evil");
    assert.match(e12ChloeMissingSessionChromeMessage(), /not chrome authority/);
  });

  it("reuses existing stale/expired session chrome on 401 (no new chrome)", async () => {
    setActiveSession({
      ...emptyBrowserSession(),
      subject: "ada",
      idleExpiresAt: "2026-09-10T21:00:00.000Z",
      absoluteExpiresAt: "2026-09-11T07:00:00.000Z",
    });
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          type: "urn:flowforge:problem:unauthenticated",
          title: "Unauthenticated",
          status: 401,
          detail: "Session is missing or stale.",
          instance: "/session",
          code: "unauthenticated",
          request_id: "req-401",
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/problem+json" },
        },
      )) as typeof fetch;

    const result = await loadCurrentSession();
    assert.equal(result.ok, false);
    const snapshot = getSessionSnapshot();
    assert.equal(snapshot.stale, true);
    assert.equal(snapshot.active, false);
    assert.equal(snapshot.embedChrome, null);

    const banner = e12ChloeSessionExpiryBanner(snapshot);
    assert.equal(banner.visible, true);
    if (banner.visible) {
      assert.equal(banner.title, "Stale session");
      assert.equal(banner.kind, "stale");
      assert.equal(banner.role, "alert");
    }
    assert.equal(e12ChloeSessionChip(snapshot), "Session stale");

    const expiredAt = Date.parse("2026-09-10T12:00:00.000Z");
    const expiredBanner = e12ChloeSessionExpiryBanner(
      {
        active: true,
        stale: false,
        session: {
          ...emptyBrowserSession(),
          subject: "ada",
          idleExpiresAt: "2026-09-10T11:00:00.000Z",
          absoluteExpiresAt: "2026-09-10T11:30:00.000Z",
        },
      },
      expiredAt,
    );
    assert.equal(expiredBanner.visible, true);
    if (expiredBanner.visible) {
      assert.equal(expiredBanner.title, "Session expired");
      assert.equal(expiredBanner.kind, "expired");
    }
    assert.equal(
      e12ChloeSessionChip(
        {
          active: true,
          stale: false,
          session: {
            ...emptyBrowserSession(),
            subject: "ada",
            idleExpiresAt: "2026-09-10T11:00:00.000Z",
            absoluteExpiresAt: "2026-09-10T11:30:00.000Z",
          },
        },
        expiredAt,
      ),
      "ada · Session expired",
    );
  });

  it("shows the expired approval banner and disables decide", () => {
    const expired = approval({
      status: "expired",
      binding: binding({ expiresAt: "2020-01-01T00:00:00Z" }),
      validity: {
        current: false,
        reason: "expired",
        changedFields: [],
        currentBinding: null,
      },
    });
    const banner = e12ChloeApprovalBanner(expired);
    assert.equal(banner.visible, true);
    if (banner.visible) {
      assert.equal(banner.title, "Approval expired");
      assert.equal(banner.role, "alert");
      assert.match(banner.detail, /expired/);
    }
    const decide = e12ChloeApprovalDecide(
      expired,
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      ["approval.decide"],
    );
    assert.equal(decide.canDecide, false);
    assert.equal(decide.approveDisabled, true);
    assert.equal(decide.rejectDisabled, true);

    const current = approval();
    const open = e12ChloeApprovalBanner(current);
    assert.equal(open.visible, false);
    const openDecide = e12ChloeApprovalDecide(
      current,
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      ["approval.decide"],
    );
    assert.equal(openDecide.canDecide, true);
    assert.equal(openDecide.approveDisabled, false);
  });
});
