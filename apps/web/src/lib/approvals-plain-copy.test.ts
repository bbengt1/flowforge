import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  APPROVAL_BINDING_HELP,
  APPROVAL_DECIDE_NOTE,
  APPROVAL_DETAIL_PAGE_HELP,
  APPROVALS_PAGE_HELP,
  APPROVALS_VIEW_DENIED,
} from "./approval-contract.ts";
import {
  EXECUTION_AUDIT_EVENTS_HELP,
  EXECUTION_CANCEL_DENIED_NOTE,
  EXECUTION_DETAIL_PAGE_HELP,
  IDEMPOTENCY_CONFLICT_MESSAGE,
  IDEMPOTENCY_CREATED_MESSAGE,
  IDEMPOTENCY_REPLAY_MESSAGE,
  PRE_RUN_PUBLISHED_ONLY_HELP,
} from "./execution-contract.ts";
import {
  EXECUTION_DECIDE_APPROVED_MESSAGE,
  EXECUTION_DECIDE_MISSING_COPY,
  EXECUTION_DECIDE_OPEN_RUN_LABEL,
  EXECUTION_DECIDE_SELF_REQUESTED_COPY,
  EXECUTION_DECIDE_WAITING_COPY,
} from "./execution-decide.ts";
import {
  MANUAL_START_AUDIT_HELP,
  MANUAL_START_CONFIRM_HELP,
  MANUAL_START_CSRF_MESSAGE,
  MANUAL_START_FORBIDDEN_MESSAGE,
  MANUAL_START_IDEMPOTENCY_HELP,
  MANUAL_START_INPUT_HELP,
  MANUAL_START_UNAUTHENTICATED_MESSAGE,
} from "./manual-start-contract.ts";
import { WAITING_STATUS_HELP } from "./execution-types.ts";
import { PEAK_END_HEADLINES, peakEndLabel } from "./peak-end-operate-endings.ts";
import { homeLastRunPresentation } from "./home-row-scan.ts";

/**
 * Developer wording that must not reach the approvals pages, the run
 * page header and approval panel, the Start dialog, or the workflows
 * last-run chip: routes, HTTP verbs and codes, CSRF, permission keys,
 * API flags, the old resume and self-approval notes, and issue or
 * epic references.
 */
const DEVELOPER_COPY =
  /\bPOST\b|\bGET \/|CSRF|Idempotency-Key|\/approvals\/|\/executions\/|\/api\/|approval\.(decide|view)|workflow\.execute|execution\.cancel|script\.emergencyStop|waitResumeEnabled|dispatchAllowed|capabilities\.|workflowVersionId|workflowDigest|[Rr]esume is decide|[Ss]elf-approval|HTTP \d{3}|#\d+|\bE\d+\.\d+\b|Chloe UI|This UI/;

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
  ]
    .map((match) => match[1].trim())
    .filter(Boolean);
}

const SURFACES = [
  "app/approvals/page.tsx",
  "app/approvals/[id]/page.tsx",
  "components/approvals/ApprovalList.tsx",
  "components/approvals/ApprovalDetail.tsx",
  "components/approvals/ApprovalDecideControls.tsx",
  "components/approvals/ApprovalBindingSnapshot.tsx",
  "components/approvals/ExecutionApprovalState.tsx",
  "components/approvals/PreRunPolicyReview.tsx",
  "app/executions/[id]/page.tsx",
  "components/executions/ExecutionDecideActions.tsx",
  "components/workflows/EditorStartDialog.tsx",
  "components/workflows/RunControl.tsx",
  "components/workflows/ManualStartFields.tsx",
  "components/home/HomeLastRunStatus.tsx",
] as const;

