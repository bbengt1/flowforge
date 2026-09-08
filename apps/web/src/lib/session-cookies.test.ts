import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  requestIsSecure,
  rewriteUpstreamSetCookie,
  rewriteUpstreamSetCookies,
} from "./session-cookies.ts";

describe("rewriteUpstreamSetCookie", () => {
  it("strips Domain and Secure on localhost HTTP so the UI origin can store the cookie", () => {
    const rewritten = rewriteUpstreamSetCookie(
      "flowforge_session=opaque; Path=/api; Domain=api.example.test; HttpOnly; Secure; SameSite=Lax",
      { requestSecure: false },
    );
    assert.ok(rewritten);
    assert.match(rewritten ?? "", /^flowforge_session=opaque;/);
    assert.match(rewritten ?? "", /HttpOnly/i);
    assert.match(rewritten ?? "", /SameSite=Lax/i);
    assert.doesNotMatch(rewritten ?? "", /Domain=/i);
    assert.doesNotMatch(rewritten ?? "", /Secure/i);
  });

  it("keeps Secure on TLS and defaults Path=/ plus SameSite=Lax", () => {
    const rewritten = rewriteUpstreamSetCookie("flowforge_csrf=token", {
      requestSecure: true,
    });
    assert.equal(rewritten, "flowforge_csrf=token; Path=/; SameSite=Lax; Secure");
    assert.deepEqual(
      rewriteUpstreamSetCookies(["flowforge_session=a; Domain=x"], {
        requestSecure: false,
      }),
      ["flowforge_session=a; Path=/; SameSite=Lax"],
    );
  });
});

describe("requestIsSecure", () => {
  it("uses X-Forwarded-Proto then the request URL", () => {
    assert.equal(
      requestIsSecure({
        url: "http://localhost:3000/api/control-plane/session",
        headers: new Headers({ "x-forwarded-proto": "https" }),
      }),
      true,
    );
    assert.equal(
      requestIsSecure({
        url: "http://localhost:3000/api/control-plane/session",
        headers: new Headers({ "x-forwarded-proto": "http" }),
      }),
      false,
    );
    assert.equal(
      requestIsSecure({ url: "https://ui.example.test/api/control-plane/session" }),
      true,
    );
  });
});
