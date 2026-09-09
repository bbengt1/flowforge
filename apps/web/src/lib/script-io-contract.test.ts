import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SCRIPT_IO_API_PR,
  SCRIPT_IO_CONTRACT_FALLBACK_CATALOG,
  SCRIPT_IO_CONTRACT_FALLBACK_HELP,
  SCRIPT_IO_DEFAULT_RETRY_MAX_ATTEMPTS,
  SCRIPT_IO_EPIC,
  SCRIPT_IO_HANDLE_HELP,
  SCRIPT_IO_INDETERMINATE_HELP,
  SCRIPT_IO_MAX_INPUT_BYTES,
  SCRIPT_IO_NO_BLIND_RETRY_HELP,
  SCRIPT_IO_RETRY_ZERO_MESSAGE,
  SCRIPT_IO_ROUTE_MAP_SOURCE,
  SCRIPT_IO_SCHEMA_HELP,
  SCRIPT_IO_SECRET_SCHEMA_MESSAGE,
  SCRIPT_IO_SIZE_HELP,
  SCRIPT_IO_STORY,
  canBlindRetryScript,
  canOfferScriptRetry,
  coerceScriptIoSchema,
  executionHasScriptIndeterminate,
  executionHasScriptRun,
  isScriptIoActionType,
  isScriptIoHandleKey,
  looksLikeScriptIoNameTypeStub,
  parseScriptIoCatalog,
  parseScriptIoResult,
  parseScriptIoRetryResult,
  parseScriptIoSchemaText,
  patchScriptIoSchemaBounds,
  scriptIndeterminateCopy,
  scriptIoBounds,
  scriptRetryAllowed,
  scriptRetryBlockedMessage,
  stringifyScriptIoSchema,
  validateScriptIoNodeExtras,
  validateScriptIoSchema,
} from "./script-io-contract.ts";

describe("script I/O contract adapter", () => {
  it("cites E9.3 / #94 and marked contract-fallback until jonny's map lands", () => {
    assert.equal(SCRIPT_IO_STORY, 94);
    assert.equal(SCRIPT_IO_EPIC, 91);
    assert.equal(SCRIPT_IO_API_PR, 0);
    assert.equal(SCRIPT_IO_ROUTE_MAP_SOURCE, "e93-contract-fallback");
    assert.match(SCRIPT_IO_CONTRACT_FALLBACK_HELP, /e93-contract-fallback/);
    assert.match(SCRIPT_IO_CONTRACT_FALLBACK_HELP, /result\.retry\.allowed/);
    assert.equal(SCRIPT_IO_CONTRACT_FALLBACK_CATALOG.source, "contract-fallback");
    assert.equal(SCRIPT_IO_CONTRACT_FALLBACK_CATALOG.retry.blindRetry, false);
    assert.equal(
      SCRIPT_IO_CONTRACT_FALLBACK_CATALOG.retry.defaultMaxAttempts,
      SCRIPT_IO_DEFAULT_RETRY_MAX_ATTEMPTS,
    );
    assert.equal(scriptIoBounds().maxInputBytes, SCRIPT_IO_MAX_INPUT_BYTES);
    assert.match(SCRIPT_IO_SCHEMA_HELP, /JSON Schema subset/);
    assert.match(SCRIPT_IO_SIZE_HELP, /16 KiB/);
    assert.match(SCRIPT_IO_RETRY_ZERO_MESSAGE, /idempotency key/);
    assert.match(SCRIPT_IO_HANDLE_HELP, /never displays handle values/);
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
    assert.match(SCRIPT_IO_INDETERMINATE_HELP, /Do not blindly re-run/);
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

  it("overlays GET /scripts/catalog io / retry when present", () => {
    const parsed = parseScriptIoCatalog({
      io: {
        maxInputBytes: 8192,
        maxOutputBytes: 8192,
        schemaKeywords: ["type", "properties"],
      },
      retry: {
        defaultMaxAttempts: 0,
        leaseLossOutcome: "indeterminate",
        ui: { hideRetryWhen: "indeterminate without retry.allowed" },
      },
      errors: [{ code: "invalid-schema", status: 400, meaning: "bad schema" }],
    });
    assert.equal(parsed.source, "scripts-catalog");
    assert.equal(parsed.bounds.maxInputBytes, 8192);
    assert.equal(parsed.retry.blindRetry, false);
    assert.equal(parsed.errors[0]?.code, "invalid-schema");

    const empty = parseScriptIoCatalog({});
    assert.equal(empty.source, "contract-fallback");
    assert.equal(empty.notes, SCRIPT_IO_CONTRACT_FALLBACK_HELP);
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
