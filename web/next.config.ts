import path from "node:path";
import type { NextConfig } from "next";
import { securityHeaders } from "./lib/app/access";

const dev = process.env.NODE_ENV !== "production";
const asList = (h: Record<string, string>) => Object.entries(h).map(([key, value]) => ({ key, value }));

const nextConfig: NextConfig = {
  // Let Turbopack resolve files up to the repo root (the /signs route reads <repo>/signs).
  turbopack: { root: path.join(__dirname, "..") },
  // Security (red-team B7, B8, D4): no "X-Powered-By: Next.js", no request logging (full URLs could
  // carry guest data), and security headers on every response (lib/app/access.ts securityHeaders).
  poweredByHeader: false,
  logging: { incomingRequests: false },
  async headers() {
    return [
      { source: "/:path*", headers: asList(securityHeaders(dev)) },
      { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
    ];
  },
};

export default nextConfig;
