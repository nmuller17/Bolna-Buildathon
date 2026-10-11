// SignBridge custom server: the app listens on this laptop only (red-team fixes B1, B3, B4, B7, B8).
//
//   npm run dev                      -> http://localhost:3000 (development), 127.0.0.1 only
//   npm run build && npm run start   -> the same in production mode
//   (flag: --production = NODE_ENV=production; cross-platform, no shell env syntax)
//
// Plain `next dev` / `next start` bind every network interface and skip the checks below, so the
// routes that call paid vendors (/api/english, /api/tts) refuse to work without this server (403).
//
// Before Next sees a request this server:
//   1. deletes every client-sent x-sb-* header, and the forwarding headers (X-Forwarded-*, Forwarded,
//      X-Real-IP), so Next fills X-Forwarded-For from the real socket;
//   2. answers 403 unless the Host header is localhost/127.0.0.1/[::1]:PORT, which blocks DNS rebinding;
//   3. answers 403 to any socket that is not on this machine (defence in depth: it only listens on 127.0.0.1);
//   4. answers 413 when Content-Length exceeds 8 KB (5 MB for /api/transcribe);
//   5. passes x-sb-loopback and x-sb-proof (a per-start random secret) to the route guard (lib/app/guard.ts).
// It never logs URLs, headers or bodies.
//
// Environment: PORT (3000), NODE_ENV=production for `start`.
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import next from "next";
import {
  allowedHostsFor,
  BODY_CAP_AUDIO,
  BODY_CAP_DEFAULT,
  hostAllowed,
  isLoopbackAddress,
  securityHeaders,
} from "./lib/app/access.ts";

if (process.argv.includes("--production")) process.env.NODE_ENV = "production";
process.env.NEXT_TELEMETRY_DISABLED = "1";
const dev = process.env.NODE_ENV !== "production";
const port = Number.parseInt(process.env.PORT || "3000", 10);

// Set before next() is created so the route guard sees them.
process.env.SB_PROOF = randomBytes(32).toString("base64url");
const allowedHosts = allowedHostsFor(port);
process.env.SB_ALLOWED_HOSTS = allowedHosts.join(",");

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

const STRIPPED = /^(x-sb-|x-forwarded-|forwarded$|x-real-ip$)/;

function stripClientHeaders(req) {
  for (const name of Object.keys(req.headers)) if (STRIPPED.test(name)) delete req.headers[name];
  const raw = req.rawHeaders;
  for (let i = raw.length - 2; i >= 0; i -= 2) if (STRIPPED.test(raw[i].toLowerCase())) raw.splice(i, 2);
}

/** Returns [status, error] when the request must be refused, or null. */
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
// and forward only upgrades that pass the same Host and socket checks.
const upgradeHub = new EventEmitter();
const app = next({ dev, hostname: "127.0.0.1", port, httpServer: upgradeHub });
const handle = app.getRequestHandler();
await app.prepare();

function onRequest(req, res) {
  stripClientHeaders(req);
  const refused = check(req);
  if (refused) return deny(res, refused[0], refused[1]);
  req.headers["x-sb-loopback"] = "1";
  req.headers["x-sb-proof"] = process.env.SB_PROOF;
  handle(req, res).catch(() => {
    if (!res.headersSent) deny(res, 500, "internal error");
    else res.destroy();
  });
}

function onUpgrade(req, socket, head) {
  stripClientHeaders(req);
  if (!hostAllowed(req.headers.host, allowedHosts) || !isLoopbackAddress(req.socket.remoteAddress)) {
    socket.destroy();
    return;
  }
  upgradeHub.emit("upgrade", req, socket, head);
}

const server = createServer(onRequest);
server.on("upgrade", onUpgrade);
server.listen(port, "127.0.0.1", () => {
  console.log(`> SignBridge on http://localhost:${port} (${dev ? "development" : "production"}), this laptop only`);
});
