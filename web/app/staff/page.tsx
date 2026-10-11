// Receptionist screen (P4): talk button, quick replies, live recognised signs, check-in co-pilot,
// evidence, latency, privacy and benchmark panels (docs/app-plan.md section 4.2).
import StaffApp from "@/components/staff/StaffApp";

export const metadata = { title: "SignBridge desk", referrer: "no-referrer" as const };

export default function StaffPage() {
  return <StaffApp />;
}
