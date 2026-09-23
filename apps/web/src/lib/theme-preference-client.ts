"use client";

import {
  THEME_ATTR,
  colorTheme,
  themeCookieAssignment,
  type ColorTheme,
} from "./theme-preference.ts";

const listeners = new Set<() => void>();

export function subscribeColorTheme(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function currentColorTheme(): ColorTheme {
  if (typeof document === "undefined") {
    return "dark";
  }
  return colorTheme(document.documentElement.getAttribute(THEME_ATTR));
}

export function applyColorTheme(theme: ColorTheme): void {
  document.documentElement.setAttribute(THEME_ATTR, theme);
  document.cookie = themeCookieAssignment(theme);
  for (const listener of listeners) {
    listener();
  }
}
