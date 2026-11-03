#!/usr/bin/env bash
# Starts the v2 Rust gateway in front of v1, so the app can be used and QA'd through v2.
#
#   scripts/v2-run.sh                 # auto-detect v1, port 7420
#   PORT=7421 UPSTREAM=http://127.0.0.1:7317 scripts/v2-run.sh
#   DIST=/path/to/dist scripts/v2-run.sh
#
# Native under v2: /api/session, /api/pane/read, /api/pane/scroll. Everything else, including /ws,
# is proxied to v1 until its contract is matched (see spec/004).
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PORT=${PORT:-7420}
DIST=${DIST:-$ROOT/dist}
UPSTREAM=${UPSTREAM:-}
SOCKET=${SOCKET:-$HOME/.config/herdr/herdr.sock}
STATE=${STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/ovis-v2/state.json}
TOOLCHAIN=${TOOLCHAIN:-+1.96.1}
BIN="$ROOT/crates/ovis-v2/target/release/ovis-v2"

if [ ! -x "$BIN" ] || [ -n "$(find "$ROOT/crates/ovis-v2/src" -name '*.rs' -newer "$BIN" -print -quit)" ]; then
  echo "building the v2 binary..."
  (cd "$ROOT/crates/ovis-v2" && cargo $TOOLCHAIN build --release)
fi

if [ ! -f "$DIST/index.html" ]; then
  echo "dist/ is missing: building the app (bun install + bun run build)..."
  (cd "$ROOT" && bun install --frozen-lockfile && bun run build)
fi

if [ -z "$UPSTREAM" ]; then
  for candidate in 7317 7414 7415 7399; do
    if curl -fsS -m 1 -o /dev/null "http://127.0.0.1:$candidate/" 2>/dev/null; then
      UPSTREAM="http://127.0.0.1:$candidate"
      break
    fi
  done
fi

mkdir -p "$(dirname "$STATE")"
args=(--dist "$DIST" --port "$PORT" --state "$STATE")
if [ -n "$UPSTREAM" ]; then args+=(--upstream "$UPSTREAM"); fi
if [ -f "$SOCKET" ]; then args+=(--herdr-socket "$SOCKET"); fi

echo "v2: http://127.0.0.1:$PORT"
echo "upstream: ${UPSTREAM:-none}; only the native routes answer without one"
echo "state: $STATE"
exec "$BIN" "${args[@]}"
