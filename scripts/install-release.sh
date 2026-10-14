#!/bin/bash
# a Linux checkout onto the latest release, run on the host as root (the web's
# update, through nsenter): the .deb from github, its installer migrating the checkout
set -uo pipefail

say() { echo "[install-release] $*"; }
fail() { echo "[install-release] ERROR: $*" >&2; exit 1; }

command -v apt-get >/dev/null 2>&1 && command -v dpkg >/dev/null 2>&1 || fail "no apt on this host: install the release by hand"
command -v curl >/dev/null 2>&1 || apt-get install -y -q curl >/dev/null || fail "no curl"
arch="$(dpkg --print-architecture)"
url="https://github.com/pmghartman/phosphorus/releases/download/update/phosphorus_$arch.deb"
deb="$(mktemp -d)/phosphorus_$arch.deb"
say "downloading $url"
curl -fsSL --retry 5 -o "$deb" "$url" || fail "no $arch release at $url"
say "installing, $(dpkg-deb -f "$deb" Version)"
DEBIAN_FRONTEND=noninteractive apt-get install -y -q -o Dpkg::Options::=--force-confold "$deb" || fail "apt-get install failed"
rm -rf "$(dirname "$deb")"
[ -f /var/lib/phosphorus/.phosphorus-installed ] || fail "installed, but phosphorus isn't up: sudo phosphorus start"
say "done"
