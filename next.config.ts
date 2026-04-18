import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Produces .next/standalone/ for the Dockerfile's runner stage. Required for Railway deploy.
  output: "standalone",
  experimental: {
    typedRoutes: true,
  },
  serverExternalPackages: ["@anthropic-ai/sdk", "openai", "@google/genai"],
};

export default nextConfig;
