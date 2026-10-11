// Guest screen (P4 layout): captions and avatar (P2), live signs, confirm-before-speaking, Type,
// interpreter and "Get staff now". The guest device never uses a camera or a microphone; the desk
// camera belongs to recognition/live.py on the laptop (docs/app-plan.md section 1, AS-19).
//
// Installable (SES-11 as amended 2026-10-11): a web-app manifest, icons and the full-screen meta tags,
// so a team phone or tablet can add the guest screen to its home screen and open it without browser
// bars. There is still NO service worker, Cache API or storage: the manifest stores nothing, the
// installed app opens /guest without a pairing code ("Ask the front desk to connect this screen"),
// and every conversation stays in page memory only.
import type { Metadata, Viewport } from "next";
import GuestApp from "@/components/guest/GuestApp";

export const metadata: Metadata = {
  title: "SignBridge front desk",
  referrer: "no-referrer",
  manifest: "/manifest.webmanifest",
  applicationName: "SignBridge",
  appleWebApp: { capable: true, title: "SignBridge", statusBarStyle: "black-translucent" },
  icons: { icon: [{ url: "/icons/icon-192.png", sizes: "192x192" }], apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }] },
  formatDetection: { telephone: false, email: false, address: false },
};

// viewport-fit=cover lets the navy board reach the screen edges; guest.module.css keeps every control
// inside the safe-area insets (notch, home indicator, rounded corners).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0e2a47",
};

export default function GuestPage() {
  return <GuestApp />;
}
