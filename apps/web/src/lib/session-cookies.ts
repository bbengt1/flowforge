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

/**
 * Expire first-party and CHIPS ff_session / ff_csrf pairs. Matches
 * Go clearSessionCookies: empty value, Max-Age=0, Path=/api/v1.
 * Used when a wizard POST cannot present a hydrated CSRF token.
 */
export function expireSessionCookies(options: {
  requestSecure: boolean;
}): string[] {
  return [
    expireOneCookie("ff_session", {
      httpOnly: true,
      sameSite: "Lax",
      secure: options.requestSecure,
      partitioned: false,
    }),
    expireOneCookie("ff_csrf", {
      httpOnly: false,
      sameSite: "Strict",
      secure: options.requestSecure,
      partitioned: false,
    }),
    expireOneCookie("ff_session", {
      httpOnly: true,
      sameSite: "None",
      secure: true,
      partitioned: true,
    }),
    expireOneCookie("ff_csrf", {
      httpOnly: false,
      sameSite: "None",
      secure: true,
      partitioned: true,
    }),
  ];
}

function expireOneCookie(
  name: "ff_session" | "ff_csrf",
  flags: {
    httpOnly: boolean;
    sameSite: "Lax" | "Strict" | "None";
    secure: boolean;
    partitioned: boolean;
  },
): string {
  const parts = [`${name}=`, "Path=/api/v1", "Max-Age=0", `SameSite=${flags.sameSite}`];
  if (flags.httpOnly) {
    parts.push("HttpOnly");
  }
  if (flags.secure || flags.partitioned || flags.sameSite === "None") {
    parts.push("Secure");
  }
  if (flags.partitioned || flags.sameSite === "None") {
    parts.push("Partitioned");
  }
  return parts.join("; ");
}

/** Drop ff_session / ff_csrf from a Cookie header. Other cookies stay. */
export function stripSessionCookieHeader(
  cookieHeader: string | null | undefined,
): string {
  if (!cookieHeader?.trim()) {
    return "";
  }
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => {
      const name = part.split("=")[0]?.trim();
      return name !== "ff_session" && name !== "ff_csrf";
    })
    .join("; ");
}

export function headersWithoutSessionCookies(source: Headers): Headers {
  const next = new Headers(source);
  const stripped = stripSessionCookieHeader(source.get("cookie"));
  if (stripped) {
    next.set("cookie", stripped);
  } else {
    next.delete("cookie");
  }
  return next;
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
