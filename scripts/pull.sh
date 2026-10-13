#!/bin/bash
# a checkout's update: github's main pulled, per-host files kept, then rebuild.sh,
# from a host terminal or inside hesperus
set -uo pipefail

# inside main(): the reset rewrites this file mid-run
main() {
  local dir; dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  cd "$dir"

  say() { echo "[pull] $*"; }
  fail() { echo "[pull] ERROR: $*" >&2; exit 1; }

  [ -e .git ] || fail "$dir is an install, not a checkout: hesperus update"
  local upstream="https://github.com/pmghartman/hesperus.git"
  [ "$(git remote get-url origin 2>/dev/null)" = "$upstream" ] || git remote set-url origin "$upstream" 2>/dev/null \
    || git remote add origin "$upstream"

  say "fetching $upstream..."
  local tries=0
  until git fetch -q origin main; do
    tries=$((tries + 1))
    [ "$tries" -lt 24 ] || fail "couldn't fetch github, nothing changed"
    sleep 5
  done

  local before; before="$(git rev-parse HEAD)"
  # per-host files saved around the reset, skip-worktree off for it
  local keep=() f saved i reset=1
  for f in .env config/services.export config/hesperus.ini; do
    [ -f "$f" ] || continue
    saved="$(mktemp)"
    cp -p "$f" "$saved" || fail "couldn't back up $f, nothing changed"
    git update-index --no-skip-worktree "$f" 2>/dev/null
    keep+=("$f" "$saved")
  done
  git reset -q --hard origin/main || reset=0
  for ((i = 0; i < ${#keep[@]}; i += 2)); do
    cp -p "${keep[i+1]}" "${keep[i]}" && rm -f "${keep[i+1]}"
    [ "${keep[i]}" = .env ] || git update-index --skip-worktree "${keep[i]}" 2>/dev/null
  done
  [ "$reset" = 1 ] || fail "couldn't reset to origin/main, nothing changed"
  [ "$(git rev-parse HEAD)" = "$before" ] && say "already on github's main"

  say "rebuilding onto $(tr -d '[:space:]' < VERSION).$(git rev-list --count HEAD)"
  bash "$dir/scripts/rebuild.sh" || fail "rebuild failed, still running the previous version"
}

main "$@"
exit
