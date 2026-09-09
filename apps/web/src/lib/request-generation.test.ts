import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createGenerationGate } from "./request-generation.ts";

describe("request generation gate", () => {
  it("drops a slower earlier poll after a newer request begins", () => {
    const gate = createGenerationGate();
    const poll = gate.begin();
    const refresh = gate.begin();
    assert.equal(gate.isCurrent(poll), false);
    assert.equal(gate.isCurrent(refresh), true);
  });

  it("invalidates in-flight work when a later begin runs (unmount / stop poll)", () => {
    const gate = createGenerationGate();
    const inFlight = gate.begin();
    gate.begin();
    assert.equal(gate.isCurrent(inFlight), false);
  });
});
