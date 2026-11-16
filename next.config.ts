import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Database and Redis clients: load from node_modules at runtime instead of bundling them.
  serverExternalPackages: ["pg", "ioredis"],
  devIndicators: false,
};

export default nextConfig;
