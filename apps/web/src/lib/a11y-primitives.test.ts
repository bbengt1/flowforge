import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  dialogChildShouldBeInert,
  dialogEscapeCloses,
  dialogEscapeSwallowed,
  dialogStackIsTop,
  dialogStackPop,
  dialogStackPush,
  dialogStackReset,
  dialogTabTargetIndex,
  isDialogTabStop,
} from "./a11y-dialog.ts";
import {
  fieldControlAria,
  fieldDescriptionIds,
  fieldMarksInvalid,
} from "./a11y-field.ts";
import {
  FF_STATUS_TIP_CLASS,
  FF_STATUS_TIP_END_CLASS,
  TOOLTIP_CLOSED,
  tooltipEscapeDismisses,
  tooltipFocusOpens,
  tooltipIsOpen,
  tooltipReduce,
  tooltipTextClass,
  tooltipTriggerAria,
  type TooltipEvent,
  type TooltipState,
} from "./a11y-tooltip.ts";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..", "..");

function source(relative: string): string {
  return readFileSync(join(webRoot, relative), "utf8");
}

const DIALOG_SURFACES = [
  "src/components/workflows/ActionWizard.tsx",
  "src/components/workflows/EditorStartDialog.tsx",
  "src/components/credentials/CredentialWizardDialog.tsx",
  "src/components/credentials/CredentialTestDialog.tsx",
  "src/components/a11y/ConfirmDestructive.tsx",
  "src/components/shell/CommandPalette.tsx",
  "src/components/session/MfaStepUpHost.tsx",
  "src/components/groups/GroupNameDialog.tsx",
  "src/components/groups/AddGroupMemberDialog.tsx",
  "src/components/approvals/AdminOverrideConfirm.tsx",
  "src/components/scim-tokens/CreateScimTokenDialog.tsx",
] as const;

const FIELD_SURFACES = [
  "src/components/credentials/SecretField.tsx",
  "src/components/credentials/CredentialWizard.tsx",
  "src/components/credentials/DeleteImpactDialog.tsx",
  "src/components/session/LoginChrome.tsx",
  "src/components/session/ChangePasswordChrome.tsx",
  "src/components/session/SetPasswordChrome.tsx",
  "src/components/session/MfaChrome.tsx",
  "src/components/bootstrap/FirstRunWizard.tsx",
  "src/components/membership/IdentityBootstrap.tsx",
  "src/components/isolation/IsolationExercise.tsx",
  "src/components/workflows/ScheduleTriggerPanel.tsx",
  "src/components/workflows/WebhookTriggerPanel.tsx",
  "src/components/workflows/ManualStartFields.tsx",
  "src/components/workflows/NodeInspector.tsx",
  "src/components/workflows/NdvParameterEditors.tsx",
  "src/components/workflows/ActionWizard.tsx",
  "src/components/home/WorkflowHome.tsx",
  "src/components/groups/GroupNameDialog.tsx",
  "src/components/groups/AddGroupMemberDialog.tsx",
  "src/components/workflows/ApproverPicker.tsx",
  "src/components/scim-tokens/CreateScimTokenDialog.tsx",
] as const;

describe("G.3.1 Field primitive", () => {
  it("wires hint and error ids into aria-describedby and aria-invalid", () => {
    const described = fieldDescriptionIds({
      id: "display-name",
      hasHint: true,
      hasError: true,
    });
    assert.equal(described.hintId, "display-name-hint");
    assert.equal(described.errorId, "display-name-error");
    assert.equal(
      described.describedBy,
      "display-name-hint display-name-error",
    );
    const control = fieldControlAria({
      id: "display-name",
      invalid: fieldMarksInvalid({ invalid: false, hasError: true }),
      describedBy: described.describedBy,
      required: true,
    });
    assert.equal(control.id, "display-name");
    assert.equal(control["aria-invalid"], true);
    assert.equal(control["aria-describedby"], described.describedBy);
    assert.equal(control["aria-required"], true);
    assert.equal(control.required, true);
  });

  it("shares one visible error id and omits invalid when the field is clean", () => {
    const shared = fieldDescriptionIds({
      id: "login-identifier",
      hasHint: false,
      hasError: true,
      errorId: "login-form-error",
    });
    assert.equal(shared.errorId, "login-form-error");
    assert.equal(shared.describedBy, "login-form-error");
    assert.equal(fieldMarksInvalid({ hasError: false }), false);
    const clean = fieldControlAria({
      id: "login-identifier",
      invalid: false,
    });
    assert.equal(clean["aria-invalid"], undefined);
    assert.equal(clean["aria-describedby"], undefined);
  });

  it("primary forms use the shared Field primitive", () => {
    for (const relative of FIELD_SURFACES) {
      const text = source(relative);
      assert.match(text, /from "@\/components\/a11y\/Field"/, relative);
    }
  });
});

