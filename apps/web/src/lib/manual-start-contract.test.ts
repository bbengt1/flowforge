import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_MANUAL_START_SCHEMA,
  MANUAL_START_API_PR,
  MANUAL_START_CONTRACT_FALLBACK_HELP,
  MANUAL_START_CSRF_HELP,
  MANUAL_START_EPIC,
  MANUAL_START_FORBIDDEN_MESSAGE,
  MANUAL_START_IDEMPOTENCY_KEY_RE,
  MANUAL_START_MAX_INPUT_BYTES,
  MANUAL_START_PERMISSION,
  MANUAL_START_ROUTE_MAP_SOURCE,
  MANUAL_START_STORY,
  MANUAL_START_UNAUTHENTICATED_MESSAGE,
  buildManualStartRequest,
  canOfferManualStart,
  coerceManualStartFieldValue,
  editorManualStartHref,
  extractManualStartSchema,
  generateManualStartIdempotencyKey,
  inputFromTypedFields,
  isManualStartAuthFailure,
  manualStartAuthFailureMessage,
  manualStartHref,
  manualStartPath,
  normalizeManualStartIdempotencyKey,
  parseManualStartInputText,
  startOutcomeMessage,
  validateManualStartInput,
} from "./manual-start-contract.ts";
import type { WorkflowVersion } from "./workflow-types.ts";
import { listYamlTriggers } from "./workflow-yaml-nodes.ts";

const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";

const yamlWithSchema = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: restart-api
spec:
  triggers:
    - id: manual
      type: manual
      schema:
        type: object
        additionalProperties: false
        required:
          - ticket
        properties:
          ticket:
            type: string
            maxLength: 32
          dryRun:
            type: boolean
          token:
            type: string
  nodes:
    - id: seed
      type: data.set
      name: Seed
      with:
        value:
          ok: true
