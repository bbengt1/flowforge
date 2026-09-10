import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEmbedHostDisplay } from "./embed-contract.ts";
import {
  SESSION_EMBED_API_PR,
  SESSION_EMBED_CHROME_HELP,
  SESSION_EMBED_CHROME_RULES,
  SESSION_EMBED_CHROME_SOURCE,
  SESSION_EMBED_DRAFT_ASSUMPTIONS,
  SESSION_EMBED_EPIC,
  SESSION_EMBED_EXISTING_PATHS,
  SESSION_EMBED_GET_PATH,
  SESSION_EMBED_RETARGET,
  SESSION_EMBED_ROUTE_MAP_SOURCE,
  SESSION_EMBED_STORY,
  SESSION_EMBED_WAITING_HELP,
  capChromeCapabilities,
  isSessionEmbedProxySegments,
  isVerifiedSessionEmbedChrome,
  parseSessionEmbedChrome,
  retargetSessionEmbedApiPath,
  sessionEmbedAsVerifiedWorkspace,
  sessionEmbedChromeFromHostDisplay,
  sessionEmbedChromeFromPeekedAssertion,
  sessionEmbedChromeLabel,
  sessionEmbedGetPath,
} from "./session-embed-contract.ts";

const GET_SESSION = {
  session: {
    id: "sess-1",
    idle_expires_at: "2026-09-10T21:00:00.000Z",
    embed: {
      tenantId: "ten-1",
      workbenchKey: "ops",
      workspaceId: "ws-1",
      capabilities: ["workflow.view", "credential.view"],
    },
  },
  principal: {
    issuer: "https://idp.example",
    external_subject: "ada",
  },
  csrf_token: "csrf-1",
};

