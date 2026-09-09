import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { highlightYamlLine } from "./workflow-yaml-highlight.ts";

describe("highlightYamlLine", () => {
  it("marks keys, comments, and scalars", () => {
    const key = highlightYamlLine("  name: validate-example");
    assert.equal(key.some((token) => token.kind === "key" && token.text.includes("name")), true);
    const comment = highlightYamlLine("  # operator note");
    assert.equal(comment.some((token) => token.kind === "comment"), true);
    const flag = highlightYamlLine("    additionalProperties: true");
    assert.equal(flag.some((token) => token.kind === "boolean"), true);
  });
});
