import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Produces .next/standalone/ for the Dockerfile's runner stage. Required for Railway deploy.
  output: "standalone",
  // Next 15 promoted typedRoutes from experimental to stable.
  typedRoutes: true,
  serverExternalPackages: ["@anthropic-ai/sdk", "openai", "@google/genai"],
};

export default nextConfig;
