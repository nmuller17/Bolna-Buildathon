// Call-share view: its own tab/window title. screen_source.py skips windows whose title contains "SignBridge",
// so the recognizer never reads this page (or its pop-out) as the guest.
export const metadata = { title: "SignBridge call share" };

export default function CallShareLayout({ children }: { children: React.ReactNode }) {
  return children;
}
