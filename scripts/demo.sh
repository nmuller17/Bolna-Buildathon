#!/usr/bin/env bash
# SignBridge one-command demo start (talha/app-shell). Run from anywhere:
#
#   scripts/demo.sh                 # app + live_key recognizer (key mode, the team's demo path)
#   scripts/demo.sh --no-recognizer # app only: typing, quick replies, avatar; guest is told signing is off
#   scripts/demo.sh --camera 1 --port 3000 --no-open
#
# What it does, in order:
#   1. checks Node (>= 22.18) and installs web/node_modules once (npm ci) if missing;
#   2. builds the app once (next build) only when the source is newer than the last build;
#   3. makes a fresh BRIDGE_KEY for this run unless one is set (kept in memory, never written or printed);
#   4. starts the app server in production mode on 127.0.0.1 only (no LAN listener, decision D3);
#   5. starts recognition/live_key.py with --control-port, so the guest screen's Record button drives
#      the desk camera (skipped with a clear message when Python, the model or the landmarker is missing);
#   6. opens the one-time staff link in Chrome on this laptop (--no-open prints it only);
#   7. on Ctrl-C stops everything it started (by PID), and nothing else.
#
# No API keys are needed: without them the staff laptop speaks with its on-device voice and the
# staff types or taps quick replies (the microphone needs OPENAI_API_KEY). Keys, if you have them,
# go in web/.env.local (never committed).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB="$ROOT/web"
PORT=3000
CONTROL_PORT=8766
CAMERA=""
RECOGNIZER=1
OPEN=1
PROFILE="${SB_PROFILE:-stage}"

usage() { sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --camera) CAMERA="$2"; shift 2 ;;
    --control-port) CONTROL_PORT="$2"; shift 2 ;;
    --no-recognizer) RECOGNIZER=0; shift ;;
    --no-open) OPEN=0; shift ;;
    --profile) PROFILE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

say() { printf '\n== %s\n' "$*"; }
die() { printf '\nSTOPPED: %s\n' "$*" >&2; exit 1; }

# ---- 1. Node and dependencies ----
command -v node >/dev/null || die "Node is not installed. Install Node 22.18 or newer (https://nodejs.org)."
NODE_V="$(node -p 'process.versions.node')"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)' \
  || die "Node $NODE_V is too old: the app server needs 22.18 or newer (it runs TypeScript directly)."
if [[ ! -d "$WEB/node_modules/next" ]]; then
  say "Installing the web app's packages (first run only)"
  (cd "$WEB" && npm ci --no-audit --no-fund)
fi

# ---- 2. Build once, only when needed ----
BUILD_ID="$WEB/.next/BUILD_ID"
if [[ ! -f "$BUILD_ID" ]] || [[ -n "$(find "$WEB/app" "$WEB/components" "$WEB/lib" "$WEB/public" "$WEB/next.config.ts" -newer "$BUILD_ID" -print -quit 2>/dev/null)" ]]; then
  say "Building the app (about a minute; only when the code changed)"
  (cd "$WEB" && npx next build) || die "The build failed. Read the error above."
else
  say "Build is up to date"
fi

# ---- 3. Ports and the bridge key ----
port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
port_busy "$PORT" && die "Port $PORT is already in use. Stop the other server, or use --port 3001."
if [[ "$RECOGNIZER" == 1 ]] && port_busy "$CONTROL_PORT"; then
  die "Port $CONTROL_PORT (live_key control) is already in use. Stop the old live_key, or use --control-port."
