// P4: runs once when the Next.js server starts, before any route. Installs the outbound-request counter
// shown on the staff privacy panel (lib/app/egress.ts). Node runtime only.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { installEgressCounter } = await import("./lib/app/egress");
  installEgressCounter();
}
