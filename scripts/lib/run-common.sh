#!/bin/bash
# shared by run-mac.sh and run-linux.sh, sourced once DIR, say, fail and
# DOCKER ("docker" or "sudo docker") are set

. "$DIR/scripts/lib/config.sh"

# $1: where to get docker on this OS
run_preflight() {
  command -v docker >/dev/null 2>&1 || fail "docker not found, $1"
  [ -f .env ] || fail ".env not found in $DIR, copy .env.example to it and fill it in"
  [ -f config/services.export ] || fail "config/services.export not found in $DIR"
}

phosphorus_running() { [ "$($DOCKER inspect -f '{{.State.Running}}' phosphorus 2>/dev/null)" = "true" ]; }

# the machine's own ram, invisible to the container behind a vm, shown
# by the model tab against what docker gave
record_machine_ram() {
  local gib=$((1024 ** 3)) machine want vm
  if [ "$(uname)" = Darwin ]; then
    machine="$(sysctl -n hw.memsize 2>/dev/null)"
  else
    machine=$(( $(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null || echo 0) * 1024 ))
  fi
  [ "${machine:-0}" -gt 0 ] || return 0
  mkdir -p state
  printf '{"ram":%s}\n' "$machine" > state/machine.json
  [ "$(uname)" = Darwin ] || return 0

  # the whole machine, as run.ps1 gives wsl and the model tab expects, colima's
  # ram fixed when its vm starts, so a hint, not a fix
  want=$(( machine / gib ))
  vm="$($DOCKER info --format '{{.MemTotal}}' 2>/dev/null)"
  if [ "$want" -gt 0 ] && [ -n "$vm" ] && [ "$vm" -gt 0 ] && [ "$(( vm * 10 ))" -lt $(( machine * 9 )) ]; then
    say "docker's vm has $((vm / gib))GB of this machine's ${want}GB, and the mesh model only sees the vm"
    say "for all of it: colima stop && colima start --memory $want (Docker Desktop: Settings > Resources)"
  fi
}

# everything after the OS-specific checks: ssh by name, git-host opt-in and
# the build
run_bring_up() {
  record_machine_ram

  # --- ssh <host> from this host's terminals -------------------------------
  # state/ssh_config the frontend's, one Host per tailnet peer
  local inc=/etc/ssh/ssh_config.d/phosphorus.conf line="Include \"$DIR/state/ssh_config\""
  if [ "$(cat "$inc" 2>/dev/null)" = "$line" ]; then
    say "ssh to hosts by name already set up, skipping"
  else
    say "letting ssh reach hosts by name..."
    sudo mkdir -p /etc/ssh/ssh_config.d
    printf '%s\n' "$line" | sudo tee "$inc" >/dev/null
  fi
  grep -qs 'ssh_config\.d' /etc/ssh/ssh_config \
    || say "/etc/ssh/ssh_config never reads ssh_config.d, add 'Include /etc/ssh/ssh_config.d/*.conf' at its top for ssh <host>"

  # --- phosphorus and phos on PATH ------------------------------------------------
  if [ "$(readlink /usr/local/bin/phosphorus 2>/dev/null)" = "$DIR/scripts/phosphorus" ] \
     && [ "$(readlink /usr/local/bin/phos 2>/dev/null)" = "$DIR/scripts/phosphorus" ]; then
    say "phosphorus already on PATH, skipping"
  else
    say "putting phosphorus and phos on PATH..."
    sudo mkdir -p /usr/local/bin
    sudo ln -sfn "$DIR/scripts/phosphorus" /usr/local/bin/phosphorus
    sudo ln -sfn "$DIR/scripts/phosphorus" /usr/local/bin/phos
  fi

  # --- git-host opt-in ---------------------------------------------------
  if [ -z "$(phosphorus_ini)" ] && [ -t 0 ]; then
    read -rp "make this host a git host (forgejo/litefs)? [y/N] " ans
    local host=false
    [[ "$ans" =~ ^[Yy] ]] && host=true
    printf '[git]\nhost = %s\n' "$host" > config/phosphorus.ini
  fi

  # --- phosphorus container -----------------------------------------------
  # on a live host no swap in this shell: handed by rebuild.sh to a
  # sibling container, an async build with nothing to wait on
  local bootstrap=0
  phosphorus_running || bootstrap=1
  say "building and starting phosphorus..."
  bash "$DIR/scripts/rebuild.sh" || fail "build failed, nothing changed"

  # --- verify the frontend came up inside the container --------------------
  if [ "$bootstrap" = "1" ]; then
    # everything after tailscaled waiting on its login, real time allowed
    say "waiting for the frontend..."
    local up=0
    for _ in $(seq 1 200); do
      $DOCKER compose exec -T phosphorus curl -s -o /dev/null "http://127.0.0.1:8090/" && { up=1; break; }
      sleep 0.3
    done
    [ "$up" = "1" ] || fail "the frontend never came up, check: docker compose logs -f"
    say "the frontend is up"
  else
    say "rebuilding in phosphorus-updater, docker logs -f phosphorus-updater to follow"
  fi

  say "done. 'docker compose logs -f' to watch phosphorus come up."
}
