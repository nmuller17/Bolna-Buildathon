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
  // The guest device in LAN dev mode; web/server.mjs sets LAN_IP before Next starts.
  ...(process.env.LAN_IP ? { allowedDevOrigins: [process.env.LAN_IP] } : {}),
  async headers() {
    return [
      { source: "/:path*", headers: asList(securityHeaders(dev, "/")) },
      // Later entries override earlier ones for the same key: no microphone on the guest page.
      { source: "/guest/:path*", headers: asList(securityHeaders(dev, "/guest")) },
      { source: "/guest", headers: asList(securityHeaders(dev, "/guest")) },
      { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
    ];
  },
};

export default nextConfig;
