import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { EDITOR_CHROME } from "./editor-chrome.ts";
import { EDITOR_LIBRARY } from "./editor-library.ts";
import { INDETERMINATE_STATUS_HELP } from "./execution-contract.ts";
import { ENGINE_CATALOG_UNAVAILABLE_HELP } from "./catalog-fail-closed.ts";
import { R7_HARD_LINE } from "./rewrite-embed-mount.ts";
import {
  DOHERTY_GESTURES,
  DOHERTY_IDLE,
  DOHERTY_INDETERMINATE_START,
  DOHERTY_LABELS,
  DOHERTY_PENDING_CHROME,
  DOHERTY_PENDING_CHROME_HELP,
  DOHERTY_PENDING_CHROME_SOURCES,
  DOHERTY_PERCEIVED_MS,
  UXL3_BRIEF,
  UXL3_EPIC,
  UXL3_ID,
  UXL3_KEEP_STORY_OPEN,
  UXL3_STORY,
  dohertyBegin,
  dohertyCanvasPendingIsValidationOnly,
  dohertyChromeLabel,
  dohertyFeedbackLabel,
  dohertyFinish,
  dohertyHoldsHardLines,
  dohertyInheritsPriorStories,
  dohertyInventedProgress,
  dohertyLabelClaimsRunSucceeded,
  dohertyOptimisticHostQuerySwitch,
  dohertyRequestBlocksCanvas,
  dohertyShowsImmediatePending,
  dohertyStatusRole,
  dohertyVisibleFailClosedWait,
} from "./doherty-pending-chrome.ts";

const here = dirname(fileURLToPath(import.meta.url));

function source(relative: string): string {
  return readFileSync(join(here, "..", "..", relative), "utf8");
}

