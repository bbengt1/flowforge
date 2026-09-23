/**
 * G.3.8 document direction. Playwright sends `x-ff-dir: rtl` so the
 * server renders `dir` before paint. Browsers do not send the header.
 * Anything other than the exact value `rtl` stays `ltr` (fail closed).
 */

export const DOCUMENT_DIRECTION_HEADER = "x-ff-dir";

export type DocumentDirection = "ltr" | "rtl";

export function documentDirectionFromHeader(
  value: string | null | undefined,
): DocumentDirection {
  return value === "rtl" ? "rtl" : "ltr";
}
