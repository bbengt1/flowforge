import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SCRIPT_IO_ALLOWLISTED_ENV,
  SCRIPT_IO_API_PR,
  SCRIPT_IO_CONTRACT_FALLBACK_CATALOG,
  SCRIPT_IO_CONTRACT_FALLBACK_HELP,
  SCRIPT_IO_DEFAULT_RETRY_MAX_ATTEMPTS,
  SCRIPT_IO_EPIC,
  SCRIPT_IO_HANDLE_HELP,
  SCRIPT_IO_HANDLE_TTL_SECONDS,
  SCRIPT_IO_INDETERMINATE_HELP,
  SCRIPT_IO_INVALID_VERIFICATION_MESSAGE,
  SCRIPT_IO_MAX_INPUT_BYTES,
  SCRIPT_IO_NO_BLIND_RETRY_HELP,
  SCRIPT_IO_RETRY_DENIED_MESSAGE,
  SCRIPT_IO_RETRY_ZERO_MESSAGE,
  SCRIPT_IO_ROUTE_MAP_SOURCE,
  SCRIPT_IO_SCHEMA_HELP,
  SCRIPT_IO_SECRET_SCHEMA_MESSAGE,
  SCRIPT_IO_SIZE_HELP,
  SCRIPT_IO_STORY,
  SCRIPT_IO_VERIFICATION_BEHAVIOR,
  canBlindRetryScript,
  canOfferScriptRetry,
  coerceScriptIoSchema,
  executionHasScriptIndeterminate,
  executionHasScriptRun,
  isAllowlistedScriptEnv,
  isScriptIoActionType,
  isScriptIoHandleKey,
  looksLikeScriptIoNameTypeStub,
  parseScriptEvaluateRetry,
  parseScriptIoCatalog,
  parseScriptIoResult,
  parseScriptIoRetryResult,
  parseScriptIoSchemaText,
  patchScriptIoSchemaBounds,
  publicScriptHandle,
  scriptIndeterminateCopy,
  scriptIoBounds,
  scriptRetryAllowed,
  scriptRetryBlockedMessage,
  stringifyScriptIoSchema,
  validateScriptIoNodeExtras,
  validateScriptIoRetryDeclaration,
  validateScriptIoSchema,
} from "./script-io-contract.ts";

