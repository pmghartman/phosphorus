#!/usr/bin/env bash
# Sulfur.app for macOS, universal: its one binary in the bundle; then its .dmg and,
# with a signing key, the feed's signed .app.tar.gz
# usage: macos.sh VERSION OUT_DIR UPDATE_DIR
# env: FEED_URL and FEED_PUBKEY for the app's own updates, UPDATE_SIGNING_KEY to sign them
set -euo pipefail
VER=$1 OUT=$2 UPD=$3
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
WORK=$(mktemp -d)
APP=$WORK/Sulfur.app
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$OUT" "$UPD"
export MACOSX_DEPLOYMENT_TARGET=11.0

# cgo: the window is Cocoa's; each architecture built by clang for it
LD="-s -w -X main.version=$VER -X main.feedURL=${FEED_URL:-} -X main.feedPubkey=${FEED_PUBKEY:-}"
b() { (cd "$ROOT" && GOOS=darwin GOARCH=$1 CGO_ENABLED=1 CC="clang -arch $2" go build -trimpath -ldflags "$LD" -o "$3" ./cmd/sulfur); }
b arm64 arm64 "$WORK/sulfur-arm64" &
b amd64 x86_64 "$WORK/sulfur-amd64" &
for j in $(jobs -p); do wait "$j"; done
lipo -create -output "$APP/Contents/MacOS/Sulfur" "$WORK/sulfur-arm64" "$WORK/sulfur-amd64"

cp "$ROOT/LICENSE" "$ROOT/THIRD_PARTY_LICENSES.txt" "$APP/Contents/Resources/"
cp "$HERE/icons/icon.icns" "$APP/Contents/Resources/icon.icns"
sed "s/@VERSION@/$VER/g" "$HERE/Info.plist" > "$APP/Contents/Info.plist"
# ad hoc: the binary first, then the bundle
codesign --force -s - "$APP/Contents/MacOS/Sulfur"
codesign --force -s - "$APP"

DMG=$WORK/dmg
mkdir -p "$DMG"
cp -R "$APP" "$DMG/"
ln -s /Applications "$DMG/Applications"
# the runners' disk images now and then busy: a few tries
for i in 1 2 3; do
  hdiutil create -volname Sulfur -srcfolder "$DMG" -ov -format UDZO "$OUT/sulfur-$VER-macos-universal.dmg" && break
  [ $i = 3 ] && exit 1
  sleep 5
done

if [ -n "${UPDATE_SIGNING_KEY:-}" ] && [ -n "${FEED_PUBKEY:-}" ]; then
  tar -czf "$UPD/sulfur-macos-universal.app.tar.gz" -C "$WORK" Sulfur.app
  (cd "$ROOT" && go run ./cmd/feedsign "$UPD/sulfur-macos-universal.app.tar.gz")
fi
rm -rf "$WORK"
