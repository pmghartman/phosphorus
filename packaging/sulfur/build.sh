#!/usr/bin/env bash
# Sulfur's app built here, its version the Phosphorus release's: this OS's own
# packages in out/ (the web client generated first). CI runs the same scripts per OS.
# usage: packaging/sulfur/build.sh [VERSION]
#   VERSION  a Phosphorus version, MAJOR.MINOR; the newest v* tag if left out
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
cd "$ROOT"
VER=${1:-$(git tag --list 'v[0-9]*' --sort=-version:refname | head -n 1 | sed 's/^v//')}
[[ "$VER" =~ ^[0-9]+\.[0-9]+$ ]] || { echo "a version is MAJOR.MINOR, as Phosphorus's: got '$VER'" >&2; exit 1; }
go generate ./internal/web
OUT=$ROOT/out UPD=$ROOT/out/update
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) "$HERE/windows.sh" "$VER" "$OUT" "$UPD" ;;
  Darwin) "$HERE/macos.sh" "$VER" "$OUT" "$UPD" ;;
  *) arch=$(dpkg --print-architecture 2>/dev/null || echo amd64); "$HERE/linux.sh" "$VER" "$arch" "$OUT" "$UPD" ;;
esac
echo "Sulfur $VER: $OUT"
