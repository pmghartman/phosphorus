#!/usr/bin/env bash
# Sulfur for Linux: a .deb around its one binary, which is dynamic to the system's
# GTK 3 and WebKitGTK 4.1 (libwebkit2gtk-4.1-dev to build). No feed: apt updates it
# usage: linux.sh VERSION ARCH(amd64|arm64) OUT_DIR
# env: FEED_URL and FEED_PUBKEY, set in the binary
set -euo pipefail
VER=$1 ARCH=$2 OUT=$3
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
mkdir -p "$OUT"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

# cgo, so on a runner of its own architecture
cd "$ROOT"
CGO_ENABLED=1 GOOS=linux GOARCH=$ARCH go build -trimpath \
  -ldflags "-s -w -X main.version=$VER -X main.feedURL=${FEED_URL:-} -X main.feedPubkey=${FEED_PUBKEY:-}" \
  -o "$T/sulfur" ./cmd/sulfur

P=$T/pkg
install -Dm755 "$T/sulfur" "$P/usr/bin/sulfur"
install -Dm644 "$HERE/sulfur.desktop" "$P/usr/share/applications/sulfur.desktop"
install -Dm644 "$HERE/icons/icon.png" "$P/usr/share/icons/hicolor/512x512/apps/sulfur.png"
install -Dm644 "$HERE/icon.svg" "$P/usr/share/icons/hicolor/scalable/apps/sulfur.svg"
install -Dm644 LICENSE "$P/usr/share/doc/sulfur/copyright"
install -Dm644 THIRD_PARTY_LICENSES.txt "$P/usr/share/doc/sulfur/THIRD_PARTY_LICENSES.txt"
install -d "$P/DEBIAN"
cat > "$P/DEBIAN/control" <<CTL
Package: sulfur
Version: $VER
Architecture: $ARCH
Maintainer: Phosphorus <https://github.com/pmghartman/phosphorus>
Depends: libgtk-3-0 | libgtk-3-0t64, libwebkit2gtk-4.1-0
Recommends: git, zenity | kdialog, xdg-utils
Installed-Size: $(du -sk --exclude=DEBIAN "$P" | cut -f1)
Section: devel
Priority: optional
Homepage: https://github.com/pmghartman/phosphorus
Description: Sulfur, a code editor
 Sulfur, a code editor in the shape of VS Code: offline on this computer's own
 files, terminals and compilers, or connected to a Phosphorus mesh's machines and agents.
CTL
dpkg-deb --root-owner-group -Zxz --build "$P" "$OUT/sulfur_${VER}_$ARCH.deb" >/dev/null
