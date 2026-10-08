import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  EDITOR_RUN_OVERLAY_KEYBOARD_HELP,
  EDITOR_RUNS_OPERATE_HELP,
} from "./editor-runs.ts";
import {
  CANCEL_APPLIED_MESSAGE,
  CANCEL_FORBIDDEN_MESSAGE,
  CANCEL_IDEMPOTENT_MESSAGE,
  DOWNLOAD_APPLIED_MESSAGE,
  DOWNLOAD_EXPIRED_MESSAGE,
  DOWNLOAD_FORBIDDEN_MESSAGE,
  DOWNLOAD_GRANT_HELP,
  DOWNLOAD_UNAVAILABLE_MESSAGE,
  COMPARE_REDACTION_HELP,
  EXECUTION_JOBS_HELP,
  EXECUTION_NO_CONFIG_PINS,
  EXECUTIONS_VIEW_DENIED,
  GRAPH_REPLAY_HELP,
  IDEMPOTENCY_CONFLICT_MESSAGE,
  IDEMPOTENCY_KEY_HELP,
  LEGAL_HOLD_HELP,
  RETENTION_HELP,
  RETRY_APPLIED_MESSAGE,
  RETRY_FORBIDDEN_MESSAGE,
  RETRY_UNAVAILABLE_MESSAGE,
  strippedSecretFieldsMessage,
} from "./execution-contract.ts";
import { executionStatusReasonSentence } from "./execution.ts";
import {
  EXECUTION_INBOX_COMPARE_HELP,
  EXECUTION_INBOX_EMPTY_HELP,
  EXECUTION_INBOX_HELP,
  EXECUTION_INBOX_KEYBOARD_HELP,
  EXECUTION_INBOX_START_HELP,
  EXECUTION_INBOX_START_LINK,
  EXECUTIONS_PAGE_HELP,
} from "./execution-inbox.ts";
import {
  EXECUTION_OPERATE_HELP,
  EXECUTION_OPERATE_RETRY_GATE_HELP,
} from "./execution-operate.ts";
import {
  KUBERNETES_ROLLOUT_AUDIT_HELP,
  KUBERNETES_ROLLOUT_REDACTION_HELP,
  KUBERNETES_ROLLOUT_WAITING_MESSAGE,
} from "./kubernetes-rollout-contract.ts";
import {
  MANUAL_START_BAD_INPUT_MESSAGE,
  MANUAL_START_CONFLICT_MESSAGE,
  MANUAL_START_ROLE_DENIED,
  startFailureMessage,
} from "./manual-start-contract.ts";
import {
  SCRIPT_IO_INDETERMINATE_HELP,
  SCRIPT_IO_NO_BLIND_RETRY_HELP,
  SCRIPT_IO_RESULT_PANEL_HELP,
  SCRIPT_IO_VALIDATION_HELP,
} from "./script-io-contract.ts";
import {
  SCRIPT_EMERGENCY_STOP_CONFIRM_HELP,
  SCRIPT_EMERGENCY_STOP_DENIED_MESSAGE,
  SCRIPT_EMERGENCY_STOP_FORBIDDEN_MESSAGE,
  SCRIPT_EMERGENCY_STOP_HELP,
  SCRIPT_EMERGENCY_STOP_INDETERMINATE_HELP,
  SCRIPT_NO_BLIND_RETRY_AFTER_STOP_HELP,
} from "./script-ops-contract.ts";
import { SSH_NO_BLIND_RETRY_HELP } from "./ssh-retry-contract.ts";

/**
 * Developer wording that must not reach the runs inbox, run history, the
 * run page and its panels, the editor's Runs drawer, or the Start panel:
 * HTTP verbs with routes, CSRF, status codes in text, permission keys,
 * API fields and flags, node type keys, tracker ids, and "this UI".
 */