describe("approvals and run surfaces use plain copy", () => {
  it("pins the new sentences", () => {
    assert.equal(
      APPROVALS_PAGE_HELP,
      "Approval requests in this workspace. A waiting run continues once someone approves or rejects its request.",
    );
    assert.equal(
      APPROVAL_DETAIL_PAGE_HELP,
      "Check what this request covers before you approve or reject it.",
    );
    assert.equal(APPROVALS_VIEW_DENIED, "Your role can't view approvals.");
    assert.equal(
      APPROVAL_BINDING_HELP,
      "Each approval covers one exact workflow version, target, operation, and policy. If any of them is published again, an earlier approval no longer applies, even one that was already approved.",
    );
    assert.equal(
      APPROVAL_DECIDE_NOTE,
      "The person who requested this approval can't approve or reject it.",
    );
    assert.equal(EXECUTION_DECIDE_SELF_REQUESTED_COPY, APPROVAL_DECIDE_NOTE);
    assert.equal(
      WAITING_STATUS_HELP,
      "Waiting for someone to approve or reject it, or for a timed delay to end.",
    );
    assert.equal(
      PRE_RUN_PUBLISHED_ONLY_HELP,
      "Only published versions can run. Drafts and unsaved changes never run.",
    );
  });

  it("keeps every user-facing constant on these surfaces free of developer wording", () => {
    const copy = {
      APPROVALS_PAGE_HELP,
      APPROVAL_DETAIL_PAGE_HELP,
      APPROVALS_VIEW_DENIED,
      APPROVAL_BINDING_HELP,
      APPROVAL_DECIDE_NOTE,
      EXECUTION_DETAIL_PAGE_HELP,
      EXECUTION_CANCEL_DENIED_NOTE,
      EXECUTION_AUDIT_EVENTS_HELP,
      IDEMPOTENCY_CONFLICT_MESSAGE,
      IDEMPOTENCY_CREATED_MESSAGE,
      IDEMPOTENCY_REPLAY_MESSAGE,
      PRE_RUN_PUBLISHED_ONLY_HELP,
      EXECUTION_DECIDE_WAITING_COPY,
      EXECUTION_DECIDE_MISSING_COPY,
      EXECUTION_DECIDE_OPEN_RUN_LABEL,
      EXECUTION_DECIDE_SELF_REQUESTED_COPY,
      EXECUTION_DECIDE_APPROVED_MESSAGE,
      MANUAL_START_AUDIT_HELP,
      MANUAL_START_CONFIRM_HELP,
      MANUAL_START_CSRF_MESSAGE,
      MANUAL_START_FORBIDDEN_MESSAGE,
      MANUAL_START_IDEMPOTENCY_HELP,
      MANUAL_START_INPUT_HELP,
      MANUAL_START_UNAUTHENTICATED_MESSAGE,
      WAITING_LABEL_OVERLAY: peakEndLabel("waiting"),
      WAITING_LABEL_INBOX: peakEndLabel("waiting", "inbox"),
      WAITING_LABEL_NDV: peakEndLabel("waiting", "ndv"),
      WAITING_HEADLINE: PEAK_END_HEADLINES.waiting,
    };
    for (const [name, text] of Object.entries(copy)) {
      assert.doesNotMatch(text, DEVELOPER_COPY, name);
      assert.doesNotMatch(text, /\bpin\b|bound approval|fail(s|ed)? closed/i, name);
    }
  });

  it("renders no developer wording or title attribute on any of these surfaces", () => {
    for (const relative of SURFACES) {
      const text = source(relative);
      assert.equal(text.includes("title="), false, relative);
      for (const literal of renderedLiterals(text)) {
        assert.doesNotMatch(literal, DEVELOPER_COPY, `${relative}: ${literal}`);
      }
    }
  });

  it("renders no contract notes on these surfaces", () => {
    const contractNotes = [
      "APPROVAL_SOD_HELP",
      "APPROVAL_WAIT_DURABLE_HELP",
      "APPROVAL_RESUME_VIA_DECIDE_HELP",
      "APPROVAL_DECIDE_HELP",
      "APPROVAL_RESUME_DISABLED_HELP",
      "EXECUTION_DECIDE_HELP",
      "MANUAL_START_CSRF_HELP",
      "MANUAL_START_CATALOG_HELP",
      "manualStartHelp(",
      "CANCEL_CSRF_HELP",
      "RETRY_CSRF_HELP",
      "STATUS_POLL_HELP",
    ];
    for (const relative of [
      ...SURFACES,
      "components/executions/ExecutionDetail.tsx",
      "components/workflows/ManualStartPanel.tsx",
    ]) {
      const text = source(relative);
      for (const note of contractNotes) {
        assert.equal(text.includes(note), false, `${relative} renders ${note}`);
      }
    }
  });

  it("drops the epic eyebrows from the approvals and run page headers", () => {
    for (const relative of [
      "app/approvals/page.tsx",
      "app/approvals/[id]/page.tsx",
      "app/executions/[id]/page.tsx",
    ]) {
      const text = source(relative);
      assert.doesNotMatch(text, /E4\.3|E10\.3|E6\.4|Chloe UI|Graph replay/, relative);
      assert.doesNotMatch(text, /<code/, relative);
    }
    assert.match(source("app/approvals/page.tsx"), /\{APPROVALS_PAGE_HELP\}/);
    assert.match(source("app/approvals/[id]/page.tsx"), /\{APPROVAL_DETAIL_PAGE_HELP\}/);
    assert.match(source("app/executions/[id]/page.tsx"), /\{EXECUTION_DETAIL_PAGE_HELP\}/);
  });
});

