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
