import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EMBED_CHIPS_RULES,
  EMBED_COOKIE_CREDENTIALS,
  EMBED_EXCHANGE_PATH,
  EMBED_HOST_ALLOWLIST_RULES,
  EMBED_SDK,
  assertionFromURL,
  embedHostAllowlist,
  frameAncestorsForPath,
  isAllowedEmbedMessageOrigin,
} from "./embed-contract.ts";
import {
  ADV013_CHIPS,
  ADV013_CHECKLIST,
  ADV013_CHLOE_GAPS,
  ADV013_EMBED_ORIGIN,
  ADV013_EPIC,
  ADV013_EVIL_ORIGIN,
  ADV013_EXCHANGE_BODY,
  ADV013_HARNESS,
  ADV013_ID,
  ADV013_PATHS,
  ADV013_PORTAL_ORIGIN,
  ADV013_RULES,
  ADV013_STORY,
  adv013AssertionFromUrlIsRejected,
  adv013CrossOriginIframeSrc,
  adv013EmptyAllowlistFailsClosed,
  adv013FrameAncestors,
  adv013HostEnv,
  adv013HostileAncestorBlocked,
  adv013Origins,
} from "./adv013-cross-origin-contract.ts";
import {
  buildCrossOriginPortalEmbedSrc,
  isDistinctOriginPair,
  portalHostDisplay,
} from "./portal-adapter-contract.ts";
import { deliverCrossOriginPortalAssertion } from "./portal-embed-client.ts";

