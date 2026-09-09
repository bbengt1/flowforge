import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EmbedVerifiedContext } from "./embed-contract.ts";
import {
  EMBED_HOST_MISMATCH_MESSAGE,
  EMBED_LOCKED_MESSAGE,
  EMBED_MISSING_VERIFIED_MESSAGE,
  EMBED_TENANCY_API_PR,
  EMBED_TENANCY_EPIC,
  EMBED_TENANCY_EXISTING_PATHS,
  EMBED_TENANCY_HOOK_IDS,
  EMBED_TENANCY_HOOK_OWNERS,
  EMBED_TENANCY_PROXY_ROUTES,
  EMBED_TENANCY_RETARGET,
  EMBED_TENANCY_ROUTE_MAP_SOURCE,
  EMBED_TENANCY_RULES,
  EMBED_TENANCY_STORY,
  EMBED_TENANCY_MISMATCH_MESSAGE,
  EMBED_VERIFIED_STORAGE_KEY,
  capEmbedPermissions,
  decideEmbedTenancy,
  embedDeepLink,
  embedDeepLinkIsActive,
  embedVerifiedLabel,
  hasVerifiedWorkspaceLookup,
  hostDisplayConflictsWithVerified,
  hostDisplayFromSearch,
  identityFromVerified,
  identityMatchesVerified,
  maybeEmbedDeepLink,
  parseEmbedCatalogHooks,
  parseEmbedVerifiedWorkspace,
  rejectHostSuppliedLookup,
  isEmbedTenancyProxySegments,
  shouldAttachEmbedTenancyHeaders,
  retargetEmbedTenancyApiPath,
  rewriteEmbedNavigationHref,
  verifiedWorkspaceFromCurrent,
  verifiedWorkspaceFromExchange,
  verifiedWorkspaceFromSessionEmbed,
  workspaceMatchesVerified,
} from "./embed-tenancy-contract.ts";

const verifiedContext: EmbedVerifiedContext = {
  audience: "flowforge",
  sdk: "embed.v1",
  tenantId: "ten-1",
  tenantSlug: "acme",
  workbenchKey: "ops",
  workspaceId: "ws-1",
  workspaceName: "Ops",
  capabilities: ["workflow.view"],
  tokenId: "jti-1",
};

