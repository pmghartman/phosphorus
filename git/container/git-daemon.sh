#!/bin/bash
set -uo pipefail

STATE_DIR="${STATE_DIR:-/state}"
DATA_ROOT="${DATA_ROOT:-/var/lib/phosphorus/git}"
LITEFS_YML_TMPL="${LITEFS_YML_TMPL:-/etc/litefs/litefs.yml.tmpl}"
LITEFS_YML="${LITEFS_YML:-/etc/litefs/litefs.yml}"
APP_INI_TMPL="${APP_INI_TMPL:-/etc/forgejo/app.ini.tmpl}"
APP_INI="${APP_INI:-$DATA_ROOT/conf/app.ini}"
GIT_ROLE_FILE="${GIT_ROLE_FILE:-$STATE_DIR/git-role}"
SELF_HOST_FILE="${SELF_HOST_FILE:-$STATE_DIR/self-host}"
ELECTOR="${ELECTOR:-/usr/local/lib/phosphorus-git/elector.js}"
# touch to let this host lead without proof it has the newest data
FORCE_FILE="${FORCE_FILE:-$STATE_DIR/git-force-promote}"
VERSION_FILE="$DATA_ROOT/GIT_VERSION"
# pre-0.14 replicas' name for it, written beside it until none are left
LEGACY_VERSION_FILE="$DATA_ROOT/MU_GIT_VERSION"
# set by any pull: forgejo's per-node indexers and queues predating that data
PULLED_FILE="$DATA_ROOT/GIT_PULLED"

# shared with elector.js
export LOCAL_FILE="${LOCAL_FILE:-/run/git-local}"
export DECISION_FILE="${DECISION_FILE:-/run/git-decision}"
export LEASE_UNTIL_FILE="${LEASE_UNTIL_FILE:-/run/git-lease-until}"
# the master litefs's pid, for the watchdog, empty otherwise
export LITEFS_PID_FILE="${LITEFS_PID_FILE:-/run/git-litefs-pid}"

# must match across every git host
GIT_NAME="${GIT_NAME:-git}"
GIT_PORT="${GIT_PORT:-3001}"
GIT_MODE="${GIT_MODE:-subdomain}"
: "${BASE_DOMAIN:?BASE_DOMAIN must be set in .env}"

TICK="${TICK:-0.25}"
# a decision older than this: the elector gone, stand down
DECISION_MAX_AGE_MS="${DECISION_MAX_AGE_MS:-2000}"
# synced this recently: may lead without seeing every other git host
IN_SYNC_SECS="${IN_SYNC_SECS:-30}"
REPLICATE_INTERVAL="${REPLICATE_INTERVAL:-5}"

say() { echo "[git-daemon] $*"; }

