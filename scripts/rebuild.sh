#!/bin/bash
# phosphorus built and the running container swapped onto the new image,
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
  phosphorus_add_missing_sections
  # a migrated host's shares still in its old checkout, moved here, host side only
  if [ ! -f /.dockerenv ] && [ -s .phosphorus-migrated-from ]; then
    phosphorus_rehome_files "$(cat .phosphorus-migrated-from)" || fail "couldn't move [files] dirs out of the old checkout"
  fi
  local profiles=()
  phosphorus_is_git_host && profiles+=(git-host)
  phosphorus_is_model_host && profiles+=(model-host)
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
      repo="$(docker inspect phosphorus \
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
  export PHOSPHORUS_FILES_DIR; PHOSPHORUS_FILES_DIR="$(phosphorus_files_dir)"
  if phosphorus_write_files_override "$repo" "$((1 - in_container))"; then
    COMPOSE_FILE="docker-compose.yml:$PHOSPHORUS_FILES_OVERRIDE"
    PHOSPHORUS_FILES_DIR="$dir/files"
    say "publishing $(grep -c ' - "' "$PHOSPHORUS_FILES_OVERRIDE") shares from [files] dir"
  elif [ ! -d "$PHOSPHORUS_FILES_DIR" ]; then
    # else a missing directory created root-owned by docker
    say "[files] dir '$PHOSPHORUS_FILES_DIR' doesn't exist, publishing $dir/files instead"
    PHOSPHORUS_FILES_DIR="$dir/files"
  fi
  mkdir -p "$PHOSPHORUS_FILES_DIR"
  # in a container: the home's own path as the host sees it, else compose
  # binding /repo/... off the docker VM's disk
  if [ "$in_container" = 1 ]; then
    case "$PHOSPHORUS_FILES_DIR" in
      "$dir") PHOSPHORUS_FILES_DIR="$repo" ;;
      "$dir"/*) PHOSPHORUS_FILES_DIR="$repo/${PHOSPHORUS_FILES_DIR#"$dir"/}" ;;
    esac
  fi

  # what compose interpolates, dropped by sudo and the siblings, TS_HOSTNAME
  # in a container rebuild.ps1's COMPUTERNAME, else docker-desktop on Windows
  local compose_env=("COMPOSE_PROFILES=$COMPOSE_PROFILES" "PHOSPHORUS_FILES_DIR=$PHOSPHORUS_FILES_DIR" "COMPOSE_FILE=$COMPOSE_FILE" "TS_HOSTNAME=${TS_HOSTNAME:-}")
  # Windows: git data on docker volumes, as rebuild.ps1 has it
  [ "$windows" = 1 ] && compose_env+=("PHOSPHORUS_GIT_DATA=git-data" "PHOSPHORUS_GIT_DB=git-db" "PHOSPHORUS_MODEL_DIR=models")
  # the host's drives for the status tab's disk: Windows' under the VM's
  # mount, Linux's own root, never another Docker Desktop VM's root
  if [ "$windows" = 1 ]; then
    compose_env+=("PHOSPHORUS_HOST_ROOT=/run/desktop/mnt/host")
  elif [ "$($sudo docker info --format '{{.OperatingSystem}}' 2>/dev/null)" != "Docker Desktop" ]; then
    compose_env+=("PHOSPHORUS_HOST_ROOT=/")
  fi

  # the release's images pulled, nothing stopped, run here for a real exit
  # code and visible failures
  say "pulling phosphorus $(phosphorus_version)..."
  phosphorus_pull_images "$sudo docker" || fail "pull failed, still running the previous version"

  # nvidia gpus handed in wherever a probe off the new image gets them
  if $sudo docker run --rm --gpus all --network none --entrypoint true phosphorus:latest >/dev/null 2>&1; then
    COMPOSE_FILE="$COMPOSE_FILE:docker-compose.gpu.yml"
    compose_env=("${compose_env[@]/#COMPOSE_FILE=*/COMPOSE_FILE=$COMPOSE_FILE}")
    say "handing the nvidia gpu to phosphorus"
  fi
  local e compose_flags=()
  for e in "${compose_env[@]}"; do compose_flags+=(-e "$e"); done

  # no longer a git host: skipped by compose as a disabled profile, still
  # running (and voting) otherwise, a clean stop for a master's hand-off
  if ! phosphorus_is_git_host \
     && [ -n "$($sudo docker ps -aq -f name=^phosphorus-git$)" ]; then
    say "no longer a git host, removing phosphorus-git"
    $sudo docker stop -t 30 phosphorus-git >/dev/null 2>&1
    $sudo docker rm phosphorus-git >/dev/null 2>&1
  fi
  # likewise the search, model hosts' alone
  if ! phosphorus_is_model_host && [ -n "$($sudo docker ps -aq -f name=^phosphorus-search$)" ]; then
    say "no longer a model host, removing phosphorus-search"
    $sudo docker rm -f phosphorus-search >/dev/null 2>&1
  fi

  # leftovers of earlier runs, from the new image's sweep.sh, host pids and
  # an unconfined profile for signals to processes outside any container
  $sudo docker run --rm --pid=host --security-opt apparmor=unconfined \
    -v /var/run/docker.sock:/var/run/docker.sock \
    --entrypoint sh phosphorus:latest /opt/phosphorus/sweep.sh "$repo" 2>/dev/null \
    | while IFS= read -r line; do say "$line"; done
  # Windows: git/data onto the volumes once, as rebuild.ps1 does
  if [ "$windows" = 1 ] && phosphorus_is_git_host \
     && { [ -f git/data/GIT_VERSION ] || [ -f git/data/MU_GIT_VERSION ]; } \
     && ! $sudo docker volume inspect phosphorus-git-data >/dev/null 2>&1; then
    say "moving git data onto a docker volume..."
    $sudo docker stop -t 30 phosphorus-git >/dev/null 2>&1
    if ! $sudo docker run --rm -v "$repo/git/data:/src:ro" -v phosphorus-git-data:/data -v phosphorus-git-db:/db \
         --entrypoint sh phosphorus:latest -c \
         'tar -C /src --exclude=./litefs --exclude=./litefs-internal -cf - . | tar -C /data -xf - && { [ ! -d /src/litefs-internal ] || cp -a /src/litefs-internal/. /db/; }'; then
      $sudo docker volume rm phosphorus-git-data phosphorus-git-db >/dev/null 2>&1
      $sudo docker start phosphorus-git >/dev/null 2>&1
      fail "couldn't copy git/data onto a volume, still running the previous version"
    fi
  fi

  # images earlier swaps replaced, and those the sweep freed, in-use ones
  # never dangling, so never hit
  $sudo docker image prune -f >/dev/null 2>&1

  # nothing running, nothing for the swap to kill, finished here for the
  # caller to wait on
  local running; running="$($sudo docker inspect -f '{{.State.Running}}' phosphorus 2>/dev/null)"
  if [ "$running" != "true" ]; then
    say "phosphorus isn't running, starting it here"
    $sudo env "${compose_env[@]}" docker compose up -d --remove-orphans || fail "couldn't start phosphorus"
    return 0
  fi

  # the swap planned where it'll run: the new image, at host paths (inside
  # phosphorus compose sees another project and always plans a recreate)
  local plan rc
  plan="$($sudo docker run --rm "${compose_flags[@]}" \
    -v /var/run/docker.sock:/var/run/docker.sock -v "$repo:$repo" -w "$repo" \
    --entrypoint sh phosphorus:latest \
    -c 'command -v docker >/dev/null || exit 127; docker compose up -d --remove-orphans --dry-run' 2>&1)"
  rc=$?
  # an image without the docker CLI: the swap starting fine, then exiting 127 silently
  [ "$rc" = 127 ] && fail "the phosphorus image has no docker CLI; finish by hand with 'docker compose up -d'"
  # every container already on its image and config: skip the restart (and git handoff)
  if [ "$rc" = 0 ] && grep -q ' Running' <<<"$plan" && ! grep -v ' Running' <<<"$plan" | grep -q .; then
    say "already up to date, nothing to swap"
    return 0
  fi

  # the git elector told while the frontend is still up, best effort
  $sudo docker exec phosphorus sh -c "curl -fsS -m 3 -X POST -H 'Content-Type: application/json' \
    -d '{}' 127.0.0.1:\${FRONTEND_PORT:-8090}/internal/status/updating" >/dev/null 2>&1

  # the swap killing whatever's driving it (a frontend terminal, or the frontend) but
  # not the sibling, left behind (not --rm'd) so `docker logs` records a failure
  say "swapping containers in phosphorus-updater, this terminal may drop"
  $sudo docker rm -f phosphorus-updater >/dev/null 2>&1
  $sudo docker run -d --name phosphorus-updater "${compose_flags[@]}" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$repo:$repo" -w "$repo" \
    --entrypoint sh phosphorus:latest \
    -c "docker compose up -d --remove-orphans" >/dev/null \
    || fail "couldn't start phosphorus-updater, still running the previous version"

  # `docker run -d` returning once the container starts, a beat waited for an
  # early fall-over, only an exit inside that window cutting it short
  local state=""
  for _ in $(seq 1 25); do
    state="$($sudo docker inspect -f '{{.State.Status}}:{{.State.ExitCode}}' phosphorus-updater 2>/dev/null)"
    case "$state" in exited:*) break ;; esac
    sleep 0.2
  done
  case "$state" in
    ''|running:*|exited:0) say "swap under way" ;;
    *) fail "phosphorus-updater exited early ($state), see: docker logs phosphorus-updater" ;;
  esac
}

main "$@"
exit