describe("G.3.1 Dialog primitive", () => {
  it("traps Tab, closes the top dialog on Escape, and inerts the page behind", () => {
    assert.equal(dialogTabTargetIndex(3, 1, false), null);
    assert.equal(dialogTabTargetIndex(3, 2, false), 0);
    assert.equal(dialogTabTargetIndex(3, 0, true), 2);
    assert.equal(dialogTabTargetIndex(3, -1, false), 0);
    assert.equal(dialogTabTargetIndex(3, -1, true), 2);
    assert.equal(dialogTabTargetIndex(0, -1, false), -1);
    assert.equal(dialogTabTargetIndex(1, 0, false), 0);
    assert.equal(
      isDialogTabStop({
        disabled: false,
        tabIndex: 0,
        hidden: false,
        inert: false,
        ariaHidden: false,
      }),
      true,
    );
    assert.equal(
      isDialogTabStop({
        disabled: false,
        tabIndex: -1,
        hidden: false,
        inert: true,
        ariaHidden: false,
      }),
      false,
    );
    assert.equal(
      dialogChildShouldBeInert({
        tagName: "DIV",
        containsDialog: false,
        alreadyInert: false,
      }),
      true,
    );
    assert.equal(
      dialogChildShouldBeInert({
        tagName: "DIV",
        containsDialog: true,
        alreadyInert: false,
      }),
      false,
    );
    assert.equal(
      dialogChildShouldBeInert({
        tagName: "SCRIPT",
        containsDialog: false,
        alreadyInert: false,
      }),
      false,
    );
    assert.equal(
      dialogEscapeCloses({
        key: "Escape",
        defaultPrevented: false,
        isTop: true,
      }),
      true,
    );
    assert.equal(
      dialogEscapeCloses({
        key: "Escape",
        defaultPrevented: true,
        isTop: true,
      }),
      false,
    );
    assert.equal(
      dialogEscapeCloses({
        key: "Escape",
        defaultPrevented: false,
        isTop: false,
      }),
      false,
    );
    dialogStackReset();
    const lower = Symbol("lower");
    const upper = Symbol("upper");
    dialogStackPush(lower);
    dialogStackPush(upper);
    assert.equal(dialogStackIsTop(upper), true);
    assert.equal(dialogStackIsTop(lower), false);
    dialogStackPop(upper);
    assert.equal(dialogStackIsTop(lower), true);
    dialogStackReset();
  });

  it("primary overlays use the shared Dialog primitive", () => {
    for (const relative of DIALOG_SURFACES) {
      const text = source(relative);
      assert.match(text, /from "@\/components\/a11y\/Dialog"/, relative);
      assert.equal(text.includes('role="dialog"'), false, relative);
    }
  });
});

function runTooltip(events: readonly TooltipEvent[]): TooltipState {
  return events.reduce(tooltipReduce, TOOLTIP_CLOSED);
}

const STATUS_TOOLTIP_SURFACES = [
  "src/components/chrome/StatusMark.tsx",
  "src/components/home/HomeLastRunStatus.tsx",
  "src/components/workflows/WorkflowCanvas.tsx",
] as const;

