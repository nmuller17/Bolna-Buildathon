// SignBridge custom server (red-team fixes B1, B3, B4, B7, B8; docs/app-plan.md section 9).
//
//   npm run dev        -> 127.0.0.1:3000 only (the front-desk laptop)
//   npm run dev:lan    -> also LAN_IP:3000, for the guest device (use an isolated network)
//   (flags: --lan = GUEST_LAN=1, --production = NODE_ENV=production; cross-platform, no shell env syntax)
//   npm run build && npm run start[:lan]   -> the same in production mode (use this for the demo)
//
// Never run plain `next dev` / `next start` for the app: they bind every interface and skip the
// checks below (loopback-only routes then fail closed with 403).
//
// Before Next sees a request this server:
//   1. deletes every client-sent x-sb-* header;
//   2. answers 403 unless the Host header is localhost/127.0.0.1/[::1]:PORT (or LAN_IP:PORT in LAN mode),
//      which blocks DNS rebinding;
//   3. decides loopback from the TCP socket (never from X-Forwarded-For) and, for a non-loopback
//      client, allows only the guest paths in access.ts lanPathAllowed (default deny);
//   4. answers 413 when Content-Length exceeds 8 KB (5 MB for /api/transcribe);
//   5. passes x-sb-loopback and x-sb-proof (a per-start random secret) to the route guard.
// It never logs URLs, headers or bodies.
//
// Environment: PORT (3000), GUEST_LAN=1 (LAN mode), LAN_IP (default: first non-internal IPv4),
// NODE_ENV=production for `start`.
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import os from "node:os";
import next from "next";
import {
  allowedHostsFor,
  BODY_CAP_AUDIO,
  BODY_CAP_DEFAULT,
  hostAllowed,
  isLoopbackAddress,
  lanPathAllowed,
  securityHeaders,
} from "./lib/app/access.ts";

if (process.argv.includes("--production")) process.env.NODE_ENV = "production";
if (process.argv.includes("--lan")) process.env.GUEST_LAN = "1";
process.env.NEXT_TELEMETRY_DISABLED = "1";
const dev = process.env.NODE_ENV !== "production";
const port = Number.parseInt(process.env.PORT || "3000", 10);
const lan = process.env.GUEST_LAN === "1";

function firstLanIPv4() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  return null;
}

const lanIp = lan ? process.env.LAN_IP || firstLanIPv4() : null;
if (lan && !lanIp) {
  console.error("GUEST_LAN=1 but no LAN address found; set LAN_IP");
  process.exit(1);
}

// Set before next() is created so next.config.ts and the route guard see them.
process.env.SB_PROOF = randomBytes(32).toString("base64url");
const allowedHosts = allowedHostsFor(port, lanIp);
process.env.SB_ALLOWED_HOSTS = allowedHosts.join(",");
if (lanIp) process.env.LAN_IP = lanIp;

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
  const loopback = isLoopbackAddress(req.socket.remoteAddress);
  if (!loopback && !lanPathAllowed(req.method || "GET", req.url || "/", dev)) return [403, "not available from this device"];
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
  req.headers["x-sb-loopback"] = isLoopbackAddress(req.socket.remoteAddress) ? "1" : "0";
  req.headers["x-sb-proof"] = process.env.SB_PROOF;
  handle(req, res).catch(() => {
    if (!res.headersSent) deny(res, 500, "internal error");
    else res.destroy();
  });
}

function onUpgrade(req, socket, head) {
  stripSbHeaders(req);
  const loopback = isLoopbackAddress(req.socket.remoteAddress);
  if (!hostAllowed(req.headers.host, allowedHosts) || (!loopback && !lanPathAllowed("GET", req.url || "/", dev))) {
    socket.destroy();
    return;
  }
  upgradeHub.emit("upgrade", req, socket, head);
}

const loopbackServer = createServer(onRequest);
loopbackServer.on("upgrade", onUpgrade);
loopbackServer.listen(port, "127.0.0.1", () => {
  console.log(`> SignBridge on http://127.0.0.1:${port} (${dev ? "development" : "production"}), loopback only`);
});

if (lanIp) {
  // A second listener on the LAN address only (not 0.0.0.0), so other interfaces stay closed.
  const lanServer = createServer(onRequest);
  lanServer.on("upgrade", onUpgrade);
  lanServer.listen(port, lanIp, () => {
    console.warn(
      `> Guest URL: http://${lanIp}:${port}/guest  (plain HTTP: use an isolated network, never hotel/guest Wi-Fi)`,
    );
  });
}
