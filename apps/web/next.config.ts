import type { NextConfig } from "next";
import {
  HSTS_VALUE,
  staticSecurityHeaders,
} from "./src/lib/security-headers";

const dockerBuild = process.env.DOCKER_BUILD === "1";
// CSP is applied per-request in src/proxy.ts with a nonce so Next.js
// can authorize inline bootstrap/RSC scripts. A baked nonce-less CSP
// here would block hydration.
const security = staticSecurityHeaders({ includeCsp: false });

const nextConfig: NextConfig = {
  ...(dockerBuild ? { output: "standalone" as const } : {}),
  poweredByHeader: false,
  // Browser session cookies are Path=/api/v1. Rewrite so same-origin
  // fetches to /api/v1/* hit the existing control-plane forwarder.
  async rewrites() {
    return [
      {
        source: "/api/v1/:path*",
        destination: "/api/control-plane/:path*",
      },
      // E11.1: /embed/v1 mounts the same canonical UI. Deep links stay valid
      // standalone. Chloe owns the embed shell chrome.
      {
        source: "/embed/v1",
        destination: "/",
      },
      {
        source: "/embed/v1/:path*",
        destination: "/:path*",
      },
    ];
  },
  async headers() {
    // `/:path*` does not always match `/` in Next.js; set both.
    const sources = ["/", "/:path*"];
    return [
      ...sources.map((source) => ({ source, headers: security })),
      // HSTS only when a TLS terminator advertised HTTPS. Local
      // http://localhost:3000 does not send this header.
      ...sources.map((source) => ({
        source,
        has: [{ type: "header" as const, key: "x-forwarded-proto", value: "https" }],
        headers: [{ key: "Strict-Transport-Security", value: HSTS_VALUE }],
      })),
    ];
  },
};

export default nextConfig;
