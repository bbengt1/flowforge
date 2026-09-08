/**
 * Rewrite API Set-Cookie so the browser stores session cookies on the UI
 * origin (same-origin Next proxy). Domain is stripped. Secure is kept only
 * when the inbound browser request is TLS so localhost HTTP still works.
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

  for (const attr of parts.slice(1)) {
    const key = attr.split("=")[0]?.trim().toLowerCase();
    if (key === "domain") {
      continue;
    }
    if (key === "secure") {
      if (options.requestSecure) {
        kept.push("Secure");
      }
      continue;
    }
    if (key === "path") {
      hasPath = true;
      kept.push(attr);
      continue;
    }
    if (key === "samesite") {
      hasSameSite = true;
      kept.push(attr);
      continue;
    }
    kept.push(attr);
  }

  if (!hasPath) {
    kept.push("Path=/");
  }
  if (!hasSameSite) {
    kept.push("SameSite=Lax");
  }
  if (options.requestSecure && !kept.some((item) => item.toLowerCase() === "secure")) {
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