`;

function version(overrides: Partial<WorkflowVersion> = {}): WorkflowVersion {
  return {
    id: VERSION_ID,
    workflowId: WORKFLOW_ID,
    versionNumber: 3,
    definitionYaml: yamlWithSchema,
    digest: "sha256:abcdef0123456789",
    publishNote: "ready",
    publishedAt: "2026-09-09T00:00:00.000Z",
    ...overrides,
  };
}

describe("manual-start contract adapter", () => {
  it("keeps the E5 fallback route as the single retarget point", () => {
    assert.equal(MANUAL_START_STORY, 106);
    assert.equal(MANUAL_START_EPIC, 105);
    assert.equal(MANUAL_START_API_PR, 0);
    assert.equal(MANUAL_START_ROUTE_MAP_SOURCE, "e5-fallback");
    assert.equal(MANUAL_START_PERMISSION, "workflow.execute");
    assert.equal(
      manualStartPath(WORKFLOW_ID),
      `/workflows/${WORKFLOW_ID}/executions`,
    );
    assert.equal(manualStartHref(WORKFLOW_ID), `/workflows?start=${WORKFLOW_ID}`);
    assert.equal(manualStartHref("draft"), "/workflows?start=1");
    assert.equal(editorManualStartHref(WORKFLOW_ID), `/workflows/${WORKFLOW_ID}`);
    assert.match(MANUAL_START_CONTRACT_FALLBACK_HELP, /e5-fallback/);
    assert.match(MANUAL_START_CONTRACT_FALLBACK_HELP, /Do not invent POST \/executions/);
  });

  it("extracts a typed schema from published version YAML and skips secret fields", () => {
    const parsed = listYamlTriggers(yamlWithSchema);
    assert.equal(parsed[0]?.type, "manual");
    assert.equal((parsed[0]?.schema as { type?: string } | undefined)?.type, "object");

    const schema = extractManualStartSchema(yamlWithSchema);
    assert.equal(schema.source, "version-yaml");
    assert.equal(schema.triggerId, "manual");
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(
      schema.fields.map((field) => field.name),
      ["ticket", "dryRun"],
    );
    assert.equal(schema.fields.some((field) => field.name === "token"), false);
    const fallback = extractManualStartSchema("");
    assert.equal(fallback.source, "contract-fallback");
    assert.equal(fallback.additionalProperties, true);
    assert.deepEqual(fallback.schema.type, DEFAULT_MANUAL_START_SCHEMA.type);
  });

  it("generates and validates a letter-prefixed idempotency key", () => {
    const generated = generateManualStartIdempotencyKey(1_725_000_000_000, () => "abc-123");
    assert.match(generated, MANUAL_START_IDEMPOTENCY_KEY_RE);
    assert.equal(generated.startsWith("m-"), true);
    const empty = normalizeManualStartIdempotencyKey("  ");
    assert.equal(empty.ok, true);
    assert.match(empty.key, MANUAL_START_IDEMPOTENCY_KEY_RE);
    const bad = normalizeManualStartIdempotencyKey("1bad");
    assert.equal(bad.ok, false);
    const ok = normalizeManualStartIdempotencyKey("deploy-prod-1");
    assert.equal(ok.ok, true);
    assert.equal(ok.key, "deploy-prod-1");
  });

  it("coerces typed fields and rejects extra/secret/oversize input", () => {
    const schema = extractManualStartSchema(yamlWithSchema);
    const fields = inputFromTypedFields(schema.fields, {
      ticket: "OPS-1",
      dryRun: "true",
    });
    assert.equal(fields.ok, true);
    assert.deepEqual(fields.value, { ticket: "OPS-1", dryRun: true });
    const bool = coerceManualStartFieldValue(
      { name: "dryRun", type: "boolean", required: false },
      "false",
    );
    assert.equal(bool.value, false);
    const missing = inputFromTypedFields(
      [{ name: "ticket", type: "string", required: true }],
      { ticket: "" },
    );
    assert.equal(missing.ok, false);
    const extra = validateManualStartInput({ ticket: "OPS-1", other: true }, schema);
    assert.ok(extra.some((error) => /not declared/.test(error)));
    const secret = validateManualStartInput({ ticket: "OPS-1", password: "x" }, schema);
    assert.ok(secret.some((error) => /secret field/.test(error)));
    const huge = "x".repeat(MANUAL_START_MAX_INPUT_BYTES + 8);
    const oversize = validateManualStartInput({ ticket: huge }, schema);
    assert.ok(oversize.some((error) => /byte size bound/.test(error)));
    const parsed = parseManualStartInputText('{"ticket":"OPS-1","token":"hunter2"}');
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value?.ticket, "OPS-1");
    assert.equal("token" in (parsed.value ?? {}), false);
    assert.ok(parsed.strippedKeys.includes("token"));
  });

  it("builds a start body only for a published version with execute permission", () => {
    const versions = [version()];
    const unknown = buildManualStartRequest({
      versions,
      selectedVersionId: VERSION_ID,
      yaml: yamlWithSchema,
      fieldValues: { ticket: "OPS-1", dryRun: "true" },
      permissions: null,
    });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.authClosed, true);

    const denied = buildManualStartRequest({
      versions,
      selectedVersionId: VERSION_ID,
      yaml: yamlWithSchema,
      fieldValues: { ticket: "OPS-1", dryRun: "true" },
      permissions: ["workflow.view"],
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.authClosed, true);
    assert.equal(denied.body, null);
    assert.match(denied.reason, /workflow.execute/);

    const draft = buildManualStartRequest({
      versions,
      selectedVersionId: "draft",
      yaml: yamlWithSchema,
      fieldValues: { ticket: "OPS-1" },
      permissions: ["workflow.execute"],
    });
    assert.equal(draft.ok, false);
    assert.equal(draft.body, null);
    assert.match(draft.reason, /published/i);

    const started = buildManualStartRequest({
      versions,
      selectedVersionId: VERSION_ID,
      yaml: yamlWithSchema,
      fieldValues: { ticket: "OPS-1", dryRun: "true" },
      idempotencyKey: "deploy-prod-1",
      permissions: ["workflow.execute"],
    });
    assert.equal(started.ok, true);
    assert.deepEqual(started.body, {
      workflowVersionId: VERSION_ID,
      idempotencyKey: "deploy-prod-1",
      input: { ticket: "OPS-1", dryRun: true },
    });
    assert.equal(JSON.stringify(started.body).includes("draft"), false);
    assert.equal(started.confirmation?.digest, "sha256:abcdef0123456789");
    assert.equal(started.confirmation?.routeMapSource, "e5-fallback");
    assert.equal(started.confirmation?.permission, "workflow.execute");
    assert.match(started.confirmation?.auditHelp ?? "", /audited/);
  });

  it("fails closed on 401/403/CSRF and reports 201/200 replay copy", () => {
    assert.equal(canOfferManualStart(null), false);
    assert.equal(canOfferManualStart(["workflow.view"]), false);
    assert.equal(canOfferManualStart(["workflow.execute"]), true);
    assert.equal(
      manualStartAuthFailureMessage({
        type: "urn:flowforge:problem:forbidden",
        title: "Forbidden",
        status: 403,
        detail: "missing workflow.execute",
        instance: "/workflows",
        code: "forbidden",
        request_id: "req-1",
      }),
      MANUAL_START_FORBIDDEN_MESSAGE,
    );
    assert.equal(
      manualStartAuthFailureMessage({
        type: "urn:flowforge:problem:unauthenticated",
        title: "Unauthenticated",
        status: 401,
        detail: "stale",
        instance: "/session",
        code: "unauthenticated",
        request_id: "req-2",
      }),
      MANUAL_START_UNAUTHENTICATED_MESSAGE,
    );
    assert.equal(
      isManualStartAuthFailure({
        type: "urn:flowforge:problem:csrf-required",
        title: "CSRF required",
        status: 403,
        detail: "csrf header missing",
        instance: "/workflows",
        code: "csrf-required",
        request_id: "req-3",
      }),
      true,
    );
    assert.match(MANUAL_START_CSRF_HELP, /X-CSRF-Token/);
    assert.match(startOutcomeMessage(201), /201/);
    assert.match(startOutcomeMessage(200), /200/);
  });
});
