#!/bin/bash
# first bring-up for a macOS host, safe to re-run
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

say() { echo "[run-mac] $*"; }
fail() { echo "[run-mac] ERROR: $*" >&2; exit 1; }
DOCKER="docker"
. "$DIR/scripts/lib/run-common.sh"

run_preflight "install colima and docker first (see README)"

# --- native tailscaled conflict check ---------------------------------------
# the container's tailscaled sharing this machine's network, a native
# Tailscale client fighting it for the TUN/WireGuard port
if phosphorus_running; then
  say "phosphorus is already running, any tailscale here is its own, skipping the native-client check"
elif pgrep -x tailscaled >/dev/null 2>&1 || pgrep -x Tailscale >/dev/null 2>&1 \
   || ifconfig 2>/dev/null | grep -q 'inet 100\.'; then
  fail "native Tailscale client active, colliding with phosphorus's own tailscaled, quit the Tailscale app (or stop tailscaled) first"
fi

# --- local SSH server (Remote Login) ----------------------------------------
# for the frontend's terminals, which log in over ssh
if [ "$(sudo systemsetup -getremotelogin 2>/dev/null)" = "Remote Login: On" ]; then
  say "Remote Login (SSH) already enabled, skipping"
else
  say "enabling Remote Login (SSH)..."
  sudo systemsetup -setremotelogin on
fi

run_bring_up
