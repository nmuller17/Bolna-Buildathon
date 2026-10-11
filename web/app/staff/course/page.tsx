// Staff micro-course (P4, builder S; docs/features-plan.md F14): the 20 receptionist sentences played
// by the avatar with the English caption and the sign key. Staff only: web/server.mjs answers 403 unless
// the Host is 127.0.0.1:PORT and the staff cookie is valid (the guest window runs on localhost).
import CourseApp from "@/components/staff/CourseApp";

export const metadata = { title: "SignBridge staff course", referrer: "no-referrer" as const };
export const dynamic = "force-dynamic";

export default function StaffCoursePage() {
  return <CourseApp />;
}
