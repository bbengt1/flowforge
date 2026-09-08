import type { NextConfig } from "next";

const dockerBuild = process.env.DOCKER_BUILD === "1";

const nextConfig: NextConfig = {
  ...(dockerBuild ? { output: "standalone" as const } : {}),
};

export default nextConfig;
