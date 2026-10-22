#!/usr/bin/env bash
# Sulfur's app built here, its version the Phosphorus release's: the web client,
# its server for this machine, then Tauri's bundles. CI does the same per OS.
# usage: packaging/sulfur/build.sh [VERSION] [BUNDLES]
#   VERSION  a Phosphorus version, MAJOR.MINOR; the newest v* tag if left out
#   BUNDLES  Tauri's, as nsis or dmg or deb,appimage; this OS's own if left out
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
cd "$ROOT"
VER=${1:-$(git tag --list 'v[0-9]*' --sort=-version:refname | head -n 1 | sed 's/^v//')}
[[ "$VER" =~ ^[0-9]+\.[0-9]+$ ]] || { echo "a version is MAJOR.MINOR, as Phosphorus's: got '$VER'" >&2; exit 1; }
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) os=windows; triple=x86_64-pc-windows-msvc; exe=.exe; flags="-H windowsgui"; bundles=${2:-nsis} ;;
  Darwin) os=darwin; triple=$(rustc -vV | sed -n 's/^host: //p'); exe=; flags=; bundles=${2:-dmg} ;;
  *) os=linux; triple=$(rustc -vV | sed -n 's/^host: //p'); exe=; flags=; bundles=${2:-deb,appimage} ;;
esac
go generate ./internal/web
mkdir -p "$HERE/src-tauri/binaries"
CGO_ENABLED=0 GOOS=$os go build -trimpath -ldflags "-s -w $flags -X main.version=$VER" -o "$HERE/src-tauri/binaries/sulfur-server-$triple$exe" ./cmd/sulfur
cd "$HERE"
# Tauri's own version semver's three parts: the release's, .0
npx --yes @tauri-apps/cli@2.12.2 build --bundles "$bundles" --config "{\"version\":\"$VER.0\"}" -- --locked
echo "Sulfur $VER: $HERE/src-tauri/target/release/bundle/"
