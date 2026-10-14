#!/bin/bash
# the frontend's play/stop onto this host: a key in state/game-control/, authorized
# for scripts/game-control.sh only, safe to re-run
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEY_DIR="$DIR/state/game-control"
KEY="$KEY_DIR/id_ed25519"
TAG="phosphorus-game-control"

say() { echo "[game-control] $*"; }

# state/ possibly root's, made by docker's bind mount
if ! mkdir -p "$KEY_DIR" 2>/dev/null || [ ! -w "$KEY_DIR" ]; then
  sudo mkdir -p "$KEY_DIR" && sudo chown "$(id -un)" "$KEY_DIR"
fi
[ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N '' -C "$TAG" -f "$KEY"
id -un > "$KEY_DIR/user"

line="restrict,command=\"/bin/bash '$DIR/scripts/game-control.sh'\" $(cat "$KEY.pub")"
ak="$HOME/.ssh/authorized_keys"
mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
touch "$ak" && chmod 600 "$ak"
if grep -qxF "$line" "$ak"; then
  say "play/stop key already authorized for $(id -un)"
else
  # swaps out a stale line from an older key or checkout path
  { grep -vF "$TAG" "$ak"; echo "$line"; } > "$ak.tmp" && mv "$ak.tmp" "$ak"
  say "authorized the play/stop key for $(id -un), it can only run scripts/game-control.sh"
fi