describe("Status tooltip primitive", () => {
  it("opens on focus and on hover, and closes when both end", () => {
    assert.equal(tooltipIsOpen(TOOLTIP_CLOSED), false);
    assert.equal(tooltipIsOpen(runTooltip(["focus"])), true);
    assert.equal(tooltipIsOpen(runTooltip(["focus", "blur"])), false);
    assert.equal(tooltipIsOpen(runTooltip(["pointerenter"])), true);
    assert.equal(tooltipIsOpen(runTooltip(["pointerenter", "pointerleave"])), false);
    // Hovering the bubble keeps it open while focus moves on.
    assert.equal(tooltipIsOpen(runTooltip(["focus", "pointerenter", "blur"])), true);
    assert.equal(tooltipIsOpen(runTooltip(["pointerenter", "focus", "pointerleave"])), true);
  });

  it("Escape dismisses without moving focus, and a new focus or hover reopens", () => {
    const dismissed = runTooltip(["focus", "escape"]);
    assert.equal(dismissed.focused, true);
    assert.equal(tooltipIsOpen(dismissed), false);
    assert.equal(tooltipIsOpen(runTooltip(["focus", "escape", "pointerenter"])), true);
    assert.equal(tooltipIsOpen(runTooltip(["focus", "escape", "blur", "focus"])), true);
    assert.equal(tooltipIsOpen(runTooltip(["pointerenter", "escape"])), false);
    assert.equal(
      tooltipIsOpen(runTooltip(["pointerenter", "escape", "pointerleave", "pointerenter"])),
      true,
    );
    // Escape on a closed tooltip changes nothing.
    assert.deepEqual(runTooltip(["escape"]), TOOLTIP_CLOSED);
    assert.equal(
      tooltipEscapeDismisses({ key: "Escape", open: true, defaultPrevented: false }),
      true,
    );
    assert.equal(
      tooltipEscapeDismisses({ key: "Escape", open: false, defaultPrevented: false }),
      false,
    );
    assert.equal(
      tooltipEscapeDismisses({ key: "Escape", open: true, defaultPrevented: true }),
      false,
    );
    assert.equal(
      tooltipEscapeDismisses({ key: "Enter", open: true, defaultPrevented: false }),
      false,
    );
  });

  it("opens on keyboard focus of the trigger only", () => {
    assert.equal(tooltipFocusOpens({ targetIsTrigger: true, focusVisible: true }), true);
    assert.equal(tooltipFocusOpens({ targetIsTrigger: true, focusVisible: false }), false);
    assert.equal(tooltipFocusOpens({ targetIsTrigger: false, focusVisible: true }), false);
  });

  it("describes the trigger and keeps the text readable when closed", () => {
    assert.deepEqual(
      tooltipTriggerAria({ tipId: "chip-tip", text: "Waiting for upstream steps to finish." }),
      { "aria-describedby": "chip-tip" },
    );
    assert.deepEqual(tooltipTriggerAria({ tipId: "chip-tip", text: "" }), {});
    assert.deepEqual(tooltipTriggerAria({ tipId: "chip-tip", text: undefined }), {});
    assert.equal(tooltipTextClass({ open: false }), "sr-only");
    assert.equal(tooltipTextClass({ open: false, align: "end" }), "sr-only");
    assert.equal(tooltipTextClass({ open: true }), FF_STATUS_TIP_CLASS);
    assert.equal(
      tooltipTextClass({ open: true, align: "end" }),
      `${FF_STATUS_TIP_CLASS} ${FF_STATUS_TIP_END_CLASS}`,
    );
  });

  it("status chips use the shared tooltip instead of a native title", () => {
    for (const relative of STATUS_TOOLTIP_SURFACES) {
      const text = source(relative);
      assert.match(text, /from "@\/components\/a11y\/Tooltip"/, relative);
    }
    const mark = source("src/components/chrome/StatusMark.tsx");
    assert.equal(mark.includes("title="), false);
    assert.match(mark, /tabIndex=\{focusable \? 0 : undefined\}/);
    assert.match(mark, /aria-label=\{focusable \? label : undefined\}/);
    assert.match(mark, /tip\.describedBy/);
    const lastRun = source("src/components/home/HomeLastRunStatus.tsx");
    assert.equal(lastRun.includes("title="), false);
    const canvas = source("src/components/workflows/WorkflowCanvas.tsx");
    assert.equal(canvas.includes("title={stateHelp"), false);
    assert.match(canvas, /stateTip\.focusProps/);
  });

  it("chips inside an interactive row take no tab stop of their own", () => {
    const listbox = source("src/components/executions/ExecutionHistoryListbox.tsx");
    assert.equal(listbox.includes("<ExecutionStatusBadge status={row.status} />"), false);
    assert.equal((listbox.match(/<ExecutionStatusBadge status=\{row\.status\} nested \/>/g) ?? []).length, 3);
    const replay = source("src/components/executions/ExecutionReplay.tsx");
    assert.match(replay, /<ExecutionStatusBadge\s+nested\s+status=\{item\.status\}/);
  });

  it("tooltip css uses V.1 tokens and logical sides only", () => {
    const globals = source("src/app/globals.css");
    const start = globals.indexOf(".ff-status-tip-trigger {");
    const end = globals.indexOf(".ff-status-tip-end {");
    assert.ok(start > 0 && end > start);
    const block = globals.slice(start, globals.indexOf("}", end) + 1);
    assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b/i);
    assert.doesNotMatch(block, /(^|[^-])\b(left|right)\s*:/m);
    assert.match(block, /inset-inline-start/);
    assert.match(block, /var\(--ff-surface\)/);
    assert.match(block, /var\(--ff-text\)/);
  });
});

describe("Dialog dismissible opt-out", () => {
  const top = { key: "Escape", defaultPrevented: false, isTop: true };

  it("closes on Escape by default, so existing dialogs are unchanged", () => {
    assert.equal(dialogEscapeCloses(top), true);
    assert.equal(dialogEscapeCloses({ ...top, dismissible: true }), true);
    assert.equal(dialogEscapeSwallowed(top), false);
  });

  it("swallows Escape without closing when dismissible is false", () => {
    assert.equal(dialogEscapeCloses({ ...top, dismissible: false }), false);
    assert.equal(dialogEscapeSwallowed({ ...top, dismissible: false }), true);
  });

  it("leaves other keys, lower dialogs and handled events alone", () => {
    for (const input of [
      { ...top, key: "Enter", dismissible: false },
      { ...top, isTop: false, dismissible: false },
      { ...top, defaultPrevented: true, dismissible: false },
    ]) {
      assert.equal(dialogEscapeCloses(input), false);
      assert.equal(dialogEscapeSwallowed(input), false);
    }
  });

  it("the shared Dialog defaults dismissible to true and keeps the focus trap", () => {
    const dialog = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../components/a11y/Dialog.tsx"),
      "utf8",
    );
    assert.match(dialog, /dismissible = true,/);
    assert.match(dialog, /dialogEscapeSwallowed\(escape\)/);
    // The Tab trap and focus-in guard do not depend on dismissible.
    const trap = dialog.slice(dialog.indexOf('event.key !== "Tab"'));
    assert.equal(trap.slice(0, trap.indexOf("function onFocusIn")).includes("dismissible"), false);
  });
});
