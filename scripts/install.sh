#!/bin/bash
# release files into this host's home, per-host ones kept, then bring-up or the rebuild
# usage: install.sh [--update], by the package only
set -uo pipefail

main() {
  local payload; payload="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  local mode=install
  while [ $# -gt 0 ]; do
    case "$1" in
      --update) mode=update ;;
      *) echo "usage: install.sh [--update]" >&2; exit 2 ;;
    esac
    shift
  done

  say() { echo "[install] $*"; }
  fail() { echo "[install] ERROR: $*" >&2; exit 1; }

  local home="${PHOSPHORUS_HOME:-}"
  if [ -z "$home" ]; then
    case "$(uname)" in
      Darwin) home="$HOME/Library/Phosphorus" ;;
      *) home=/var/lib/phosphorus ;;
    esac
  fi
  [ -e "$payload/.git" ] && fail "$payload is a git clone, not a release: install from the latest release"
  [ "$payload" = "$home" ] && fail "run the package's copy, not $home's"
  mkdir -p "$home" || fail "can't create $home"

  # macOS: colima's vm down after a reboot until started
  if [ "$(uname)" = Darwin ] && ! docker info >/dev/null 2>&1 && command -v colima >/dev/null 2>&1; then
    say "starting colima..."
    colima start || fail "colima didn't start"
  fi

  sync_payload "$payload" "$home" || fail "couldn't copy the release into $home"
  # app resources carry no exec bits
  chmod +x "$home/scripts/phosphorus" "$home"/scripts/*.sh 2>/dev/null
  local version; version="$(tr -d '[:space:]' < "$home/VERSION")"
  say "phosphorus $version in $home"

  if [ ! -f "$home/.env" ]; then
    cp "$home/.env.example" "$home/.env" && chmod 600 "$home/.env"
  fi
  if grep -qx 'BASE_DOMAIN=example.com' "$home/.env" || grep -qx 'BASE_DOMAIN=' "$home/.env"; then
    say "fill in $home/.env, then: phosphorus start"
    printf '%s\n' "$version" > "$home/.phosphorus-installed"
    exit 0
  fi

  cd "$home" || exit 1
  if [ "$mode" = update ]; then
    bash scripts/rebuild.sh || fail "rebuild failed, still running the previous version"
  else
    case "$(uname)" in
      Darwin) bash scripts/run-mac.sh ;;
      *) bash scripts/run-linux.sh ;;
    esac || fail "bring-up failed, see above"
  fi
  printf '%s\n' "$version" > "$home/.phosphorus-installed"
}

# every release file into $2, what the last one shipped and this one doesn't
# removed, this host's config and share never overwritten
sync_payload() {
  local src="$1" dst="$2" f
  local manifest="$dst/.phosphorus-manifest" next; next="$(mktemp)"
  (cd "$src" && find . -type f ! -name '.phosphorus-*' | sed 's|^\./||' | LC_ALL=C sort) > "$next" || return 1
  while IFS= read -r f; do
    case "$f" in
      config/services.export|config/phosphorus.ini|files/*) [ -e "$dst/$f" ] && continue ;;
    esac
    mkdir -p "$dst/$(dirname "$f")" && cp -p "$src/$f" "$dst/$f" || return 1
  done < "$next"
  if [ -f "$manifest" ]; then
    LC_ALL=C comm -23 <(LC_ALL=C sort "$manifest") "$next" | while IFS= read -r f; do
      case "$f" in config/*|files/*) continue ;; esac
      rm -f "$dst/$f"
    done
  fi
  mv "$next" "$manifest"
}

main "$@"
exit
