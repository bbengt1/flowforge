import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { EDITOR_NDV_RUN_IO } from "./editor-ndv-run-io.ts";
import { EDITOR_RUNS, EDITOR_RUNS_DETAIL_PATH } from "./editor-runs.ts";
import { INDETERMINATE_STATUS_HELP } from "./execution-contract.ts";
import {
  EXECUTION_INBOX,
  EXECUTION_INBOX_DETAIL_PATH,
  R4_GUARDRAILS,
} from "./execution-inbox.ts";
import {
  PEAK_END_GESTURES,
  PEAK_END_HEADLINES,
  PEAK_END_INBOX_LABELS,
  PEAK_END_NDV_LABELS,
  PEAK_END_OPERATE,
  PEAK_END_OPERATE_HELP,
  PEAK_END_OPERATE_SOURCES,
  PEAK_END_RUN_STORAGE_KEY,
  UXL4_BRIEF,
  UXL4_EPIC,
  UXL4_FOLLOWUP_STORY,
  UXL4_ID,
  UXL4_KEEP_FOLLOWUP_OPEN,
  UXL4_KEEP_STORY_OPEN,
  UXL4_STORY,
  consumePeakEndOverlay,
  parsePeakEndHandoff,
  peakEndEditorHref,
  peakEndEndsOnOverlay,
  peakEndHoldsHardLines,
  peakEndInboxIsNotSecondReplay,
  peakEndInheritsPriorStories,
  peakEndInventedSecondReplay,
  peakEndKind,
  peakEndLabel,
  peakEndNeverSilentSuccessWhenUncertain,
  peakEndOpenExecutionHref,
  peakEndOpenStaysExecutionsId,
  peakEndOverlayRowShowsEnding,
  peakEndOverlaySuccessIsFocusedOnly,
  peakEndOverlaySuccessIsLoud,
  peakEndOverlaySuccessLoudCount,
  peakEndShouldOpenOverlay,
  peakEndShowsExplicitEnding,
  peakEndSuccessIsDistinctFromIndeterminate,
  peakEndSurfaceClassName,
  rememberPeakEndOverlay,
} from "./peak-end-operate-endings.ts";

const here = dirname(fileURLToPath(import.meta.url));

function source(relative: string): string {
  return readFileSync(join(here, "..", "..", relative), "utf8");
}

