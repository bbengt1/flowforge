import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DOCUMENT_DIR_COOKIE, documentDirection } from "./document-dir.ts";

describe("document direction", () => {
  it("accepts rtl and fails closed to ltr", () => {
    assert.equal(DOCUMENT_DIR_COOKIE, "ff-dir");
    assert.equal(documentDirection("rtl"), "rtl");
    assert.equal(documentDirection(" RTL "), "rtl");
    assert.equal(documentDirection(undefined), "ltr");
    assert.equal(documentDirection(null), "ltr");
    assert.equal(documentDirection(""), "ltr");
    assert.equal(documentDirection("ltr"), "ltr");
    assert.equal(documentDirection("arabic"), "ltr");
    assert.equal(documentDirection("rtl;secret"), "ltr");
  });
});
