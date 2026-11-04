#!/usr/bin/env bash
# Windows' Authenticode signature on each .exe given, timestamped, so SmartScreen and
# Defender know who made it; on Linux. Signed by Microsoft's Trusted Signing (Artifact
# Signing) through jsign when its account is set, else by a .pfx certificate through
# osslsigncode; with neither, left unsigned with a notice (WINDOWS_SIGNING_REQUIRED=1 an error)
# usage: winsign.sh FILE...
# env, Trusted Signing: AZURE_SIGNING_ENDPOINT (e.g. https://eus.codesigning.azure.net),
#   AZURE_SIGNING_ACCOUNT, AZURE_SIGNING_PROFILE, and the app registration it signs as:
#   AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET
# env, a certificate: WINDOWS_CERT_PFX (base64 of the .pfx), WINDOWS_CERT_PASSWORD
set -euo pipefail
[ $# -gt 0 ] || { echo "usage: winsign.sh FILE..." >&2; exit 2; }

mode=
if [ -n "${AZURE_SIGNING_ENDPOINT:-}" ] && [ -n "${AZURE_SIGNING_ACCOUNT:-}" ] && [ -n "${AZURE_SIGNING_PROFILE:-}" ]; then mode=azure
elif [ -n "${WINDOWS_CERT_PFX:-}" ]; then mode=pfx
fi
if [ -z "$mode" ]; then
  msg="not code-signed (no Trusted Signing account or certificate set): $*"
  [ "${WINDOWS_SIGNING_REQUIRED:-}" = 1 ] && { echo "::error::$msg" >&2; exit 1; }
  echo "::notice::$msg" >&2
  exit 0
fi

# the tools kept between calls: one release signs several files
TOOLS=${RUNNER_TEMP:-${TMPDIR:-/tmp}}/winsign
mkdir -p "$TOOLS"

if [ "$mode" = azure ]; then
  JSIGN_VER=6.0
  jar=$TOOLS/jsign-$JSIGN_VER.jar
  [ -e "$jar" ] || curl -fsSL --retry 3 -o "$jar" "https://github.com/ebourg/jsign/releases/download/$JSIGN_VER/jsign-$JSIGN_VER.jar"
  # the app registration's token for the signing service
  token=$(curl -fsS --retry 3 "https://login.microsoftonline.com/$AZURE_TENANT_ID/oauth2/v2.0/token" \
    --data-urlencode grant_type=client_credentials --data-urlencode "client_id=$AZURE_CLIENT_ID" \
    --data-urlencode "client_secret=$AZURE_CLIENT_SECRET" --data-urlencode scope=https://codesigning.azure.net/.default |
    sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
  [ -n "$token" ] || { echo "winsign: no token from Azure" >&2; exit 1; }
  sign() {
    java -jar "$jar" --storetype TRUSTEDSIGNING --keystore "${AZURE_SIGNING_ENDPOINT#https://}" \
      --storepass "$token" --alias "$AZURE_SIGNING_ACCOUNT/$AZURE_SIGNING_PROFILE" \
      --tsaurl http://timestamp.acs.microsoft.com --tsmode RFC3161 --alg SHA-256 "$1"
  }
else
  pfx=$TOOLS/cert.pfx
  printf '%s' "$WINDOWS_CERT_PFX" | base64 -d > "$pfx"
  trap 'rm -f "$pfx"' EXIT
  sign() {
    osslsigncode sign -pkcs12 "$pfx" -pass "${WINDOWS_CERT_PASSWORD:-}" -h sha256 -n Phosphorus \
      -ts "${WINDOWS_TIMESTAMP_URL:-http://timestamp.digicert.com}" -in "$1" -out "$1.signed" && mv "$1.signed" "$1"
  }
fi

for f in "$@"; do
  # the signing service blips now and then: tried again before failing the release
  for try in 1 2 3; do
    sign "$f" > "$TOOLS/sign.log" 2>&1 && break
    cat "$TOOLS/sign.log" >&2
    [ $try = 3 ] && { echo "winsign: signing $f failed" >&2; exit 1; }
    sleep $((try * 5))
  done
  osslsigncode verify -in "$f" -CAfile /etc/ssl/certs/ca-certificates.crt > "$TOOLS/verify.log" 2>&1 ||
    { cat "$TOOLS/verify.log" >&2; echo "winsign: $f's signature doesn't verify" >&2; exit 1; }
  echo "signed $(basename "$f")"
done
