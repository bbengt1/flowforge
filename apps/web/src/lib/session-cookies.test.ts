import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  requestIsSecure,
  rewriteUpstreamSetCookie,
  rewriteUpstreamSetCookies,
} from "./session-cookies.ts";

describe("rewriteUpstreamSetCookie", () => {
  it("keeps ff_* names, Path=/api/v1, and API SameSite; strips Domain and Secure on HTTP", () => {
    const rewritten = rewriteUpstreamSetCookie(
      "ff_session=opaque; Path=/api/v1; Domain=api.example.test; HttpOnly; Secure; SameSite=Lax",
      { requestSecure: false },
    );
    assert.ok(rewritten);
    assert.match(rewritten ?? "", /^ff_session=opaque;/);
    assert.match(rewritten ?? "", /Path=\/api\/v1/);
    assert.match(rewritten ?? "", /HttpOnly/i);
    assert.match(rewritten ?? "", /SameSite=Lax/i);
    assert.doesNotMatch(rewritten ?? "", /Domain=/i);
    assert.doesNotMatch(rewritten ?? "", /Secure/i);
  });

  it("preserves SameSite=Strict on ff_csrf and defaults Path=/api/v1", () => {
    const rewritten = rewriteUpstreamSetCookie(
      "ff_csrf=token; SameSite=Strict",
      { requestSecure: true },
    );
    assert.equal(
      rewritten,
      "ff_csrf=token; SameSite=Strict; Path=/api/v1; Secure",
    );
    assert.deepEqual(
      rewriteUpstreamSetCookies(["ff_session=a; Domain=x; SameSite=Lax"], {
        requestSecure: false,
      }),
      ["ff_session=a; SameSite=Lax; Path=/api/v1"],
    );
  });
});

describe("requestIsSecure", () => {
  it("uses X-Forwarded-Proto then the request URL", () => {
    assert.equal(
      requestIsSecure({
        url: "http://localhost:3000/api/v1/session",
        headers: new Headers({ "x-forwarded-proto": "https" }),
      }),
      true,
    );
    assert.equal(
      requestIsSecure({
        url: "http://localhost:3000/api/v1/session",
        headers: new Headers({ "x-forwarded-proto": "http" }),
      }),
      false,
    );
    assert.equal(
      requestIsSecure({ url: "https://ui.example.test/api/v1/session" }),
      true,
    );
  });
});
