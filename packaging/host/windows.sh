#!/usr/bin/env bash
# Phosphorus's setup .exe for Windows: the tray, the host binary and the release,
# by NSIS; with a signing key, the feed's signature beside a copy of it
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
# the tray (no console, the icon in its .exe) and the host, both carrying the feed:
# the service updates the app with no one signed in
bun scripts/build.ts windows-x64 "$STAGE" "$VER"

# Authenticode-signed (packaging/winsign.sh), the uninstaller and setup too below, so
# SmartScreen and Defender know who made them
SIGNER=$ROOT/packaging/winsign.sh
"$SIGNER" "$STAGE/Phosphorus.exe" "$STAGE/phosphorus-host.exe"
SIGN=()
if [ -n "${AZURE_SIGNING_ENDPOINT:-}${WINDOWS_CERT_PFX:-}" ]; then SIGN=(-DSIGN="\"$(cygpath -w "$BASH")\" \"$(cygpath -w "$SIGNER")\""); fi

cp -R "$PAYLOAD" "$STAGE/release"
cp LICENSE "$PAYLOAD/THIRD_PARTY_NOTICES.txt" packaging/icons/icon.ico "$STAGE/"
SETUP=$OUT/phosphorus-$VER-windows-x86_64-setup.exe
# NSIS on the runner's image, else from chocolatey
PATH="$PATH:/c/Program Files (x86)/NSIS"
command -v makensis >/dev/null || choco install nsis -y --no-progress >/dev/null
makensis -V2 "${SIGN[@]}" -DVERSION="$VER" -DSTAGE="$(cygpath -w "$STAGE")" -DOUTFILE="$(cygpath -w "$SETUP")" "$(cygpath -w "$HERE/installer.nsi")"
"$SIGNER" "$SETUP"

if [ -n "${UPDATE_SIGNING_KEY:-}" ] && [ -n "${FEED_PUBKEY:-}" ]; then
  cp "$SETUP" "$UPD/phosphorus-windows-x86_64-setup.exe"
  bun scripts/feedsign.ts "$UPD/phosphorus-windows-x86_64-setup.exe"
fi
rm -rf "$STAGE"