describe("requester sees one plain sentence", () => {
  it("removes the old self-request block from the decide controls", () => {
    const controls = source("components/approvals/ApprovalDecideControls.tsx");
    assert.equal(controls.includes("Self-approval"), false);
    assert.equal(controls.includes("approval.decide"), false);
    assert.equal(controls.includes("You requested this approval"), false);
    assert.equal(controls.includes("offerDecision && selfRequested ?"), false);
    // The decide note is the only requester sentence, rendered once.
    assert.equal(controls.match(/\{APPROVAL_DECIDE_NOTE\}/g)?.length, 1);
  });

  it("uses the same sentence on inbox and Runs rows", () => {
    const actions = source("components/executions/ExecutionDecideActions.tsx");
    assert.match(actions, /\{EXECUTION_DECIDE_SELF_REQUESTED_COPY\}/);
    assert.equal(actions.includes("sr-only"), false);
    assert.equal(actions.includes("resume is decide"), false);
  });
});

describe("approval panel ids are per instance", () => {
  it("uses useId for the resume sentence and keeps aria-describedby on it", () => {
    const panel = source("components/approvals/ExecutionApprovalState.tsx");
    assert.equal(panel.includes('id="execution-approval-resume"'), false);
    assert.equal(panel.includes('"execution-approval-resume"'), false);
    assert.equal(panel.includes('id="execution-approval-heading"'), false);
    assert.match(panel, /const resumeId = useId\(\);/);
    assert.match(panel, /const headingId = useId\(\);/);
    assert.match(panel, /id=\{resumeId\}/);
    assert.match(panel, /aria-labelledby=\{headingId\}/);
    assert.equal(
      panel.match(/aria-describedby=\{waiting \? resumeId : undefined\}/g)?.length,
      2,
    );
    // Hooks run before the early return.
    assert.ok(panel.indexOf("useId()") < panel.indexOf("return null"));
  });

  it("gives each binding snapshot its own heading id", () => {
    const snapshot = source("components/approvals/ApprovalBindingSnapshot.tsx");
    assert.equal(snapshot.includes('"approval-binding-heading"'), false);
    assert.match(snapshot, /const headingId = useId\(\);/);
    assert.match(snapshot, /aria-labelledby=\{headingId\}/);
    assert.match(snapshot, /id=\{headingId\}/);
  });
});

describe("workflows last-run chip", () => {
  it("shows Waiting with the Waiting sentence as its help", () => {
    const waiting = homeLastRunPresentation({
      status: "waiting",
      known: true,
      waiting: true,
    });
    assert.equal(waiting.label, "Waiting");
    assert.equal(waiting.help, WAITING_STATUS_HELP);
    assert.equal(waiting.loud, true);
    // A succeeded run with a pending gate also reads as Waiting.
    const joined = homeLastRunPresentation({
      status: "succeeded",
      known: true,
      waiting: true,
    });
    assert.equal(joined.label, "Waiting");
    assert.equal(joined.help, WAITING_STATUS_HELP);
  });

  it("never starts a stacking context on the last-run link, so the bubble stays on top", () => {
    const lastRun = source("components/home/HomeLastRunStatus.tsx");
    const code = lastRun.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    // Opacity below 1, filters, transforms, isolation, or a z-index on
    // the trigger would trap the bubble's z-40 under the next row.
    assert.doesNotMatch(
      code,
      /\b(?:hover:|focus:|focus-visible:)?(?:opacity-\d|brightness-|contrast-|saturate-|grayscale|invert|sepia|blur-|drop-shadow|backdrop-|scale-|rotate-|translate-|skew-|transform|isolate|z-\d|will-change|mix-blend)/,
    );
    assert.match(code, /group\/last-run/);
    assert.match(code, /group-hover\/last-run:underline/);
  });
});
