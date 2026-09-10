import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EMBED_CHROME_MISSING_SESSION_MESSAGE,
  parseEmbedChromeFromSession,
  parseEmbedHostDisplay,
} from "./embed-contract.ts";
import {
  SESSION_EMBED_API_PR,
  SESSION_EMBED_CHROME_HELP,
  SESSION_EMBED_CHROME_RULES,
  SESSION_EMBED_CHROME_SOURCE,
  SESSION_EMBED_EPIC,
  SESSION_EMBED_EXISTING_PATHS,
  SESSION_EMBED_GET_PATH,
  SESSION_EMBED_RETARGET,
  SESSION_EMBED_ROUTE_MAP_SOURCE,
  SESSION_EMBED_STORY,
  SESSION_EMBED_WAITING_HELP,
  capChromeCapabilities,
  isSessionEmbedMode,
  isSessionEmbedProxySegments,
  isVerifiedSessionEmbedChrome,
  parseSessionEmbedChrome,
  retargetSessionEmbedApiPath,
  sessionEmbedAsVerifiedWorkspace,
  sessionEmbedChromeFromHostDisplay,
  sessionEmbedChromeFromPeekedAssertion,
  sessionEmbedChromeLabel,
  embedChromeChipLabel,
  sessionEmbedGetPath,
} from "./session-embed-contract.ts";

const GET_SESSION = {
  session: {
    id: "sess-1",
    idle_expires_at: "2026-09-10T21:00:00.000Z",
    embed: {
      mode: "embed",
      sdk: "embed.v1",
      tenantId: "ten-1",
      tenantSlug: "acme",
      tenantName: "Acme",
      workbenchKey: "ops",
      workspaceId: "ws-1",
      workspaceName: "Ops",
      capabilities: ["workflow.view", "credential.view"],
    },
  },
  principal: {
    issuer: "https://idp.example",
    external_subject: "ada",
    display_name: "Ada",
  },
  csrf_token: "csrf-1",
};

