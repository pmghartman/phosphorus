#!/bin/sh
# the host installers' bundled tools, pinned and checked: tailscale and forgejo on
# Linux (git hosts are Linux only), cloudflared everywhere
# Usage: packaging/tools.sh OS (linux|darwin|windows) ARCH (amd64|arm64|universal) OUTDIR
set -eu
OS=${1:?usage: packaging/tools.sh OS ARCH OUTDIR} ARCH=${2:?ARCH} OUT=${3:?OUTDIR}
TAILSCALE=1.104.1
CLOUDFLARED=2026.9.3
FORGEJO=16.0.5
CF=https://github.com/cloudflare/cloudflared/releases/download/$CLOUDFLARED
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$OUT"
get() { curl -fsSL --retry 3 -o "$1" "$2"; }
check() { echo "$2  $1" | sha256sum -c - >/dev/null 2>&1 || echo "$2  $1" | shasum -a 256 -c - >/dev/null || { echo "checksum mismatch: $1" >&2; exit 1; }; }

case $OS in
linux)
    get "$T/ts.tgz" "https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE}_${ARCH}.tgz"
    check "$T/ts.tgz" "$(curl -fsSL "https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE}_${ARCH}.tgz.sha256")"
    tar -xzf "$T/ts.tgz" -C "$T"
    install -m755 "$T/tailscale_${TAILSCALE}_${ARCH}/tailscale" "$T/tailscale_${TAILSCALE}_${ARCH}/tailscaled" "$OUT/"
    get "$OUT/forgejo" "https://codeberg.org/forgejo/forgejo/releases/download/v${FORGEJO}/forgejo-${FORGEJO}-linux-${ARCH}"
    check "$OUT/forgejo" "$(curl -fsSL "https://codeberg.org/forgejo/forgejo/releases/download/v${FORGEJO}/forgejo-${FORGEJO}-linux-${ARCH}.sha256" | cut -d' ' -f1)"
    get "$OUT/cloudflared" "$CF/cloudflared-linux-${ARCH}"
    case $ARCH in
    amd64) check "$OUT/cloudflared" 77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2 ;;
    arm64) check "$OUT/cloudflared" aaeb2d7d0da3614634c7e03ab13487a1522c2e79165ed2929cfe23d5e95b326d ;;
    esac
    chmod 755 "$OUT/forgejo" "$OUT/cloudflared"
    ;;
darwin)
    # one universal binary out of upstream's two
    get "$T/a.tgz" "$CF/cloudflared-darwin-amd64.tgz"
    check "$T/a.tgz" d1155d0837487f261183b15c1eab6c4ebcad9dc49b94675f1524c3564cea3977
    get "$T/b.tgz" "$CF/cloudflared-darwin-arm64.tgz"
    check "$T/b.tgz" 587c2cfb1c230fe36c7fa7727da78be459dae028cabe8c001291999350f07095
    mkdir -p "$T/a" "$T/b"
    tar -xzf "$T/a.tgz" -C "$T/a" && tar -xzf "$T/b.tgz" -C "$T/b"
    lipo -create -output "$OUT/cloudflared" "$T/a/cloudflared" "$T/b/cloudflared"
    chmod 755 "$OUT/cloudflared"
    ;;
windows)
    get "$OUT/cloudflared.exe" "$CF/cloudflared-windows-amd64.exe"
    check "$OUT/cloudflared.exe" e9285e111d44ae76fa084127b458a9cef3017151837c735be1421f02b46f7362
    ;;
*) echo "unknown OS $OS" >&2; exit 1 ;;
esac
echo "tools for $OS/$ARCH in $OUT: $(ls "$OUT" | tr '\n' ' ')"
