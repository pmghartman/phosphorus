#!/bin/bash
# a three host mesh in network namespaces, a stand-in tailscale between them:
# alpha and beta the binary, beta the model host, gamma the JS frontend;
# checks peers, users across both, asks and projects passed to the model host,
# and a host dropping. Root, iproute2, jq, node with legacy/frontend's modules.
# $1 the binary
set -u
cd "$(dirname "$0")/../.."
bin="$(realpath "${1:-./phosphorus}")"
here="$(pwd)/test/mesh"
dir="$(mktemp -d)/dualrun"
mkdir -p "$dir/down"
hosts="$dir/hosts"
printf 'alpha 100.64.0.1 linux\nbeta 100.64.0.2 linux\ngamma 100.64.0.3 linux\n' > "$hosts"
pids=()
fails=0

cleanup() {
  kill "${pids[@]}" 2>/dev/null
  wait 2>/dev/null
  for h in alpha beta gamma; do ip netns del "ph-$h" 2>/dev/null; ip link del "ph-$h" 2>/dev/null; done
  ip link del phbr 2>/dev/null
  [ -n "${KEEP:-}" ] && echo "kept $dir" || rm -rf "$(dirname "$dir")"
}
trap cleanup EXIT

ok() { echo "ok   $*"; }
bad() { echo "FAIL $*"; fails=$((fails + 1)); }

# --- the network ----------------------------------------------------------
# what an earlier run left
for h in alpha beta gamma; do ip netns del "ph-$h" 2>/dev/null; ip link del "ph-$h" 2>/dev/null; done
ip link del phbr 2>/dev/null
ip link add phbr type bridge && ip link set phbr up || { echo "can't make a bridge, run as root"; exit 2; }
i=0
for h in alpha beta gamma; do
  i=$((i + 1))
  ip netns add "ph-$h"
  ip link add "ph-$h" type veth peer name eth0 netns "ph-$h"
  ip link set "ph-$h" master phbr up
  ip netns exec "ph-$h" ip addr add "100.64.0.$i/24" dev eth0
  ip netns exec "ph-$h" ip link set eth0 up
  ip netns exec "ph-$h" ip link set lo up
done

# a host's environment, as env.sh with this mesh's names and the stand-in first on PATH
envof() {
  echo "source test/dualrun/env.sh $1 8090 8091; export SELF_HOST=$1 MESH_HOSTS=$hosts MESH_SELF=$1 PATH=$here:\$PATH MODEL_DIR=$dir/$1/models"
}
on() { local h=$1; shift; ip netns exec "ph-$h" bash -c "$(envof "$h"); $*"; }

# --- the model host's tools, fetched here, its namespace offline --------------
mkdir -p "$dir/beta/config" "$dir/beta/state"
printf '[model]\nhost = true\n' > "$dir/beta/config/phosphorus.ini"
(
  DUALRUN_DIR=$dir; eval "$(envof beta)"; unset OPENCODE_BIN
  "$bin" model > "$dir/fetch.log" 2>&1 &
  p=$!
  for _ in $(seq 1 120); do
    [ "$(jq -r '.tools.opencode + .tools.llama' "$STATE_DIR/model-claim.json" 2>/dev/null)" = readyready ] && break
    sleep 1
  done
  kill $p; wait $p 2>/dev/null
)
[ -e "$dir/beta/models/tools" ] && ok "beta's tools fetched" || bad "beta's tools never fetched"

# --- the hosts ----------------------------------------------------------------
export DUALRUN_DIR=$dir
for h in alpha beta gamma; do
  mkdir -p "$dir/$h"
  echo 0.0.0 > "$dir/$h/VERSION"
done
on alpha "exec $bin serve" > "$dir/alpha.log" 2>&1 & pids+=($!)
on beta "unset OPENCODE_BIN; exec $bin serve" > "$dir/beta.log" 2>&1 & pids+=($!)
on beta "unset OPENCODE_BIN; exec $bin model" > "$dir/beta-model.log" 2>&1 & pids+=($!)
on gamma "cd legacy/frontend && exec node server.js" > "$dir/gamma.log" 2>&1 & pids+=($!)
gamma_pid=$!

# curl on a host's own loopback: $1 host, then curl's arguments
api() { local h=$1; shift; ip netns exec "ph-$h" curl -s -m 10 -b "$dir/$h.jar" -c "$dir/$h.jar" "$@"; }
json() { api "$1" -H 'content-type: application/json' -X POST -d "$3" "http://127.0.0.1:8090$2"; }

wait_for() {
  local what=$1 tries=$2; shift 2
  for _ in $(seq 1 "$tries"); do eval "$*" >/dev/null 2>&1 && { ok "$what"; return 0; }; sleep 1; done
  bad "$what"
  return 1
}

