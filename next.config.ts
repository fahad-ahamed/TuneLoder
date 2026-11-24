import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // type errors are NOT ignored anymore — a self-hosted VPS build should be honest
  typescript: {
    ignoreBuildErrors: false,
  },
  reactStrictMode: false,
  poweredByHeader: false,
};

export default nextConfig;