describe("UXL.4 peak-end operate endings", () => {
  it("keeps #291 open and cites epic #287", () => {
    assert.equal(UXL4_STORY, 291);
    assert.equal(UXL4_EPIC, 287);
    assert.equal(UXL4_KEEP_STORY_OPEN, true);
    assert.equal(UXL4_ID, "UXL.4-peak-end-endings");
    assert.equal(UXL4_BRIEF, "docs/internal/flowforge-ux-laws.md");
    assert.match(PEAK_END_OPERATE_HELP, /Runs overlay/);
    assert.match(PEAK_END_OPERATE_HELP, /not only a toast/);
    assert.match(PEAK_END_OPERATE_HELP, /indeterminate/);
    assert.match(PEAK_END_OPERATE_HELP, /\/executions\/\{id\}/);
    assert.equal(PEAK_END_OPERATE.uxl5ThroughUxl8OutOfScope, true);
    assert.equal(PEAK_END_OPERATE.jonnyNoneExpected, true);
    assert.equal(PEAK_END_OPERATE.d6MigrateInPlace, true);
    assert.equal(PEAK_END_OPERATE.noSilentSuccessToastOnly, true);
    const frontend = readFileSync(
      join(here, "..", "..", "..", "..", "docs/reference/frontend-ui.md"),
      "utf8",
    );
    assert.match(frontend, /peak-end operate endings/i);
  });

  it("opens the remembered-open overlay after start or test-run, not only a toast", () => {
    assert.deepEqual([...PEAK_END_GESTURES], ["start", "test-run"]);
    assert.equal(peakEndShouldOpenOverlay(true), true);
    assert.equal(peakEndShouldOpenOverlay(false), false);
    assert.equal(PEAK_END_OPERATE.afterStartOrTestRunOpenOverlay, true);
    assert.equal(PEAK_END_OPERATE.rememberedOpenSatellite, true);
    assert.equal(PEAK_END_OPERATE.notOnlyAToast, true);
    assert.equal(EDITOR_RUNS.rememberedOpen, true);
    assert.equal(
      peakEndEditorHref("11111111-1111-4111-8111-111111111111"),
      "/workflows/11111111-1111-4111-8111-111111111111",
    );
    assert.equal(PEAK_END_RUN_STORAGE_KEY, "flowforge.editor.peak-end-run.v1");
    assert.deepEqual(
      parsePeakEndHandoff(
        '{"workflowId":"wf-1","executionId":"ex-1"}',
      ),
      { workflowId: "wf-1", executionId: "ex-1" },
    );
    assert.equal(parsePeakEndHandoff("not-json"), null);
    assert.equal(parsePeakEndHandoff("{}"), null);

    const operator = source("src/components/workflows/WorkflowOperator.tsx");
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.equal(peakEndEndsOnOverlay(operator), true);
    assert.equal(peakEndEndsOnOverlay(home), true);
    assert.match(operator, /endOperateOnOverlay/);
    assert.match(operator, /consumePeakEndOverlay/);
    assert.match(home, /rememberPeakEndOverlay/);
    assert.match(home, /workflowEditorHref|peakEndEditorHref/);
  });

  it("keeps fail jump, loud indeterminate, waiting decide, and explicit success", () => {
    assert.equal(peakEndKind("succeeded"), "success");
    assert.equal(peakEndKind("failed"), "failed");
    assert.equal(peakEndKind("indeterminate"), "indeterminate");
    assert.equal(peakEndKind("waiting"), "waiting");
    assert.equal(peakEndKind("succeeded", true), "waiting");
    assert.equal(peakEndKind("running"), "running");
    assert.equal(peakEndKind("queued"), "queued");
    assert.equal(peakEndKind("canceled"), "canceled");
    assert.equal(peakEndSuccessIsDistinctFromIndeterminate(), true);
    assert.equal(peakEndNeverSilentSuccessWhenUncertain("indeterminate"), true);
    assert.equal(peakEndNeverSilentSuccessWhenUncertain("succeeded"), true);
    assert.match(peakEndLabel("indeterminate"), /indeterminate/i);
    assert.match(peakEndLabel("indeterminate"), new RegExp(INDETERMINATE_STATUS_HELP));
    assert.match(peakEndLabel("success"), /succeed/i);
    assert.equal(/indeterminate/i.test(peakEndLabel("success")), false);
    assert.match(peakEndLabel("failed"), /jump/i);
    assert.match(peakEndLabel("waiting"), /decide/i);
    assert.equal(PEAK_END_HEADLINES.success, "Run succeeded");
    assert.notEqual(PEAK_END_INBOX_LABELS.success, PEAK_END_INBOX_LABELS.indeterminate);
    assert.notEqual(PEAK_END_NDV_LABELS.success, PEAK_END_NDV_LABELS.indeterminate);
    assert.match(peakEndSurfaceClassName("success"), /ff-status-succeeded/);
    assert.match(peakEndSurfaceClassName("indeterminate"), /ff-loud-indeterminate/);
    assert.match(peakEndSurfaceClassName("failed"), /ff-loud-danger/);
    assert.notEqual(
      peakEndSurfaceClassName("success"),
      peakEndSurfaceClassName("indeterminate"),
    );
    assert.equal(EDITOR_NDV_RUN_IO.failuresJumpToNode, true);
    assert.equal(PEAK_END_OPERATE.failJumpsToNode, true);
    assert.equal(PEAK_END_OPERATE.loudIndeterminateOnOverlayAndInbox, true);
    assert.equal(PEAK_END_OPERATE.waitingDecideOnOverlayAndInbox, true);
    assert.equal(PEAK_END_OPERATE.successExplicitAndDistinctFromIndeterminate, true);
  });

  it("densifies overlay, inbox, NDV last-run, and home activation endings in place", () => {
    const overlay = source("src/components/workflows/EditorRunsDrawer.tsx");
    const inbox = source("src/components/executions/ExecutionHistoryListbox.tsx");
    const ndv = source("src/components/workflows/LastRunIoPanel.tsx");
    const ending = source("src/components/chrome/PeakEndEnding.tsx");
    const operator = source("src/components/workflows/WorkflowOperator.tsx");
    const history = source("src/components/executions/ExecutionHistory.tsx");

    assert.equal(peakEndShowsExplicitEnding(overlay), true);
    assert.equal(peakEndShowsExplicitEnding(inbox), true);
    assert.equal(peakEndShowsExplicitEnding(ndv), true);
    assert.equal(peakEndShowsExplicitEnding(ending), true);
    assert.match(overlay, /PeakEndEnding/);
    assert.match(inbox, /PeakEndEnding/);
    assert.match(ndv, /PeakEndEnding/);
    assert.match(ending, /data-peak-end/);
    assert.match(operator, /selectRun\(/);
    assert.equal(peakEndInboxIsNotSecondReplay(inbox), true);
    assert.equal(peakEndInboxIsNotSecondReplay(history), true);
    assert.equal(peakEndInventedSecondReplay(inbox), false);
    assert.equal(peakEndInventedSecondReplay(history), false);
    assert.equal(peakEndInventedSecondReplay(overlay), false);
    assert.equal(EXECUTION_INBOX.noInboxReplayGraph, true);
    for (const path of PEAK_END_OPERATE_SOURCES) {
      assert.equal(source(path).length > 0, true);
    }
  });

  it("keeps one replay path and Open execution on /executions/{id}", () => {
    assert.equal(peakEndOpenStaysExecutionsId(), true);
    assert.equal(
      peakEndOpenExecutionHref(
        "33333333-3333-4333-8333-333333333333",
        "11111111-1111-4111-8111-111111111111",
      ).startsWith("/executions/"),
      true,
    );
    assert.equal(EDITOR_RUNS_DETAIL_PATH, "/executions/{id}");
    assert.equal(EXECUTION_INBOX_DETAIL_PATH, "/executions/{id}");
    assert.equal(EDITOR_RUNS.noSecondReplayCanvas, true);
    assert.equal(R4_GUARDRAILS.oneOperatePath, true);
    assert.equal(PEAK_END_OPERATE.cancelRetryStopStayOnSamePath, true);
    assert.equal(PEAK_END_OPERATE.noReplayRoute, true);
    assert.equal(peakEndInheritsPriorStories(), true);
    assert.equal(peakEndHoldsHardLines(), true);

    const overlay = source("src/components/workflows/EditorRunsDrawer.tsx");
    const inbox = source("src/components/executions/ExecutionHistoryListbox.tsx");
    assert.match(overlay, /Open execution/);
    assert.match(overlay, /editorRunOpenHref/);
    assert.match(inbox, /EXECUTION_INBOX_OPEN_LABEL|Open/);
    assert.equal(overlay.includes("/replay"), false);
    assert.equal(inbox.includes("/replay"), false);
  });

  it("remembers the overlay handoff only as workflow + execution ids", () => {
    rememberPeakEndOverlay({
      workflowId: "wf-remember",
      executionId: "ex-remember",
    });
    assert.equal(consumePeakEndOverlay("other"), null);
    assert.equal(consumePeakEndOverlay("wf-remember"), "ex-remember");
    assert.equal(consumePeakEndOverlay("wf-remember"), null);
  });

  it("keeps overlay peak-end success on the focused or just-finished ending only", () => {
    assert.equal(UXL4_FOLLOWUP_STORY, 301);
    assert.equal(UXL4_KEEP_FOLLOWUP_OPEN, true);
    assert.equal(PEAK_END_OPERATE.successLoudOnlyOnFocusedOverlay, true);
    assert.equal(peakEndOverlaySuccessIsLoud({}), false);
    assert.equal(peakEndOverlaySuccessIsLoud({ focused: false }), false);
    assert.equal(peakEndOverlaySuccessIsLoud({ focused: true }), true);
    assert.equal(peakEndOverlaySuccessIsLoud({ selected: true }), true);
    assert.equal(peakEndOverlaySuccessIsLoud({ justFinished: true }), true);
    assert.equal(peakEndOverlayRowShowsEnding("success"), false);
    assert.equal(peakEndOverlayRowShowsEnding("success", { focused: true }), true);
    assert.equal(peakEndOverlayRowShowsEnding("success", { selected: true }), true);
    assert.equal(
      peakEndOverlayRowShowsEnding("success", { justFinished: true }),
      true,
    );
    assert.equal(peakEndOverlayRowShowsEnding("indeterminate"), true);
    assert.equal(
      peakEndOverlayRowShowsEnding("indeterminate", { focused: false }),
      true,
    );
    assert.equal(peakEndOverlayRowShowsEnding("waiting"), true);
    assert.equal(peakEndOverlayRowShowsEnding("waiting", { focused: false }), true);
    assert.equal(peakEndOverlayRowShowsEnding("failed"), true);
    assert.equal(peakEndOverlayRowShowsEnding("failed", { focused: false }), true);
    assert.equal(peakEndOverlayRowShowsEnding("running"), false);

    const fourteenSucceeded = Array.from({ length: 14 }, (_, index) => ({
      kind: "success" as const,
      focused: index === 2,
      selected: index === 2,
    }));
    assert.equal(peakEndOverlaySuccessLoudCount(fourteenSucceeded), 1);
    assert.equal(
      peakEndOverlaySuccessLoudCount(
        fourteenSucceeded.map((row) => ({ ...row, focused: false, selected: false })),
      ),
      0,
    );
    assert.equal(peakEndOverlaySuccessIsFocusedOnly(), true);

    const overlay = source("src/components/workflows/EditorRunsDrawer.tsx");
    const listbox = source("src/components/executions/ExecutionHistoryListbox.tsx");
    const frontend = readFileSync(
      join(here, "..", "..", "..", "..", "docs/reference/frontend-ui.md"),
      "utf8",
    );
    assert.match(listbox, /peakEndOverlayRowShowsEnding/);
    assert.match(listbox, /data-peak-end|PeakEndEnding/);
    assert.match(overlay, /PeakEndEnding/);
    assert.match(overlay, /selectedPeakEnd|data-peak-end-surface="overlay"/);
    assert.match(frontend, /focused\/selected only|focused\/selected operate ending/i);
    assert.match(PEAK_END_OPERATE_HELP, /quiet success badges/);
    assert.equal(listbox.includes("/replay"), false);
    assert.equal(peakEndInboxIsNotSecondReplay(listbox), true);
    assert.equal(peakEndHoldsHardLines(), true);
  });
});
