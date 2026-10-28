#!/usr/bin/env bash
# Windows' Authenticode signature on each .exe given, timestamped, so SmartScreen and
# Defender know who made it. Signed by Microsoft's Trusted Signing (Artifact Signing) when
# its account is set, else by a .pfx certificate; with neither, left unsigned with a notice
# (WINDOWS_SIGNING_REQUIRED=1 makes that an error)
# usage: winsign.sh FILE...
# env, Trusted Signing: AZURE_SIGNING_ENDPOINT (e.g. https://eus.codesigning.azure.net),
#   AZURE_SIGNING_ACCOUNT, AZURE_SIGNING_PROFILE, and the app registration it signs as:
#   AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET
# env, a certificate: WINDOWS_CERT_PFX (base64 of the .pfx), WINDOWS_CERT_PASSWORD
set -euo pipefail
# Git Bash's tools first, called from NSIS through cmd too
export PATH="/usr/bin:$PATH"
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
# signtool from the newest Windows SDK installed (Trusted Signing needs 10.0.22621.755 or later)
signtool=$(ls -d "/c/Program Files (x86)/Windows Kits/10/bin/"10.*/x64/signtool.exe 2>/dev/null | sort -V | tail -n 1)
[ -n "$signtool" ] || { echo "winsign: no signtool.exe (install the Windows SDK)" >&2; exit 1; }
TS=http://timestamp.acs.microsoft.com
[ "$mode" = pfx ] && TS=${WINDOWS_TIMESTAMP_URL:-http://timestamp.digicert.com}

args=(sign /v /fd SHA256 /tr "$TS" /td SHA256)
if [ "$mode" = azure ]; then
  DLIB_VER=1.0.95
  dlib=$TOOLS/client-$DLIB_VER/bin/x64/Azure.CodeSigning.Dlib.dll
  if [ ! -e "$dlib" ]; then
    curl -fsSL --retry 3 -o "$TOOLS/client.zip" "https://api.nuget.org/v3-flatcontainer/microsoft.trusted.signing.client/$DLIB_VER/microsoft.trusted.signing.client.$DLIB_VER.nupkg"
    mkdir -p "$TOOLS/client-$DLIB_VER" && unzip -q -o "$TOOLS/client.zip" -d "$TOOLS/client-$DLIB_VER"
  fi
  printf '{"Endpoint":"%s","CodeSigningAccountName":"%s","CertificateProfileName":"%s"}\n' \
    "$AZURE_SIGNING_ENDPOINT" "$AZURE_SIGNING_ACCOUNT" "$AZURE_SIGNING_PROFILE" > "$TOOLS/metadata.json"
  args+=(/dlib "$(cygpath -w "$dlib")" /dmdf "$(cygpath -w "$TOOLS/metadata.json")")
else
  pfx=$TOOLS/cert.pfx
  printf '%s' "$WINDOWS_CERT_PFX" | base64 -d > "$pfx"
  trap 'rm -f "$pfx"' EXIT
  args+=(/f "$(cygpath -w "$pfx")" /p "${WINDOWS_CERT_PASSWORD:-}")
fi

for f in "$@"; do
  w=$(cygpath -w "$f")
  # the signing service blips now and then: tried again before failing the release
  for try in 1 2 3; do
    "$signtool" "${args[@]}" "$w" > "$TOOLS/sign.log" 2>&1 && break
    cat "$TOOLS/sign.log" >&2
    [ $try = 3 ] && { echo "winsign: signing $f failed" >&2; exit 1; }
    sleep $((try * 5))
  done
  "$signtool" verify /pa /q "$w" || { echo "winsign: $f's signature doesn't verify" >&2; exit 1; }
  echo "signed $(basename "$f")"
done
