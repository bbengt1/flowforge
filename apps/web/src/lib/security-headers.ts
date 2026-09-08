/**
 * E1.3 secure headers for the Next.js UI.
 *
 * Applied from next.config.ts (all routes, including static) and src/proxy.ts
 * (HSTS when the request is actually TLS). Keep this module free of next/server
 * so next.config and node:test can import it.
 *
 * Embed (E11) will relax frame-ancestors to allowlisted host origins. Standalone
 * defaults to deny/none so the shell cannot be clickjacked.
 */

export const HSTS_VALUE = "max-age=31536000; includeSubDomains";

export const PERMISSIONS_POLICY =
  "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), interest-cohort=()";

export type HeaderPair = { key: string; value: string };

export type HeaderEnv = {
  NODE_ENV?: string;
  NEXT_PUBLIC_API_URL?: string;
  WEB_CSP_CONNECT_SRC?: string;
  WEB_HSTS?: string;
};

const DEFAULT_API_ORIGIN = "http://localhost:8080";

export function getApiConnectOrigins(env: HeaderEnv = process.env): string[] {
  const origins = new Set<string>(["'self'"]);
  const publicApi = (env.NEXT_PUBLIC_API_URL || DEFAULT_API_ORIGIN).replace(
    /\/$/,
    "",
  );
  try {
    origins.add(new URL(publicApi).origin);
  } catch {
    // Invalid NEXT_PUBLIC_API_URL is ignored; 'self' still covers same-origin proxies.
  }
  for (const extra of env.WEB_CSP_CONNECT_SRC?.split(/\s+/) ?? []) {
    if (extra) {
      origins.add(extra);
    }
  }
  return [...origins];
}

/**
 * Credentialed browser session fetches stay on 'self' (Next proxies).
 * connect-src may list the public API origin for non-credentialed docs
 * links / health display, but never a wildcard and never credentialed
 * cross-origin session calls.
 */
export function sessionConnectSrc(): string[] {
  return ["'self'"];
}

/** Per-request nonce for Next.js inline bootstrap / RSC payload scripts. */
export function createScriptNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString("base64");
}

export function buildContentSecurityPolicy(
  options: {
    development?: boolean;
    connectSrc?: string[];
    env?: HeaderEnv;
    nonce?: string;
  } = {},
): string {
  const env = options.env ?? process.env;
  const development =
    options.development ?? env.NODE_ENV !== "production";
  const connectSrc = options.connectSrc ?? getApiConnectOrigins(env);
  const nonce = options.nonce;
  // Next.js App Router emits inline bootstrap/RSC scripts. Production
  // authorizes those with a per-request nonce (+ strict-dynamic). Dev
  // still needs eval for Turbopack/React error stacks.
  let scriptSrc: string;
  if (nonce) {
    scriptSrc = development
      ? `'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval'`
      : `'self' 'nonce-${nonce}' 'strict-dynamic'`;
  } else if (development) {
    scriptSrc = "'self' 'unsafe-eval' 'unsafe-inline'";
  } else {
    scriptSrc = "'self'";
  }
  const styleSrc = nonce
    ? `'self' 'unsafe-inline' 'nonce-${nonce}'`
    : "'self' 'unsafe-inline'";

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    `style-src ${styleSrc}`,
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${connectSrc.join(" ")}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "worker-src 'self'",
    "manifest-src 'self'",
  ].join("; ");
}

export function shouldSendHsts(input: {
  protocol?: string;
  forwardedProto?: string | null;
  force?: boolean;
}): boolean {
  if (input.force) {
    return true;
  }
  const proto = (input.forwardedProto ?? "")
    .split(",")[0]
    ?.trim()
    .toLowerCase();
  if (proto === "https") {
    return true;
  }
  return (input.protocol ?? "").replace(/:$/, "").toLowerCase() === "https";
}

export function staticSecurityHeaders(
  options: {
    development?: boolean;
    env?: HeaderEnv;
    nonce?: string;
    includeCsp?: boolean;
  } = {},
): HeaderPair[] {
  const headers: HeaderPair[] = [];
  if (options.includeCsp !== false) {
    headers.push({
      key: "Content-Security-Policy",
      value: buildContentSecurityPolicy(options),
    });
  }
  headers.push(
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: PERMISSIONS_POLICY },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-DNS-Prefetch-Control", value: "off" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
  );
  return headers;
}

export function applySecurityHeaders(
  headers: { set: (key: string, value: string) => void },
  options: {
    development?: boolean;
    env?: HeaderEnv;
    protocol?: string;
    forwardedProto?: string | null;
    nonce?: string;
  } = {},
): void {
  const env = options.env ?? process.env;
  for (const { key, value } of staticSecurityHeaders({
    development: options.development,
    env,
    nonce: options.nonce,
  })) {
    headers.set(key, value);
  }
  if (options.nonce) {
    headers.set("x-nonce", options.nonce);
  }
  if (
    shouldSendHsts({
      protocol: options.protocol,
      forwardedProto: options.forwardedProto,
      force: env.WEB_HSTS === "1",
    })
  ) {
    headers.set("Strict-Transport-Security", HSTS_VALUE);
  }
}
