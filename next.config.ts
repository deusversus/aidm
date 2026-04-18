import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: {
    typedRoutes: true,
  },
  serverExternalPackages: ["@anthropic-ai/sdk", "openai", "@google/genai"],
};

export default nextConfig;
