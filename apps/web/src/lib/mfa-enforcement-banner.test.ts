import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  MFA_ENFORCEMENT_OFF_BANNER,
  MFA_PRIVILEGED_LOUD,
  MFA_STATUS_STALE_MS,
  MFA_VERIFIED_RETRY,
  mfaChromeLoudNotice,
  mfaStatusQueryOptions,
  parseMfaEnforcement,
  parseMfaStatus,
  showMfaEnforcementOffBanner,
} from "./oidc-mfa.ts";
import { queryKeyHasSecret } from "./query-cache.ts";

const here = dirname(fileURLToPath(import.meta.url));

function source(relative: string): string {
  return readFileSync(join(here, "..", "..", relative), "utf8");
}

function status(extra: Record<string, unknown> = {}) {
  return parseMfaStatus({
    method: "totp",
    enrolled: false,
    satisfied: false,
    applicable: true,
    privileged_permissions: ["platform.administer"],
    ...extra,
  });
}

describe("parseMfaStatus enforcement", () => {
  it("keeps on, off, and does not force satisfied", () => {
    const on = status({ enforcement: "on" });
    const off = status({ enforcement: "off", satisfied: false });
    assert.equal(on?.enforcement, "on");
    assert.equal(off?.enforcement, "off");
    assert.equal(off?.satisfied, false);
    assert.equal(off?.applicable, true);
    assert.equal(off?.enrolled, false);
    assert.equal(JSON.stringify(off).includes("otpauth"), false);
  });

  it("treats a missing field as on", () => {
    const parsed = status();
    assert.equal(parsed?.enforcement, "on");
    assert.equal(
      showMfaEnforcementOffBanner({
        embed: false,
        sessionActive: true,
        enforcement: parsed?.enforcement,
      }),
      false,
    );
  });

  it("treats unknown values as on", () => {
    for (const value of [false, "OFF", "disabled", " off ", "", 0, null]) {
      assert.equal(parseMfaEnforcement(value), "on", String(value));
      const parsed = status({ enforcement: value });
      assert.equal(parsed?.enforcement, "on", String(value));
      assert.equal(
        showMfaEnforcementOffBanner({
          embed: false,
          sessionActive: true,
          enforcement: parsed?.enforcement,
        }),
        false,
        String(value),
      );
    }
  });
});

describe("MFA enforcement banner", () => {
  it("shows only for an active non-embed session whose enforcement is off", () => {
    assert.equal(
      showMfaEnforcementOffBanner({
        embed: false,
        sessionActive: true,
        enforcement: "off",
      }),
      true,
    );
    assert.equal(
      showMfaEnforcementOffBanner({
        embed: false,
        sessionActive: true,
        enforcement: "on",
      }),
      false,
    );
    assert.equal(
      showMfaEnforcementOffBanner({
        embed: true,
        sessionActive: true,
        enforcement: "off",
      }),
      false,
    );
    assert.equal(
      showMfaEnforcementOffBanner({
        embed: false,
        sessionActive: false,
        enforcement: "off",
      }),
      false,
    );
    assert.equal(
      showMfaEnforcementOffBanner({
        embed: false,
        sessionActive: true,
        enforcement: undefined,
      }),
      false,
    );
    assert.match(MFA_ENFORCEMENT_OFF_BANNER, /MFA_ENFORCEMENT=off/);
    assert.match(MFA_ENFORCEMENT_OFF_BANNER, /development only/);
    assert.equal(MFA_ENFORCEMENT_OFF_BANNER.includes(MFA_PRIVILEGED_LOUD), false);
  });

  it("is a non-dismissible status region in the authenticated shell only", () => {
    const banner = source("src/components/session/MfaEnforcementBanner.tsx");
    assert.match(banner, /role="status"/);
    assert.doesNotMatch(banner, /role="alert"/);
    assert.doesNotMatch(banner, /<button/);
    assert.doesNotMatch(banner, /onClick/);
    assert.doesNotMatch(banner, /autoFocus/);
    assert.match(banner, /MFA_ENFORCEMENT_OFF_BANNER/);
    assert.match(banner, /FF_LOUD_WARNING_CLASS/);
    assert.match(banner, /useMfaStatusQuery/);
    assert.match(banner, /showMfaEnforcementOffBanner/);
    assert.doesNotMatch(banner, /setInterval/);

    const options = mfaStatusQueryOptions();
    assert.equal(options.staleTime, MFA_STATUS_STALE_MS);
    assert.equal(options.staleTime, 60_000);
    assert.equal(options.refetchInterval, false);
    assert.equal(options.refetchOnWindowFocus, false);
    assert.equal(options.refetchOnReconnect, false);
    assert.equal(queryKeyHasSecret(options.queryKey), false);

    const shell = source("src/components/shell/WorkspaceShell.tsx");
    const embedBranch = shell.slice(
      shell.indexOf("const shell = embed ? ("),
      shell.indexOf(") : ("),
    );
    assert.equal(embedBranch.includes("MfaEnforcementBanner"), false);
    assert.match(shell, /<MfaEnforcementBanner \/>/);
    for (const relative of [
      "src/components/session/LoginChrome.tsx",
      "src/components/session/SetPasswordChrome.tsx",
      "src/components/bootstrap/FirstRunWizard.tsx",
      "src/components/session/SignedOutGate.tsx",
      "src/components/embed/EmbedChrome.tsx",
    ]) {
      assert.equal(source(relative).includes("MfaEnforcementBanner"), false, relative);
    }
  });
});

