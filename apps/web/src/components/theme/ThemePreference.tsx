"use client";

import { useSyncExternalStore } from "react";
import {
  applyColorTheme,
  currentColorTheme,
  subscribeColorTheme,
} from "@/lib/theme-preference-client";
import { THEME_COOKIE, type ColorTheme } from "@/lib/theme-preference";
import {
  FF_SETTINGS_HELP_CLASS,
  FF_SETTINGS_PANEL_CLASS,
  FF_SETTINGS_TITLE_CLASS,
} from "@/lib/settings-wizard-visual";

export function ThemePreferenceControl({
  theme,
  variant = "header",
}: {
  theme: ColorTheme;
  variant?: "header" | "settings";
}) {
  const selected = useSyncExternalStore(
    subscribeColorTheme,
    currentColorTheme,
    () => theme,
  );

  const options = (
    <div
      role="group"
      aria-label="Color theme"
      data-ff-theme-control=""
      className="flex items-center gap-1"
    >
      <ThemeOption selected={selected} value="dark" />
      <ThemeOption selected={selected} value="light" />
    </div>
  );

  if (variant === "header") {
    return options;
  }

  return (
    <section className={FF_SETTINGS_PANEL_CLASS} data-ff-theme-settings="">
      <h2 className={`text-lg ${FF_SETTINGS_TITLE_CLASS}`}>Appearance</h2>
      <p className={`mt-1 ${FF_SETTINGS_HELP_CLASS}`}>
        Dark is the default. Light uses the same design tokens on primary
        surfaces. This preference is a {THEME_COOKIE} cookie, not a secret.
        Explorer folders stay on the dark rail.
      </p>
      <div className="mt-3">{options}</div>
    </section>
  );
}

function ThemeOption({
  selected,
  value,
}: {
  selected: ColorTheme;
  value: ColorTheme;
}) {
  const pressed = selected === value;
  return (
    <button
      type="button"
      className="ff-theme-option ff-shell-control px-2 py-1 text-xs"
      aria-pressed={pressed}
      data-ff-theme-value={value}
      onClick={() => applyColorTheme(value)}
    >
      {value === "dark" ? "Dark" : "Light"}
    </button>
  );
}
