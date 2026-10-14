#!/bin/bash
# tailscaled, the frontend, the model daemon and cloudflared, all down with
# the first one out, for Docker's restart policy
set -uo pipefail

: "${BASE_DOMAIN:?BASE_DOMAIN must be set in the env file}"
: "${TUNNEL_TOKEN:?TUNNEL_TOKEN must be set in the env file}"
: "${TS_AUTHKEY:?TS_AUTHKEY must be set in the env file}"

export SERVICES_FILE="${SERVICES_FILE:-/etc/phosphorus/services.export}"
export STATE_DIR="${STATE_DIR:-/state}"
export FRONTEND_PORT="${FRONTEND_PORT:-8090}"
# the tunnel's origin
export INGRESS_PORT="${INGRESS_PORT:-80}"

mkdir -p "$STATE_DIR" /var/lib/tailscale

say() { echo "[supervisor] $*"; }

if [ ! -r "$SERVICES_FILE" ]; then
  say "can't read $SERVICES_FILE, this host will serve other machines' routes"
  say "but publish none of its own. Mount it if that's not intended."
fi

# --- tailscaled --------------------------------------------------------
# real tun device: cap_add NET_ADMIN and /dev/net/tun
tailscaled --state=/var/lib/tailscale/tailscaled.state \
           --socket=/var/run/tailscale/tailscaled.sock \
           >/var/log/tailscaled.log 2>&1 &
PIDS=("$!"); NAMES=("tailscaled")

say "waiting for tailscaled..."
for _ in $(seq 1 150); do
  tailscale --socket=/var/run/tailscale/tailscaled.sock status >/dev/null 2>&1 && break
  sleep 0.2
done

# own var: TS_HOSTNAME left as compose set it, for rebuild.sh to carry along
ts_hostname="${TS_HOSTNAME:-$(hostname)}"
if ! tailscale --socket=/var/run/tailscale/tailscaled.sock up \
       --authkey="$TS_AUTHKEY" --hostname="$ts_hostname" --accept-dns=true; then
  say "couldn't join the tailnet, check TS_AUTHKEY in .env (it must be reusable and unexpired)"
  kill "${PIDS[@]}" 2>/dev/null
  exit 1
fi

TS_DNSNAME="$(tailscale --socket=/var/run/tailscale/tailscaled.sock status --json | jq -r '.Self.DNSName' | sed 's/\.$//')"
say "joined the tailnet as $TS_DNSNAME"

# the one host name for every child, from the tailnet name
export SELF_HOST="$(printf '%s' "${TS_DNSNAME%%.*}" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')"

# the host's sshd, for the frontend's terminals and game play/stop alike
HOST_SSH_HOST="127.0.0.1"
getent hosts host.docker.internal >/dev/null 2>&1 && HOST_SSH_HOST="host.docker.internal"
export HOST_SSH_HOST HOST_SSH_PORT="${HOST_SSH_PORT:-22}"
say "terminals will log in over ssh to ${HOST_SSH_HOST}:${HOST_SSH_PORT}"

# ssh <host> on a Linux host: run-*'s Include, also for in-place updates,
# a throwaway container since only it reaches the host's /etc
if [ "$HOST_SSH_HOST" = "127.0.0.1" ]; then
  state_src="$(docker inspect phosphorus -f '{{range .Mounts}}{{if eq .Destination "/state"}}{{.Source}}{{end}}{{end}}' 2>/dev/null)"
  if [ -n "$state_src" ]; then
    line="Include \"$state_src/ssh_config\""
    docker run --rm --network none --entrypoint sh -v /etc/ssh:/host-ssh phosphorus:latest -c '
      grep -qs "ssh_config\.d" /host-ssh/ssh_config || exit 2
      inc=/host-ssh/ssh_config.d/phosphorus.conf
      [ "$(cat "$inc" 2>/dev/null)" = "$1" ] && exit 0
      mkdir -p /host-ssh/ssh_config.d && printf "%s\n" "$1" > "$inc"' _ "$line" >/dev/null 2>&1
    case $? in
      0) ;;
      2) say "the host's /etc/ssh/ssh_config never reads ssh_config.d, ssh <host> needs 'Include /etc/ssh/ssh_config.d/*.conf' at its top" ;;
      *) say "couldn't add the host's ssh Include, ssh <host> needs a sudo phosphorus start" ;;
    esac
  else
    say "can't find this container's /state on the host, ssh <host> needs a sudo phosphorus start"
  fi
  # phosphorus and phos on the host's PATH, the same way
  repo_src="$(docker inspect phosphorus -f '{{range .Mounts}}{{if eq .Destination "/repo"}}{{.Source}}{{end}}{{end}}' 2>/dev/null)"
  if [ -n "$repo_src" ]; then
    docker run --rm --network none --entrypoint sh -v /usr/local/bin:/host-bin phosphorus:latest -c '
      for l in phosphorus phos; do [ "$(readlink /host-bin/$l)" = "$1" ] || ln -sfn "$1" /host-bin/$l || exit 1; done' _ "$repo_src/scripts/phosphorus" >/dev/null 2>&1 \
      || say "couldn't put phosphorus on the host's PATH; phosphorus needs a sudo phosphorus start"
  fi
fi

node /opt/frontend/server.js &
PIDS+=("$!"); NAMES+=("frontend")

# llama-server on the model host, idle on every other
node /opt/phosphorus/model.js &
PIDS+=("$!"); NAMES+=("model")

# the ingress answering before the tunnel hands it anything
for _ in $(seq 1 100); do
  curl -fsS -o /dev/null "http://127.0.0.1:$INGRESS_PORT/healthz" 2>/dev/null && break
  sleep 0.1
done

say "tunnel: joining the Cloudflare tunnel as a replica"
cloudflared tunnel --no-autoupdate --loglevel warn run --token "$TUNNEL_TOKEN" &
PIDS+=("$!"); NAMES+=("cloudflared")

say "all up: ${NAMES[*]}"

term() {
  say "shutting down"
  kill "${PIDS[@]}" "$REAPER" 2>/dev/null
  wait
  exit 0
}

# the swap's updater, gone once it exits cleanly, a failed one kept for its logs
(
  for _ in $(seq 1 120); do
    s="$(docker inspect -f '{{.State.Status}}:{{.State.ExitCode}}' phosphorus-updater 2>/dev/null)" || exit 0
    case "$s" in
      exited:0) docker rm phosphorus-updater >/dev/null 2>&1; exit 0 ;;
      exited:*) exit 0 ;;
    esac
    sleep 5
  done
) &
REAPER=$!
trap term SIGTERM SIGINT

# gone with the first child out, the restart policy from there, the
# updater's reaper above not one of them
wait -n -p gone "${PIDS[@]}"
name="a component"
for i in "${!NAMES[@]}"; do
  [ "${PIDS[$i]}" = "${gone:-}" ] && name="${NAMES[$i]}"
done
say "$name exited, stopping the rest so this host leaves tunnel rotation"
kill "${PIDS[@]}" "$REAPER" 2>/dev/null
wait
exit 1
