import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Produces .next/standalone/ for the Dockerfile's runner stage. Required for Railway deploy.
  output: "standalone",
  // typedRoutes can land in a later milestone once the route tree stabilizes.
  // At M0 it adds friction (routes under () groups, catch-alls, etc.) without payoff.
  typedRoutes: false,
};

export default nextConfig;
