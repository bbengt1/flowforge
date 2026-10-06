"use client";

import { useEmbedMode } from "@/components/embed/EmbedMode";
import { MfaChrome } from "@/components/session/MfaChrome";
import {
  FF_SETTINGS_EYEBROW_CLASS,
  FF_SETTINGS_MUTED_CLASS,
  FF_SETTINGS_PANEL_CLASS,
  FF_SETTINGS_TITLE_CLASS,
} from "@/lib/settings-wizard-visual";

export function MfaAccountPanel() {
  const embed = useEmbedMode();
  if (embed) {
    return null;
  }

  return (
    <section id="mfa" aria-labelledby="mfa-heading" className={FF_SETTINGS_PANEL_CLASS}>
      <p className={FF_SETTINGS_EYEBROW_CLASS}>Account · MFA</p>
      <h2 id="mfa-heading" className={`mt-1 text-lg ${FF_SETTINGS_TITLE_CLASS}`}>
        Multi-factor authentication
      </h2>
      <p className={`mt-1 max-w-2xl text-sm leading-6 ${FF_SETTINGS_MUTED_CLASS}`}>
        Local sign-in and single sign-on can enroll a time-based code here.
        Machine, embed, and trusted-dev sessions do not use this step-up.
      </p>
      <div className="mt-4">
        <MfaChrome variant="account" />
      </div>
    </section>
  );
}