describe("script I/O contract adapter", () => {
  it("cites E9.3 / #101 and Keep #94 open", () => {
    assert.equal(SCRIPT_IO_STORY, 94);
    assert.equal(SCRIPT_IO_EPIC, 91);
    assert.equal(SCRIPT_IO_API_PR, 101);
    assert.equal(SCRIPT_IO_ROUTE_MAP_SOURCE, "e93-#101");
    assert.match(SCRIPT_IO_CONTRACT_FALLBACK_HELP, /e93-#101/);
    assert.match(SCRIPT_IO_CONTRACT_FALLBACK_HELP, /result\.retry\.allowed/);
    assert.match(SCRIPT_IO_CONTRACT_FALLBACK_HELP, /409 retry-denied/);
    assert.equal(SCRIPT_IO_CONTRACT_FALLBACK_CATALOG.source, "unavailable");
    assert.equal(SCRIPT_IO_CONTRACT_FALLBACK_CATALOG.retry.blindRetry, false);
    assert.equal(SCRIPT_IO_CONTRACT_FALLBACK_CATALOG.io.plaintextCredentials, false);
    assert.equal(SCRIPT_IO_CONTRACT_FALLBACK_CATALOG.io.validateBeforeInject, true);
    assert.equal(SCRIPT_IO_CONTRACT_FALLBACK_CATALOG.io.redactBeforePersist, true);
    assert.equal(
      SCRIPT_IO_CONTRACT_FALLBACK_CATALOG.io.handleTTLSeconds,
      SCRIPT_IO_HANDLE_TTL_SECONDS,
    );
    assert.equal(SCRIPT_IO_CONTRACT_FALLBACK_CATALOG.io.handleMaxTTLSeconds, 300);
    assert.deepEqual(
      [...SCRIPT_IO_CONTRACT_FALLBACK_CATALOG.io.allowlistedEnv],
      [...SCRIPT_IO_ALLOWLISTED_ENV],
    );
    assert.equal(SCRIPT_IO_CONTRACT_FALLBACK_CATALOG.probe.behavior, SCRIPT_IO_VERIFICATION_BEHAVIOR);
    assert.equal(
      SCRIPT_IO_CONTRACT_FALLBACK_CATALOG.retry.defaultMaxAttempts,
      SCRIPT_IO_DEFAULT_RETRY_MAX_ATTEMPTS,
    );
    assert.equal(
      SCRIPT_IO_CONTRACT_FALLBACK_CATALOG.errors.some((item) => item.code === "typed-io-not-implemented"),
      false,
    );
    assert.ok(SCRIPT_IO_CONTRACT_FALLBACK_CATALOG.errors.some((item) => item.code === "handle-forbidden"));
    assert.ok(SCRIPT_IO_CONTRACT_FALLBACK_CATALOG.errors.some((item) => item.code === "env-denied"));
    assert.equal(scriptIoBounds().maxInputBytes, SCRIPT_IO_MAX_INPUT_BYTES);
    assert.match(SCRIPT_IO_SCHEMA_HELP, /JSON Schema subset/);
    assert.match(SCRIPT_IO_SIZE_HELP, /16 KiB/);
    assert.match(SCRIPT_IO_RETRY_ZERO_MESSAGE, /idempotencyKey/);
    assert.match(SCRIPT_IO_HANDLE_HELP, /never collects or displays handle secrets/);
    assert.equal(isAllowlistedScriptEnv("FLOWFORGE_HANDLE_IDS"), true);
    assert.equal(isAllowlistedScriptEnv("AWS_SECRET_ACCESS_KEY"), false);
    assert.equal(isScriptIoActionType("script.python"), true);
    assert.equal(isScriptIoActionType("script.go"), true);
    assert.equal(isScriptIoActionType("ssh.run"), false);
  });

  it("coerces name=type stubs into the documented JSON Schema subset", () => {
    const stub = { payload: "object", status: "string" };
    assert.equal(looksLikeScriptIoNameTypeStub(stub), true);
    assert.deepEqual(coerceScriptIoSchema(stub), {
      type: "object",
      additionalProperties: false,
      properties: {
        payload: { type: "object" },
        status: { type: "string" },
      },
    });
    assert.deepEqual(validateScriptIoSchema("inputSchema", stub), []);
    const proper = {
      type: "object",
      additionalProperties: false,
      properties: { payload: { type: "object" } },
      required: ["payload"],
      maxProperties: 8,
    };
    assert.equal(looksLikeScriptIoNameTypeStub(proper), false);
    assert.deepEqual(validateScriptIoSchema("outputSchema", proper), []);
    assert.match(stringifyScriptIoSchema(proper), /"type": "object"/);
  });

  it("rejects secret field names, unknown keywords, and oversize schemas", () => {
    const secret = validateScriptIoSchema("inputSchema", {
      type: "object",
      properties: { token: { type: "string" } },
    });
    assert.ok(secret.includes(SCRIPT_IO_SECRET_SCHEMA_MESSAGE));

    const handle = validateScriptIoSchema("outputSchema", {
      type: "object",
      properties: { credentialHandle: { type: "string" } },
    });
    assert.ok(handle.includes(SCRIPT_IO_SECRET_SCHEMA_MESSAGE));

    const unknown = validateScriptIoSchema("inputSchema", {
      type: "object",
      $ref: "#/defs/secret",
    });
    assert.ok(unknown.some((error) => /unknown schema keyword/.test(error)));

    const classification = validateScriptIoSchema("outputSchema", {
      type: "string",
      classification: "secret",
    });
    assert.ok(classification.some((error) => /cannot be secret/.test(error)));

    assert.deepEqual(parseScriptIoSchemaText("{"), {
      error: "Schema must be valid JSON.",
    });
    assert.equal(isScriptIoHandleKey("scopedHandle"), true);
    assert.equal(isScriptIoHandleKey("payload"), false);
  });

  it("writes size bounds into the schema object, not invented with keys", () => {
    const patched = patchScriptIoSchemaBounds(
      { type: "object", properties: {} },
      { maxProperties: 4, maxItems: 8, maxLength: 128 },
    );
    assert.equal(patched.maxProperties, 4);
    assert.equal(patched.maxItems, 8);
    assert.equal(patched.maxLength, 128);
    assert.deepEqual(validateScriptIoSchema("inputSchema", patched), []);

    const oversize = validateScriptIoSchema("inputSchema", {
      type: "string",
      maxLength: SCRIPT_IO_MAX_INPUT_BYTES + 1,
    });
    assert.ok(oversize.some((error) => /maxLength/.test(error)));
  });

  it("never offers a blind script retry; Retry is gated on result.retry.allowed", () => {
    assert.equal(canBlindRetryScript({ status: "indeterminate", nodeType: "script.python" }), false);
    assert.equal(
      executionHasScriptIndeterminate([{ nodeType: "script.python", status: "indeterminate" }]),
      true,
    );
    assert.equal(executionHasScriptRun([{ nodeType: "script.go" }]), true);
    assert.equal(
      canOfferScriptRetry({
        nodeType: "script.python",
        status: "indeterminate",
        output: { retry: { allowed: false } },
      }),
      false,
    );
    assert.equal(
      canOfferScriptRetry({
        permissions: ["workflow.execute"],
        nodeType: "script.python",
        status: "indeterminate",
        output: { retry: { allowed: true, retrySafe: true, verificationDeclared: true } },
      }),
      true,
    );
    assert.equal(
      scriptRetryAllowed({ output: { result: { retry: { allowed: true } } } }),
      true,
    );
    assert.match(
      scriptRetryBlockedMessage({ status: "indeterminate", nodeType: "script.python" }),
      /Do not assume the script did not run/,
    );
    assert.match(scriptIndeterminateCopy(), /lease lost/i);
    assert.match(SCRIPT_IO_NO_BLIND_RETRY_HELP, /result\.retry\.allowed/);
    assert.match(SCRIPT_IO_INDETERMINATE_HELP, /never blindly re-run/);
  });

  it("parses redacted results, schema errors, and strips scoped handles", () => {
    const parsed = parseScriptIoResult({
      ok: true,
      stdout: "ok",
      result: {
        output: { status: "done", scopedHandle: "h-secret" },
        validation: {
          output: {
            errors: [{ path: "result.count", code: "invalid-schema", message: "not an integer" }],
          },
        },
        retry: { allowed: false, maxAttempts: 0, executedAttempts: 1 },
      },
    });
    assert.ok(parsed);
    assert.equal(parsed?.redacted, true);
    assert.equal((parsed?.output as { status?: string })?.status, "done");
    assert.equal("scopedHandle" in ((parsed?.output as object) ?? {}), false);
    assert.ok(parsed?.strippedHandleKeys.some((key) => /scopedHandle/.test(key)));
    assert.equal(parsed?.validationErrors[0]?.path, "result.count");
    assert.equal(parsed?.retry?.allowed, false);
    assert.equal(parseScriptIoRetryResult({ error: { retry: { allowed: true } } })?.allowed, true);
  });

  it("overlays GET /scripts/catalog io / retry.ui / retry.probe from #101", () => {
    const parsed = parseScriptIoCatalog({
      io: {
        maxInputBytes: 8192,
        maxOutputBytes: 8192,
        secretsForbidden: true,
        plaintextCredentials: false,
        handleInjection: "scoped-short-lived",
        handleTTLSeconds: 60,
        handleMaxTTLSeconds: 300,
        allowlistedEnv: ["FLOWFORGE_CORRELATION_ID", "FLOWFORGE_HANDLE_IDS"],
        validateBeforeInject: true,
        redactBeforePersist: true,
      },
      retry: {
        defaultMaxAttempts: 0,
        leaseLossOutcome: "indeterminate",
        requiresIdempotencyKey: true,
        requiresVerificationWhenRetrySafe: true,
        ui: {
          retryEnabledWhen: "Show Retry when result.retry.allowed is true",
          hideRetryWhen: "indeterminate without retry.allowed",
        },
        probe: {
          behavior: "declared-hook",
          onMatchDefault: "already-applied",
          onMismatchDefault: "safe-to-retry",
          onError: "indeterminate",
        },
      },
      errors: [{ code: "invalid-schema", status: 400, meaning: "bad schema" }],
    });
    assert.equal(parsed.source, "scripts-catalog");
    assert.equal(parsed.bounds.maxInputBytes, 8192);
    assert.equal(parsed.io.handleTTLSeconds, 60);
    assert.equal(parsed.io.validateBeforeInject, true);
    assert.equal(parsed.retry.blindRetry, false);
    assert.equal(parsed.retry.requiresIdempotencyKey, true);
    assert.equal(parsed.probe.behavior, "declared-hook");
    assert.equal(parsed.ui.retrySafeFlag, "retrySafe");
    assert.equal(parsed.errors[0]?.code, "invalid-schema");

    const empty = parseScriptIoCatalog({});
    assert.equal(empty.source, "unavailable");
    assert.equal(empty.notes, SCRIPT_IO_CONTRACT_FALLBACK_HELP);
    assert.equal(empty.io.handleTTLSeconds, 60);
  });

  it("validates retrySafe + idempotencyKey + declared-hook before writing with", () => {
    assert.deepEqual(
      validateScriptIoRetryDeclaration({ retrySafe: false, retryPolicy: { maxAttempts: 0 } }).errors,
      [],
    );
    const missing = validateScriptIoRetryDeclaration({
      retrySafe: true,
      retryPolicy: { maxAttempts: 1 },
    });
    assert.ok(missing.errors.includes(SCRIPT_IO_INVALID_VERIFICATION_MESSAGE));
    assert.ok(missing.errors.includes(SCRIPT_IO_RETRY_DENIED_MESSAGE));

    const badKey = validateScriptIoRetryDeclaration({
      retrySafe: true,
      idempotencyKey: "1bad",
      verification: { behavior: "declared-hook" },
    });
    assert.ok(badKey.errors.some((error) => /idempotencyKey must be 1–128/.test(error)));

    const ok = validateScriptIoRetryDeclaration({
      retrySafe: true,
      idempotencyKey: "summarize-v1",
      verification: { behavior: "declared-hook" },
      retryPolicy: { maxAttempts: 2 },
    });
    assert.deepEqual(ok.errors, []);
    assert.equal(ok.verificationDeclared, true);

    const orphan = validateScriptIoRetryDeclaration({
      retrySafe: false,
      idempotencyKey: "summarize-v1",
    });
    assert.ok(orphan.errors.some((error) => /only valid when retrySafe/.test(error)));
  });

  it("parses evaluate retryAllowed for script nodes and projects public handles", () => {
    const evaluate = parseScriptEvaluateRetry({
      operations: [
        {
          operation: "script.python",
          nodeId: "run",
          retryAllowed: true,
          retrySafe: true,
          verificationDeclared: true,
          retryMaxAttempts: 2,
        },
        { operation: "ssh.run", retryAllowed: false },
      ],
    });
    assert.equal(evaluate.length, 1);
    assert.equal(evaluate[0]?.retryAllowed, true);
    assert.deepEqual(
      publicScriptHandle({
        id: "h1",
        scopes: ["vault.read"],
        expiresAt: "2026-09-09T00:01:00Z",
        secret: "nope",
      }),
      { id: "h1", scopes: ["vault.read"], expiresAt: "2026-09-09T00:01:00Z" },
    );
  });

  it("keeps node extras fail-closed without inventing with keys", () => {
    const ok = validateScriptIoNodeExtras({
      inputSchema: {
        type: "object",
        properties: { payload: { type: "object" } },
      },
      outputSchema: { type: "object", properties: { status: { type: "string" } } },
    });
    assert.deepEqual(ok, []);
    const denied = validateScriptIoNodeExtras({
      inputSchema: { type: "object", properties: { password: { type: "string" } } },
    });
    assert.ok(denied.includes(SCRIPT_IO_SECRET_SCHEMA_MESSAGE));
  });
});
