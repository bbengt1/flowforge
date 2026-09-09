import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SSH_DEFAULT_RETRY_MAX_ATTEMPTS,
  SSH_INDETERMINATE_LEASE_LOSS_HELP,
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
  SSH_VERIFICATION_UNAVAILABLE_HELP,
  canBlindRetrySsh,
  commandProfileRetrySafe,
  defaultSshRetryPolicy,
  emptyCommandProfileRetrySafe,
  executionHasSshIndeterminate,
  executionHasSshRun,
  isSshRunType,
  parseSshRetryCatalog,
  sshIndeterminateCopy,
  sshRetryBlockedMessage,
  sshRetryPolicyFromWith,
  sshRetryPolicyHint,
  sshVerificationAction,
  sshVerificationAvailable,
  validateSshRetryPolicy,
} from "./ssh-retry-contract.ts";

describe("ssh retry contract adapter", () => {
  it("cites E8.3 / E8 and stays on contract-fallback until jonny's map", () => {
    assert.equal(SSH_RETRY_STORY, 84);
    assert.equal(SSH_RETRY_EPIC, 81);
    assert.equal(SSH_RETRY_API_PR, 0);
    assert.equal(SSH_RETRY_ROUTE_MAP_SOURCE, "e83-contract-fallback");
    assert.equal(SSH_RUN_NODE_TYPE, "ssh.run");
    assert.equal(SSH_DEFAULT_RETRY_MAX_ATTEMPTS, 0);
    assert.equal(SSH_MAX_RETRY_ATTEMPTS, 5);
    assert.equal(SSH_RETRY_CONTRACT_FALLBACK_CATALOG.source, "contract-fallback");
    assert.equal(SSH_RETRY_CONTRACT_FALLBACK_CATALOG.retrySafeDefault, false);
    assert.equal(SSH_RETRY_CONTRACT_FALLBACK_CATALOG.verification.available, false);
    assert.match(SSH_RETRY_CONTRACT_FALLBACK_CATALOG.notes ?? "", /contract-fallback|unavailable/i);
    assert.match(SSH_RETRY_SAFE_HELP, /idempotent verification path/i);
    assert.match(SSH_RETRY_ZERO_MESSAGE, /default to zero/i);
  });

  it("defaults maxAttempts to 0 and retrySafe to false", () => {
    assert.deepEqual(defaultSshRetryPolicy(), { maxAttempts: 0 });
    assert.equal(emptyCommandProfileRetrySafe(), false);
    assert.equal(commandProfileRetrySafe({}), false);
    assert.equal(commandProfileRetrySafe({ retrySafe: false }), false);
    assert.equal(commandProfileRetrySafe({ retrySafe: true }), true);
    assert.equal(commandProfileRetrySafe(null), false);
    assert.deepEqual(sshRetryPolicyFromWith({}), { maxAttempts: 0 });
    assert.deepEqual(sshRetryPolicyFromWith({ retryPolicy: { maxAttempts: 0 } }), {
      maxAttempts: 0,
    });
  });

  it("rejects maxAttempts>0 without profile retrySafe and warns when retrySafe", () => {
    const denied = validateSshRetryPolicy({
      withValue: { retryPolicy: { maxAttempts: 2 } },
      profileRetrySafe: false,
    });
    assert.equal(denied.ok, false);
    assert.ok(denied.errors.includes(SSH_RETRY_DENIED_MESSAGE));
    assert.equal(denied.maxAttempts, 2);

    const missing = validateSshRetryPolicy({
      maxAttempts: 1,
    });
    assert.equal(missing.ok, false);
    assert.ok(missing.errors.includes(SSH_RETRY_DENIED_MESSAGE));

    const allowed = validateSshRetryPolicy({
      withValue: { retryPolicy: { maxAttempts: 1 } },
      profileRetrySafe: true,
    });
    assert.equal(allowed.ok, true);
    assert.deepEqual(allowed.errors, []);
    assert.ok(allowed.warnings.some((item) => /not a blind auto-retry/i.test(item)));

    const zero = validateSshRetryPolicy({
      withValue: { retryPolicy: { maxAttempts: 0 } },
      profileRetrySafe: false,
    });
    assert.equal(zero.ok, true);
    assert.deepEqual(zero.errors, []);

    const range = validateSshRetryPolicy({
      withValue: { retryPolicy: { maxAttempts: 9 } },
      profileRetrySafe: true,
    });
    assert.equal(range.ok, false);
    assert.ok(range.errors.some((item) => /between 0 and 5/.test(item)));
  });

  it("never offers a blind SSH retry, including indeterminate", () => {
    assert.equal(canBlindRetrySsh(), false);
    assert.equal(canBlindRetrySsh({ status: "failed", nodeType: "ssh.run" }), false);
    assert.equal(
      canBlindRetrySsh({ status: "indeterminate", nodeType: "ssh.run" }),
      false,
    );
    assert.equal(isSshRunType("ssh.run"), true);
    assert.equal(isSshRunType("data.set"), false);
    assert.equal(
      executionHasSshRun([{ nodeType: "ssh.run", status: "failed" }]),
      true,
    );
    assert.equal(
      executionHasSshIndeterminate([
        { nodeType: "ssh.run", status: "indeterminate" },
      ]),
      true,
    );
    assert.equal(
      executionHasSshIndeterminate([{ nodeType: "ssh.run", status: "failed" }]),
      false,
    );
    const blocked = sshRetryBlockedMessage({
      status: "indeterminate",
      nodeType: "ssh.run",
    });
    assert.match(blocked, /Do not assume the command did not run/i);
    assert.match(blocked, /never offers a blind retry/i);
    assert.equal(blocked.includes(SSH_INDETERMINATE_LEASE_LOSS_HELP), true);
    assert.equal(blocked.includes(SSH_NO_BLIND_RETRY_HELP), true);
    assert.match(sshIndeterminateCopy({ status: "indeterminate", nodeType: "ssh.run" }), /lease lost/i);
  });

  it("overlays GET /ssh/catalog retry schema and keeps verification fallback", () => {
    const parsed = parseSshRetryCatalog({
      retry: {
        defaultMaxAttempts: 0,
        retrySafeFlag: "retrySafe",
        semantics: "E8.3",
        note: "Retries default to zero.",
      },
      errors: [
        { code: "retry-denied", status: 400, meaning: "maxAttempts>0 needs retrySafe." },
        { code: "indeterminate", status: 409, meaning: "Lease lost. No blind retry." },
      ],
    });
    assert.equal(parsed.source, "ssh-catalog");
    assert.equal(parsed.defaultMaxAttempts, 0);
    assert.equal(parsed.retrySafeFlag, "retrySafe");
    assert.equal(parsed.retrySafeDefault, false);
    assert.equal(parsed.verification.available, false);
    assert.match(parsed.verification.note, /does not yet list a verification/i);
    assert.equal(sshVerificationAvailable(parsed), false);
    assert.equal(sshVerificationAction(parsed).available, false);
    assert.match(sshVerificationAction(parsed).note, /e83-contract-fallback|does not yet list/i);

    const empty = parseSshRetryCatalog({});
    assert.equal(empty.source, "contract-fallback");
    assert.equal(empty.notes, SSH_RETRY_CONTRACT_FALLBACK_CATALOG.notes);

    const live = parseSshRetryCatalog({
      retry: {
        defaultMaxAttempts: 0,
        retrySafeFlag: "retrySafe",
        semantics: "E8.3",
        verification: {
          available: true,
          path: "/ssh/verify",
          method: "POST",
          note: "Verify before any retry.",
        },
      },
    });
    assert.equal(live.verification.available, true);
    assert.equal(live.verification.path, "/ssh/verify");
    assert.equal(live.verification.method, "POST");
    assert.equal(sshVerificationAction(live).available, true);

    const hint = sshRetryPolicyHint({ profileRetrySafe: false, maxAttempts: 0 });
    assert.match(hint, /retrySafe is false/);
    assert.match(hint, /idempotent verification path/i);
    assert.match(SSH_VERIFICATION_UNAVAILABLE_HELP, /e83-contract-fallback/);
  });
});