describe("UXL.3 Doherty-safe pending chrome", () => {
  it("keeps #290 open and cites epic #287", () => {
    assert.equal(UXL3_STORY, 290);
    assert.equal(UXL3_EPIC, 287);
    assert.equal(UXL3_KEEP_STORY_OPEN, true);
    assert.equal(UXL3_ID, "UXL.3-doherty-pending");
    assert.equal(UXL3_BRIEF, "docs/internal/flowforge-ux-laws.md");
    assert.equal(DOHERTY_PERCEIVED_MS, 400);
    assert.match(DOHERTY_PENDING_CHROME_HELP, /pending immediately/);
    assert.match(DOHERTY_PENDING_CHROME_HELP, /session.embed/);
    assert.match(DOHERTY_PENDING_CHROME_HELP, /indeterminate/);
    assert.equal(DOHERTY_PENDING_CHROME.uxl4ThroughUxl8OutOfScope, true);
    assert.equal(DOHERTY_PENDING_CHROME.jonnyNoneExpected, true);
    assert.equal(DOHERTY_PENDING_CHROME.d6MigrateInPlace, true);
    assert.equal(DOHERTY_PENDING_CHROME.noWebsocket, true);
    const frontend = readFileSync(
      join(here, "..", "..", "..", "..", "docs/reference/frontend-ui.md"),
      "utf8",
    );
    assert.match(frontend, /pending immediately/);
  });

  it("names pending then success or error for every required gesture", () => {
    assert.deepEqual([...DOHERTY_GESTURES], [
      "save",
      "publish",
      "test-run",
      "start",
      "catalog",
      "vault-test",
      "vault-rotate",
    ]);
    for (const gesture of DOHERTY_GESTURES) {
      const pending = dohertyBegin(gesture);
      assert.equal(pending.phase, "pending");
      assert.equal(pending.gesture, gesture);
      assert.match(dohertyChromeLabel(pending), /…$/);
      assert.equal(dohertyStatusRole("pending"), "status");

      const success = dohertyFinish(gesture, true);
      assert.equal(success.phase, "success");
      assert.ok(dohertyChromeLabel(success).length > 0);
      assert.equal(dohertyLabelClaimsRunSucceeded(dohertyChromeLabel(success)), false);

      const error = dohertyFinish(gesture, false);
      assert.equal(error.phase, "error");
      assert.equal(dohertyStatusRole("error"), "alert");
      assert.ok(dohertyChromeLabel(error).length > 0);
    }
    assert.equal(dohertyFeedbackLabel("save", "pending"), DOHERTY_LABELS.save.pending);
    assert.equal(dohertyFeedbackLabel("catalog", "error"), ENGINE_CATALOG_UNAVAILABLE_HELP);
    assert.equal(dohertyChromeLabel(DOHERTY_IDLE), "");
  });

  it("does not claim a run succeeded when status is indeterminate", () => {
    const started = dohertyFinish("start", true, "queued");
    assert.equal(started.phase, "success");
    assert.equal(dohertyLabelClaimsRunSucceeded(dohertyChromeLabel(started)), false);

    const uncertain = dohertyFinish("test-run", true, "indeterminate");
    assert.equal(uncertain.phase, "indeterminate");
    assert.match(dohertyChromeLabel(uncertain), /indeterminate/);
    assert.match(DOHERTY_INDETERMINATE_START, new RegExp(INDETERMINATE_STATUS_HELP));
    assert.equal(dohertyLabelClaimsRunSucceeded(dohertyChromeLabel(uncertain)), false);
    assert.equal(dohertyStatusRole("indeterminate"), "status");
    assert.equal(DOHERTY_PENDING_CHROME.noInventedIndeterminateSuccess, true);
    assert.equal(DOHERTY_PENDING_CHROME.loudIndeterminate, true);
  });

  it("keeps the canvas interactive while save / publish / test-run / start / catalog run", () => {
    assert.equal(dohertyRequestBlocksCanvas(null), false);
    assert.equal(dohertyRequestBlocksCanvas("save"), false);
    assert.equal(dohertyRequestBlocksCanvas("publish"), false);
    assert.equal(dohertyRequestBlocksCanvas("test-run"), false);
    assert.equal(dohertyRequestBlocksCanvas("run"), false);
    assert.equal(dohertyRequestBlocksCanvas("catalog"), false);
    assert.equal(DOHERTY_PENDING_CHROME.canvasStaysInteractive, true);

    const operator = source("src/components/workflows/WorkflowOperator.tsx");
    const canvas = source("src/components/workflows/WorkflowCanvas.tsx");
    assert.equal(dohertyCanvasPendingIsValidationOnly(operator), true);
    assert.match(canvas, /Invalid YAML never becomes a guessed graph/);
    assert.match(operator, /clearGraph\(\)/);
    assert.equal(EDITOR_CHROME.invalidYamlNeverGuessesGraph, true);
  });

  it("densifies existing pending chrome in place on the required surfaces", () => {
    const topBar = source("src/components/workflows/EditorTopBar.tsx");
    const operator = source("src/components/workflows/WorkflowOperator.tsx");
    const library = source("src/components/workflows/ActionLibrary.tsx");
    const run = source("src/components/workflows/RunControl.tsx");
    const start = source("src/components/workflows/ManualStartPanel.tsx");
    const ndv = source("src/components/workflows/LastRunIoPanel.tsx");
    const vault = source("src/components/credentials/CredentialDetail.tsx");
    const embed = source("src/components/embed/EmbedChrome.tsx");
    const status = source("src/components/chrome/DohertyStatus.tsx");

    assert.match(topBar, /DohertyStatus/);
    assert.match(topBar, /pending === "run"/);
    assert.match(operator, /dohertyBegin/);
    assert.match(operator, /dohertyFinish/);
    assert.match(library, /data-doherty-chrome/);
    assert.match(run, /DohertyStatus/);
    assert.match(start, /DohertyStatus/);
    assert.match(ndv, /data-doherty-phase/);
    assert.match(vault, /dohertyBegin\("vault-test"\)/);
    assert.match(vault, /dohertyBegin\("vault-rotate"\)/);
    assert.match(status, /data-doherty-chrome/);
    assert.equal(dohertyShowsImmediatePending(topBar), true);
    assert.equal(dohertyShowsImmediatePending(operator), true);
    assert.equal(dohertyShowsImmediatePending(vault), true);
    assert.equal(dohertyInheritsPriorStories(), true);
    assert.equal(dohertyInventedProgress(operator), false);
    assert.equal(dohertyInventedProgress(embed), false);
    assert.match(embed, /data-doherty-wait="session-embed"/);
  });

  it("keeps fail-closed waits visible and host query display-only", () => {
    const embed = source("src/components/embed/EmbedChrome.tsx");
    const provider = source("src/components/shell/WorkspaceProvider.tsx");
    const library = source("src/lib/editor-library.ts");
    assert.equal(dohertyVisibleFailClosedWait(embed), true);
    assert.match(embed, /data-doherty-wait="host-query"/);
    assert.equal(dohertyOptimisticHostQuerySwitch(provider), false);
    assert.equal(dohertyOptimisticHostQuerySwitch(embed), false);
    assert.equal(EDITOR_LIBRARY.catalog403FailsClosed, true);
    assert.equal(EDITOR_LIBRARY.emptyCatalogFailsClosed, true);
    assert.equal(R7_HARD_LINE.adv021FailClosedWithoutSessionEmbedOnEmbedV1, true);
    assert.equal(R7_HARD_LINE.hostQueryDisplayOnlyNeverAuthorization, true);
    assert.match(library, /catalog403FailsClosed: true/);
    assert.equal(dohertyHoldsHardLines(), true);
    for (const path of DOHERTY_PENDING_CHROME_SOURCES) {
      assert.equal(source(path).length > 0, true);
    }
  });
});