seen() { api "$1" http://127.0.0.1:8090/api/state | jq -e --arg p "$2" '.tailnet[] | select(.name == $p) | .phosphorus == true'; }
for h in alpha beta gamma; do wait_for "$h answers" 30 "api $h -f http://127.0.0.1:8090/healthz || api $h -f http://127.0.0.1:8091/healthz"; done
wait_for "alpha sees gamma (JS)" 40 seen alpha gamma
wait_for "gamma (JS) sees alpha" 40 seen gamma alpha
wait_for "beta sees alpha" 40 seen beta alpha

# --- users: made on one side, logged in on the other ------------------------
json alpha /api/login '{"user":"admin","pass":"adminpass"}' > /dev/null
json alpha /api/users '{"name":"ann","pass":"hunter22","admin":true}' > /dev/null
wait_for "ann, made on alpha, logs in on gamma (JS)" 40 "json gamma /api/login '{\"user\":\"ann\",\"pass\":\"hunter22\"}' | jq -e '.user == \"ann\"'"
wait_for "ann logs in on beta" 40 "json beta /api/login '{\"user\":\"ann\",\"pass\":\"hunter22\"}' | jq -e '.user == \"ann\"'"
json gamma /api/users '{"name":"bob","pass":"hunter33"}' > /dev/null
wait_for "bob, made on gamma (JS), logs in on alpha" 40 "json alpha /api/login '{\"user\":\"bob\",\"pass\":\"hunter33\"}' | jq -e '.user == \"bob\"'"

# --- the model host: asks and projects passed to it -----------------------------
wait_for "alpha sees beta's opencode" 40 "api alpha http://127.0.0.1:8090/api/state | jq -e '.model.models[] | select(.host == \"beta\") | .harness == true'"
ask='{"messages":[{"role":"system","content":"s"},{"role":"user","content":"hi"}],"role":"chimp","asker":"alpha|x"}'
out=$(ip netns exec ph-alpha curl -s -m 20 -H 'content-type: application/json' -d "$ask" http://100.64.0.2:8090/api/model/ask)
echo "$out" | jq -e '.error | test("model|loaded|load")' > /dev/null && ok "beta takes alpha's ask, no model loaded: $(echo "$out" | jq -r .error)" || bad "beta's ask: $out"
code=$(ip netns exec ph-beta curl -s -o /dev/null -w '%{http_code}' -m 5 -H 'content-type: application/json' -d "$ask" http://127.0.0.1:8090/api/model/ask)
[ "$code" = 403 ] && ok "an ask from off the tailnet refused" || bad "an off-tailnet ask got $code"
out=$(ip netns exec ph-beta curl -s -m 5 -H 'content-type: application/json' -d '{"id":"gone","op":"name"}' http://100.64.0.1:8090/api/model/asker)
echo "$out" | jq -e '.error == "that ask is over"' > /dev/null && ok "beta reaches back to alpha's askers" || bad "asker relay: $out"
out=$(api alpha -m 45 http://127.0.0.1:8090/api/model/catalog)
echo "$out" | grep -q "isn't on this host" && bad "alpha's catalog not passed to beta: $out" || ok "alpha's catalog asked of beta: $(echo "$out" | head -c 80)"
out=$(json alpha /api/projects '{"title":"mesh test","brief":"nothing","hours":1}')
echo "$out" | jq -e '.host == "beta"' > /dev/null && ok "a project asked of alpha runs on beta" || bad "project start: $out"
id=$(echo "$out" | jq -r .id)
out=$(json beta /api/projects '{"title":"again","brief":"x","hours":1,"host":"alpha"}')
echo "$out" | jq -e '.error | test("model host")' > /dev/null && ok "alpha refuses a project of its own" || bad "alpha's own project: $out"
wait_for "alpha lists beta's project" 30 "api alpha http://127.0.0.1:8090/api/projects | jq -e '.projects[] | select(.id == \"$id\" and .host == \"beta\")'"
json alpha "/api/projects/beta/$id/stop" '{"by":"test"}' | jq -e '.status != null or .ok == true' > /dev/null && ok "stopped from alpha" || bad "stop from alpha"

# --- a host dropping --------------------------------------------------------------
kill "$gamma_pid"
touch "$dir/down/gamma"
# gone from the list once tailscale says offline, marked not answering before
wait_for "alpha sees gamma drop" 60 "api alpha http://127.0.0.1:8090/api/state | jq -e '[.tailnet[] | select(.name == \"gamma\" and .phosphorus)] | length == 0'"

echo
[ "$fails" = 0 ] && echo "mesh: all ok" || { echo "mesh: $fails failed"; KEEP=1; exit 1; }
