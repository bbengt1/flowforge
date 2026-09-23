/**
 * Fail-closed URL checks. Scheme and host decisions go through the URL
 * parser. Substring searches on unparsed URLs are not a security check.
 */

const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Absolute or relative navigation URL whose scheme is http: or https:.
 * `javascript:`, `data:`, `vbscript:`, `mailto:`, `tel:`, and any other
 * scheme are null. Relative URLs inherit the base scheme.
 */
export function parseHttpNavigationUrl(href: string, base: string): URL | null {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(trimmed, base);
  } catch {
    return null;
  }
  if (!HTTP_PROTOCOLS.has(url.protocol)) {
    return null;
  }
  return url;
}

/** scheme + host + port, or null when the value is not an http(s) URL. */
export function httpOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!HTTP_PROTOCOLS.has(url.protocol) || url.username || url.password) {
    return null;
  }
  return url.origin;
}

/**
 * True when a CSP source list (space-separated tokens) contains the
 * candidate as an exact http(s) origin. A shorter prefix, a suffix, or
 * an extra label does not match.
 */
export function sourceListHasExactHttpOrigin(
  sourceList: string,
  candidate: string,
): boolean {
  const expected = httpOrigin(candidate);
  if (!expected) {
    return false;
  }
  return sourceList.split(/\s+/).some((token) => httpOrigin(token) === expected);
}

/** Exact membership. Not a substring search. */
export function listHasExactValue(
  values: readonly string[],
  candidate: string,
): boolean {
  return values.some((value) => value === candidate);
}

/**
 * True when `hostname` is the host of a URL in `text`, or a whole host
 * token. `example.com` does not match `notexample.com` or `example.com.evil.net`.
 */
export function textMentionsHostname(text: string, hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (!host) {
    return false;
  }
  const urls = text.match(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi) ?? [];
  for (const raw of urls) {
    try {
      if (new URL(raw).hostname.toLowerCase() === host) {
        return true;
      }
    } catch {
      // Unparsable token is not a host match.
    }
  }
  return text
    .split(/[^A-Za-z0-9.-]+/)
    .some((token) => token.toLowerCase() === host);
}
