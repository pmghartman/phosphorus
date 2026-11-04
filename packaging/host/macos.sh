#!/usr/bin/env bash
# Phosphorus.app for macOS on Apple silicon: the one binary, host and tray, as the
# bundle's Phosphorus, the release beside it; then its .dmg and, with a signing key,
# the feed's signed .app.tar.gz
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

# the bundle's executable: opened as the app it runs the tray, called by it the host's commands
(cd "$ROOT" && bun scripts/build.ts darwin-arm64 "$WORK/bin" "$VER")
cp "$WORK/bin/phosphorus-host" "$APP/Contents/MacOS/Phosphorus"
# not "phosphorus": beside the Phosphorus binary on a case-insensitive disk
cp -R "$PAYLOAD" "$APP/Contents/Resources/release"
cp "$ROOT/packaging/icons/icon.icns" "$APP/Contents/Resources/icon.icns"
sed "s/@VERSION@/$VER/g" "$HERE/Info.plist" > "$APP/Contents/Info.plist"
# ad hoc: the binary inside first, then the bundle
codesign --force -s - "$APP/Contents/MacOS/Phosphorus"
codesign --force -s - "$APP"

DMG=$WORK/dmg
mkdir -p "$DMG"
cp -R "$APP" "$DMG/"
ln -s /Applications "$DMG/Applications"
# lzfse (ULFO, macOS 10.11+): smaller than zlib's UDZO and several times faster;
# the runners' disk images now and then busy: a few tries
for i in 1 2 3; do
  hdiutil create -volname Phosphorus -srcfolder "$DMG" -ov -format ULFO "$OUT/phosphorus-$VER-macos-arm64.dmg" && break
  [ $i = 3 ] && exit 1
  sleep 5
done

if [ -n "${UPDATE_SIGNING_KEY:-}" ] && [ -n "${FEED_PUBKEY:-}" ]; then
  # gzip at its fastest: the bun binary barely compresses better at the default level
  tar -cf - -C "$WORK" Phosphorus.app | gzip -1 > "$UPD/phosphorus-macos-arm64.app.tar.gz"
  (cd "$ROOT" && bun scripts/feedsign.ts "$UPD/phosphorus-macos-arm64.app.tar.gz")
fi
rm -rf "$WORK"
