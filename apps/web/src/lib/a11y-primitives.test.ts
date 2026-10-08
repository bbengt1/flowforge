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
  FF_STATUS_TIP_ABOVE_CLASS,
  FF_STATUS_TIP_CLASS,
  FF_STATUS_TIP_END_CLASS,
  FF_STATUS_TIP_SHIFT_VAR,
  TOOLTIP_CLOSED,
  createTooltipEscapeRegistry,
  nestedTipActive,
  tooltipDefaultPlacement,
  tooltipEscapeDismisses,
  tooltipIntersectRects,
  tooltipOverflowClips,
  tooltipPlacement,
  tooltipShiftStyle,
  tooltipFocusOpens,
  tooltipIsOpen,
  tooltipReduce,
  tooltipTextClass,
  tooltipTriggerAria,
  type TooltipEvent,
  type TooltipPlacementInput,
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
    const badges = listbox.match(/<ExecutionStatusBadge\b[^>]*\/>/g) ?? [];
    assert.equal(badges.length, 3);
    for (const badge of badges) {
      assert.match(badge, /status=\{row\.status\}\s+nested\b/);
      assert.match(badge, /help=\{rowHelp\}/);
      assert.match(badge, /tipActive=\{rowTipActive\}/);
    }
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

function placementInput(
  overrides: Partial<TooltipPlacementInput> = {},
): TooltipPlacementInput {
  return {
    // A 100x20 chip in a 1280x800 viewport with room on every side.
    trigger: { left: 500, top: 300, right: 600, bottom: 320 },
    bubble: { width: 280, height: 60 },
    boundary: { left: 0, top: 0, right: 1280, bottom: 800 },
    direction: "ltr",
    align: "start",
    gap: 4,
    ...overrides,
  };
}

