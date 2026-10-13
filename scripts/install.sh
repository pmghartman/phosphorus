#!/bin/bash
# release files into this host's home, per-host ones kept, then bring-up or the rebuild
# usage: install.sh [--update] [--from OLD_CHECKOUT], by the package only
set -uo pipefail

main() {
  local payload; payload="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  local mode=install from="" migrated=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --update) mode=update ;;
      --from) from="${2:-}"; shift ;;
      *) echo "usage: install.sh [--update] [--from OLD_CHECKOUT]" >&2; exit 2 ;;
    esac
    shift
  done

  say() { echo "[install] $*"; }
  fail() { echo "[install] ERROR: $*" >&2; exit 1; }

  local home="${HESPERUS_HOME:-}"
  if [ -z "$home" ]; then
    case "$(uname)" in
      Darwin) home="$HOME/Library/Hesperus" ;;
      *) home=/var/lib/hesperus ;;
    esac
  fi
  [ -e "$payload/.git" ] && fail "$payload is a checkout, run scripts/run-linux.sh or run-mac.sh there"
  [ "$payload" = "$home" ] && fail "run the package's copy, not $home's"
  mkdir -p "$home" || fail "can't create $home"

  # macOS: colima's vm down after a reboot until started
  if [ "$(uname)" = Darwin ] && ! docker info >/dev/null 2>&1 && command -v colima >/dev/null 2>&1; then
    say "starting colima..."
    colima start || fail "colima didn't start"
  fi

  sync_payload "$payload" "$home" || fail "couldn't copy the release into $home"
  # app resources carry no exec bits
  chmod +x "$home/scripts/hesperus" "$home"/scripts/*.sh 2>/dev/null
  local version; version="$(tr -d '[:space:]' < "$home/VERSION")"
  say "hesperus $version in $home"

  # an earlier checkout's host carried over once, before anything starts
  if [ ! -f "$home/.env" ]; then
    [ -n "$from" ] || from="$(old_checkout "$home")"
    if [ -n "$from" ]; then
      migrated=1
      bash "$home/scripts/migrate.sh" "$from" "$home" || fail "migration from $from failed, it's still there as it was"
    fi
  fi
  if [ ! -f "$home/.env" ]; then
    cp "$home/.env.example" "$home/.env" && chmod 600 "$home/.env"
  fi
  if grep -qx 'BASE_DOMAIN=example.com' "$home/.env" || grep -qx 'BASE_DOMAIN=' "$home/.env"; then
    say "fill in $home/.env, then: hesperus start"
    printf '%s\n' "$version" > "$home/.hesperus-installed"
    exit 0
  fi

  cd "$home" || exit 1
  # a failed first bring-up after a migration: the old install back up, still reachable
  [ -n "$migrated" ] && trap 'rollback "$home"' EXIT
  if [ "$mode" = update ]; then
    bash scripts/rebuild.sh || fail "rebuild failed, still running the previous version"
  else
    case "$(uname)" in
      Darwin) bash scripts/run-mac.sh ;;
      *) bash scripts/run-linux.sh ;;
    esac || fail "bring-up failed, see above"
  fi
  trap - EXIT
  printf '%s\n' "$version" > "$home/.hesperus-installed"
}

# new containers stopped, the old ones restarted, .env set aside so a rerun migrates again
rollback() {
  local docker=docker c
  docker info >/dev/null 2>&1 || docker="sudo docker"
  say "rolling back to the old install"
  for c in hesperus-git hesperus hesperus-search hesperus-updater; do
    $docker rm -f "$c" >/dev/null 2>&1
  done
  # git last, after its frontend
  for c in $(awk '{a[NR]=$0} END {for (i = NR; i; i--) print a[i]}' "$1/.hesperus-migrated-containers" 2>/dev/null); do
    $docker update --restart=unless-stopped "$c" >/dev/null 2>&1 && $docker start "$c" >/dev/null 2>&1 \
      && say "restarted $c"
  done
  mv "$1/.env" "$1/.env.failed-$(date +%s)" 2>/dev/null
  rm -f "$1/.hesperus-migrated-containers"
  say "old install running again; fix the error above and rerun the installer"
}

# every release file into $2, what the last one shipped and this one doesn't
# removed, this host's config and share never overwritten
sync_payload() {
  local src="$1" dst="$2" f
  local manifest="$dst/.hesperus-manifest" next; next="$(mktemp)"
  (cd "$src" && find . -type f ! -name '.hesperus-*' | sed 's|^\./||' | LC_ALL=C sort) > "$next" || return 1
  while IFS= read -r f; do
    case "$f" in
      config/services.export|config/hesperus.ini|files/*) [ -e "$dst/$f" ] && continue ;;
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

# any earlier checkout's /repo (phosphorus, git-era hesperus), from its container
old_checkout() {
  local docker=docker c src
  docker info >/dev/null 2>&1 || docker="sudo docker"
  for c in $($docker ps -a --format '{{.Names}}' 2>/dev/null); do
    src="$($docker inspect "$c" --format '{{range .Mounts}}{{if eq .Destination "/repo"}}{{.Source}}{{end}}{{end}}' 2>/dev/null)"
    [ -n "$src" ] && [ "$src" != "$1" ] && [ -f "$src/.env" ] && { printf '%s' "$src"; return; }
  done
}

main "$@"
exit
