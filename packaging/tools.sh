#!/bin/sh
# the host installers' bundled tools, pinned and checked: tailscale and forgejo on
# Linux (git hosts are Linux only), cloudflared everywhere; OS source: forgejo's
# source tarball, attached to releases shipping its binary (GPL-3.0)
# Usage: packaging/tools.sh OS (linux|darwin|windows|source) ARCH (amd64|arm64|universal|any) OUTDIR
set -eu
OS=${1:?usage: packaging/tools.sh OS ARCH OUTDIR} ARCH=${2:?ARCH} OUT=${3:?OUTDIR}
TAILSCALE=1.104.1
CLOUDFLARED=2026.9.3
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
    check "$OUT/cloudflared.exe" f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2
    ;;
source)
    get "$OUT/forgejo-src-${FORGEJO}.tar.gz" "https://codeberg.org/forgejo/forgejo/releases/download/v${FORGEJO}/forgejo-src-${FORGEJO}.tar.gz"
    check "$OUT/forgejo-src-${FORGEJO}.tar.gz" 0fe93c0bc4e1006ec3aa7d65be51181cc02efe4974c4237bb23723d954ffa630
    ;;
*) echo "unknown OS $OS" >&2; exit 1 ;;
esac
echo "tools for $OS/$ARCH in $OUT: $(ls "$OUT" | tr '\n' ' ')"
