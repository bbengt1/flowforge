import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EMBED_AUDIENCE,
  EMBED_MOUNT_PREFIX,
  EMBED_SDK,
  frameAncestorsForPath,
} from "./embed-contract.ts";
import {
  PORTAL_ADAPTER,
  PORTAL_ADAPTER_PATH,
  PORTAL_AUDIENCE,
  PORTAL_BOUNDARY,
  PORTAL_CAPABILITY_MAP,
  PORTAL_EPIC,
  PORTAL_EXCHANGE_PATH,
  PORTAL_HELP,
  PORTAL_HOST_WIRING,
  PORTAL_MINT_PATH,
  PORTAL_MOUNT_PREFIX,
  PORTAL_PROXY_ROUTES,
  PORTAL_ROLES,
  PORTAL_SDK,
  PORTAL_STORY,
  mapPortalRoles,
  normalizePortalRole,
  portalFrameAncestors,
  portalMintBody,
} from "./portal-adapter-contract.ts";

describe("portal adapter contract", () => {
  it("reuses embed.v1 rather than a parallel auth path", () => {
    assert.equal(PORTAL_ADAPTER, "portal.v1");
    assert.equal(PORTAL_SDK, EMBED_SDK);
    assert.equal(PORTAL_AUDIENCE, EMBED_AUDIENCE);
    assert.equal(PORTAL_MOUNT_PREFIX, EMBED_MOUNT_PREFIX);
    assert.equal(PORTAL_EXCHANGE_PATH, "/embed/exchange");
    assert.equal(PORTAL_STORY, 123);
    assert.equal(PORTAL_EPIC, 120);
    assert.equal(PORTAL_BOUNDARY.sharesDatabase, false);
    assert.equal(PORTAL_BOUNDARY.sharesExecutor, false);
    assert.equal(PORTAL_BOUNDARY.portalEntryIsAuthorization, false);
    assert.equal(PORTAL_BOUNDARY.parallelAuthPath, false);
    assert.equal(PORTAL_BOUNDARY.usesEmbedMint, true);
    assert.equal(PORTAL_BOUNDARY.usesEmbedExchange, true);
    assert.match(PORTAL_HELP, /not FlowForge authorization/);
  });

  it("maps portal roles and rejects unknown roles", () => {
    const viewer = mapPortalRoles(["viewer"]);
    assert.deepEqual(viewer.unknown, []);
    assert.ok(viewer.capabilities.includes("workflow.view"));
    assert.ok(!viewer.capabilities.includes("workspace.administer"));
    const hostile = mapPortalRoles(["portal.root"]);
    assert.deepEqual(hostile.unknown, ["portal.root"]);
    assert.equal(normalizePortalRole("operator"), "portal.operator");
    assert.equal(normalizePortalRole("portal.admin"), "portal.admin");
    assert.equal(normalizePortalRole("nope"), "");
    assert.equal(PORTAL_ROLES.length, 6);
    assert.ok(PORTAL_CAPABILITY_MAP["portal.operator"].includes("workflow.execute"));
  });

  it("documents host wiring for Chloe", () => {
    const ids = PORTAL_HOST_WIRING.map((step) => step.id);
    assert.deepEqual(ids, ["entry", "map-roles", "mint", "mount", "exchange"]);
    assert.equal(
      PORTAL_HOST_WIRING.find((s) => s.id === "mint")?.path,
      `/api/v1${PORTAL_MINT_PATH}`,
    );
    assert.equal(
      PORTAL_HOST_WIRING.find((s) => s.id === "exchange")?.path,
      "/api/v1/embed/exchange",
    );
    assert.equal(PORTAL_ADAPTER_PATH, "/portal/adapter");
    const body = portalMintBody({
      portalRoles: ["portal.operator"],
      subject: "u1",
    });
    assert.deepEqual(body.portalRoles, ["portal.operator"]);
  });

  it("merges portal frame ancestors on the embed mount only", () => {
    assert.equal(
      frameAncestorsForPath("/workflows", {
        WEB_PORTAL_FRAME_ANCESTORS: "https://portal.example",
      }),
      "'none'",
    );
    assert.equal(
      portalFrameAncestors({
        WEB_PORTAL_FRAME_ANCESTORS: "https://portal.example",
      }),
      "https://portal.example",
    );
    assert.equal(
      frameAncestorsForPath("/embed/v1/workflows", {
        WEB_EMBED_FRAME_ANCESTORS: "https://host.example",
        WEB_PORTAL_FRAME_ANCESTORS: "https://portal.example",
      }),
      "https://host.example https://portal.example",
    );
  });

  it("allowlists portal adapter proxy routes", () => {
    assert.equal(PORTAL_PROXY_ROUTES.length, 2);
    assert.ok(PORTAL_PROXY_ROUTES[0]?.match(["portal", "adapter"]));
    assert.ok(
      PORTAL_PROXY_ROUTES[1]?.match(["portal", "adapter", "assertions"]),
    );
    assert.ok(!PORTAL_PROXY_ROUTES[0]?.match(["portal", "db"]));
  });
});
