import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SSH_DEFAULT_RETRY_MAX_ATTEMPTS,
  SSH_INDETERMINATE_LEASE_LOSS_HELP,
  SSH_INVALID_VERIFICATION_MESSAGE,
  SSH_MAX_RETRY_ATTEMPTS,
  SSH_NO_BLIND_RETRY_HELP,
  SSH_RETRY_API_PR,
  SSH_RETRY_CONTRACT_FALLBACK_CATALOG,
  SSH_RETRY_DENIED_MESSAGE,
  SSH_RETRY_EPIC,
  SSH_RETRY_ROUTE_MAP_SOURCE,
  SSH_RETRY_SAFE_HELP,
  SSH_RETRY_STORY,
  SSH_RETRY_ZERO_MESSAGE,
  SSH_RUN_NODE_TYPE,
  SSH_VERIFY_ALREADY_APPLIED,
  canBlindRetrySsh,
  canOfferSshRetry,
  commandProfileRetrySafe,
  commandProfileVerificationDeclared,
  defaultSshRetryPolicy,
  defaultSshVerificationSpec,
  emptyCommandProfileRetrySafe,
  executionHasSshIndeterminate,
  isSshRunType,
  parseSshEvaluateRetry,
  parseSshRetryCatalog,
  parseSshRetryResult,
  parseSshVerificationSpec,
  sshRetryAllowed,
  sshRetryPolicyFromWith,
  sshVerificationOutcomeCopy,
  validateSshRetryPolicy,
  validateSshVerificationSpec,
} from "./ssh-retry-contract.ts";

