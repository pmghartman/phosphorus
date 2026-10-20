#!/usr/bin/env bash
# Phosphorus's setup .exe for Windows: the tray, the host binary and the release,
# by NSIS; with a signing key, the feed's signature beside a copy of it
# usage: windows.sh VERSION PAYLOAD_DIR OUT_DIR UPDATE_DIR
# env: FEED_URL and FEED_PUBKEY for the tray's own updates, UPDATE_SIGNING_KEY to sign them
set -euo pipefail
VER=$1 PAYLOAD=$2 OUT=$3 UPD=$4
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
STAGE=$HERE/stage
rm -rf "$STAGE"
mkdir -p "$STAGE" "$OUT" "$UPD"

cd "$ROOT"
# the tray's icon and manifest into its .exe
go run github.com/tc-hib/go-winres@v0.3.3 simply --arch amd64 --out cmd/tray/rsrc --icon cmd/tray/assets/icon.ico \
  --manifest gui --product-name Phosphorus --file-description Phosphorus --file-version "$VER.0.0" --product-version "$VER.0.0"
export GOOS=windows GOARCH=amd64 CGO_ENABLED=0
go build -trimpath -ldflags "-s -w -H windowsgui -X main.appVersion=$VER -X main.feedURL=${FEED_URL:-} -X main.feedPubkey=${FEED_PUBKEY:-}" \
  -o "$STAGE/Phosphorus.exe" ./cmd/tray &
t=$!
go build -trimpath -ldflags "-s -w" -o "$STAGE/phosphorus-host.exe" ./cmd/phosphorus
wait $t
unset GOOS GOARCH
rm -f cmd/tray/rsrc_windows_*.syso

cp -R "$PAYLOAD" "$STAGE/release"
cp LICENSE THIRD_PARTY_LICENSES.txt cmd/tray/assets/icon.ico "$STAGE/"
SETUP=$OUT/phosphorus-$VER-windows-x86_64-setup.exe
# NSIS on the runner's image, else from chocolatey
PATH="$PATH:/c/Program Files (x86)/NSIS"
command -v makensis >/dev/null || choco install nsis -y --no-progress >/dev/null
makensis -V2 -DVERSION="$VER" -DSTAGE="$(cygpath -w "$STAGE")" -DOUTFILE="$(cygpath -w "$SETUP")" "$(cygpath -w "$HERE/installer.nsi")"

if [ -n "${UPDATE_SIGNING_KEY:-}" ] && [ -n "${FEED_PUBKEY:-}" ]; then
  cp "$SETUP" "$UPD/phosphorus-windows-x86_64-setup.exe"
  go run ./cmd/feedsign "$UPD/phosphorus-windows-x86_64-setup.exe"
fi
rm -rf "$STAGE"
