#!/bin/sh
# phosphorus leftovers: stopped containers from its images, its node processes
# outside any running container, run by rebuild with --pid=host, $1 the repo
repo="$1"

# compose services kept (a stop of theirs possibly deliberate), a failed
# updater kept for its logs
docker ps -a --format '{{.ID}}	{{.State}}	{{.Status}}	{{.Names}}	{{.Label "org.phosphorus"}}' |
while IFS='	' read -r id state status name label; do
  case "$state" in running|restarting|paused|removing) continue ;; esac
  case "$name" in phosphorus|phosphorus-git|phosphorus-search) continue ;; esac
  [ "$name" = phosphorus-updater ] && case "$status" in *"(0)"*) ;; *) continue ;; esac
  [ -n "$label" ] || continue
  docker rm "$id" >/dev/null 2>&1 && echo "removed container $name ($status)"
done

# ids of every running container, a process in one of their cgroups live
live=" $(docker ps -q --no-trunc | tr '\n' ' ') "
for p in /proc/[0-9]*; do
  pid="${p#/proc/}"
  # the redirect's own error too: a process gone mid-scan
  cmd="$({ tr '\0' ' ' < "$p/cmdline"; } 2>/dev/null)"
  case "$cmd" in node\ *|*/node\ *) ;; *) continue ;; esac
  case "$cmd" in
    *" /opt/frontend/"*|*" /opt/phosphorus/"*|*" /usr/local/lib/phosphorus-git/"*) ;;
    *" $repo/frontend/"*|*" $repo/container/"*|*" $repo/git/"*) ;;
    *) continue ;;
  esac
  cid="$(grep -o '[0-9a-f]\{64\}' "$p/cgroup" 2>/dev/null | head -n 1)"
  [ -n "$cid" ] && case "$live" in *" $cid "*) continue ;; esac
  kill "$pid" 2>/dev/null && echo "stopped stray node $pid: $cmd"
done
exit 0
