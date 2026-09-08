import type { NextConfig } from "next";
import path from "node:path";

const dockerBuild = process.env.DOCKER_BUILD === "1";

const nextConfig: NextConfig = {
  ...(dockerBuild
    ? {
        output: "standalone" as const,
        outputFileTracingRoot: path.join(__dirname, "../.."),
      }
    : {}),
};

export default nextConfig;
