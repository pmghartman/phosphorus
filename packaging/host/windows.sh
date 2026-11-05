#!/usr/bin/env bash
# Phosphorus's setup .exe for Windows, built on Linux: the host binary (the tray in it)
# cross-compiled by bun, the launcher that starts the tray without a console window,
# and the release (afterglow in it when PAYLOAD_DIR/afterglow holds its build), by
# NSIS; with a signing key, the feed's signature beside a copy of it
# usage: windows.sh VERSION PAYLOAD_DIR OUT_DIR UPDATE_DIR
# env: FEED_URL and FEED_PUBKEY for the app's own updates (the tray's, and the
# service's when no one is signed in), UPDATE_SIGNING_KEY to sign them
set -euo pipefail
VER=$1 PAYLOAD=$2 OUT=$3 UPD=$4
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
STAGE=$HERE/stage
rm -rf "$STAGE"
mkdir -p "$STAGE" "$OUT" "$UPD"

cd "$ROOT"
# the host with the tray in it, carrying the feed: the service updates the app with
# no one signed in; cross-compiled, so the .exe keeps bun's icon, the launcher ours
bun scripts/build.ts windows-x64 "$STAGE" "$VER"
cp LICENSE "$PAYLOAD/THIRD_PARTY_NOTICES.txt" packaging/icons/icon.ico "$STAGE/"

# Phosphorus.exe: the launcher, a window-less start of the tray in the host binary
makensis -V2 -DVERSION="$VER" -DSTAGE="$STAGE" -DOUTFILE="$STAGE/Phosphorus.exe" "$HERE/launcher.nsi"

# Authenticode-signed (packaging/winsign.sh), the uninstaller and setup too below, so
# SmartScreen and Defender know who made them
SIGNER=$ROOT/packaging/winsign.sh
"$SIGNER" "$STAGE/Phosphorus.exe" "$STAGE/phosphorus-host.exe"
SIGN=()
if [ -n "${AZURE_SIGNING_ENDPOINT:-}${WINDOWS_CERT_PFX:-}" ]; then SIGN=(-DSIGN="\"$BASH\" \"$SIGNER\""); fi

# afterglow (native/afterglow, built on Windows by .github/workflows/afterglow.yml) in
# the release when the build brought it: signed as ours, its GPL source named beside it
if [ -f "$PAYLOAD/afterglow/afterglow.exe" ]; then
  "$SIGNER" "$PAYLOAD/afterglow/afterglow.exe" "$PAYLOAD/afterglow/tools/afterglowsvc.exe"
  printf '\n\nafterglow (afterglow/): GPL-3.0-only, a fork of Apollo and Sunshine; afterglow/SOURCE.txt names its source\n' >> "$PAYLOAD/THIRD_PARTY_NOTICES.txt"
fi
cp -R "$PAYLOAD" "$STAGE/release"
SETUP=$OUT/phosphorus-$VER-windows-x86_64-setup.exe
makensis -V2 "${SIGN[@]}" -DVERSION="$VER" -DSTAGE="$STAGE" -DOUTFILE="$SETUP" "$HERE/installer.nsi"
"$SIGNER" "$SETUP"

if [ -n "${UPDATE_SIGNING_KEY:-}" ] && [ -n "${FEED_PUBKEY:-}" ]; then
  cp "$SETUP" "$UPD/phosphorus-windows-x86_64-setup.exe"
  bun scripts/feedsign.ts "$UPD/phosphorus-windows-x86_64-setup.exe"
fi
rm -rf "$STAGE"
