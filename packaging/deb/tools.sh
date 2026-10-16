#!/bin/sh
# the host package's bundled tools, pinned and checked: tailscale, cloudflared, forgejo
# Usage: packaging/deb/tools.sh ARCH (amd64|arm64) OUTDIR
set -eu
ARCH=${1:?usage: packaging/deb/tools.sh ARCH OUTDIR} OUT=${2:?usage: packaging/deb/tools.sh ARCH OUTDIR}
TAILSCALE=1.104.1
CLOUDFLARED=2026.9.3
FORGEJO=16.0.5
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$OUT"
get() { curl -fsSL --retry 3 -o "$1" "$2"; }
check() { echo "$2  $1" | sha256sum -c - >/dev/null || { echo "checksum mismatch: $1" >&2; exit 1; }; }

get "$T/ts.tgz" "https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE}_${ARCH}.tgz"
check "$T/ts.tgz" "$(curl -fsSL "https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE}_${ARCH}.tgz.sha256")"
tar -xzf "$T/ts.tgz" -C "$T"
install -m755 "$T/tailscale_${TAILSCALE}_${ARCH}/tailscale" "$T/tailscale_${TAILSCALE}_${ARCH}/tailscaled" "$OUT/"

get "$OUT/forgejo" "https://codeberg.org/forgejo/forgejo/releases/download/v${FORGEJO}/forgejo-${FORGEJO}-linux-${ARCH}"
check "$OUT/forgejo" "$(curl -fsSL "https://codeberg.org/forgejo/forgejo/releases/download/v${FORGEJO}/forgejo-${FORGEJO}-linux-${ARCH}.sha256" | cut -d' ' -f1)"

get "$OUT/cloudflared" "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED}/cloudflared-linux-${ARCH}"
case $ARCH in
amd64) check "$OUT/cloudflared" 77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2 ;;
arm64) check "$OUT/cloudflared" aaeb2d7d0da3614634c7e03ab13487a1522c2e79165ed2929cfe23d5e95b326d ;;
esac
chmod 755 "$OUT/forgejo" "$OUT/cloudflared"
echo "tools: tailscale $TAILSCALE, cloudflared $CLOUDFLARED, forgejo $FORGEJO in $OUT"
