#!/bin/sh
# phosphorus leftovers: every container of its images or names but the
# compose project's own, running or not, and its processes outside any
# running container, run by rebuild with --pid=host and by supervisor.sh
self="$(hostname)"

# the project's services kept (a stop of theirs possibly deliberate), project
# sandboxes left to phosphorus, a failed updater kept for its logs, a running
# one mid-swap
# | between fields, tabs' runs collapsing an empty label into the next
docker ps -a --no-trunc --format '{{.ID}}|{{.State}}|{{.Status}}|{{.Names}}|{{.Label "org.phosphorus"}}|{{.Label "org.phosphorus.sandbox"}}|{{.Label "com.docker.compose.project"}}' |
while IFS='|' read -r id state status name label sandbox project; do
  case "$id" in "$self"*) continue ;; esac
  [ -n "$sandbox" ] && continue
  case "$name" in
    phosphorus|phosphorus-model|phosphorus-git|phosphorus-search) [ "$project" = phosphorus ] && continue ;;
    phosphorus-updater)
      [ "$state" = running ] && continue
      case "$status" in *"(0)"*) ;; *) continue ;; esac ;;
    phosphorus*|hesperus*) ;;
    *) [ -n "$label" ] || continue ;;
  esac
  docker rm -f "$id" >/dev/null 2>&1 && echo "removed container $name ($status)"
done

# ids of every running container, a process in one of their cgroups live
live=" $(docker ps -q --no-trunc | tr '\n' ' ') "
for p in /proc/[0-9]*; do
  pid="${p#/proc/}"
  # the redirect's own error too: a process gone mid-scan
  cmd="$({ tr '\0' ' ' < "$p/cmdline"; } 2>/dev/null)"
  case "$cmd" in
    phosphorus\ serve*|phosphorus\ model*|phosphorus\ elector*) ;;
    */phosphorus\ serve*|*/phosphorus\ model*|*/phosphorus\ elector*) ;;
    *) continue ;;
  esac
  cid="$(grep -o '[0-9a-f]\{64\}' "$p/cgroup" 2>/dev/null | head -n 1)"
  [ -n "$cid" ] && case "$live" in *" $cid "*) continue ;; esac
  kill "$pid" 2>/dev/null && echo "stopped stray $pid: $cmd"
done
exit 0
