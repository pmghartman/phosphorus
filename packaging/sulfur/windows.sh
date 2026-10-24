#!/usr/bin/env bash
# Sulfur's setup .exe for Windows: its one binary, by NSIS; with a signing key, the
# feed's signature beside a copy of it
# usage: windows.sh VERSION OUT_DIR UPDATE_DIR
# env: FEED_URL and FEED_PUBKEY for the app's own updates, UPDATE_SIGNING_KEY to sign them
set -euo pipefail
VER=$1 OUT=$2 UPD=$3
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
STAGE=$HERE/stage
rm -rf "$STAGE"
mkdir -p "$STAGE" "$OUT" "$UPD"

cd "$ROOT"
# the icon and manifest (DPI awareness) into the .exe
go run github.com/tc-hib/go-winres@v0.3.3 simply --arch amd64 --out cmd/sulfur/rsrc --icon cmd/sulfur/assets/icon.ico \
  --manifest gui --product-name Sulfur --file-description "Sulfur code editor" --copyright "Phosphorus contributors, Apache-2.0" --original-filename Sulfur.exe --file-version "$VER.0.0" --product-version "$VER.0.0"
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath \
  -ldflags "-s -w -H windowsgui -X main.version=$VER -X main.feedURL=${FEED_URL:-} -X main.feedPubkey=${FEED_PUBKEY:-}" \
  -o "$STAGE/Sulfur.exe" ./cmd/sulfur
rm -f cmd/sulfur/rsrc_windows_*.syso

# Authenticode-signed (packaging/winsign.sh), the uninstaller and setup too below, so
# SmartScreen and Defender know who made them
SIGNER=$ROOT/packaging/winsign.sh
"$SIGNER" "$STAGE/Sulfur.exe"
SIGN=()
if [ -n "${AZURE_SIGNING_ENDPOINT:-}${WINDOWS_CERT_PFX:-}" ]; then SIGN=(-DSIGN="\"$(cygpath -w "$BASH")\" \"$(cygpath -w "$SIGNER")\""); fi

cp LICENSE THIRD_PARTY_LICENSES.txt cmd/sulfur/assets/icon.ico "$STAGE/"
SETUP=$OUT/sulfur-$VER-windows-x86_64-setup.exe
# NSIS on the runner's image, else from chocolatey
PATH="$PATH:/c/Program Files (x86)/NSIS"
command -v makensis >/dev/null || choco install nsis -y --no-progress >/dev/null
makensis -V2 "${SIGN[@]}" -DVERSION="$VER" -DSTAGE="$(cygpath -w "$STAGE")" -DOUTFILE="$(cygpath -w "$SETUP")" "$(cygpath -w "$HERE/installer.nsi")"
"$SIGNER" "$SETUP"

if [ -n "${UPDATE_SIGNING_KEY:-}" ] && [ -n "${FEED_PUBKEY:-}" ]; then
  cp "$SETUP" "$UPD/sulfur-windows-x86_64-setup.exe"
  go run ./cmd/feedsign "$UPD/sulfur-windows-x86_64-setup.exe"
fi
rm -rf "$STAGE"
