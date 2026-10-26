#!/bin/sh
# the host installers' bundled tools, pinned and checked: tailscale and forgejo on
# Linux (git hosts are Linux only), cloudflared everywhere
# Usage: packaging/tools.sh OS (linux|darwin|windows) ARCH (amd64|arm64|universal) OUTDIR
set -eu
OS=${1:?usage: packaging/tools.sh OS ARCH OUTDIR} ARCH=${2:?ARCH} OUT=${3:?OUTDIR}
TAILSCALE=1.104.1
CLOUDFLARED=2026.10.4
FORGEJO=16.0.6
CF=https://github.com/cloudflare/cloudflared/releases/download/$CLOUDFLARED
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$OUT"
get() { curl -fsSL --retry 3 -o "$1" "$2"; }
check() { s=$( (sha256sum "$1" 2>/dev/null || shasum -a 256 "$1") | cut -d' ' -f1); [ "$s" = "$2" ] || { echo "checksum mismatch: $1 (got $s)" >&2; exit 1; }; }

case $OS in
linux)
    get "$T/ts.tgz" "https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE}_${ARCH}.tgz"
    case $ARCH in
    amd64) check "$T/ts.tgz" 108d1d96ecf410d305571e173516f27038f870919a9b89c914a167c6d33a4528 ;;
    arm64) check "$T/ts.tgz" f60294374967f3dfd8cf57bbbd474d6cfce32d123e3a8ddeab82a87940daa806 ;;
    esac
    tar -xzf "$T/ts.tgz" -C "$T"
    install -m755 "$T/tailscale_${TAILSCALE}_${ARCH}/tailscale" "$T/tailscale_${TAILSCALE}_${ARCH}/tailscaled" "$OUT/"
    get "$OUT/forgejo" "https://codeberg.org/forgejo/forgejo/releases/download/v${FORGEJO}/forgejo-${FORGEJO}-linux-${ARCH}"
    case $ARCH in
    amd64) check "$OUT/forgejo" b90e22c2e5534fd7705d93d81ecea792b00f15cad0ee7bbc3061c65bf9524293 ;;
    arm64) check "$OUT/forgejo" c55ec791a3924097971c65dfd960f02a63efabc3ebcb4bb9a3363c2b5c693206 ;;
    esac
    get "$OUT/cloudflared" "$CF/cloudflared-linux-${ARCH}"
    case $ARCH in
    amd64) check "$OUT/cloudflared" ae5e8add7884b0531d66bbca4570d1de491ff6da51e4ebe7eb160cdf241d9e42 ;;
    arm64) check "$OUT/cloudflared" 2b7203b4fb0ba28a0c1e12f8855ce2c25f76d266a8d5edafac5540b6812acff6 ;;
    esac
    chmod 755 "$OUT/forgejo" "$OUT/cloudflared"
    ;;
darwin)
    # one universal binary out of upstream's two
    get "$T/a.tgz" "$CF/cloudflared-darwin-amd64.tgz"
    check "$T/a.tgz" f11fbef4207d715892331917dafd437f032cf4b7137ed64dea3008338c1c613d
    get "$T/b.tgz" "$CF/cloudflared-darwin-arm64.tgz"
    check "$T/b.tgz" 68b6bc4080ac1330234db2a9002d07f98b000537a1bd531a687b660d4160fa7f
    mkdir -p "$T/a" "$T/b"
    tar -xzf "$T/a.tgz" -C "$T/a" && tar -xzf "$T/b.tgz" -C "$T/b"
    lipo -create -output "$OUT/cloudflared" "$T/a/cloudflared" "$T/b/cloudflared"
    chmod 755 "$OUT/cloudflared"
    ;;
windows)
    get "$OUT/cloudflared.exe" "$CF/cloudflared-windows-amd64.exe"
    check "$OUT/cloudflared.exe" 411b16d40c8d872243efeb52c550053d00af0a8a97fbb32e730fb8aba429eaa8
    ;;
*) echo "unknown OS $OS" >&2; exit 1 ;;
esac
echo "tools for $OS/$ARCH in $OUT: $(ls "$OUT" | tr '\n' ' ')"