describe("MFA chrome bypass notice", () => {
  it("replaces the red required state when enforcement is off", () => {
    const bypass = mfaChromeLoudNotice({
      enforcement: "off",
      variant: "account",
      satisfied: false,
      hasSetupUri: false,
      done: false,
      requiredMessage: MFA_PRIVILEGED_LOUD,
    });
    assert.equal(bypass?.tone, "warning");
    assert.equal(bypass?.message, MFA_ENFORCEMENT_OFF_BANNER);
    assert.notEqual(bypass?.message, MFA_PRIVILEGED_LOUD);

    const required = mfaChromeLoudNotice({
      enforcement: "on",
      variant: "account",
      satisfied: false,
      hasSetupUri: false,
      done: false,
      requiredMessage: MFA_PRIVILEGED_LOUD,
    });
    assert.equal(required?.tone, "danger");
    assert.equal(required?.message, MFA_PRIVILEGED_LOUD);

    const stepUp = mfaChromeLoudNotice({
      enforcement: "off",
      variant: "step-up",
      satisfied: true,
      hasSetupUri: false,
      done: false,
      requiredMessage: MFA_PRIVILEGED_LOUD,
    });
    assert.equal(stepUp?.tone, "warning");
    assert.equal(stepUp?.message, MFA_ENFORCEMENT_OFF_BANNER);

    const verified = mfaChromeLoudNotice({
      enforcement: "off",
      variant: "account",
      satisfied: true,
      hasSetupUri: false,
      done: true,
      requiredMessage: MFA_PRIVILEGED_LOUD,
    });
    assert.equal(verified, null);

    const verifiedStepUp = mfaChromeLoudNotice({
      enforcement: "off",
      variant: "step-up",
      satisfied: true,
      hasSetupUri: false,
      done: true,
      requiredMessage: MFA_PRIVILEGED_LOUD,
    });
    assert.equal(verifiedStepUp?.tone, "danger");
    assert.equal(verifiedStepUp?.message, MFA_VERIFIED_RETRY);

    const satisfied = mfaChromeLoudNotice({
      enforcement: "off",
      variant: "account",
      satisfied: true,
      hasSetupUri: false,
      done: false,
      requiredMessage: MFA_PRIVILEGED_LOUD,
    });
    assert.equal(satisfied, null);
  });

  it("renders one warning notice and does not keep the danger required copy", () => {
    const chrome = source("src/components/session/MfaChrome.tsx");
    assert.match(chrome, /mfaChromeLoudNotice/);
    assert.match(chrome, /FF_LOUD_WARNING_CLASS/);
    assert.match(chrome, /useMfaStatusQuery/);
    assert.doesNotMatch(chrome, /loadMfaStatus/);
    assert.equal(chrome.match(/\{loud\.message\}/g)?.length, 1);
    assert.match(chrome, /loud\.tone === "warning"/);
    assert.match(chrome, /var\(--ff-danger\)/);
    const firstWarning = chrome.indexOf('loud.tone === "warning"');
    const secondWarning = chrome.indexOf('loud.tone === "warning"', firstWarning + 1);
    const warningBranch = chrome.slice(firstWarning, secondWarning);
    assert.match(warningBranch, /FF_LOUD_WARNING_CLASS/);
    assert.equal(warningBranch.includes("--ff-danger"), false);
    const panel = source("src/components/session/MfaAccountPanel.tsx");
    assert.equal(panel.includes("MFA_PRIVILEGED_LOUD"), false);
  });
});