describe("ssh retry contract adapter", () => {
  it("cites E8.3 / E8 and jonny's #90 map on main", () => {
    assert.equal(SSH_RETRY_STORY, 84);
    assert.equal(SSH_RETRY_EPIC, 81);
    assert.equal(SSH_RETRY_API_PR, 90);
    assert.equal(SSH_RETRY_ROUTE_MAP_SOURCE, "e83-#90");
    assert.equal(SSH_RUN_NODE_TYPE, "ssh.run");
    assert.equal(SSH_DEFAULT_RETRY_MAX_ATTEMPTS, 0);
    assert.equal(SSH_MAX_RETRY_ATTEMPTS, 5);
    assert.equal(SSH_RETRY_CONTRACT_FALLBACK_CATALOG.source, "unavailable");
    assert.equal(SSH_RETRY_CONTRACT_FALLBACK_CATALOG.retrySafeDefault, false);
    assert.equal(SSH_RETRY_CONTRACT_FALLBACK_CATALOG.ui.neverAssumeAbsent, true);
    assert.equal(SSH_RETRY_CONTRACT_FALLBACK_CATALOG.probe.requiredWhenRetrySafe, true);
    assert.match(SSH_RETRY_SAFE_HELP, /idempotent verification probe/i);
    assert.match(SSH_RETRY_ZERO_MESSAGE, /default to zero/i);
  });

  it("defaults maxAttempts to 0 and retrySafe to false", () => {
    assert.deepEqual(defaultSshRetryPolicy(), { maxAttempts: 0 });
    assert.equal(emptyCommandProfileRetrySafe(), false);
    assert.equal(commandProfileRetrySafe({}), false);
    assert.equal(commandProfileVerificationDeclared({}), false);
    assert.equal(commandProfileVerificationDeclared({ verification: { template: "true" } }), true);
    assert.deepEqual(sshRetryPolicyFromWith({}), { maxAttempts: 0 });
    assert.equal(defaultSshVerificationSpec().onError, "indeterminate");
    assert.equal(parseSshVerificationSpec({ template: " systemctl is-active nginx " })?.template, "systemctl is-active nginx");
  });

  it("rejects maxAttempts>0 without retrySafe+verification", () => {
    const denied = validateSshRetryPolicy({
      withValue: { retryPolicy: { maxAttempts: 2 } },
      profileRetrySafe: false,
    });
    assert.equal(denied.ok, false);
    assert.ok(denied.errors.includes(SSH_RETRY_DENIED_MESSAGE));

    const missingProbe = validateSshRetryPolicy({
      maxAttempts: 1,
      profileRetrySafe: true,
      verificationDeclared: false,
    });
    assert.equal(missingProbe.ok, false);
    assert.ok(missingProbe.errors.includes(SSH_RETRY_DENIED_MESSAGE));
    assert.ok(missingProbe.errors.includes(SSH_INVALID_VERIFICATION_MESSAGE));

    const allowed = validateSshRetryPolicy({
      withValue: { retryPolicy: { maxAttempts: 1 } },
      profileRetrySafe: true,
      verificationDeclared: true,
    });
    assert.equal(allowed.ok, true);
    assert.deepEqual(allowed.errors, []);
    assert.ok(allowed.warnings.some((item) => /probe first/i.test(item)));

    const zero = validateSshRetryPolicy({
      withValue: { retryPolicy: { maxAttempts: 0 } },
      profileRetrySafe: false,
    });
    assert.equal(zero.ok, true);
  });

  it("requires verification.template when retrySafe is true", () => {
    assert.deepEqual(
      validateSshVerificationSpec({ retrySafe: true }),
      [SSH_INVALID_VERIFICATION_MESSAGE],
    );
    assert.deepEqual(
      validateSshVerificationSpec({
        retrySafe: true,
        verification: { template: "true" },
      }),
      [],
    );
    assert.deepEqual(
      validateSshVerificationSpec({
        retrySafe: false,
        verification: { template: "true" },
      }),
      [SSH_INVALID_VERIFICATION_MESSAGE],
    );
  });

  it("never offers a blind SSH retry; Retry is gated on result.retry.allowed", () => {
    assert.equal(canBlindRetrySsh(), false);
    assert.equal(canBlindRetrySsh({ status: "indeterminate", nodeType: "ssh.run" }), false);
    assert.equal(isSshRunType("ssh.run"), true);
    assert.equal(
      executionHasSshIndeterminate([{ nodeType: "ssh.run", status: "indeterminate" }]),
      true,
    );
    assert.equal(
      canOfferSshRetry({
        permissions: ["workflow.execute"],
        nodeType: "ssh.run",
        status: "indeterminate",
        output: { retry: { allowed: false, retrySafe: false } },
      }),
      false,
    );
    assert.equal(
      canOfferSshRetry({
        permissions: ["workflow.execute"],
        nodeType: "ssh.run",
        status: "indeterminate",
        output: {
          retry: {
            allowed: true,
            retrySafe: true,
            verificationDeclared: true,
            maxAttempts: 2,
          },
        },
      }),
      true,
    );
    assert.equal(
      canOfferSshRetry({
        permissions: [],
        nodeType: "ssh.run",
        output: { retry: { allowed: true } },
      }),
      false,
    );
    assert.equal(
      sshRetryAllowed({
        evaluation: {
          nodeId: "run",
          operation: "ssh.run",
          retrySafe: true,
          retryMaxAttempts: 1,
          retryAllowed: true,
          verificationDeclared: true,
        },
      }),
      true,
    );
    assert.match(SSH_NO_BLIND_RETRY_HELP, /result\.retry\.allowed/);
    assert.match(SSH_INDETERMINATE_LEASE_LOSS_HELP, /Do not assume the command did not run/);
  });

  it("overlays GET /ssh/catalog retry.ui and retry.probe", () => {
    const parsed = parseSshRetryCatalog({
      retry: {
        defaultMaxAttempts: 0,
        retrySafeFlag: "retrySafe",
        semantics: "E8.3",
        note: "Retries default to zero.",
        ui: {
          indeterminateBadge: "indeterminate",
          retrySafeFlag: "retrySafe",
          retryEnabledWhen: "Show Retry when result.retry.allowed is true",
          hideRetryWhen: "indeterminate without retry.allowed",
          neverAssumeAbsent: true,
        },
        probe: {
          requiredWhenRetrySafe: true,
          field: "verification",
          onMatchDefault: "already-applied",
          onMismatchDefault: "safe-to-retry",
          onError: "indeterminate",
          outcomes: ["already-applied", "safe-to-retry", "indeterminate"],
        },
      },
      errors: [
        { code: "retry-denied", status: 400, meaning: "maxAttempts>0 needs retrySafe." },
        { code: "invalid-verification", status: 400, meaning: "retrySafe needs probe." },
        { code: "indeterminate", status: 409, meaning: "Lease lost." },
      ],
    });
    assert.equal(parsed.source, "ssh-catalog");
    assert.equal(parsed.ui.neverAssumeAbsent, true);
    assert.equal(parsed.probe.requiredWhenRetrySafe, true);
    assert.equal(parsed.probe.onMatchDefault, "already-applied");
    assert.equal(parsed.errors.some((item) => item.code === "invalid-verification"), true);

    const empty = parseSshRetryCatalog({});
    assert.equal(empty.source, "unavailable");
    assert.match(empty.notes ?? "", /e83-#90/);

    const result = parseSshRetryResult({
      retry: {
        allowed: true,
        retrySafe: true,
        verificationDeclared: true,
        verification: { outcome: SSH_VERIFY_ALREADY_APPLIED },
      },
    });
    assert.equal(result?.allowed, true);
    assert.equal(result?.verificationOutcome, "already-applied");
    assert.match(sshVerificationOutcomeCopy("already-applied"), /was not repeated/);

    const evaluate = parseSshEvaluateRetry({
      operations: [
        {
          nodeId: "run",
          operation: "ssh.run",
          retrySafe: true,
          retryMaxAttempts: 0,
          retryAllowed: false,
          verificationDeclared: true,
        },
        { nodeId: "set", operation: "data.set", retryAllowed: true },
      ],
    });
    assert.equal(evaluate.length, 1);
    assert.equal(evaluate[0]?.retryMaxAttempts, 0);
    assert.equal(evaluate[0]?.verificationDeclared, true);
  });
});