# CLOCK_BOOTTIME in ms, no wall-clock step bending a lease
now_ms() { local up; read -r up _ </proc/uptime; REPLY=$(( 10#${up/./} * 10 )); }

write_file() { echo "$2" >"$1.tmp" && mv "$1.tmp" "$1"; }

# __HOSTNAME__ the master's identity, not always this node's own, static
# lease without discovery: every node points at the same hostname/url
render_litefs_yml() {
  sed -e "s/__HOSTNAME__/${2}/g" -e "s/__CANDIDATE__/${1}/g" \
      "$LITEFS_YML_TMPL" > "$LITEFS_YML"
}

# DOMAIN/ROOT_URL the stable mesh name, never this host's own hostname:
# conf/ rsynced wholesale from the master, a local value would drift
render_app_ini_once() {
  if [ -s "$APP_INI" ]; then
    # added after first render, appended once, then rsynced like the rest of conf/
    grep -q '^\[cron.git_gc_repos\]' "$APP_INI" \
      || printf '\n[cron.git_gc_repos]\nENABLED  = true\nSCHEDULE = @every 24h\n' >> "$APP_INI"
    return
  fi
  sed -e "s/__GITHOST__/${GIT_NAME}.${BASE_DOMAIN}/g" \
      -e "s/__PORT__/${GIT_PORT}/g" \
      -e "s#__ROOT_URL__#https://${GIT_NAME}.${BASE_DOMAIN}/#g" \
      "$APP_INI_TMPL" > "$APP_INI"
}

# repo hooks written under an older data root, pointed at this app.ini
fix_hook_configs() {
  local root="$DATA_ROOT/obj/forgejo-repositories"
  [ -d "$root" ] || return 0
  find "$root" -path '*/hooks/*.d/*' -type f -print0 2>/dev/null \
    | xargs -0r grep -lZ -e '--config=' 2>/dev/null \
    | xargs -0r grep -LZ -F -e "$APP_INI" 2>/dev/null \
    | xargs -0r sed -i -E "s#--config=(['\"]?)[^'\" ]*app\.ini#--config=\1$APP_INI#"
}

LITEFS_PID=""
LITEFS_STARTED_AT=0
# a litefs dying on startup never respawned every tick
LITEFS_RETRY_MS="${LITEFS_RETRY_MS:-5000}"
am_master=false

start_litefs() {
  litefs mount --config "$LITEFS_YML" &
  LITEFS_PID="$!"
  now_ms; LITEFS_STARTED_AT="$REPLY"
  say "litefs started (pid $LITEFS_PID)"
  [ "$am_master" = true ] && write_file "$LITEFS_PID_FILE" "$LITEFS_PID"
}

# kill -0 succeeding on a child exited but not reaped, so the
# process state decides it, not the signal
litefs_alive() {
  [ -n "$LITEFS_PID" ] || return 1
  kill -0 "$LITEFS_PID" 2>/dev/null || return 1
  # still signalable, so a zombie ruled out, comm can hold spaces and parens,
  # hence the state read after the last ") "
  local stat="" rest
  read -r stat 2>/dev/null < /proc/"$LITEFS_PID"/stat
  [ -n "$stat" ] || return 0
  rest=${stat##*') '}
  [ "${rest%% *}" != Z ]
}

# pid cleared only once forgejo is down, the elector handing off on that
stop_litefs() {
  if [ -n "$LITEFS_PID" ]; then
    kill "$LITEFS_PID" 2>/dev/null
    wait "$LITEFS_PID" 2>/dev/null
    LITEFS_PID=""
  fi
  write_file "$LITEFS_PID_FILE" ""
}

# $1: true (master), false (servant of $2) or none (stopped)
# static lease reading hostname/candidate only at startup, any change a restart
CURRENT_CANDIDATE=""
CURRENT_MASTER_HOSTNAME=""
apply_litefs_state() {
  if [ "$1" = "$CURRENT_CANDIDATE" ] && [ "$2" = "$CURRENT_MASTER_HOSTNAME" ]; then
    # the config still stands, so only a litefs gone away under it means acting:
    # a fenced, crashed or failed-to-mount one
    { [ "$1" = none ] || litefs_alive; } && return
    now_ms
    [ $((REPLY - LITEFS_STARTED_AT)) -ge "$LITEFS_RETRY_MS" ] || return
    # the watchdog fencing a master whose lease lapsed, a restart while still
    # lapsed: two masters on the same database
    [ "$1" = true ] && ! lease_valid && return
    say "litefs is gone under candidate=$1 master=${2:-none}, restarting it"
  else
    say "litefs state: candidate=$1 master=${2:-none}"
  fi
  stop_litefs
  CURRENT_CANDIDATE="$1"
  CURRENT_MASTER_HOSTNAME="$2"
  [ "$1" = none ] && return
  render_litefs_yml "$1" "$2"
  start_litefs
}

lease_valid() {
  local until=0
  read -r until <"$LEASE_UNTIL_FILE" 2>/dev/null
  now_ms
  [ "${until:-0}" -gt "$REPLY" ]
}

# fencing on its own clock, no stalled tick outliving the lease
watchdog() {
  local pid fenced=""
  while sleep 0.2; do
    read -r pid <"$LITEFS_PID_FILE" 2>/dev/null || continue
    [ -n "$pid" ] && [ "$pid" != "$fenced" ] || continue
    lease_valid && continue
    kill "$pid" 2>/dev/null && say "lease ran out, watchdog fenced litefs (pid $pid)"
    fenced="$pid"
  done
}

start_rsyncd() {
  rsync --daemon --config=/etc/rsyncd.conf --no-detach &
  RSYNCD_PID="$!"
  say "rsync daemon started (pid $RSYNCD_PID)"
}

MY_GEN=0
MY_STAMP=0

# "<gen> <epoch>": gen bumped on every promotion, epoch the master's last stamp
read_version() {
  local line=""
  [ -r "$VERSION_FILE" ] && read -r line <"$VERSION_FILE"
  if [[ "$line" =~ ^([0-9]+)\ ([0-9]+)$ ]]; then
    MY_GEN="${BASH_REMATCH[1]}"; MY_STAMP="${BASH_REMATCH[2]}"
  else
    MY_GEN=0; MY_STAMP=0
  fi
}

stamp_version() {
  local tmp; tmp="$(mktemp "$VERSION_FILE.XXXXXX")" || return
  echo "$MY_GEN $EPOCHSECONDS" >"$tmp" && chmod 644 "$tmp" && mv "$tmp" "$VERSION_FILE" || rm -f "$tmp"
  cp -p "$VERSION_FILE" "$LEGACY_VERSION_FILE.tmp" 2>/dev/null && mv "$LEGACY_VERSION_FILE.tmp" "$LEGACY_VERSION_FILE"
  MY_STAMP="$EPOCHSECONDS"
}

log_rsync() { while read -r line; do say "rsync: $line"; done; }

# stamp last, vouching for the rest, TERM to rsync or a kill orphans a
# --delete pull, git's locks and temp objects swept: a copied .lock jams a ref
pull_from() {
  local src="rsync://${1}:8873/gitdata" pid=""
  trap '[ -n "$pid" ] && kill "$pid" 2>/dev/null; exit 143' TERM
  touch "$PULLED_FILE"
  rsync -az --delete --delete-excluded --timeout=30 --contimeout=5 --exclude=/obj/tmp/ \
        --exclude='/obj/forgejo-repositories/**.lock' --exclude='/obj/forgejo-repositories/**/gc.pid' \
        --exclude='/obj/forgejo-repositories/**/objects/**/tmp_*' --exclude='/obj/forgejo-repositories/**/objects/tmp_*' \
        "$src/conf" "$src/custom" "$src/obj" "$DATA_ROOT/" > >(log_rsync) 2>&1 &
  pid="$!"; wait "$pid" || exit 1
  # a pre-0.14 master's stamp under its old name
  rsync -a --timeout=30 --contimeout=5 "$src/GIT_VERSION" "$DATA_ROOT/" > >(log_rsync) 2>&1 &
  pid="$!"
  if ! wait "$pid"; then
    rsync -a --timeout=30 --contimeout=5 "$src/MU_GIT_VERSION" "$DATA_ROOT/GIT_VERSION" > >(log_rsync) 2>&1 &
    pid="$!"; wait "$pid"
  fi
}

LAST_ROLE=""

# rewritten only on change, the frontend re-reading the file every tick
write_git_role() {
  [ "$1" = "$LAST_ROLE" ] && [ -e "$GIT_ROLE_FILE" ] && return
  # same dir as the target: mv across filesystems not atomic
  local tmp; tmp="$(mktemp "$GIT_ROLE_FILE.XXXXXX")"
  jq -n --argjson master "$1" --argjson publish "$1" \
        --arg name "$GIT_NAME" --argjson port "$GIT_PORT" --arg mode "$GIT_MODE" \
    '{master:$master, publish:$publish, name:$name, port:$port, scheme:"http", mode:$mode, base_path:""}' \
    > "$tmp" && mv "$tmp" "$GIT_ROLE_FILE" && LAST_ROLE="$1" || rm -f "$tmp"
}

AUTHORITATIVE=""
REPL_PID=""
LAST_GOOD=0
# elected, forgejo held back until the final pull lands
PROMOTING=false

stop_pull() {
  [ -n "$REPL_PID" ] || return
  kill "$REPL_PID" 2>/dev/null
  wait "$REPL_PID" 2>/dev/null
  REPL_PID=""
}

# what the elector needs from us: data version, and whether we can vouch for it
write_local() {
  local in_sync=0 force=0
  now_ms
  { [ "$am_master" = true ] || { [ "$LAST_GOOD" -gt 0 ] && [ $((REPLY - LAST_GOOD)) -lt $((IN_SYNC_SECS * 1000)) ]; }; } && in_sync=1
  [ -e "$FORCE_FILE" ] && force=1
  write_file "$LOCAL_FILE" "$MY_GEN $MY_STAMP $in_sync $force"
}

step_down() {
  say "no longer master, stopping forgejo"
  am_master=false
  PROMOTING=false
  AUTHORITATIVE=""
  stop_pull
  apply_litefs_state none ""
}

# once, before forgejo first starts as master
begin_leading() {
  if [ -e "$PULLED_FILE" ]; then
    say "data pulled since this host last led, indexers and queues rebuilt"
    rm -rf "$DATA_ROOT"/state/indexers "$DATA_ROOT"/state/queues
    rm -f "$PULLED_FILE"
  fi
  stamp_version
  PROMOTING=false
}

apply_decision() {
  local role=none master="" gen=0 written=0 from=""
  read -r role master gen written from <"$DECISION_FILE" 2>/dev/null
  now_ms
  [ $((REPLY - ${written:-0})) -le "$DECISION_MAX_AGE_MS" ] || role=none
  master="${master#-}"
  from="${from#-}"

  case "$role" in
    master)
      if [ "$am_master" != true ]; then
        say "elected master (gen $gen)"
        stop_pull
        MY_GEN="$gen"
        rm -f "$FORCE_FILE"
        am_master=true
        PROMOTING=true
        AUTHORITATIVE="$SELF_HOST"
        # the handing-off master, forgejo already down: nothing pushed lost
        if [ -n "$from" ]; then
          say "final pull from $from"
          pull_from "$from" &
          REPL_PID="$!"
        fi
      fi
      if [ "$PROMOTING" = true ]; then
        if [ -n "$REPL_PID" ]; then
          kill -0 "$REPL_PID" 2>/dev/null && return
          wait "$REPL_PID" || say "final pull from $from failed, leading on the last one"
          REPL_PID=""
        fi
        begin_leading
      fi
      # every tick, not only on the transition: a no-op unless the
      # config drifted or litefs died under it
      apply_litefs_state true "$SELF_HOST"
      ;;
    servant)
      [ "$am_master" = true ] && step_down
      [ "$AUTHORITATIVE" = "$master" ] || stop_pull
      AUTHORITATIVE="$master"
      apply_litefs_state false "$master"
      ;;
    *)
      [ "$am_master" = true ] && step_down
      AUTHORITATIVE=""
      ;;
  esac
}

LAST_REPL=0

# own interval, backgrounded: no slow rsync stalling ticks
replicate() {
  [ "$PROMOTING" = true ] && return
  if [ -n "$REPL_PID" ]; then
    kill -0 "$REPL_PID" 2>/dev/null && return
    if wait "$REPL_PID"; then now_ms; LAST_GOOD="$REPLY"; fi
    REPL_PID=""
  fi
  [ $((EPOCHSECONDS - LAST_REPL)) -ge "$REPLICATE_INTERVAL" ] || return
  if [ "$am_master" = true ]; then
    stamp_version
  elif [ -n "$AUTHORITATIVE" ]; then
    pull_from "$AUTHORITATIVE" &
    REPL_PID="$!"
  else
    return
  fi
  LAST_REPL="$EPOCHSECONDS"
}

ELECTOR_PID=""
ELECTOR_NEXT=0

start_elector() {
  [ "$EPOCHSECONDS" -ge "$ELECTOR_NEXT" ] || return
  ELECTOR_NEXT=$((EPOCHSECONDS + 2))
  node "$ELECTOR" &
  ELECTOR_PID="$!"
}

# forgejo down first, then the grants handed back by the elector: peers taking over in a tick
term() {
  say "shutting down"
  [ -n "${WATCHDOG_PID:-}" ] && kill "$WATCHDOG_PID" 2>/dev/null
  write_git_role false
  stop_litefs
  if [ -n "$ELECTOR_PID" ]; then kill "$ELECTOR_PID" 2>/dev/null; wait "$ELECTOR_PID" 2>/dev/null; fi
  [ -n "${RSYNCD_PID:-}" ] && kill "$RSYNCD_PID" 2>/dev/null
  stop_pull
  exit 0
}

main() {
  mkdir -p "$STATE_DIR" "$DATA_ROOT"/{conf,custom,obj,litefs} /var/lib/litefs-internal
  # forgejo running as git, never chown litefs/ (the FUSE mount)
  chown git:phosphorus "$DATA_ROOT"
  chown -R git:phosphorus "$DATA_ROOT"/{conf,custom,obj}
  # the mulab-era names, once
  [ -e "$DATA_ROOT/MU_GIT_VERSION" ] && [ ! -e "$VERSION_FILE" ] && cp -p "$DATA_ROOT/MU_GIT_VERSION" "$VERSION_FILE"
  [ -e "$DATA_ROOT/MU_GIT_PULLED" ] && mv "$DATA_ROOT/MU_GIT_PULLED" "$PULLED_FILE"

  say "waiting for $SELF_HOST_FILE..."
  while [ ! -s "$SELF_HOST_FILE" ]; do sleep 1; done
  SELF_HOST="$(cat "$SELF_HOST_FILE")"
  say "this host is $SELF_HOST"

  read_version
  write_file "$LITEFS_PID_FILE" ""
  write_file "$LEASE_UNTIL_FILE" 0
  write_local
  watchdog &
  WATCHDOG_PID="$!"

  render_app_ini_once
  fix_hook_configs
  start_rsyncd
  trap term SIGTERM SIGINT

  while true; do
    if [ -z "$ELECTOR_PID" ] || ! kill -0 "$ELECTOR_PID" 2>/dev/null; then
      start_elector
    fi

    apply_decision

    # a lapsed lease fencing, not restarting
    if [ -n "$LITEFS_PID" ] && ! kill -0 "$LITEFS_PID" 2>/dev/null; then
      if [ "$am_master" = true ] && ! lease_valid; then
        step_down
      else
        say "litefs exited unexpectedly, restarting"
        render_litefs_yml "$CURRENT_CANDIDATE" "$CURRENT_MASTER_HOSTNAME"
        start_litefs
      fi
    fi

    # a host rename landing in self-host once phosphorus restarts, restarted to follow it
    if [ -s "$SELF_HOST_FILE" ] && [ "$(<"$SELF_HOST_FILE")" != "$SELF_HOST" ]; then
      say "self-host is now $(<"$SELF_HOST_FILE"), restarting"
      term
    fi

    replicate
    [ "$am_master" = true ] || read_version
    write_git_role "$am_master"
    write_local
    sleep "$TICK"
  done
}

# sourced by tests for the functions only
[ "${GIT_DAEMON_LIB:-}" = 1 ] || main "$@"
