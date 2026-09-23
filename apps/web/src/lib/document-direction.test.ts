import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DOCUMENT_DIRECTION_HEADER,
  documentDirectionFromHeader,
} from "./document-direction.ts";

describe("G.3.8 document direction", () => {
  it("accepts only the exact rtl token and fails closed otherwise", () => {
    assert.equal(DOCUMENT_DIRECTION_HEADER, "x-ff-dir");
    assert.equal(documentDirectionFromHeader("rtl"), "rtl");
    assert.equal(documentDirectionFromHeader("ltr"), "ltr");
    assert.equal(documentDirectionFromHeader(null), "ltr");
    assert.equal(documentDirectionFromHeader(undefined), "ltr");
    assert.equal(documentDirectionFromHeader(""), "ltr");
    assert.equal(documentDirectionFromHeader("RTL"), "ltr");
    assert.equal(documentDirectionFromHeader(" rtl"), "ltr");
    assert.equal(documentDirectionFromHeader("rtl "), "ltr");
    assert.equal(documentDirectionFromHeader("rtl; ltr"), "ltr");
  });
});
