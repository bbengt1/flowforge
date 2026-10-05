"use client";

import Link from "next/link";
import { useEmbedMode } from "@/components/embed/EmbedMode";
import { CHANGE_PASSWORD_HREF } from "@/lib/change-password";
import {
  FF_SETTINGS_EYEBROW_CLASS,
  FF_SETTINGS_LINK_CLASS,
  FF_SETTINGS_MUTED_CLASS,
  FF_SETTINGS_PANEL_CLASS,
  FF_SETTINGS_TITLE_CLASS,
} from "@/lib/settings-wizard-visual";

/** Settings entry for a voluntary change. Embed never mounts this door. */
export function ChangePasswordAccountLink() {
  const embed = useEmbedMode();
  if (embed) {
    return null;
  }

  return (
    <section
      id="password"
      aria-labelledby="change-password-settings-heading"
      className={FF_SETTINGS_PANEL_CLASS}
    >
      <p className={FF_SETTINGS_EYEBROW_CLASS}>Account · Password</p>
      <h2
        id="change-password-settings-heading"
        className={`mt-1 text-lg ${FF_SETTINGS_TITLE_CLASS}`}
      >
        Password
      </h2>
      <p className={`mt-1 max-w-2xl text-sm leading-6 ${FF_SETTINGS_MUTED_CLASS}`}>
        Change your password. The next screen asks for the password you use now.
      </p>
      <p className="mt-4">
        <Link className={FF_SETTINGS_LINK_CLASS} href={CHANGE_PASSWORD_HREF}>
          Change password
        </Link>
      </p>
    </section>
  );
}