fi
# A caller may pass its own BRIDGE_KEY (32+ characters, e.g. a test rig); otherwise a fresh one per run.
if [[ -z "${BRIDGE_KEY:-}" || ${#BRIDGE_KEY} -lt 32 ]]; then
  BRIDGE_KEY="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(36).toString("base64url"))')"
fi
export BRIDGE_KEY

PIDS=()
LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/signbridge-demo.XXXXXX")"
cleanup() {
  trap - EXIT INT TERM
  if [[ ${#PIDS[@]} -gt 0 ]]; then
    say "Stopping (PIDs ${PIDS[*]})"
    for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
    sleep 1
    for p in "${PIDS[@]}"; do kill -9 "$p" 2>/dev/null || true; done
  fi
  echo "Logs kept in $LOG_DIR"
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM

# ---- 4. The app server (loopback only) ----
say "Starting the app on http://127.0.0.1:$PORT (profile $PROFILE, loopback only)"
APP_ENV=(SB_PROFILE="$PROFILE" MODE0_GUEST_INPUT=1 PORT="$PORT")
[[ "$RECOGNIZER" == 1 ]] && APP_ENV+=(LIVE_KEY_CONTROL_PORT="$CONTROL_PORT")
(cd "$WEB" && exec env "${APP_ENV[@]}" node server.mjs --production) >"$LOG_DIR/app.log" 2>&1 &
APP_PID=$!
PIDS+=("$APP_PID")
STAFF_LINK=""
for _ in $(seq 1 60); do
  STAFF_LINK="$(grep -o "http://127\.0\.0\.1:$PORT/staff#k=[A-Za-z0-9_-]*" "$LOG_DIR/app.log" | tail -1 || true)"
  [[ -n "$STAFF_LINK" ]] && break
  kill -0 "$APP_PID" 2>/dev/null || { cat "$LOG_DIR/app.log" >&2; die "The app server exited during start (log above)."; }
  sleep 0.5
done
[[ -n "$STAFF_LINK" ]] || die "The app server did not print a staff link within 30 s (log: $LOG_DIR/app.log)."

# ---- 5. The recognizer (live_key, key mode) ----
REC_NOTE="not started (--no-recognizer): the guest screen says signing is not available; typing works."
if [[ "$RECOGNIZER" == 1 ]]; then
  PY="${PYTHON:-}"
  [[ -z "$PY" && -x "$ROOT/.venv/bin/python" ]] && PY="$ROOT/.venv/bin/python"
  [[ -z "$PY" ]] && PY="$(command -v python3 || true)"
  MISSING=""
  [[ -n "$PY" ]] || MISSING="Python 3 (make .venv: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt)"
  [[ -f "$ROOT/recognition/models/model.pt" ]] || MISSING="${MISSING:+$MISSING; }recognition/models/model.pt (the pinned model from Cosme)"
  if [[ ! -f "$ROOT/recognition/models/holistic_landmarker.task" ]]; then
    MISSING="${MISSING:+$MISSING; }recognition/models/holistic_landmarker.task (curl -L -o recognition/models/holistic_landmarker.task https://storage.googleapis.com/mediapipe-models/holistic_landmarker/holistic_landmarker/float16/latest/holistic_landmarker.task)"
  fi
  if [[ -n "$MISSING" ]]; then
    REC_NOTE="NOT started, missing: $MISSING. The app runs; the guest screen says signing is not available."
  else
    REC_ARGS=(-m recognition.live_key --no-preview --control-port "$CONTROL_PORT" --post "http://127.0.0.1:$PORT/api/guest/signs")
    [[ -n "$CAMERA" ]] && REC_ARGS+=(--camera "$CAMERA")
    (cd "$ROOT" && exec "$PY" "${REC_ARGS[@]}") >"$LOG_DIR/live_key.log" 2>&1 &
    REC_PID=$!
    PIDS+=("$REC_PID")
    sleep 4
    if kill -0 "$REC_PID" 2>/dev/null; then
      REC_NOTE="live_key running (PID $REC_PID, control port $CONTROL_PORT${CAMERA:+, camera $CAMERA}). If macOS asks for camera access, allow it for Terminal."
    else
      REC_NOTE="live_key EXITED at start; last lines: $(tail -3 "$LOG_DIR/live_key.log" | tr '\n' ' '). The app keeps running without signing."
    fi
  fi
fi

# ---- 6. Open the staff screen ----
say "Ready"
echo "Recognizer: $REC_NOTE"
echo "Staff screen (one-time link, do not project this terminal):"
echo "  $STAFF_LINK"
echo "Then: Start desk -> New guest -> Open guest window (drag it to the guest display)."
echo "Logs: $LOG_DIR   (app.log, live_key.log)"
if [[ "$OPEN" == 1 ]] && command -v open >/dev/null; then
  if open -Ra "Google Chrome" 2>/dev/null; then open -a "Google Chrome" "$STAFF_LINK"; else open "$STAFF_LINK"; fi
fi
echo "Press Ctrl-C to stop everything this script started."

# ---- 7. Stay up while the app runs ----
while kill -0 "$APP_PID" 2>/dev/null; do sleep 2; done
echo "The app server stopped (log: $LOG_DIR/app.log)."
