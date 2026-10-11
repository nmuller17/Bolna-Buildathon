// The demo is a single screen at "/": the old /guest address leads there.
import { redirect } from "next/navigation";

export default function GuestRedirect() {
  redirect("/");
}
