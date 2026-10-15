#!/bin/bash
# both frontends on fresh state, every endpoint diffed, both stopped after;
# $1 the binary, legacy/frontend's node_modules installed
set -eu
cd "$(dirname "$0")/../.."
bin="$(realpath "${1:-./phosphorus}")"
tmp="$(mktemp -d)"
# the sides as .../dualrun/js and .../dualrun/go, masked alike by the diff
export DUALRUN_DIR="$tmp/dualrun"
mkdir -p "$DUALRUN_DIR"
pids=()
trap 'kill "${pids[@]}" 2>/dev/null; wait; [ -n "${KEEP:-}" ] || rm -rf "$tmp"' EXIT
(source test/dualrun/env.sh js 18090 18091; echo 0.0.0 > "$VERSION_FILE"; cd legacy/frontend && exec node server.js) > "$DUALRUN_DIR/js.log" 2>&1 &
pids+=("$!")
(source test/dualrun/env.sh go 28090 28091; echo 0.0.0 > "$VERSION_FILE"; exec "$bin" serve) > "$DUALRUN_DIR/go.log" 2>&1 &
pids+=("$!")
for port in 18090 28090; do
  for _ in $(seq 1 100); do curl -fs -o /dev/null "http://127.0.0.1:$port/" && break; sleep 0.1; done
done
go run ./test/dualrun
