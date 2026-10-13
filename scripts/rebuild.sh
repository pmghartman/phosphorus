#!/bin/bash
# hesperus built and the running container swapped onto the new image,
# shared by run-*.sh, install.sh and reconfig, the one step that can kill its caller
set -uo pipefail

main() {
  local dir; dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  cd "$dir"

  say() { echo "[rebuild] $*"; }
  fail() { echo "[rebuild] ERROR: $*" >&2; exit 1; }

  # shellcheck source=scripts/lib/config.sh
  . "$dir/scripts/lib/config.sh"

  # git tracks no permission bits, .env locked down on every build
  chmod 600 .env
  hesperus_add_missing_sections
  # a migrated host's shares still in its old checkout, moved here, host side only
  if [ ! -f /.dockerenv ] && [ -s .hesperus-migrated-from ]; then
    hesperus_rehome_files "$(cat .hesperus-migrated-from)" || fail "couldn't move [files] dirs out of the old checkout"
  fi
  local profiles=()
  hesperus_is_git_host && profiles+=(git-host)
  hesperus_is_model_host && profiles+=(model-host)
  export COMPOSE_PROFILES; COMPOSE_PROFILES="$(IFS=,; echo "${profiles[*]}")"

  local in_container=0
  [ -f /.dockerenv ] && in_container=1

  local sudo=""
  [ "$(uname -s)" = "Linux" ] && [ "$in_container" = 0 ] && sudo="sudo"

  # compose resolving relative volume paths client-side: the home mounted onto
  # itself at the host's path for the sibling, not /repo
  local repo="${HOST_REPO:-}"
  if [ -z "$repo" ]; then
    if [ "$in_container" = 1 ]; then
      repo="$(docker inspect hesperus \
        --format '{{range .Mounts}}{{if eq .Destination "/repo"}}{{.Source}}{{end}}{{end}}' 2>/dev/null)"
    else
      repo="$dir"
    fi
  fi

  # a Windows bind reported as C:\path by Docker Desktop (no legal mount dest),
  # its VM's drives under /run/desktop/mnt/host, matched by shape not platform
  local windows=0
  case "$repo" in
    [A-Za-z]:*)
      windows=1
      local drive="${repo%%:*}" rest="${repo#*:}"
      repo="/run/desktop/mnt/host/$(printf '%s' "$drive" | tr 'A-Z' 'a-z')${rest//\\//}"
      ;;
    # or already in that form
    /run/desktop/mnt/host/*) windows=1 ;;
  esac
  case "$repo" in
    /*) ;;
    *) fail "can't tell where this home lives on the host ('${repo:-unset}'); set HOST_REPO and retry" ;;
  esac

  # each [files] dir its own mount, written out as a compose override,
  # /files keeping the repo's own share underneath, whatever else is published
  export COMPOSE_FILE="docker-compose.yml"
  export HESPERUS_FILES_DIR; HESPERUS_FILES_DIR="$(hesperus_files_dir)"
  if hesperus_write_files_override "$repo" "$((1 - in_container))"; then
    COMPOSE_FILE="docker-compose.yml:$HESPERUS_FILES_OVERRIDE"
    HESPERUS_FILES_DIR="$dir/files"
    say "publishing $(grep -c ' - "' "$HESPERUS_FILES_OVERRIDE") shares from [files] dir"
  elif [ ! -d "$HESPERUS_FILES_DIR" ]; then
    # else a missing directory created root-owned by docker
    say "[files] dir '$HESPERUS_FILES_DIR' doesn't exist, publishing $dir/files instead"
    HESPERUS_FILES_DIR="$dir/files"
  fi
  mkdir -p "$HESPERUS_FILES_DIR"

  # what compose interpolates, dropped by sudo and the siblings, TS_HOSTNAME
  # in a container rebuild.ps1's COMPUTERNAME, else docker-desktop on Windows
  local compose_env=("COMPOSE_PROFILES=$COMPOSE_PROFILES" "HESPERUS_FILES_DIR=$HESPERUS_FILES_DIR" "COMPOSE_FILE=$COMPOSE_FILE" "TS_HOSTNAME=${TS_HOSTNAME:-}")
  # Windows: git data on docker volumes, as rebuild.ps1 has it
  [ "$windows" = 1 ] && compose_env+=("HESPERUS_GIT_DATA=git-data" "HESPERUS_GIT_DB=git-db" "HESPERUS_MODEL_DIR=models")
  # the host's drives for the status tab's disk: Windows' under the VM's
  # mount, Linux's own root, never another Docker Desktop VM's root
  if [ "$windows" = 1 ]; then
    compose_env+=("HESPERUS_HOST_ROOT=/run/desktop/mnt/host")
  elif [ "$($sudo docker info --format '{{.OperatingSystem}}' 2>/dev/null)" != "Docker Desktop" ]; then
    compose_env+=("HESPERUS_HOST_ROOT=/")
  fi

  # the release's images pulled, nothing stopped, run here for a real exit
  # code and visible failures
  say "pulling hesperus $(hesperus_version)..."
  hesperus_pull_images "$sudo docker" || fail "pull failed, still running the previous version"

  # nvidia gpus handed in wherever a probe off the new image gets them
  if $sudo docker run --rm --gpus all --network none --entrypoint true hesperus:latest >/dev/null 2>&1; then
    COMPOSE_FILE="$COMPOSE_FILE:docker-compose.gpu.yml"
    compose_env=("${compose_env[@]/#COMPOSE_FILE=*/COMPOSE_FILE=$COMPOSE_FILE}")
    say "handing the nvidia gpu to hesperus"
  fi
  local e compose_flags=()
  for e in "${compose_env[@]}"; do compose_flags+=(-e "$e"); done

  # no longer a git host: skipped by compose as a disabled profile, still
  # running (and voting) otherwise, a clean stop for a master's hand-off
  if ! hesperus_is_git_host \
     && [ -n "$($sudo docker ps -aq -f name=^hesperus-git$)" ]; then
    say "no longer a git host, removing hesperus-git"
    $sudo docker stop -t 30 hesperus-git >/dev/null 2>&1
    $sudo docker rm hesperus-git >/dev/null 2>&1
  fi
  # likewise the search, model hosts' alone
  if ! hesperus_is_model_host && [ -n "$($sudo docker ps -aq -f name=^hesperus-search$)" ]; then
    say "no longer a model host, removing hesperus-search"
    $sudo docker rm -f hesperus-search >/dev/null 2>&1
  fi

  # leftovers of earlier runs, from the new image's sweep.sh, host pids and
  # an unconfined profile for signals to processes outside any container
  $sudo docker run --rm --pid=host --security-opt apparmor=unconfined \
    -v /var/run/docker.sock:/var/run/docker.sock \
    --entrypoint sh hesperus:latest /opt/hesperus/sweep.sh "$repo" 2>/dev/null \
    | while IFS= read -r line; do say "$line"; done
  # Windows: git/data onto the volumes once, as rebuild.ps1 does
  if [ "$windows" = 1 ] && hesperus_is_git_host \
     && { [ -f git/data/GIT_VERSION ] || [ -f git/data/MU_GIT_VERSION ]; } \
     && ! $sudo docker volume inspect hesperus-git-data >/dev/null 2>&1; then
    say "moving git data onto a docker volume..."
    $sudo docker stop -t 30 hesperus-git >/dev/null 2>&1
    if ! $sudo docker run --rm -v "$repo/git/data:/src:ro" -v hesperus-git-data:/data -v hesperus-git-db:/db \
         --entrypoint sh hesperus:latest -c \
         'tar -C /src --exclude=./litefs --exclude=./litefs-internal -cf - . | tar -C /data -xf - && { [ ! -d /src/litefs-internal ] || cp -a /src/litefs-internal/. /db/; }'; then
      $sudo docker volume rm hesperus-git-data hesperus-git-db >/dev/null 2>&1
      $sudo docker start hesperus-git >/dev/null 2>&1
      fail "couldn't copy git/data onto a volume, still running the previous version"
    fi
  fi

  # images earlier swaps replaced, and those the sweep freed, in-use ones
  # never dangling, so never hit
  $sudo docker image prune -f >/dev/null 2>&1

  # nothing running, nothing for the swap to kill, finished here for the
  # caller to wait on
  local running; running="$($sudo docker inspect -f '{{.State.Running}}' hesperus 2>/dev/null)"
  if [ "$running" != "true" ]; then
    say "hesperus isn't running, starting it here"
    $sudo env "${compose_env[@]}" docker compose up -d --remove-orphans || fail "couldn't start hesperus"
    return 0
  fi

  # the swap planned where it'll run: the new image, at host paths (inside
  # hesperus compose sees another project and always plans a recreate)
  local plan rc
  plan="$($sudo docker run --rm "${compose_flags[@]}" \
    -v /var/run/docker.sock:/var/run/docker.sock -v "$repo:$repo" -w "$repo" \
    --entrypoint sh hesperus:latest \
    -c 'command -v docker >/dev/null || exit 127; docker compose up -d --remove-orphans --dry-run' 2>&1)"
  rc=$?
  # an image without the docker CLI: the swap starting fine, then exiting 127 silently
  [ "$rc" = 127 ] && fail "the hesperus image has no docker CLI; finish by hand with 'docker compose up -d'"
  # every container already on its image and config: skip the restart (and git handoff)
  if [ "$rc" = 0 ] && grep -q ' Running' <<<"$plan" && ! grep -v ' Running' <<<"$plan" | grep -q .; then
    say "already up to date, nothing to swap"
    return 0
  fi

  # the git elector told while the frontend is still up, best effort
  $sudo docker exec hesperus sh -c "curl -fsS -m 3 -X POST -H 'Content-Type: application/json' \
    -d '{}' 127.0.0.1:\${FRONTEND_PORT:-8090}/internal/status/updating" >/dev/null 2>&1

  # the swap killing whatever's driving it (a frontend terminal, or the frontend) but
  # not the sibling, left behind (not --rm'd) so `docker logs` records a failure
  say "swapping containers in hesperus-updater, this terminal may drop"
  $sudo docker rm -f hesperus-updater >/dev/null 2>&1
  $sudo docker run -d --name hesperus-updater "${compose_flags[@]}" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$repo:$repo" -w "$repo" \
    --entrypoint sh hesperus:latest \
    -c "docker compose up -d --remove-orphans" >/dev/null \
    || fail "couldn't start hesperus-updater, still running the previous version"

  # `docker run -d` returning once the container starts, a beat waited for an
  # early fall-over, only an exit inside that window cutting it short
  local state=""
  for _ in $(seq 1 25); do
    state="$($sudo docker inspect -f '{{.State.Status}}:{{.State.ExitCode}}' hesperus-updater 2>/dev/null)"
    case "$state" in exited:*) break ;; esac
    sleep 0.2
  done
  case "$state" in
    ''|running:*|exited:0) say "swap under way" ;;
    *) fail "hesperus-updater exited early ($state), see: docker logs hesperus-updater" ;;
  esac
}

main "$@"
exit
