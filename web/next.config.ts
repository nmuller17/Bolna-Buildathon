import type { NextConfig } from "next";
import { securityHeaders } from "./lib/app/access";

// Red-team fixes B7, B8, D4 (docs/app-plan.md section 9 and "Red-team requirements").
const dev = process.env.NODE_ENV !== "production";
const asList = (h: Record<string, string>) => Object.entries(h).map(([key, value]) => ({ key, value }));

const nextConfig: NextConfig = {
  // No "X-Powered-By: Next.js" (framework fingerprinting).
  poweredByHeader: false,
  // Dev request logging prints full URLs, which would include pairing codes and guest tokens.
  logging: { incomingRequests: false },
  // Server-sent events (/api/events) must not be buffered by gzip (docs/app-plan.md 10, SSE).
  compress: false,
  async headers() {
    return [
      { source: "/:path*", headers: asList(securityHeaders(dev, "/")) },
      // Later entries override earlier ones for the same key: no microphone on the guest page.
      { source: "/guest/:path*", headers: asList(securityHeaders(dev, "/guest")) },
      { source: "/guest", headers: asList(securityHeaders(dev, "/guest")) },
      // Every app API answer is no-store; /api/events sets its own "no-store, no-transform" (SSE).
      { source: "/api/:path((?!events$).*)", headers: [{ key: "Cache-Control", value: "no-store" }] },
      // SRV-8a: the two screens are never cached (they render per request and show a conversation).
      { source: "/guest", headers: [{ key: "Cache-Control", value: "no-store" }] },
      { source: "/staff", headers: [{ key: "Cache-Control", value: "no-store" }] },
    ];
  },
};

export default nextConfig;
