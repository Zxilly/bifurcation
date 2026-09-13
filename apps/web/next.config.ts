import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["better-sqlite3", "@node-rs/argon2"],
  transpilePackages: ["@bifurcation/rpc"],
  outputFileTracingIncludes: { "/*": ["./drizzle/**/*"] },
  outputFileTracingExcludes: {
    "/*": ["../../.local/**/*", "../../.tmp/**/*", "../../.env*", "./.env*", "../../services/**/*", "../../docs/**/*", "./tests/**/*", "./e2e/**/*"],
  },
};

export default nextConfig;
