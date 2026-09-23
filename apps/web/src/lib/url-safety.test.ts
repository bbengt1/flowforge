import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  httpOrigin,
  listHasExactValue,
  parseHttpNavigationUrl,
  sourceListHasExactHttpOrigin,
  textMentionsHostname,
} from "./url-safety.ts";

const BASE = "https://app.example";

describe("parseHttpNavigationUrl", () => {
  it("allows same-base relative paths and http(s) URLs", () => {
    const relative = parseHttpNavigationUrl("/workflows/abc?tab=run#logs", BASE);
    assert.equal(relative?.protocol, "https:");
    assert.equal(relative?.origin, BASE);
    assert.equal(relative?.pathname, "/workflows/abc");
    assert.equal(
      parseHttpNavigationUrl("https://app.example/workflows", BASE)?.pathname,
      "/workflows",
    );
    assert.equal(
      parseHttpNavigationUrl("http://localhost:8080/api", "http://localhost:8080")
        ?.origin,
      "http://localhost:8080",
    );
  });

  it("denies javascript:, data:, and vbscript: including case and control-character bypasses", () => {
    for (const href of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      " javascript:alert(1)",
      "\tjavascript:alert(1)",
      "java\nscript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "DATA:text/html,hi",
      "vbscript:msgbox(1)",
      "VbScript:msgbox(1)",
      "mailto:ada@example.com",
      "tel:15551212",
      "",
      "#schedules",
    ]) {
      assert.equal(parseHttpNavigationUrl(href, BASE), null, href);
    }
  });
});

describe("sourceListHasExactHttpOrigin", () => {
  it("matches scheme, host, and port and ignores lookalikes", () => {
    const list = "https://portal.test:8443 'self'";
    assert.equal(sourceListHasExactHttpOrigin(list, "https://portal.test:8443"), true);
    assert.equal(sourceListHasExactHttpOrigin(list, "https://portal.test:8443/"), true);
    assert.equal(sourceListHasExactHttpOrigin(list, "https://portal.test"), false);
    assert.equal(
      sourceListHasExactHttpOrigin(list, "https://portal.test:8443.evil.test"),
      false,
    );
    assert.equal(
      sourceListHasExactHttpOrigin(list, "https://evil.test:8445"),
      false,
    );
    assert.equal(sourceListHasExactHttpOrigin("'none'", "https://evil.test:8445"), false);
    assert.equal(httpOrigin("javascript:alert(1)"), null);
  });
});

describe("exact text and list checks", () => {
  it("does not treat a host as a substring", () => {
    assert.equal(listHasExactValue(["https://api.example.test"], "https://api.example.test"), true);
    assert.equal(
      listHasExactValue(["https://api.example.test.evil"], "https://api.example.test"),
      false,
    );
    assert.equal(textMentionsHostname("see https://example.com/plan", "example.com"), true);
    assert.equal(textMentionsHostname("example.com", "example.com"), true);
    assert.equal(textMentionsHostname("https://cdn.example.com/plan", "example.com"), false);
    assert.equal(textMentionsHostname("notexample.com", "example.com"), false);
    assert.equal(textMentionsHostname("plan.json [redacted]", "example.com"), false);
  });
});
