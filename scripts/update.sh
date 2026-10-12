#!/bin/bash
# pull, then the rebuild handed to scripts/rebuild.sh, the git repo as the
# distribution mechanism, from a host terminal or inside phosphorus
set -uo pipefail

# all inside main(), called on the last line, since `git reset` rewrites
# this file mid-run
main() {
  local dir; dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  cd "$dir"

  say() { echo "[update] $*"; }
  fail() { echo "[update] ERROR: $*" >&2; exit 1; }

  [ -f config/services.export ] || fail "config/services.export not found, are you running this from inside the phosphorus clone?"

  # --- step 1: the fetch gate, behind the caller's exit code ---

  # the public repo, every host's origin, no credentials needed
  local upstream="https://github.com/pmghartman/phosphorus.git"
  [ "$(git remote get-url origin)" = "$upstream" ] || git remote set-url origin "$upstream"

  say "pulling latest..."
  # origin briefly unreachable, 2 min waited out
  local tries=0
  until git fetch origin; do
    tries=$((tries + 1))
    [ "$tries" -lt 24 ] || fail "couldn't fetch origin, nothing changed"
    say "origin unreachable, retrying in 5s"
    sleep 5
  done

  # .env untracked but a reset off a commit still tracking it deletes it,
  # so saved and put back too
  local env_saved=""
  if [ -f .env ]; then
    env_saved="$(mktemp)"
    cp .env "$env_saved" || fail "couldn't back up .env, nothing changed"
  fi

  # reset ignoring skip-worktree: each per-host file saved, reset with the
  # flag off, then put back
  local keep=() f saved i reset=1
  for f in config/services.export config/phos.ini; do
    [ -f "$f" ] || continue
    saved="$(mktemp)"
    cp "$f" "$saved" || fail "couldn't back up $f, nothing changed"
    git update-index --no-skip-worktree "$f"
    keep+=("$f" "$saved")
  done
  git reset --hard origin/main || reset=0
  for ((i = 0; i < ${#keep[@]}; i += 2)); do
    [ "$reset" = 1 ] && cp "${keep[i+1]}" "${keep[i]}"
    rm -f "${keep[i+1]}"
    git update-index --skip-worktree "${keep[i]}"
  done
  if [ -n "$env_saved" ]; then
    cp "$env_saved" .env && rm -f "$env_saved"
  fi
  [ "$reset" = 1 ] || fail "couldn't reset to origin/main, nothing changed"

  local version; version="$(tr -d '[:space:]' < VERSION)"

  # --- step 2: rebuild and swap ---------------------------------------------

  # main's copy of rebuild.sh, post-reset: reads phos.ini, builds before
  # returning so a failure is real, then swaps, or skips when nothing changed
  say "building and restarting onto $version, a few minutes"
  bash "$dir/scripts/rebuild.sh" || fail "rebuild failed, still running the previous version"
}

main "$@"
exit
