import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EMBED_ALGORITHM,
  EMBED_API_PREFIX,
  EMBED_AUDIENCE,
  EMBED_CLAIM_NAMES,
  EMBED_DEFAULT_TTL_SECONDS,
  EMBED_EXCHANGE_PATH,
  EMBED_MINT_PATH,
  EMBED_MOUNT_PREFIX,
  EMBED_REQUIRED_CLAIMS,
  EMBED_ROUTES,
  EMBED_SDK,
  assertionFromURL,
  embedApiPath,
  embedMountPath,
  frameAncestorsForPath,
  isEmbedMountPath,
  parseEmbedFrameAncestors,
  standalonePathFromEmbed,
  stripAssertionParams,
} from "./embed-contract.ts";
import { csrfRequiredFor } from "./session-contract.ts";

describe("embed-contract", () => {
  it("matches the E11.1 SDK, audience, and API paths", () => {
    assert.equal(EMBED_SDK, "embed.v1");
    assert.equal(EMBED_AUDIENCE, "flowforge");
    assert.equal(EMBED_ALGORITHM, "EdDSA");
    assert.equal(embedApiPath(EMBED_MINT_PATH), "/api/v1/embed/assertions");
    assert.equal(embedApiPath(EMBED_EXCHANGE_PATH), "/api/v1/embed/exchange");
    assert.equal(EMBED_API_PREFIX, "/api/v1");
    assert.equal(EMBED_DEFAULT_TTL_SECONDS, 60);
    assert.ok(EMBED_REQUIRED_CLAIMS.includes("jti"));
    assert.ok(EMBED_REQUIRED_CLAIMS.includes("aud"));
    assert.ok(EMBED_CLAIM_NAMES.includes("workspace_id"));
  });

  it("maps standalone deep links onto /embed/v1 without changing the href", () => {
    assert.equal(embedMountPath("/"), "/embed/v1");
    assert.equal(embedMountPath("/workflows/{id}"), "/embed/v1/workflows/{id}");
    assert.equal(standalonePathFromEmbed("/embed/v1/executions/abc"), "/executions/abc");
    assert.equal(isEmbedMountPath("/embed/v1/workflows"), true);
    assert.equal(isEmbedMountPath("/workflows"), false);
    const workflow = EMBED_ROUTES.find((r) => r.id === "workflow");
    assert.equal(workflow?.standalone, "/workflows/{id}");
    assert.equal(workflow?.embed, `${EMBED_MOUNT_PREFIX}/workflows/{id}`);
  });

  it("never reads an assertion from a URL and strips leaked query keys", () => {
    assert.equal(assertionFromURL("/embed/v1?assertion=eyJ"), null);
    const stripped = stripAssertionParams("?assertion=eyJ&tab=run");
    assert.equal(stripped.rejected, true);
    assert.equal(stripped.clean, "?tab=run");
  });

  it("exempts POST /embed/exchange from CSRF (no session yet)", () => {
    assert.equal(csrfRequiredFor("POST", "/api/v1/embed/exchange"), false);
    assert.equal(csrfRequiredFor("POST", "/api/control-plane/embed/exchange"), false);
    assert.equal(csrfRequiredFor("POST", "/api/v1/embed/assertions"), true);
  });

  it("keeps standalone frame-ancestors none and allowlists only embed mounts", () => {
    assert.deepEqual(parseEmbedFrameAncestors("* https://portal.example"), [
      "https://portal.example",
    ]);
    assert.equal(frameAncestorsForPath("/workflows", { WEB_EMBED_FRAME_ANCESTORS: "https://portal.example" }), "'none'");
    assert.equal(
      frameAncestorsForPath("/embed/v1/workflows", {
        WEB_EMBED_FRAME_ANCESTORS: "https://portal.example",
      }),
      "https://portal.example",
    );
    assert.equal(frameAncestorsForPath("/embed/v1", {}), "'none'");
  });
});