describe("embed-tenancy-contract", () => {
  it("cites #122 / #120 and the #127 tenancy map", () => {
    assert.equal(EMBED_TENANCY_STORY, 122);
    assert.equal(EMBED_TENANCY_EPIC, 120);
    assert.equal(EMBED_TENANCY_API_PR, 127);
    assert.equal(EMBED_TENANCY_ROUTE_MAP_SOURCE, "e112-#127");
    assert.equal(EMBED_TENANCY_RULES.sendTenantAndWorkbenchHeaders, true);
    assert.ok(EMBED_TENANCY_EXISTING_PATHS.includes("/embed/keys/rotate"));
    assert.ok(EMBED_TENANCY_EXISTING_PATHS.includes("/session"));
    assert.equal(EMBED_VERIFIED_STORAGE_KEY, "flowforge.embed-verified.v1");
    assert.deepEqual([...EMBED_TENANCY_HOOK_IDS], [
      "jti.consume",
      "key.rotation",
      "tenancy.propagation",
    ]);
    assert.equal(EMBED_TENANCY_HOOK_OWNERS["jti.consume"], "jonny");
    assert.equal(EMBED_TENANCY_HOOK_OWNERS["key.rotation"], "jonny");
    assert.equal(EMBED_TENANCY_HOOK_OWNERS["tenancy.propagation"], "chloe");
    assert.ok(EMBED_TENANCY_EXISTING_PATHS.includes("/workspace"));
    assert.equal(EMBED_TENANCY_PROXY_ROUTES.length, 0);
    assert.equal(retargetEmbedTenancyApiPath("/workspace"), "/workspace");
    assert.equal(isEmbedTenancyProxySegments(["workspace"]), false);
    assert.match(EMBED_TENANCY_RETARGET.tenancyApis, /session\.embed/);
    assert.match(EMBED_LOCKED_MESSAGE, /locked/);
  });

  it("accepts only FlowForge-verified tenant + workbench as lookup", () => {
    const verified = verifiedWorkspaceFromExchange(verifiedContext);
    assert.ok(verified);
    assert.equal(verified?.source, "flowforge");
    assert.equal(verified?.tenantId, "ten-1");
    assert.equal(verified?.workbenchKey, "ops");
    assert.equal(hasVerifiedWorkspaceLookup(verified), true);
    assert.equal(
      verifiedWorkspaceFromExchange({
        ...verifiedContext,
        tenantId: "",
        tenantSlug: "",
        workbenchKey: "",
      }),
      null,
    );
    assert.equal(
      parseEmbedVerifiedWorkspace({
        source: "host",
        tenantId: "evil",
        workbenchKey: "other",
      }),
      null,
    );
    assert.equal(
      parseEmbedVerifiedWorkspace({
        source: "flowforge",
        tenantId: "ten-1",
        tenantSlug: "acme",
        workbenchKey: "ops",
        workspaceId: "ws-1",
        workspaceName: "Ops",
      })?.workbenchKey,
      "ops",
    );
  });

  it("never treats host query tenant/workbench as authorization", () => {
    const host = hostDisplayFromSearch(
      "?tenant=evil&tenantId=other&workbench=prod&workspaceId=ws-hack",
    );
    assert.equal(host.unverified, true);
    assert.equal(host.tenant, "evil");
    const rejected = rejectHostSuppliedLookup(host);
    assert.equal(rejected.used, false);
    assert.equal(rejected.display.unverified, true);
    const verified = verifiedWorkspaceFromExchange(verifiedContext);
    assert.ok(verified);
    assert.equal(hostDisplayConflictsWithVerified(host, verified), true);
    assert.equal(
      hostDisplayConflictsWithVerified(
        hostDisplayFromSearch("?tenant=acme&workbench=ops"),
        verified,
      ),
      false,
    );
    assert.match(EMBED_HOST_MISMATCH_MESSAGE, /display-only/);
  });

  it("locks GET /workspace to the verified pair and fail-closes mismatches", () => {
    const verified = verifiedWorkspaceFromExchange(verifiedContext);
    assert.ok(verified);
    assert.equal(
      workspaceMatchesVerified(
        { tenant_id: "ten-1", workbench_key: "ops", id: "ws-1", name: "Ops", status: "active" },
        verified,
      ),
      true,
    );
    assert.equal(
      workspaceMatchesVerified(
        { tenant_id: "ten-9", workbench_key: "ops", id: "ws-9", name: "X", status: "active" },
        verified,
      ),
      false,
    );
    const current = {
      workspace: {
        id: "ws-9",
        tenant_id: "ten-9",
        workbench_key: "prod",
        name: "Other",
        status: "active",
      },
      tenant: { id: "ten-9", slug: "other", name: "Other", status: "active" },
      principal: {
        id: "u1",
        issuer: "https://host",
        external_subject: "ada",
        status: "active",
      },
      roles: ["admin"],
      permissions: ["workflow.view"],
    };
    const mismatch = decideEmbedTenancy({ verified, current });
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) {
      assert.equal(mismatch.reason, "mismatch");
      assert.equal(mismatch.message, EMBED_TENANCY_MISMATCH_MESSAGE);
    }
    const missing = decideEmbedTenancy({ verified: null, current: null });
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.equal(missing.reason, "missing");
      assert.equal(missing.message, EMBED_MISSING_VERIFIED_MESSAGE);
    }
    const ok = decideEmbedTenancy({
      verified,
      current: {
        ...current,
        workspace: {
          id: "ws-1",
          tenant_id: "ten-1",
          workbench_key: "ops",
          name: "Ops",
          status: "active",
        },
        tenant: { id: "ten-1", slug: "acme", name: "Acme", status: "active" },
      },
    });
    assert.equal(ok.ok, true);
  });

  it("overwrites identity lookup from verified values, not host", () => {
    const verified = verifiedWorkspaceFromExchange(verifiedContext);
    assert.ok(verified);
    const next = identityFromVerified(
      {
        issuer: "https://host",
        subject: "ada",
        displayName: "Ada",
        tenantId: "host-tenant",
        tenantSlug: "evil",
        workbenchKey: "prod",
      },
      verified,
    );
    assert.equal(next.tenantId, "ten-1");
    assert.equal(next.tenantSlug, "acme");
    assert.equal(next.workbenchKey, "ops");
    assert.equal(identityMatchesVerified(next, verified), true);
    assert.equal(
      identityMatchesVerified(
        { ...next, workbenchKey: "prod" },
        verified,
      ),
      false,
    );
    const fromCurrent = verifiedWorkspaceFromCurrent({
      workspace: {
        id: "ws-1",
        tenant_id: "ten-1",
        workbench_key: "ops",
        name: "Ops",
        status: "active",
      },
      tenant: { id: "ten-1", slug: "acme", name: "Acme", status: "active" },
      principal: {
        id: "u1",
        issuer: "https://host",
        external_subject: "ada",
        status: "active",
      },
      roles: [],
      permissions: [],
    });
    assert.equal(fromCurrent?.source, "flowforge");
    assert.equal(embedVerifiedLabel(verified), "acme / ops");
  });

  it("builds embed deep links without host auth query params", () => {
    assert.equal(embedDeepLink("/workflows/abc"), "/embed/v1/workflows/abc");
    assert.equal(
      embedDeepLink("/config?group=targets"),
      "/embed/v1/config?group=targets",
    );
    assert.equal(
      embedDeepLink("/embed/v1/executions/1#logs"),
      "/embed/v1/executions/1#logs",
    );
    assert.equal(
      embedDeepLink("/workflows/abc?assertion=eyJ&tab=run"),
      "/embed/v1/workflows/abc?tab=run",
    );
    assert.equal(maybeEmbedDeepLink("/alerts/1", false), "/alerts/1");
    assert.equal(maybeEmbedDeepLink("/alerts/1", true), "/embed/v1/alerts/1");
    assert.equal(embedDeepLinkIsActive("/embed/v1/workflows", "/workflows/abc"), true);
    assert.equal(embedDeepLinkIsActive("/embed/v1/settings", "/membership"), false);
    assert.equal(
      rewriteEmbedNavigationHref("/workflows/abc", "https://app.example"),
      "/embed/v1/workflows/abc",
    );
    assert.equal(
      rewriteEmbedNavigationHref("/embed/v1/workflows/abc", "https://app.example"),
      null,
    );
    assert.equal(
      rewriteEmbedNavigationHref("/api/v1/workspace", "https://app.example"),
      null,
    );
    assert.equal(
      rewriteEmbedNavigationHref("https://evil.example/workflows", "https://app.example"),
      null,
    );
  });

  it("caps UI by session.embed capabilities and skips public embed hops", () => {
    assert.deepEqual(
      capEmbedPermissions(
        ["workflow.view", "workflow.edit", "credential.view"],
        ["workflow.view"],
      ),
      ["workflow.view"],
    );
    assert.deepEqual(capEmbedPermissions(["workflow.view"], undefined), [
      "workflow.view",
    ]);
    assert.deepEqual(capEmbedPermissions(["workflow.view"], []), []);
    const fromSession = verifiedWorkspaceFromSessionEmbed({
      embed: {
        tenantId: "ten-1",
        workbenchKey: "ops",
        workspaceId: "ws-1",
        capabilities: ["workflow.view"],
      },
    });
    assert.equal(fromSession?.source, "flowforge");
    assert.deepEqual(fromSession?.capabilities, ["workflow.view"]);
    assert.equal(shouldAttachEmbedTenancyHeaders("/api/v1/workspace"), true);
    assert.equal(shouldAttachEmbedTenancyHeaders("/api/v1/embed/exchange"), false);
    assert.equal(shouldAttachEmbedTenancyHeaders("/api/v1/embed/catalog"), false);
    assert.equal(shouldAttachEmbedTenancyHeaders("/api/v1/embed/keys/rotate"), true);
  });

  it("parses catalog hooks and keeps jonny APIs out of the UI adapter", () => {
    const hooks = parseEmbedCatalogHooks({
      hooks: [
        {
          id: "jti.consume",
          status: "stub",
          failClosed: "in-process",
          note: "E11.2 atomic",
        },
        {
          id: "key.rotation",
          status: "stub",
          fail: "unknown kid",
          note: "overlap kids",
        },
        {
          id: "tenancy.propagation",
          status: "stub",
          failClosed: "host is context",
          note: "propagate",
        },
      ],
    });
    assert.equal(hooks.length, 3);
    assert.equal(hooks[0]?.owner, "jonny");
    assert.equal(hooks[1]?.owner, "jonny");
    assert.equal(hooks[2]?.owner, "chloe");
    assert.equal(hooks[1]?.failClosed, "unknown kid");
  });
});
