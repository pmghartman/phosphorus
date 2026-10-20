#!/usr/bin/env bash
# Phosphorus.app for macOS, universal: the tray and the host binary, the release
# beside them; then its .dmg and, with a signing key, the feed's signed .app.tar.gz
# usage: macos.sh VERSION PAYLOAD_DIR OUT_DIR UPDATE_DIR
# env: FEED_URL and FEED_PUBKEY for the tray's own updates, UPDATE_SIGNING_KEY(_PASSWORD) to sign them
set -euo pipefail
VER=$1 PAYLOAD=$2 OUT=$3 UPD=$4
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
WORK=$(mktemp -d)
APP=$WORK/Phosphorus.app
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$OUT" "$UPD"
export MACOSX_DEPLOYMENT_TARGET=12.0

b() { (cd "$ROOT" && GOOS=darwin GOARCH=$1 CGO_ENABLED=$2 CC="clang -arch $3" go build -trimpath -ldflags "-s -w $4" -o "$5" "$6"); }
TRAY_LD="-X main.appVersion=$VER -X main.feedURL=${FEED_URL:-} -X main.feedPubkey=${FEED_PUBKEY:-}"
b arm64 1 arm64 "$TRAY_LD" "$WORK/tray-arm64" ./cmd/tray &
b amd64 1 x86_64 "$TRAY_LD" "$WORK/tray-amd64" ./cmd/tray &
b arm64 0 arm64 "" "$WORK/host-arm64" ./cmd/phosphorus &
b amd64 0 x86_64 "" "$WORK/host-amd64" ./cmd/phosphorus &
for j in $(jobs -p); do wait "$j"; done
lipo -create -output "$APP/Contents/MacOS/Phosphorus" "$WORK/tray-arm64" "$WORK/tray-amd64"
lipo -create -output "$APP/Contents/MacOS/phosphorus-host" "$WORK/host-arm64" "$WORK/host-amd64"

# not "phosphorus": beside the Phosphorus binary on a case-insensitive disk
cp -R "$PAYLOAD" "$APP/Contents/Resources/release"
cp "$ROOT/LICENSE" "$ROOT/THIRD_PARTY_LICENSES.txt" "$APP/Contents/Resources/"
cp "$ROOT/packaging/icons/icon.icns" "$APP/Contents/Resources/icon.icns"
sed "s/@VERSION@/$VER/g" "$HERE/Info.plist" > "$APP/Contents/Info.plist"
# ad hoc: the binaries inside first, then the bundle
codesign --force -s - "$APP/Contents/MacOS/phosphorus-host"
codesign --force -s - "$APP/Contents/MacOS/Phosphorus"
codesign --force -s - "$APP"

DMG=$WORK/dmg
mkdir -p "$DMG"
cp -R "$APP" "$DMG/"
ln -s /Applications "$DMG/Applications"
# the runners' disk images now and then busy: a few tries
for i in 1 2 3; do
  hdiutil create -volname Phosphorus -srcfolder "$DMG" -ov -format UDZO "$OUT/phosphorus-$VER-macos-universal.dmg" && break
  [ $i = 3 ] && exit 1
  sleep 5
done

if [ -n "${UPDATE_SIGNING_KEY:-}" ] && [ -n "${FEED_PUBKEY:-}" ]; then
  tar -czf "$UPD/phosphorus-macos-universal.app.tar.gz" -C "$WORK" Phosphorus.app
  (cd "$ROOT" && go run ./cmd/feedsign "$UPD/phosphorus-macos-universal.app.tar.gz")
fi
rm -rf "$WORK"
