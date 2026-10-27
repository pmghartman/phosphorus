#!/usr/bin/env bash
# Phosphorus.app for macOS, universal: the tray and the host binary, the release
# beside them; then its .dmg and, with a signing key, the feed's signed .app.tar.gz
# usage: macos.sh VERSION PAYLOAD_DIR OUT_DIR UPDATE_DIR
# env: FEED_URL and FEED_PUBKEY for the tray's own updates, UPDATE_SIGNING_KEY to sign them
set -euo pipefail
VER=$1 PAYLOAD=$2 OUT=$3 UPD=$4
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
WORK=$(mktemp -d)
APP=$WORK/Phosphorus.app
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$OUT" "$UPD"
export MACOSX_DEPLOYMENT_TARGET=12.0

# the tray and the host compiled by bun per arch, then one universal binary each
(cd "$ROOT" && bun scripts/build.ts darwin-arm64 "$WORK/arm64" "$VER" && bun scripts/build.ts darwin-x64 "$WORK/x64" "$VER")
lipo -create -output "$APP/Contents/MacOS/Phosphorus" "$WORK/arm64/Phosphorus" "$WORK/x64/Phosphorus"
lipo -create -output "$APP/Contents/MacOS/phosphorus-host" "$WORK/arm64/phosphorus-host" "$WORK/x64/phosphorus-host"

# not "phosphorus": beside the Phosphorus binary on a case-insensitive disk
cp -R "$PAYLOAD" "$APP/Contents/Resources/release"
cp "$ROOT/LICENSE" "$PAYLOAD/THIRD_PARTY_NOTICES.txt" "$APP/Contents/Resources/"
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
  (cd "$ROOT" && bun scripts/feedsign.ts "$UPD/phosphorus-macos-universal.app.tar.gz")
fi
rm -rf "$WORK"
