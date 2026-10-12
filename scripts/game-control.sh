#!/bin/bash
# forced command for the game-control key (see game-control-setup.sh): a
# game's start/stop line from config/services.export, on the host, bash 3.2-safe
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICES_FILE="$DIR/config/services.export"
LOG_DIR="$DIR/state/game-control"
. "$DIR/scripts/lib/config.sh"

fail() { echo "$*" >&2; exit 1; }

# "<start|stop> <name>", nothing else, the key never reaching a shell
read -r action name extra <<<"${SSH_ORIGINAL_COMMAND:-}"
[ -z "${extra:-}" ] || fail "usage: start|stop <name>"
case "${action:-}" in start|stop) ;; *) fail "usage: start|stop <name>" ;; esac
[[ "${name:-}" =~ ^[a-z0-9][a-z0-9-]*$ ]] || fail "bad game name"

cmd=""
[ "$(ini_get "$SERVICES_FILE" "$name" type)" = game ] && cmd="$(ini_get "$SERVICES_FILE" "$name" "$action")"
[ -n "$cmd" ] || fail "$name has no $action command in services.export"

# output to a file, not the ssh channel a backgrounded server would hold open
mkdir -p "$LOG_DIR"
log="$LOG_DIR/$name.log"
echo "--- $(date '+%F %T') $action: $cmd" >>"$log"
"${SHELL:-/bin/sh}" -lc "$cmd" </dev/null >>"$log" 2>&1
rc=$?
[ "$rc" = 0 ] || { tail -n 5 "$log" >&2; exit "$rc"; }
