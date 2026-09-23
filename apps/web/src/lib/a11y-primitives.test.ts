import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  dialogChildShouldBeInert,
  dialogEscapeCloses,
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
  "src/components/credentials/DeleteImpactDialog.tsx",
  "src/components/shell/CommandPalette.tsx",
  "src/components/session/MfaStepUpHost.tsx",
] as const;

const FIELD_SURFACES = [
  "src/components/credentials/SecretField.tsx",
  "src/components/credentials/CredentialWizard.tsx",
  "src/components/credentials/DeleteImpactDialog.tsx",
  "src/components/session/LoginChrome.tsx",
  "src/components/session/ChangePasswordChrome.tsx",
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

  it("owns label, invalid, describedby, and visible error text in one component", () => {
    const field = source("src/components/a11y/Field.tsx");
    assert.match(field, /htmlFor=\{id\}/);
    assert.match(field, /aria-invalid/);
    assert.match(field, /aria-describedby/);
    assert.match(field, /role="alert"/);
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

  it("keeps focus trap, Escape, inert backdrop, and focus return on the shared dialog", () => {
    const dialog = source("src/components/a11y/Dialog.tsx");
    assert.match(dialog, /role="dialog"/);
    assert.match(dialog, /aria-modal="true"/);
    assert.match(dialog, /data-a11y-backdrop="inert"/);
    assert.match(dialog, /setAttribute\("inert"/);
    assert.match(dialog, /Escape/);
    assert.match(dialog, /dialogTabTargetIndex/);
    assert.match(dialog, /restoreSatelliteOverlayFocus/);
    assert.match(dialog, /focusin/);
    for (const relative of DIALOG_SURFACES) {
      const text = source(relative);
      assert.match(text, /from "@\/components\/a11y\/Dialog"/, relative);
      assert.equal(text.includes('role="dialog"'), false, relative);
    }
  });
});

describe("G.3.1 embed parity", () => {
  it("keeps wizard, Login, and Change-password off /embed/v1", () => {
    const embed = source("src/components/embed/EmbedChrome.tsx");
    const gate = source("src/components/bootstrap/BootstrapGate.tsx");
    const shellBranch = source("src/components/shell/WorkspaceShell.tsx");
    const field = source("src/components/a11y/Field.tsx");
    const dialog = source("src/components/a11y/Dialog.tsx");
    for (const text of [embed, shellBranch, field, dialog]) {
      assert.equal(text.includes("LoginChrome"), false);
      assert.equal(text.includes("ChangePasswordChrome"), false);
      assert.equal(text.includes("FirstRunWizard"), false);
    }
    assert.match(gate, /if \(embed\)/);
    assert.equal(embed.includes("FirstRunWizard"), false);
    assert.equal(gate.includes("/embed/v1"), false);
  });
});
