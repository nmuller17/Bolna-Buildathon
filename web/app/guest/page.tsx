// Guest screen (P4 layout): captions and avatar (P2), live signs, confirm-before-speaking, Type,
// interpreter and "Get staff now". The guest device never uses a camera or a microphone; the desk
// camera belongs to recognition/live.py on the laptop (docs/app-plan.md section 1, AS-19).
import GuestApp from "@/components/guest/GuestApp";

export const metadata = { title: "SignBridge front desk", referrer: "no-referrer" as const };

export default function GuestPage() {
  return <GuestApp />;
}
