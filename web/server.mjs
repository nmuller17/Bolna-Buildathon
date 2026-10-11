// SignBridge custom server (red-team fixes B1, B3, B4, B7, B8; docs/app-plan.md sections 2.2, 9.6, 10).
//
//   npm run dev        -> 127.0.0.1:PORT only (development)
//   npm run build && npm run start   -> the same in production mode (use this for the demo)
//   (flag: --production = NODE_ENV=production; cross-platform, no shell env syntax)
//
// There is NO plain-HTTP LAN listener any more (decision record D3, SRV-2a): the --lan flag, the
// automatic LAN address choice and the dev:lan / start:lan scripts are gone. The Mode 0 guest window is a
// second browser window on this laptop at http://localhost:PORT/guest; the staff window is at
// http://127.0.0.1:PORT/staff (two cookie sites, docs/app-plan.md 9.6). The guest HTTPS listener for
// Mode C is Tier 1 (gate G1) and is not built here.
//
// Never run plain `next dev` / `next start` for the app: they bind every interface and skip the
// checks below (loopback-only routes then fail closed with 403).
//
// Before Next sees a request this server:
//   1. deletes every client-sent x-sb-* header;
//   2. answers 403 unless the Host header is localhost/127.0.0.1/[::1]:PORT, which blocks DNS rebinding;
//   3. decides loopback from the TCP socket (never from X-Forwarded-For);
//   4. answers 413 when Content-Length exceeds 8 KB (5 MB for /api/transcribe);
//   5. passes x-sb-loopback and x-sb-proof (a per-start random secret) to the route guard.
// It never logs URLs, headers or bodies.
//
// Staff capability (SRV-10, D6): at start it prints a one-time URL http://127.0.0.1:PORT/staff#k=<k> to
// this terminal (never project it). `kill -USR2 <pid>` prints a new one; claiming it replaces the old
// staff cookie and leaves the guest session alone.
//
// Environment: PORT (3000), NODE_ENV=production for `start`. App settings (SB_PROFILE, MODE0_GUEST_INPUT,
// BRIDGE_KEY, SB_SIMULATE, ...) are read by web/lib/app/runtime.ts.
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import next from "next";
import { allowedHostsFor, BODY_CAP_AUDIO, BODY_CAP_DEFAULT, hostAllowed, isLoopbackAddress, securityHeaders } from "./lib/app/access.ts";
import { issueCapability } from "./lib/app/staffcap.ts";
import { recordVendorTap } from "./lib/app/taps.ts";

if (process.argv.includes("--lan")) {
  console.error("The plain-HTTP --lan mode was removed (decision record D3). Use Mode 0 (guest window on localhost).");
  process.exit(1);
}
if (process.argv.includes("--production")) process.env.NODE_ENV = "production";
process.env.NEXT_TELEMETRY_DISABLED = "1";
const dev = process.env.NODE_ENV !== "production";
const port = Number.parseInt(process.env.PORT || "3000", 10);
for (const k of ["GUEST_LAN", "LAN_IP"]) delete process.env[k];

// Set before next() is created so next.config.ts and the route guard see them.
process.env.SB_PROOF = randomBytes(32).toString("base64url");
const allowedHosts = allowedHostsFor(port, null);
process.env.SB_ALLOWED_HOSTS = allowedHosts.join(",");
process.env.SB_STAFF_HOST = `127.0.0.1:${port}`;
process.env.PORT = String(port);

function printStaffLink(why) {
  const k = issueCapability();
  console.log(`> ${why}: open this once in Chrome on this laptop (do not project this terminal):`);
  console.log(`>   http://127.0.0.1:${port}/staff#k=${k}`);
}

function deny(res, status, error) {
  const body = JSON.stringify({ error });
  res.writeHead(status, {
    ...securityHeaders(dev),
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    Connection: "close",
  });
  res.end(body);
}

function stripSbHeaders(req) {
  for (const name of Object.keys(req.headers)) if (name.startsWith("x-sb-")) delete req.headers[name];
  const raw = req.rawHeaders;
  for (let i = raw.length - 2; i >= 0; i -= 2) if (raw[i].toLowerCase().startsWith("x-sb-")) raw.splice(i, 2);
}

/** Returns [status, error] when the request must be refused, or null. Exported logic lives in access.ts. */
function check(req) {
  if (!hostAllowed(req.headers.host, allowedHosts)) return [403, "host not allowed"];
  if (!isLoopbackAddress(req.socket.remoteAddress)) return [403, "not available from this device"];
  const pathname = (req.url || "/").split("?")[0];
  const cap = pathname === "/api/transcribe" ? BODY_CAP_AUDIO : BODY_CAP_DEFAULT;
  const declared = Number(req.headers["content-length"] ?? "0");
  if (!Number.isFinite(declared) || declared > cap) return [413, "request body too large"];
  return null;
}

// Next attaches its (dev HMR) upgrade listener to the "httpServer" it is given. We give it a hub
// and forward only upgrades that pass the same Host and path checks, from either listener.
const upgradeHub = new EventEmitter();
const app = next({ dev, hostname: "127.0.0.1", port, httpServer: upgradeHub });
const handle = app.getRequestHandler();
await app.prepare();

function onRequest(req, res) {
  stripSbHeaders(req);
  const refused = check(req);
  if (refused) return deny(res, refused[0], refused[1]);
  req.headers["x-sb-loopback"] = "1";
  req.headers["x-sb-proof"] = process.env.SB_PROOF;
  // Privacy panel (DSH-5): a speech-to-text call reached the vendor only when a key is set and P1's
  // route answered 200; the audio size is what was sent. Only the byte count is kept.
  if ((req.url || "").split("?")[0] === "/api/transcribe" && process.env.OPENAI_API_KEY) {
    const bytes = Number(req.headers["content-length"] ?? "0");
    res.on("finish", () => {
      if (res.statusCode === 200) recordVendorTap("/api/transcribe", bytes);
    });
  }
  handle(req, res).catch(() => {
    if (!res.headersSent) deny(res, 500, "internal error");
    else res.destroy();
  });
}

function onUpgrade(req, socket, head) {
  stripSbHeaders(req);
  if (!hostAllowed(req.headers.host, allowedHosts) || !isLoopbackAddress(req.socket.remoteAddress)) {
    socket.destroy();
    return;
  }
  upgradeHub.emit("upgrade", req, socket, head);
}

const loopbackServer = createServer(onRequest);
loopbackServer.on("upgrade", onUpgrade);
// Event streams stay open; keep idle sockets from piling up without cutting a stream.
loopbackServer.keepAliveTimeout = 5_000;
loopbackServer.listen(port, "127.0.0.1", () => {
  console.log(`> SignBridge on http://127.0.0.1:${port} (${dev ? "development" : "production"}), loopback only`);
  console.log(`> Guest window (Mode 0): opened from the staff screen on http://localhost:${port}/guest`);
  printStaffLink("Staff link");
});

// SIGUSR2: a new one-time staff link without a restart (docs/app-plan.md 9.6). The guest session is untouched.
process.on("SIGUSR2", () => printStaffLink("New staff link (SIGUSR2)"));