describe("ADV-013 cross-origin checklist", () => {
  it("requires two distinct HTTPS origins and cites #144 / #130", () => {
    assert.equal(ADV013_ID, "ADV-013");
    assert.equal(ADV013_STORY, 144);
    assert.equal(ADV013_EPIC, 130);
    assert.equal(ADV013_RULES.keep144Open, true);
    const origins = adv013Origins();
    assert.equal(origins.portal, "https://portal.test:8443");
    assert.equal(origins.embed, "https://embed.test:8444");
    assert.equal(origins.distinct, true);
    assert.ok(isDistinctOriginPair(ADV013_PORTAL_ORIGIN, ADV013_EMBED_ORIGIN));
    assert.equal(
      isDistinctOriginPair(ADV013_PORTAL_ORIGIN, ADV013_PORTAL_ORIGIN),
      false,
    );
    assert.equal(ADV013_HARNESS.script, "scripts/adv013-cross-origin.sh");
  });

  it("shares the ADV-011 host allowlist for CSP and postMessage", () => {
    assert.equal(ADV013_RULES.sharedAllowlistWithAdv011, true);
    assert.equal(EMBED_HOST_ALLOWLIST_RULES.cspAndPostMessageShareList, true);
    assert.equal(ADV013_RULES.nextPublicIsNotASource, true);
    const env = adv013HostEnv();
    assert.equal(adv013FrameAncestors(env), ADV013_PORTAL_ORIGIN);
    assert.deepEqual(embedHostAllowlist(env), [ADV013_PORTAL_ORIGIN]);
    assert.equal(
      isAllowedEmbedMessageOrigin(ADV013_PORTAL_ORIGIN, embedHostAllowlist(env)),
      true,
    );
    assert.equal(
      frameAncestorsForPath("/workflows", env),
      "'none'",
    );
  });

  it("exercises mint → frame /embed/v1 → body-only exchange + CHIPS", () => {
    assert.equal(ADV013_PATHS.mint, "/api/v1/portal/adapter/assertions");
    assert.equal(ADV013_PATHS.exchange, `/api/v1${EMBED_EXCHANGE_PATH}`);
    assert.equal(ADV013_PATHS.mount, "/embed/v1/workflows");
    assert.equal(ADV013_EXCHANGE_BODY.sdk, EMBED_SDK);
    assert.equal(ADV013_EXCHANGE_BODY.assertionIn, "body");
    assert.equal(ADV013_EXCHANGE_BODY.assertionInUrl, false);
    assert.equal(ADV013_CHIPS.credentials, "include");
    assert.equal(EMBED_COOKIE_CREDENTIALS, "include");
    assert.equal(ADV013_CHIPS.setCookie, "SameSite=None; Secure; Partitioned");
    assert.equal(EMBED_CHIPS_RULES.partitioned, true);
    assert.equal(EMBED_CHIPS_RULES.neverDropSecure, true);
    assert.equal(ADV013_RULES.chipsSameSiteNoneSecurePartitioned, true);

    const framed = adv013CrossOriginIframeSrc();
    assert.equal(framed.displayOnly, true);
    assert.ok(framed.src.startsWith(`${ADV013_EMBED_ORIGIN}/embed/v1/workflows?`));
    assert.equal(framed.src.includes("assertion="), false);
  });

  it("rejects assertion-in-URL, hostile ancestors, and an empty allowlist", () => {
    assert.ok(
      adv013AssertionFromUrlIsRejected(
        `${ADV013_EMBED_ORIGIN}/embed/v1/workflows?assertion=eyJ.hbG.sig`,
      ),
    );
    assert.equal(
      assertionFromURL(`${ADV013_EMBED_ORIGIN}/embed/v1?assertion=eyJ`),
      null,
    );
    const leaked = adv013CrossOriginIframeSrc({
      leakedSearch: "?assertion=eyJhbGciOiJFZERTQSJ9.e30.sig&tab=run",
    });
    assert.equal(leaked.rejectedAssertion, true);
    assert.equal(leaked.src.includes("assertion="), false);

    assert.equal(adv013HostileAncestorBlocked(), true);
    assert.equal(
      isAllowedEmbedMessageOrigin(ADV013_EVIL_ORIGIN, [
        ADV013_PORTAL_ORIGIN,
      ]),
      false,
    );
    assert.equal(adv013EmptyAllowlistFailsClosed(), true);
    assert.ok(ADV013_CHECKLIST.includes("empty-allowlist-fail-closed"));
    assert.ok(ADV013_CHECKLIST.includes("hostile-ancestor-blocked"));
  });

  it("postMessages only to the embed origin when the Portal sender is allowlisted", () => {
    const sample = "eyJhbGciOiJFZERTQSJ9.eyJhdWQiOiJmbG93Zm9yZ2UifQ.signature";
    const posted: Array<{ data: unknown; origin: string }> = [];
    const target = {
      postMessage(data: unknown, origin: string) {
        posted.push({ data, origin });
      },
    };

    const ok = deliverCrossOriginPortalAssertion(
      target as unknown as Window,
      { assertion: sample },
      {
        embedOrigin: ADV013_EMBED_ORIGIN,
        portalOrigin: ADV013_PORTAL_ORIGIN,
        allowlist: [ADV013_PORTAL_ORIGIN],
      },
    );
    assert.equal(ok.delivered, true);
    assert.equal(posted[0]?.origin, ADV013_EMBED_ORIGIN);

    posted.length = 0;
    const wildcard = deliverCrossOriginPortalAssertion(
      target as unknown as Window,
      { assertion: sample },
      {
        embedOrigin: "*",
        portalOrigin: ADV013_PORTAL_ORIGIN,
        allowlist: [ADV013_PORTAL_ORIGIN],
      },
    );
    assert.equal(wildcard.delivered, false);

    const empty = deliverCrossOriginPortalAssertion(
      target as unknown as Window,
      { assertion: sample },
      {
        embedOrigin: ADV013_EMBED_ORIGIN,
        portalOrigin: ADV013_PORTAL_ORIGIN,
        allowlist: [],
      },
    );
    assert.equal(empty.delivered, false);

    const hostileSender = deliverCrossOriginPortalAssertion(
      target as unknown as Window,
      { assertion: sample },
      {
        embedOrigin: ADV013_EMBED_ORIGIN,
        portalOrigin: ADV013_EVIL_ORIGIN,
        allowlist: [ADV013_PORTAL_ORIGIN],
      },
    );
    assert.equal(hostileSender.delivered, false);
    assert.deepEqual(posted, []);
  });

  it("documents Chloe host-wiring gaps without changing product authz", () => {
    const ids = ADV013_CHLOE_GAPS.map((item) => item.id);
    assert.ok(ids.includes("same-origin-demo"));
    assert.ok(ids.includes("shared-allowlist-on-both-processes"));
    assert.ok(ids.includes("chips-https"));
    const src = buildCrossOriginPortalEmbedSrc({
      embedOrigin: ADV013_EMBED_ORIGIN,
      display: portalHostDisplay({ tenant: "acme", workbench: "ops" }),
    });
    assert.equal(src.embedOrigin, ADV013_EMBED_ORIGIN);
    assert.equal(src.displayOnly, true);
  });
});
