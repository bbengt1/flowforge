import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  generateRequestId,
  isValidRequestId,
  resolveRequestId,
} from "./request-id.ts";

describe("isValidRequestId", () => {
  it("accepts 16–128 ASCII letters, digits, or hyphens", () => {
    assert.equal(isValidRequestId("abcdefghijklmnop"), true);
    assert.equal(isValidRequestId("01234567-89ab-cdef"), true);
    assert.equal(isValidRequestId("a".repeat(128)), true);
  });

  it("rejects short, long, or punctuation values", () => {
    assert.equal(isValidRequestId("short"), false);
    assert.equal(isValidRequestId("a".repeat(129)), false);
    assert.equal(isValidRequestId("abcdefghijklmno_"), false);
    assert.equal(isValidRequestId("abcdefghijklmnop "), false);
  });
});

describe("generateRequestId", () => {
  it("returns a 32-character hex value the API will accept", () => {
    const id = generateRequestId();
    assert.equal(id.length, 32);
    assert.equal(isValidRequestId(id), true);
    assert.match(id, /^[0-9a-f]{32}$/);
  });
});

describe("resolveRequestId", () => {
  it("keeps a valid caller value and replaces an invalid one", () => {
    assert.equal(resolveRequestId("caller-request-16"), "caller-request-16");
    const generated = resolveRequestId("nope");
    assert.equal(isValidRequestId(generated), true);
    assert.notEqual(generated, "nope");
  });
});
