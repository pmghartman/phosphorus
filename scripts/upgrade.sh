#!/bin/bash
# Linux host's update agent: phosphorus-update.service on state/update-request.json,
# apt to the feed's newest, else the same release rebuilt; result in update-agent.json
set -uo pipefail

HOME_DIR="${PHOSPHORUS_HOME:-/var/lib/phosphorus}"
REQ="$HOME_DIR/state/update-request.json"
OUT="$HOME_DIR/state/update-agent.json"
LIST=/etc/apt/sources.list.d/phosphorus.list

id="$(sed -n 's/.*"id" *: *"\([^"]*\)".*/\1/p' "$REQ" 2>/dev/null | head -1)"
# consumed first, or the path unit fires again
rm -f "$REQ"

report() {
  local tmp="$OUT.tmp"
  printf '{"id":"%s","state":"%s","current":%s,"version":"%s","error":"%s","at":%s}\n' \
    "$id" "$1" "${2:-false}" "${3:-}" "$(printf '%s' "${4:-}" | tr -d '"\\\n' | cut -c1-400)" "$(date +%s%3N)" > "$tmp" \
    && mv "$tmp" "$OUT"
}

apt_phosphorus() {
  # the feed's Origin and Label still hesperus's, free to change
  DEBIAN_FRONTEND=noninteractive apt-get -q -o Dir::Etc::sourcelist=sources.list.d/phosphorus.list \
    -o Dir::Etc::sourceparts=- -o Acquire::AllowReleaseInfoChange::Origin=true \
    -o Acquire::AllowReleaseInfoChange::Label=true "$@"
}

report running
log="$(mktemp)"
trap 'rm -f "$log"' EXIT

if [ ! -f "$LIST" ]; then
  report failed false "" "no update feed ($LIST missing), reinstall from the latest release"
  exit 1
fi
if ! apt_phosphorus update -o APT::Get::List-Cleanup=0 >"$log" 2>&1; then
  report failed false "" "apt-get update failed: $(tail -1 "$log")"
  exit 1
fi
policy="$(apt-cache policy phosphorus)"
have="$(awk '/Installed:/{print $2; exit}' <<<"$policy")"
cand="$(awk '/Candidate:/{print $2; exit}' <<<"$policy")"

if [ -n "$cand" ] && [ "$cand" != "(none)" ] && [ "$cand" != "$have" ]; then
  echo "[upgrade] $have -> $cand"
  # postinst syncs the release and rebuilds
  if apt_phosphorus install -y -o Dpkg::Options::=--force-confold --only-upgrade phosphorus 2>&1 | tee "$log"; then
    report ok false "$cand"
  else
    report failed false "" "$(grep -E 'ERROR|E:' "$log" | tail -1)"
    exit 1
  fi
  exit 0
fi

# newest already: this release's images and config, re-applied
echo "[upgrade] $have is the newest"
if bash /usr/lib/phosphorus/scripts/install.sh --update 2>&1 | tee "$log"; then
  current=false
  grep -q 'already up to date' "$log" && current=true
  report ok "$current" "$have"
else
  report failed false "" "$(grep ERROR "$log" | tail -1)"
  exit 1
fi
