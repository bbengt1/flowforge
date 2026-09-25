import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseExecutionRecord, parseExecutionStep } from "./execution.ts";
import {
  APPROVAL_CLOSED_MESSAGE,
  EXECUTION_NOT_RETRYABLE_MESSAGE,
  RETRY_CAPABILITY_UNAVAILABLE_MESSAGE,
  RETRY_REASON_MESSAGE,
  STEP_ATTEMPT_SUPERSEDED_MESSAGE,
  parseAnnotatedCapabilities,
  readRecordCapabilities,
  retryCapabilityAffordance,
  retryHiddenCopy,
  retryProblemMessage,
  retryProblemShouldRefetch,
} from "./execution-retry.ts";
import { RETRY_CAPABILITY_REASONS } from "./execution-types.ts";

const EXECUTION_ID = "33333333-3333-4333-8333-333333333333";
const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";

function execution(capabilities: unknown, present = true) {
  const row: Record<string, unknown> = {
    id: EXECUTION_ID,
    workflowId: WORKFLOW_ID,
    workflowVersionId: VERSION_ID,
    status: "failed",
  };
  if (present) {
    row.capabilities = capabilities;
  }
  return parseExecutionRecord(row);
}

describe("retry capability", () => {
  it("offers retry only when allowed is true and code and reason are omitted", () => {
    const parsed = parseAnnotatedCapabilities({ retry: { allowed: true } });
    assert.equal(parsed.state, "allowed");
    const record = execution({ retry: { allowed: true } });
    assert.equal(record?.capabilities?.retry.allowed, true);
    assert.equal(record?.capabilitiesInvalid, undefined);
    const offer = retryCapabilityAffordance({
      capabilities: record?.capabilities,
    });
    assert.equal(offer.show, true);
    assert.equal(offer.denial, "");
    assert.equal(offer.state, "allowed");
  });

  it("fails closed when capabilities are missing", () => {
    const parsed = parseAnnotatedCapabilities(undefined);
    assert.equal(parsed.state, "missing");
    const record = execution(undefined, false);
    assert.equal(record?.capabilities, undefined);
    assert.equal(record?.capabilitiesInvalid, undefined);
    const offer = retryCapabilityAffordance({});
    assert.equal(offer.show, false);
    assert.equal(offer.state, "missing");
    assert.equal(offer.denial, "");
    assert.equal(
      retryHiddenCopy(offer, { active: false, copy: "" }),
      RETRY_CAPABILITY_UNAVAILABLE_MESSAGE,
    );
  });

  it("fails closed on every malformed shape", () => {
    const malformed = [
      null,
      [],
      {},
      { retry: null },
      { retry: { allowed: "true" } },
      { retry: { allowed: true, code: "execution_not_retryable" } },
      { retry: { allowed: true, reason: "run_canceled" } },
      { retry: { allowed: false } },
      { retry: { allowed: false, code: "nope", reason: "run_canceled" } },
      {
        retry: {
          allowed: false,
          code: "execution_not_retryable",
        },
      },
      {
        retry: {
          allowed: false,
          code: "execution_not_retryable",
          reason: "not_a_reason",
        },
      },
      {
        retry: {
          allowed: false,
          code: "step_attempt_superseded",
          reason: "run_canceled",
        },
      },
      { retry: { allowed: false, code: "step_attempt_superseded", extra: true } },
    ];
    for (const value of malformed) {
      const parsed = parseAnnotatedCapabilities(value);
      assert.equal(parsed.state, "malformed", JSON.stringify(value));
      const attached = readRecordCapabilities({ capabilities: value });
      assert.equal(attached.capabilities, undefined);
      assert.equal(attached.capabilitiesInvalid, true);
      const offer = retryCapabilityAffordance(attached);
      assert.equal(offer.show, false);
      assert.equal(offer.denial, "");
    }
  });

  it("maps every denial reason to a plain sentence and hides the button", () => {
    for (const reason of RETRY_CAPABILITY_REASONS) {
      const parsed = parseAnnotatedCapabilities({
        retry: { allowed: false, code: "execution_not_retryable", reason },
      });
      assert.equal(parsed.state, "denied");
      if (parsed.state !== "denied") {
        continue;
      }
      assert.equal(parsed.message, RETRY_REASON_MESSAGE[reason]);
      assert.equal(parsed.message.includes(reason), false);
      assert.equal(parsed.message.includes("execution_not_retryable"), false);
      const offer = retryCapabilityAffordance({
        capabilities: { retry: parsed.capability },
      });
      assert.equal(offer.show, false);
      assert.equal(offer.denial, RETRY_REASON_MESSAGE[reason]);
    }
  });

  it("accepts a superseded attempt without a reason", () => {
    const parsed = parseAnnotatedCapabilities({
      retry: { allowed: false, code: "step_attempt_superseded" },
    });
    assert.equal(parsed.state, "denied");
    if (parsed.state === "denied") {
      assert.equal(parsed.message, STEP_ATTEMPT_SUPERSEDED_MESSAGE);
      assert.equal("reason" in parsed.capability, false);
    }
    const step = parseExecutionStep({
      id: "44444444-4444-4444-8444-444444444444",
      nodeId: "gate",
      capabilities: {
        retry: { allowed: false, code: "step_attempt_superseded" },
      },
    });
    assert.equal(step?.capabilities?.retry.allowed, false);
    assert.equal(
      retryCapabilityAffordance({ capabilities: step?.capabilities }).show,
      false,
    );
  });

  it("maps retry and approval 409s and refetches those codes", () => {
    for (const reason of RETRY_CAPABILITY_REASONS) {
      assert.equal(
        retryProblemMessage({
          code: "execution_not_retryable",
          reason,
        }),
        RETRY_REASON_MESSAGE[reason],
      );
    }
    assert.equal(
      retryProblemMessage({ code: "execution_not_retryable" }),
      EXECUTION_NOT_RETRYABLE_MESSAGE,
    );
    assert.equal(
      retryProblemMessage({ code: "step_attempt_superseded" }),
      STEP_ATTEMPT_SUPERSEDED_MESSAGE,
    );
    assert.equal(
      retryProblemMessage({ code: "approval_closed" }),
      APPROVAL_CLOSED_MESSAGE,
    );
    assert.equal(retryProblemMessage({ code: "retry-denied" }), null);
    assert.equal(
      retryProblemShouldRefetch({ code: "execution_not_retryable" }),
      true,
    );
    assert.equal(
      retryProblemShouldRefetch({ code: "step_attempt_superseded" }),
      true,
    );
    assert.equal(retryProblemShouldRefetch({ code: "approval_closed" }), true);
    assert.equal(retryProblemShouldRefetch({ code: "retry-denied" }), false);
  });
});