describe("session-embed-contract", () => {
  it("cites ADV-021 draft retarget points for Jonny's session map", () => {
    assert.equal(SESSION_EMBED_STORY, 151);
    assert.equal(SESSION_EMBED_EPIC, 130);
    assert.equal(SESSION_EMBED_API_PR, 127);
    assert.equal(SESSION_EMBED_ROUTE_MAP_SOURCE, "adv021-#151");
    assert.equal(SESSION_EMBED_GET_PATH, "/session");
    assert.equal(sessionEmbedGetPath(), "/api/v1/session");
    assert.deepEqual(SESSION_EMBED_EXISTING_PATHS, ["/session", "/session/refresh"]);
    assert.equal(retargetSessionEmbedApiPath("/api/v1/session"), "/api/v1/session");
    assert.equal(retargetSessionEmbedApiPath("/session/refresh"), "/session/refresh");
    assert.equal(isSessionEmbedProxySegments(["session"]), true);
    assert.equal(isSessionEmbedProxySegments(["session", "refresh"]), true);
    assert.equal(isSessionEmbedProxySegments(["embed", "exchange"]), false);
    assert.equal(SESSION_EMBED_DRAFT_ASSUMPTIONS.method, "GET");
    assert.equal(SESSION_EMBED_DRAFT_ASSUMPTIONS.path, "/api/v1/session");
    assert.equal(SESSION_EMBED_DRAFT_ASSUMPTIONS.csrf, false);
    assert.equal(SESSION_EMBED_DRAFT_ASSUMPTIONS.embedObject, "session.embed");
    assert.equal(SESSION_EMBED_DRAFT_ASSUMPTIONS.exchangeIsNotChrome, true);
    assert.equal(SESSION_EMBED_RETARGET.routeMap, "adv021-#151");
    assert.match(SESSION_EMBED_RETARGET.getSession, /GET \/api\/v1\/session/);
    assert.match(SESSION_EMBED_RETARGET.notChrome, /peeked JWS/);
    assert.equal(SESSION_EMBED_CHROME_RULES.driveFromGetSession, true);
    assert.equal(SESSION_EMBED_CHROME_RULES.ignoreHostQuery, true);
    assert.equal(SESSION_EMBED_CHROME_RULES.ignorePeekedAssertion, true);
    assert.equal(SESSION_EMBED_CHROME_RULES.ignorePostMessageDisplay, true);
    assert.match(SESSION_EMBED_CHROME_HELP, /GET \/session/);
    assert.match(SESSION_EMBED_WAITING_HELP, /display-only/);
  });

  it("parses GET /session session.embed as chrome and accepts snake_case aliases", () => {
    const chrome = parseSessionEmbedChrome(GET_SESSION);
    assert.equal(isVerifiedSessionEmbedChrome(chrome), true);
    assert.equal(chrome?.source, SESSION_EMBED_CHROME_SOURCE);
    assert.equal(chrome?.tenantId, "ten-1");
    assert.equal(chrome?.workbenchKey, "ops");
    assert.equal(chrome?.workspaceId, "ws-1");
    assert.deepEqual(chrome?.capabilities, ["workflow.view", "credential.view"]);
    assert.equal(sessionEmbedChromeLabel(chrome!), "ten-1 / ops");

    const snake = parseSessionEmbedChrome({
      session: {
        id: "sess-2",
        embed: {
          tenant_id: "ten-2",
          workbench_key: "dev",
          workspace_id: "ws-2",
          capabilities: ["approval.view"],
        },
      },
    });
    assert.equal(snake?.tenantId, "ten-2");
    assert.equal(snake?.workbenchKey, "dev");
    assert.deepEqual(snake?.capabilities, ["approval.view"]);

    const fromSessionObject = parseSessionEmbedChrome(GET_SESSION.session);
    assert.equal(fromSessionObject?.workbenchKey, "ops");
  });

  it("does not drive chrome from host query, peeked assertion, or postMessage", () => {
    const host = parseEmbedHostDisplay(
      new URLSearchParams({
        tenant: "evil",
        tenantId: "host-ten",
        workbench: "prod",
        host: "https://evil.example",
        displayName: "Hostile",
      }),
    );
    assert.equal(host.unverified, true);
    assert.equal(sessionEmbedChromeFromHostDisplay(host), null);
    assert.equal(parseSessionEmbedChrome(host), null);
    assert.equal(
      parseSessionEmbedChrome({
        tenant: "evil",
        workbench: "prod",
        host: "https://evil.example",
        displayName: "Hostile",
        unverified: true,
      }),
      null,
    );

    const peeked = {
      iss: "https://evil.example",
      aud: "flowforge",
      jti: "jti-evil",
      tenant_id: "evil-ten",
      workbench_key: "prod",
      capabilities: ["workspace.administer"],
    };
    assert.equal(sessionEmbedChromeFromPeekedAssertion(peeked), null);
    assert.equal(parseSessionEmbedChrome(peeked), null);
    assert.equal(
      parseSessionEmbedChrome({
        assertion:
          "eyJhbGciOiJFZERTQSJ9.eyJ0ZW5hbnRfaWQiOiJldmlsIn0.sig",
        tenant_id: "evil-ten",
        workbench_key: "prod",
      }),
      null,
    );

    assert.equal(
      parseSessionEmbedChrome({
        type: "flowforge.embed.assertion",
        version: 1,
        assertion: "eyJhbGciOiJFZERTQSJ9.eyJhdWQiOiJmbG93Zm9yZ2UifQ.sig",
        tenant: "acme",
        workbench: "ops",
      }),
      null,
    );

    assert.equal(parseSessionEmbedChrome({ session: { id: "sess-bare" } }), null);
    assert.equal(
      parseSessionEmbedChrome({
        workspace: { tenant_id: "ten-1", workbench_key: "ops" },
        capabilities: ["workflow.view"],
      }),
      null,
    );
    assert.equal(parseSessionEmbedChrome(null), null);
    assert.equal(parseSessionEmbedChrome([]), null);
  });

  it("caps gated actions from GET /session capabilities and fails closed without chrome", () => {
    const chrome = parseSessionEmbedChrome(GET_SESSION);
    assert.deepEqual(
      capChromeCapabilities(
        ["workflow.view", "workflow.edit", "credential.view"],
        chrome,
      ),
      ["workflow.view", "credential.view"],
    );
    assert.equal(capChromeCapabilities(["workflow.view"], null), null);
    assert.equal(capChromeCapabilities(null, chrome), null);

    const verified = sessionEmbedAsVerifiedWorkspace(chrome!, {
      tenantSlug: "acme",
      workspaceName: "Ops",
    });
    assert.equal(verified.source, "flowforge");
    assert.equal(verified.tenantId, "ten-1");
    assert.equal(verified.workbenchKey, "ops");
    assert.equal(verified.tenantSlug, "acme");
    assert.equal(verified.workspaceName, "Ops");
    assert.deepEqual(verified.capabilities, ["workflow.view", "credential.view"]);
  });
});
