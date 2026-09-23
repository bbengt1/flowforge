/**
 * Document direction for G.3.8 / #495.
 *
 * The root layout reads the `ff-dir` cookie. Missing or unknown values
 * fail closed to `ltr`. Playwright sets `rtl` and checks layout in the
 * browser; this helper is not the coverage gate.
 */

export const DOCUMENT_DIR_COOKIE = "ff-dir";

export type DocumentDirection = "ltr" | "rtl";

export function documentDirection(
  value: string | undefined | null,
): DocumentDirection {
  return value?.trim().toLowerCase() === "rtl" ? "rtl" : "ltr";
}
