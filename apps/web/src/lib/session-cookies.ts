/**
 * Rewrite API Set-Cookie onto the UI origin (same-origin Next proxy).
 * Domain is stripped. Path and SameSite stay as the API set them
 * (`Path=/api/v1`, Lax/Strict for top-level, None+Partitioned for
 * embed CHIPS). Secure is kept when the inbound browser request is TLS
 * so localhost HTTP still works for first-party cookies. CHIPS cookies
 * (`SameSite=None` / `Partitioned`) always keep Secure — never drop it
 * and never emit SameSite=None without Partitioned.
 *
 * Cookie values are never logged.
 */

export function rewriteUpstreamSetCookies(
  rawCookies: readonly string[],
  options: { requestSecure: boolean },
): string[] {
  const rewritten: string[] = [];
  for (const raw of rawCookies) {
    const next = rewriteUpstreamSetCookie(raw, options);
    if (next) {
      rewritten.push(next);
    }
  }
  return rewritten;
}

export function rewriteUpstreamSetCookie(
  raw: string,
  options: { requestSecure: boolean },
): string | null {
  const parts = raw
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return null;
  }
  const nameValue = parts[0];
  if (!nameValue || !nameValue.includes("=")) {
    return null;
  }

  const kept: string[] = [nameValue];
  let hasPath = false;
  let hasSameSite = false;
  let sameSiteNone = false;
  let partitioned = false;

  for (const attr of parts.slice(1)) {
    const key = attr.split("=")[0]?.trim().toLowerCase();
    const value = attr.includes("=")
      ? attr.slice(attr.indexOf("=") + 1).trim().toLowerCase()
      : "";
    if (key === "domain") {
      continue;
    }
    if (key === "secure") {
      continue;
    }
    if (key === "path") {
      hasPath = true;
      kept.push(attr);
      continue;
    }
    if (key === "samesite") {
      hasSameSite = true;
      sameSiteNone = value === "none";
      kept.push(attr);
      continue;
    }
    if (key === "partitioned") {
      partitioned = true;
      kept.push("Partitioned");
      continue;
    }
    kept.push(attr);
  }

  const chips = partitioned || sameSiteNone;
  if (chips && !partitioned) {
    kept.push("Partitioned");
    partitioned = true;
  }
  if (!hasPath) {
    kept.push("Path=/api/v1");
  }
  if (!hasSameSite) {
    // API default for first-party ff_session. Embed CHIPS is None.
    kept.push(chips ? "SameSite=None" : "SameSite=Lax");
  }
  // CHIPS requires Secure. Never drop it for Partitioned / SameSite=None.
  if (
    (options.requestSecure || chips) &&
    !kept.some((item) => item.toLowerCase() === "secure")
  ) {
    kept.push("Secure");
  }
  return kept.join("; ");
}

export function requestIsSecure(request: {
  url?: string;
  headers?: Headers;
}): boolean {
  const forwarded = request.headers
    ?.get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();
  if (forwarded === "https") {
    return true;
  }
  if (forwarded === "http") {
    return false;
  }
  if (!request.url) {
    return false;
  }
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function collectSetCookies(headers: Headers): string[] {
  const getter = (
    headers as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie;
  if (typeof getter === "function") {
    return getter.call(headers);
  }
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}
