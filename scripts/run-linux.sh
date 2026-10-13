#!/bin/bash
# first bring-up for a Linux host, safe to re-run
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

say() { echo "[run-linux] $*"; }
fail() { echo "[run-linux] ERROR: $*" >&2; exit 1; }
DOCKER="sudo docker"
. "$DIR/scripts/lib/run-common.sh"

run_preflight "install Docker first (see README)" "install git first (see README)"

# --- native tailscaled conflict check ---------------------------------------
# the container's tailscaled sharing this machine's netns (network_mode: host),
# a native one fighting it for tailscale0/WireGuard
if hesperus_running; then
  say "hesperus is already running, tailscale0 is its own, skipping the native-client check"
elif ip link show tailscale0 >/dev/null 2>&1 || systemctl is-active --quiet tailscaled 2>/dev/null; then
  fail "native tailscaled running, colliding with hesperus's own, disable it first: sudo systemctl disable --now tailscaled"
fi

# --- local SSH server -------------------------------------------------------
# for the frontend's terminals, which log in over ssh
if systemctl is-active --quiet ssh 2>/dev/null || systemctl is-active --quiet sshd 2>/dev/null; then
  say "local SSH server already active, skipping"
else
  say "enabling local SSH server..."
  # installed already (the package's own dependency): enabled only, apt busy under dpkg
  if [ -x /usr/sbin/sshd ]; then
    sudo systemctl enable --now ssh 2>/dev/null || sudo systemctl enable --now sshd
  elif command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update && sudo apt-get install -y openssh-server
    sudo systemctl enable --now ssh
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y openssh-server
    sudo systemctl enable --now sshd
  elif command -v pacman >/dev/null 2>&1; then
    sudo pacman -Sy --noconfirm openssh
    sudo systemctl enable --now sshd
  else
    fail "no supported package manager found (apt/dnf/pacman), install and enable an SSH server manually, then re-run"
  fi
fi

run_bring_up