describe("session-embed-contract", () => {
  it("cites ADV-021 #177 retarget points for embed chrome", () => {
    assert.equal(SESSION_EMBED_STORY, 151);
    assert.equal(SESSION_EMBED_EPIC, 130);
    assert.equal(SESSION_EMBED_API_PR, 177);
    assert.equal(SESSION_EMBED_ROUTE_MAP_SOURCE, "adv021-#177");
    assert.equal(SESSION_EMBED_GET_PATH, "/session");
    assert.equal(sessionEmbedGetPath(), "/api/v1/session");
    assert.deepEqual(SESSION_EMBED_EXISTING_PATHS, ["/session", "/session/refresh"]);
    assert.equal(retargetSessionEmbedApiPath("/api/v1/session"), "/api/v1/session");
    assert.equal(retargetSessionEmbedApiPath("/session/refresh"), "/session/refresh");
    assert.equal(isSessionEmbedProxySegments(["session"]), true);
    assert.equal(isSessionEmbedProxySegments(["session", "refresh"]), true);
    assert.equal(isSessionEmbedProxySegments(["embed", "exchange"]), false);
    assert.equal(SESSION_EMBED_RETARGET.routeMap, "adv021-#177");
    assert.equal(SESSION_EMBED_RETARGET.parser, "parseEmbedChromeFromSession");
    assert.match(SESSION_EMBED_RETARGET.getSession, /GET \/session/);
    assert.match(SESSION_EMBED_RETARGET.embedShape, /tenantSlug/);
    assert.match(SESSION_EMBED_RETARGET.embedShape, /principal\.display_name/);
    assert.ok(
      SESSION_EMBED_RETARGET.notChrome.some((item) => /assertion leftovers/.test(item)),
    );
    assert.ok(SESSION_EMBED_RETARGET.notChrome.some((item) => /catalog/.test(item)));
    assert.ok(SESSION_EMBED_RETARGET.notChrome.some((item) => /host query/.test(item)));
    assert.equal(SESSION_EMBED_CHROME_RULES.driveFromGetSession, true);
    assert.equal(SESSION_EMBED_CHROME_RULES.ignoreHostQuery, true);
    assert.equal(SESSION_EMBED_CHROME_RULES.ignorePeekedAssertion, true);
    assert.equal(SESSION_EMBED_CHROME_RULES.ignorePostMessageDisplay, true);
    assert.equal(SESSION_EMBED_CHROME_RULES.sessionIsAuthority, true);
    assert.equal(SESSION_EMBED_CHROME_RULES.failClosedWithoutEmbedBinding, true);
    assert.match(SESSION_EMBED_CHROME_HELP, /GET \/session/);
    assert.match(SESSION_EMBED_WAITING_HELP, /display-only/);
    assert.match(EMBED_CHROME_MISSING_SESSION_MESSAGE, /not chrome authority/);
  });

  it("parses GET /session session.embed as chrome via parseEmbedChromeFromSession", () => {
    const chrome = parseSessionEmbedChrome(GET_SESSION);
    assert.equal(isVerifiedSessionEmbedChrome(chrome), true);
    assert.equal(isSessionEmbedMode(chrome), true);
    assert.equal(chrome?.source, SESSION_EMBED_CHROME_SOURCE);
    assert.equal(chrome?.mode, "embed");
    assert.equal(chrome?.sdk, "embed.v1");
    assert.equal(chrome?.tenantId, "ten-1");
    assert.equal(chrome?.tenantSlug, "acme");
    assert.equal(chrome?.tenantName, "Acme");
    assert.equal(chrome?.workbenchKey, "ops");
    assert.equal(chrome?.workspaceId, "ws-1");
    assert.equal(chrome?.workspaceName, "Ops");
    assert.equal(chrome?.displayName, "Ada");
    assert.deepEqual(chrome?.capabilities, ["workflow.view", "credential.view"]);
    assert.equal(sessionEmbedChromeLabel(chrome!), "acme / ops");
    assert.equal(embedChromeChipLabel(chrome!), "Verified · acme / ops · Ops · Ada");

    const decision = parseEmbedChromeFromSession(GET_SESSION);
    assert.equal(decision.ok, true);
    if (decision.ok) {
      assert.equal(decision.chrome.displayName, "Ada");
      assert.equal(decision.chrome.tenantSlug, "acme");
    }

    const snake = parseSessionEmbedChrome({
      session: {
        id: "sess-2",
        embed: {
          mode: "embed",
          tenant_id: "ten-2",
          tenant_slug: "beta",
          tenant_name: "Beta",
          workbench_key: "dev",
          workspace_id: "ws-2",
          workspace_name: "Dev",
          capabilities: ["approval.view"],
        },
      },
      principal: { display_name: "Bea" },
    });
    assert.equal(snake?.tenantId, "ten-2");
    assert.equal(snake?.tenantSlug, "beta");
    assert.equal(snake?.workbenchKey, "dev");
    assert.equal(snake?.workspaceName, "Dev");
    assert.equal(snake?.displayName, "Bea");
    assert.deepEqual(snake?.capabilities, ["approval.view"]);

    const fromSessionObject = parseSessionEmbedChrome(GET_SESSION.session);
    assert.equal(fromSessionObject?.workbenchKey, "ops");
    assert.equal(fromSessionObject?.mode, "embed");
  });

  it("uses principal.display_name and ignores assertion leftover display_name", () => {
    const chrome = parseSessionEmbedChrome({
      session: GET_SESSION.session,
      principal: {
        issuer: "https://idp.example",
        external_subject: "ada",
        display_name: "Ada",
      },
      assertion: {
        display_name: "Hostile leftover",
        jti: "jti-evil",
      },
    });
    assert.equal(chrome?.displayName, "Ada");

    const noPrincipalName = parseSessionEmbedChrome({
      session: GET_SESSION.session,
      principal: { external_subject: "ada" },
      assertion: { display_name: "Hostile leftover" },
    });
    assert.equal(noPrincipalName?.displayName, "");
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
    assert.equal(isSessionEmbedMode(null), false);
    assert.equal(
      parseSessionEmbedChrome({
        workspace: { tenant_id: "ten-1", workbench_key: "ops" },
        capabilities: ["workflow.view"],
      }),
      null,
    );
    assert.equal(
      parseSessionEmbedChrome({
        session: {
          id: "sess-catalog",
          capabilities: ["workflow.view", "workspace.administer"],
        },
      }),
      null,
    );
    assert.equal(parseSessionEmbedChrome(null), null);
    assert.equal(parseSessionEmbedChrome([]), null);
  });

  it("fail-closes without session.embed and rejects non-embed mode", () => {
    const standalone = parseSessionEmbedChrome({
      session: { id: "sess-standalone" },
      principal: { display_name: "Admin" },
    });
    assert.equal(standalone, null);
    const missing = parseEmbedChromeFromSession({
      session: { id: "sess-standalone" },
    });
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.equal(missing.message, EMBED_CHROME_MISSING_SESSION_MESSAGE);
    }

    assert.equal(
      parseSessionEmbedChrome({
        session: {
          embed: {
            mode: "standalone",
            tenantId: "ten-1",
            workbenchKey: "ops",
          },
        },
      }),
      null,
    );
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

    const verified = sessionEmbedAsVerifiedWorkspace(chrome!);
    assert.equal(verified.source, "flowforge");
    assert.equal(verified.tenantId, "ten-1");
    assert.equal(verified.tenantSlug, "acme");
    assert.equal(verified.workbenchKey, "ops");
    assert.equal(verified.workspaceId, "ws-1");
    assert.equal(verified.workspaceName, "Ops");
    assert.deepEqual(verified.capabilities, ["workflow.view", "credential.view"]);
  });
});