const DEVELOPER_COPY =
  /\b(?:GET|POST|PUT|PATCH|DELETE)\b|CSRF|Idempotency-Key|\/executions\b|\/workflows\/|\/approvals\/|\/artifact|\/api\/|HTTP \d{3}|\b(?:200|201|400|401|403|404|409|410)\b|workflow\.execute|execution\.(?:view|cancel)|approval\.(?:decide|view)|script\.(?:emergencyStop|python|go)|ssh\.run|capabilities\.|result\.(?:retry|observation|status|audit)|workflowVersionId|workflowId|allowEmergencyStop|kind=script|ops-config|fail-closed|fails closed|idempotent\b|contract bug|#\d+|\b[ER]\d+(?:\.\d+)?\b|Chloe UI|[Tt]his UI|href\b/;

const here = dirname(fileURLToPath(import.meta.url));

function source(relative: string): string {
  return readFileSync(join(here, "..", relative), "utf8");
}

/** Text a component can render: JSX text and double-quoted literals. */
function renderedLiterals(text: string): string[] {
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .split("\n")
    .filter((line) => !/^\s*import\b|\bfrom "/.test(line))
    .join("\n");
  return [
    ...code.matchAll(/"([^"\n]*)"/g),
    ...code.matchAll(/>([^<>{}]+)</g),
    // JSX text that runs into an expression, such as `Uses GET /x{"{id}"}`.
    ...code.matchAll(/>([^<>{}]+)\{/g),
  ]
    .map((match) => match[1].trim())
    .filter(Boolean)
    // Tailwind classes, ids, and data attributes are not copy.
    .filter((literal) => !/^[a-z0-9:/[\]().%_-]+(?: [a-z0-9:/[\]().%_-]+)*$/.test(literal))
    // Code between a comparison and a tag, such as `a > b ? (`, is not copy.
    .filter((literal) => !/===|!==|&&|\|\||=>|\?\s*\(|\)\s*\?|\?\.|;\s*$/.test(literal));
}

/** Every `title=` must belong to a component prop (Dialog titles), never a native tooltip. */
function nativeTitleAttributes(text: string): string[] {
  const found: string[] = [];
  let index = text.indexOf("title=");
  while (index !== -1) {
    const open = text.lastIndexOf("<", index);
    const tag = /^<([A-Za-z][\w.]*)/.exec(text.slice(open))?.[1] ?? "";
    if (!/^[A-Z]/.test(tag)) {
      found.push(`${tag || "?"} at ${index}`);
    }
    index = text.indexOf("title=", index + 1);
  }
  return found;
}

const SURFACES = [
  "app/executions/page.tsx",
  "components/executions/ExecutionHistory.tsx",
  "components/executions/ExecutionArtifacts.tsx",
  "components/executions/ExecutionDetail.tsx",
  "components/executions/ExecutionOperateActions.tsx",
  "components/executions/RolloutObservationPanel.tsx",
  "components/executions/ExecutionReplay.tsx",
  "components/executions/ScriptIoResultPanel.tsx",
  "components/workflows/EditorRunsDrawer.tsx",
  "components/workflows/ManualStartPanel.tsx",
] as const;

describe("run and Start surfaces use plain copy", () => {
  it("pins the new sentences", () => {
    assert.equal(
      EXECUTIONS_PAGE_HELP,
      "Runs in this workspace. Open a run to see each step on the graph, its output, and its artifacts.",
    );
    assert.equal(
      EXECUTION_INBOX_HELP,
      "Filter runs by status or workflow, then open one to see its steps. Cancel, Retry, and Stop are on each row when they apply. A waiting run continues once someone approves or rejects it. Drafts never run, and secrets show as [redacted].",
    );
    assert.equal(
      EXECUTION_INBOX_EMPTY_HELP,
      "Start a published version from the workflow page or the panel below. Starting again with the same idempotency key opens the existing run, and the same key with different input starts nothing. Drafts never run.",
    );
    assert.equal(EXECUTIONS_VIEW_DENIED, "Your role can't view runs.");
    assert.equal(MANUAL_START_ROLE_DENIED, "Your role can't start runs.");
    // Matches the Start dialog's empty pins sentence from #610.
    assert.equal(EXECUTION_NO_CONFIG_PINS, "No config pins on this run.");
    assert.match(source("components/workflows/RunControl.tsx"), /empty="No config pins on this run\."/);
    assert.equal(
      IDEMPOTENCY_KEY_HELP,
      "Starting this version again with the same key and the same input opens this run instead of starting a second one. The same key with different input starts nothing.",
    );
    assert.equal(CANCEL_APPLIED_MESSAGE, "Cancel recorded for this run.");
    assert.equal(CANCEL_IDEMPOTENT_MESSAGE, "This run was already canceled. Nothing else changed.");
    assert.equal(CANCEL_FORBIDDEN_MESSAGE, "Your role can't cancel runs. The run wasn't canceled.");
    assert.equal(
      RETRY_APPLIED_MESSAGE,
      "Retry queued a new attempt. Steps marked Indeterminate weren't re-run.",
    );
    assert.equal(RETRY_FORBIDDEN_MESSAGE, "Your role can't retry runs. No new attempt was started.");
    assert.equal(
      SCRIPT_EMERGENCY_STOP_FORBIDDEN_MESSAGE,
      "Your role or the bound script policy can't emergency-stop this run. The run wasn't stopped.",
    );
    assert.equal(
      MANUAL_START_BAD_INPUT_MESSAGE,
      "The run wasn't started. Only published versions can run, and the input has to be valid and no larger than 16 KiB.",
    );
    assert.equal(
      MANUAL_START_CONFLICT_MESSAGE,
      "The run wasn't started. This idempotency key was already used with different input, or this start needs approval first.",
    );
    // The key-conflict sentence #610 wrote stays as it is.
    assert.equal(
      IDEMPOTENCY_CONFLICT_MESSAGE,
      "This idempotency key was already used with different input, so no run was started. Use a new key only if you mean to start a new run.",
    );
    assert.equal(
      strippedSecretFieldsMessage(["token", "password"]),
      "FlowForge hid fields that looked like secrets: token, password. Tell your FlowForge admin.",
    );
  });

  it("keeps the status-code mapping and only changes the words", () => {
    const problem = (status: number, code: string) => ({
      type: `urn:flowforge:problem:${code}`,
      title: code,
      status,
      detail: code,
      instance: "/workflows",
      code,
      request_id: "req-624",
    });
    assert.equal(startFailureMessage(problem(400, "invalid-request")), MANUAL_START_BAD_INPUT_MESSAGE);
    assert.equal(startFailureMessage(problem(409, "conflict")), MANUAL_START_CONFLICT_MESSAGE);
    assert.equal(startFailureMessage(problem(500, "internal")), null);
  });

  it("keeps every user-facing constant on these surfaces free of developer wording", () => {
    const copy = {
      EXECUTIONS_PAGE_HELP,
      EXECUTION_INBOX_HELP,
      EXECUTION_INBOX_KEYBOARD_HELP,
      EXECUTION_INBOX_EMPTY_HELP,
      EXECUTION_INBOX_START_LINK,
      EXECUTION_INBOX_START_HELP,
      EXECUTION_INBOX_COMPARE_HELP,
      EXECUTIONS_VIEW_DENIED,
      STRIPPED: strippedSecretFieldsMessage(["token"]),
      EXECUTION_NO_CONFIG_PINS,
      EXECUTION_JOBS_HELP,
      GRAPH_REPLAY_HELP,
      COMPARE_REDACTION_HELP,
      MISSING_ACTOR: executionStatusReasonSentence("missing_actor") ?? "",
      IDEMPOTENCY_KEY_HELP,
      IDEMPOTENCY_CONFLICT_MESSAGE,
      CANCEL_APPLIED_MESSAGE,
      CANCEL_IDEMPOTENT_MESSAGE,
      CANCEL_FORBIDDEN_MESSAGE,
      RETRY_APPLIED_MESSAGE,
      RETRY_FORBIDDEN_MESSAGE,
      RETRY_UNAVAILABLE_MESSAGE,
      DOWNLOAD_GRANT_HELP,
      DOWNLOAD_FORBIDDEN_MESSAGE,
      DOWNLOAD_EXPIRED_MESSAGE,
      DOWNLOAD_APPLIED_MESSAGE,
      DOWNLOAD_UNAVAILABLE_MESSAGE,
      RETENTION_HELP,
      LEGAL_HOLD_HELP,
      EXECUTION_OPERATE_HELP,
      EXECUTION_OPERATE_RETRY_GATE_HELP,
      EDITOR_RUNS_OPERATE_HELP,
      EDITOR_RUN_OVERLAY_KEYBOARD_HELP,
      KUBERNETES_ROLLOUT_REDACTION_HELP,
      KUBERNETES_ROLLOUT_WAITING_MESSAGE,
      KUBERNETES_ROLLOUT_AUDIT_HELP,
      SCRIPT_IO_RESULT_PANEL_HELP,
      SCRIPT_IO_VALIDATION_HELP,
      SCRIPT_IO_NO_BLIND_RETRY_HELP,
      SCRIPT_IO_INDETERMINATE_HELP,
      SSH_NO_BLIND_RETRY_HELP,
      SCRIPT_EMERGENCY_STOP_HELP,
      SCRIPT_EMERGENCY_STOP_CONFIRM_HELP,
      SCRIPT_EMERGENCY_STOP_FORBIDDEN_MESSAGE,
      SCRIPT_EMERGENCY_STOP_DENIED_MESSAGE,
      SCRIPT_EMERGENCY_STOP_INDETERMINATE_HELP,
      SCRIPT_NO_BLIND_RETRY_AFTER_STOP_HELP,
      MANUAL_START_BAD_INPUT_MESSAGE,
      MANUAL_START_CONFLICT_MESSAGE,
      MANUAL_START_ROLE_DENIED,
    };
    for (const [name, text] of Object.entries(copy)) {
      assert.doesNotMatch(text, DEVELOPER_COPY, name);
    }
  });

  it("renders no developer wording or native title tooltip on any of these surfaces", () => {
    for (const relative of SURFACES) {
      const text = source(relative);
      assert.deepEqual(nativeTitleAttributes(text), [], relative);
      assert.doesNotMatch(text, /<code\b/, relative);
      for (const literal of renderedLiterals(text)) {
        assert.doesNotMatch(literal, DEVELOPER_COPY, `${relative}: ${literal}`);
      }
    }
  });

  it("renders no contract notes on these surfaces", () => {
    const contractNotes = [
      "DOWNLOAD_CSRF_HELP",
      "DOWNLOAD_GRANT_CONTRACT_NOTE",
      "EXECUTION_INBOX_CONTRACT_NOTE",
      "EDITOR_RUNS_CONTRACT_NOTE",
      "EXECUTION_OPERATE_CONTRACT_NOTE",
      "SCRIPT_IO_HANDLE_HELP",
      "CANCEL_CSRF_HELP",
      "RETRY_CSRF_HELP",
      "STATUS_POLL_HELP",
      "MANUAL_START_CSRF_HELP",
      "MANUAL_START_CATALOG_HELP",
    ];
    for (const relative of SURFACES) {
      const text = source(relative);
      for (const note of contractNotes) {
        assert.equal(text.includes(note), false, `${relative} renders ${note}`);
      }
    }
  });

  it("drops the tracker eyebrow and route list from the runs inbox header", () => {
    const page = source("app/executions/page.tsx");
    assert.doesNotMatch(page, /R4\.1|E5\/E8\/E9|Workspace inbox|FF_INBOX_EYEBROW_CLASS/);
    assert.match(page, /\{EXECUTIONS_PAGE_HELP\}/);
  });

  it("drops the permission-key tooltip from the locked Start label", () => {
    const home = source("components/home/WorkflowHome.tsx");
    assert.equal(home.includes('title="workflow.execute required"'), false);
    assert.match(home, />\s*Start locked\s*</);
  });
});