describe("Status tooltip edge placement", () => {
  it("keeps the requested edge and opens below when everything fits", () => {
    assert.deepEqual(tooltipPlacement(placementInput()), {
      side: "below",
      align: "start",
      shift: 0,
    });
    assert.deepEqual(tooltipPlacement(placementInput({ align: "end" })), {
      side: "below",
      align: "end",
      shift: 0,
    });
    assert.deepEqual(
      tooltipPlacement(placementInput({ direction: "rtl" })),
      tooltipDefaultPlacement("start"),
    );
  });

  it("flips to the end edge near the inline-end edge of its container (last-run cell at 1280)", () => {
    // The last-run chip sits near the right edge of a 1280 wide list.
    // A 280 px bubble lined up with its left edge would cross it.
    const lastRun = placementInput({
      trigger: { left: 1110, top: 300, right: 1200, bottom: 320 },
      boundary: { left: 240, top: 0, right: 1240, bottom: 800 },
    });
    assert.deepEqual(tooltipPlacement(lastRun), {
      side: "below",
      align: "end",
      shift: 0,
    });
    // Same cell at 1440: still crosses, still flips.
    assert.equal(
      tooltipPlacement({
        ...lastRun,
        trigger: { left: 1270, top: 300, right: 1360, bottom: 320 },
        boundary: { left: 240, top: 0, right: 1400, bottom: 800 },
      }).align,
      "end",
    );
  });

  it("flips to the start edge near the inline-start edge", () => {
    const placement = tooltipPlacement(
      placementInput({
        align: "end",
        trigger: { left: 20, top: 300, right: 80, bottom: 320 },
      }),
    );
    assert.equal(placement.align, "start");
    assert.equal(placement.shift, 0);
  });

  it("mirrors under rtl: start is the right edge, so the left edge flips it", () => {
    // In rtl, start alignment lines the bubble up with the chip's right
    // edge and it grows leftward. Near the left edge it must flip.
    const nearLeft = placementInput({
      direction: "rtl",
      trigger: { left: 60, top: 300, right: 150, bottom: 320 },
    });
    assert.deepEqual(tooltipPlacement(nearLeft), {
      side: "below",
      align: "end",
      shift: 0,
    });
    // Near the right edge, rtl start already fits.
    assert.equal(
      tooltipPlacement(
        placementInput({
          direction: "rtl",
          trigger: { left: 1150, top: 300, right: 1250, bottom: 320 },
        }),
      ).align,
      "start",
    );
    // The ltr twin of the rtl case flips the other way.
    assert.equal(
      tooltipPlacement(
        placementInput({
          direction: "ltr",
          align: "end",
          trigger: { left: 60, top: 300, right: 150, bottom: 320 },
        }),
      ).align,
      "start",
    );
  });

  it("opens above a node panned to the bottom edge of the canvas", () => {
    // The canvas clips at 600. Below would show only ~10 px.
    const bottom = placementInput({
      trigger: { left: 500, top: 566, right: 600, bottom: 586 },
      boundary: { left: 0, top: 160, right: 1280, bottom: 600 },
    });
    assert.deepEqual(tooltipPlacement(bottom), {
      side: "above",
      align: "start",
      shift: 0,
    });
  });

  it("stays below near the top edge and picks the roomier side when neither fits", () => {
    assert.equal(
      tooltipPlacement(
        placementInput({ trigger: { left: 500, top: 4, right: 600, bottom: 24 } }),
      ).side,
      "below",
    );
    // 70 px tall bubble in a 100 px boundary: 50 px above, 26 below.
    assert.equal(
      tooltipPlacement(
        placementInput({
          bubble: { width: 280, height: 70 },
          trigger: { left: 500, top: 54, right: 600, bottom: 70 },
          boundary: { left: 0, top: 0, right: 1280, bottom: 100 },
        }),
      ).side,
      "above",
    );
    // Equal room: below wins.
    assert.equal(
      tooltipPlacement(
        placementInput({
          bubble: { width: 280, height: 90 },
          trigger: { left: 500, top: 40, right: 600, bottom: 60 },
          boundary: { left: 0, top: 0, right: 1280, bottom: 100 },
        }),
      ).side,
      "below",
    );
  });

  it("shifts back inside when neither inline edge fits, in logical px", () => {
    // 330 px boundary, 280 px bubble: start crosses the right edge by
    // 90, end crosses the left edge by 70. End crosses less, then it is
    // shifted 70 px toward the inline end, so it spans [0, 280].
    const narrow = placementInput({
      trigger: { left: 140, top: 300, right: 210, bottom: 320 },
      boundary: { left: 0, top: 0, right: 330, bottom: 800 },
    });
    assert.deepEqual(tooltipPlacement(narrow), {
      side: "below",
      align: "end",
      shift: 70,
    });
    // rtl: start is now the right-aligned extent, which crosses less.
    // The physical move is the same; the logical shift has the other sign.
    assert.deepEqual(tooltipPlacement({ ...narrow, direction: "rtl" }), {
      side: "below",
      align: "start",
      shift: -70,
    });
  });

  it("anchors at the inline start edge when the bubble is wider than the boundary", () => {
    const tiny = placementInput({
      trigger: { left: 110, top: 300, right: 150, bottom: 320 },
      boundary: { left: 100, top: 0, right: 300, bottom: 800 },
    });
    const ltr = tooltipPlacement(tiny);
    // Start edge is left in ltr: bubble starts at 100.
    assert.equal(ltr.align, "start");
    assert.equal(ltr.shift, -10);
    const rtl = tooltipPlacement({ ...tiny, direction: "rtl" });
    // Start edge is right in rtl: bubble ends at 300.
    assert.equal(rtl.align, "end");
    assert.equal(rtl.shift, 90);
  });

  it("is deterministic and falls back on an empty boundary or unmeasured bubble", () => {
    const input = placementInput({
      trigger: { left: 1110, top: 566, right: 1200, bottom: 586 },
      boundary: { left: 240, top: 160, right: 1240, bottom: 600 },
    });
    assert.deepEqual(tooltipPlacement(input), tooltipPlacement(input));
    assert.deepEqual(tooltipPlacement(input), {
      side: "above",
      align: "end",
      shift: 0,
    });
    assert.deepEqual(
      tooltipPlacement(
        placementInput({ boundary: { left: 10, top: 10, right: 10, bottom: 500 } }),
      ),
      tooltipDefaultPlacement("start"),
    );
    assert.deepEqual(
      tooltipPlacement(placementInput({ align: "end", bubble: { width: 0, height: 0 } })),
      tooltipDefaultPlacement("end"),
    );
  });

  it("intersects clipping ancestors with the viewport", () => {
    assert.equal(tooltipIntersectRects([]), null);
    assert.deepEqual(
      tooltipIntersectRects([
        { left: 0, top: 0, right: 1280, bottom: 800 },
        { left: 240, top: 120, right: 1300, bottom: 900 },
        { left: 200, top: 160, right: 1240, bottom: 600 },
      ]),
      { left: 240, top: 160, right: 1240, bottom: 600 },
    );
    for (const value of ["hidden", "auto", "scroll", "clip", "hidden auto"]) {
      assert.equal(tooltipOverflowClips(value), true, value);
    }
    for (const value of ["visible", ""]) {
      assert.equal(tooltipOverflowClips(value), false, value);
    }
  });

  it("maps a placement to classes and the shift variable", () => {
    assert.equal(
      tooltipTextClass({ open: true, side: "above" }),
      `${FF_STATUS_TIP_CLASS} ${FF_STATUS_TIP_ABOVE_CLASS}`,
    );
    assert.equal(
      tooltipTextClass({ open: true, align: "end", side: "above" }),
      `${FF_STATUS_TIP_CLASS} ${FF_STATUS_TIP_END_CLASS} ${FF_STATUS_TIP_ABOVE_CLASS}`,
    );
    assert.equal(tooltipTextClass({ open: false, side: "above" }), "sr-only");
    assert.deepEqual(tooltipShiftStyle({ shift: 0 }), {});
    assert.deepEqual(tooltipShiftStyle({ shift: -12 }), {
      [FF_STATUS_TIP_SHIFT_VAR]: "-12px",
    });
  });

  it("css flips with logical sides and tokens only", () => {
    const globals = source("src/app/globals.css");
    const above = globals.slice(
      globals.indexOf(".ff-status-tip-above {"),
      globals.indexOf("}", globals.indexOf(".ff-status-tip-above {")) + 1,
    );
    assert.match(above, /inset-block-start: auto/);
    assert.match(above, /inset-block-end: calc\(100% \+ var\(--ff-space\)\)/);
    assert.match(globals, /inset-inline-start: var\(--ff-tip-shift, 0px\)/);
    assert.match(globals, /inset-inline-end: calc\(0px - var\(--ff-tip-shift, 0px\)\)/);
    const tooltip = source("src/components/a11y/Tooltip.tsx");
    assert.match(tooltip, /tooltipPlacement\(/);
    assert.match(tooltip, /tooltipOverflowClips\(/);
  });
});

describe("Status tooltip one-Escape close", () => {
  it("one Escape closes every open tooltip, from focus, hover, or row", () => {
    const registry = createTooltipEscapeRegistry();
    let focused = runTooltip(["focus"]);
    let hovered = runTooltip(["pointerenter"]);
    let row = runTooltip(["activate"]);
    const unregister = [
      registry.register(() => (focused = tooltipReduce(focused, "escape"))),
      registry.register(() => (hovered = tooltipReduce(hovered, "escape"))),
      registry.register(() => (row = tooltipReduce(row, "escape"))),
    ];
    assert.equal(registry.size(), 3);
    assert.equal(registry.handleKey({ key: "Escape", defaultPrevented: false }), true);
    assert.equal(tooltipIsOpen(focused), false);
    assert.equal(tooltipIsOpen(hovered), false);
    assert.equal(tooltipIsOpen(row), false);
    for (const off of unregister) {
      off();
    }
    assert.equal(registry.size(), 0);
  });

  it("claims the key only when it closed something", () => {
    const registry = createTooltipEscapeRegistry();
    // Nothing open: the Escape belongs to a Dialog or the palette.
    assert.equal(registry.handleKey({ key: "Escape", defaultPrevented: false }), false);
    let closes = 0;
    const off = registry.register(() => {
      closes += 1;
    });
    // Another handler already took it, or another key.
    assert.equal(registry.handleKey({ key: "Escape", defaultPrevented: true }), false);
    assert.equal(registry.handleKey({ key: "Enter", defaultPrevented: false }), false);
    assert.equal(closes, 0);
    assert.equal(registry.handleKey({ key: "Escape", defaultPrevented: false }), true);
    assert.equal(closes, 1);
    off();
    off();
    assert.equal(registry.size(), 0);
  });

  it("a close that unregisters during the sweep does not skip the others", () => {
    const registry = createTooltipEscapeRegistry();
    const closed: string[] = [];
    const offs: Array<() => void> = [];
    offs.push(
      registry.register(() => {
        closed.push("a");
        offs[0]?.();
        offs[1]?.();
      }),
    );
    offs.push(registry.register(() => closed.push("b")));
    assert.equal(registry.handleKey({ key: "Escape", defaultPrevented: false }), true);
    assert.deepEqual(closed, ["a", "b"]);
  });

  it("the component sets preventDefault only on a closing Escape, before Dialog", () => {
    const tooltip = source("src/components/a11y/Tooltip.tsx");
    assert.match(tooltip, /createTooltipEscapeRegistry\(\)/);
    assert.match(
      tooltip,
      /if \(\s*escapeRegistry\.handleKey\(\{[\s\S]*?\}\)\s*\)\s*\{\s*event\.preventDefault\(\);/,
    );
    assert.match(tooltip, /addEventListener\("keydown", onEscapeKey, true\)/);
    // One shared listener, not one per open tooltip.
    assert.equal((tooltip.match(/addEventListener\("keydown"/g) ?? []).length, 1);
    // Dialog still skips an Escape a tooltip already used.
    assert.equal(
      dialogEscapeCloses({ key: "Escape", defaultPrevented: true, isTop: true }),
      false,
    );
  });
});

describe("Nested chips opened by their row", () => {
  it("activate opens, deactivate closes, and Escape holds until the row lets go", () => {
    assert.equal(tooltipIsOpen(runTooltip(["activate"])), true);
    assert.equal(tooltipIsOpen(runTooltip(["activate", "deactivate"])), false);
    assert.equal(tooltipIsOpen(runTooltip(["activate", "escape"])), false);
    // Still dismissed while hovered after the row lets go.
    assert.equal(
      tooltipIsOpen(runTooltip(["activate", "pointerenter", "escape", "deactivate"])),
      false,
    );
    assert.equal(
      tooltipIsOpen(runTooltip(["activate", "escape", "deactivate", "activate"])),
      true,
    );
    // No-op events keep the same state object, so no extra render.
    assert.equal(tooltipReduce(TOOLTIP_CLOSED, "deactivate"), TOOLTIP_CLOSED);
    const active = runTooltip(["activate"]);
    assert.equal(tooltipReduce(active, "activate"), active);
  });

  it("opens only with help, on keyboard-current or hover", () => {
    assert.equal(nestedTipActive({ hasHelp: true, keyboardCurrent: true }), true);
    assert.equal(
      nestedTipActive({ hasHelp: true, keyboardCurrent: false, rowHovered: true }),
      true,
    );
    assert.equal(nestedTipActive({ hasHelp: true, keyboardCurrent: false }), false);
    assert.equal(
      nestedTipActive({ hasHelp: false, keyboardCurrent: true, rowHovered: true }),
      false,
    );
  });

  it("the indeterminate inbox row uses the shared tooltip, not a row title", () => {
    const listbox = source("src/components/executions/ExecutionHistoryListbox.tsx");
    assert.equal(listbox.includes("title={row.indeterminate"), false);
    assert.equal(listbox.includes("INDETERMINATE_STATUS_HELP : undefined}"), false);
    assert.match(listbox, /const rowHelp = row\.indeterminate \? INDETERMINATE_STATUS_HELP : undefined;/);
    assert.match(listbox, /nestedTipActive\(\{/);
    assert.match(listbox, /keyboardCurrent: keyboardNav && index === safeIndex/);
    // No tab stop is added to the row.
    assert.equal(listbox.includes("tabIndex={0}"), true);
    assert.equal((listbox.match(/tabIndex=/g) ?? []).length, 1);
    const badge = source("src/components/executions/ExecutionStatusBadge.tsx");
    assert.match(badge, /description=\{help \?\? presentation\.description\}/);
    assert.match(badge, /tipActive=\{tipActive\}/);
    const mark = source("src/components/chrome/StatusMark.tsx");
    assert.match(mark, /useTooltip\(description, \{ active: tipActive \}\)/);
  });

  it("the activation chip and the link-less last-run chip use the shared tooltip", () => {
    const activation = source("src/components/home/HomeActivationStatus.tsx");
    assert.match(activation, /from "@\/components\/a11y\/Tooltip"/);
    assert.equal(activation.includes("title="), false);
    assert.match(activation, /useTooltip\(column\.help\)/);
    assert.match(activation, /tip\.describedBy/);
    assert.match(activation, /tip\.focusProps/);
    assert.match(activation, /<TooltipText controls=\{tip\} text=\{column\.help\}/);
    const lastRun = source("src/components/home/HomeLastRunStatus.tsx");
    assert.equal(lastRun.includes("title="), false);
    assert.match(lastRun, /hasHelp: !href/);
    assert.match(lastRun, /keyboardCurrent: rowActive/);
    // The link-less chip still takes no tab stop.
    assert.equal(lastRun.includes("tabIndex"), false);
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.match(home, /rowActive=\{paneKeyboardNav && selected\}/);
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
