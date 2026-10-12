#!/bin/bash
# readers for config/phos.ini, config/services.export and .env, from the
# checkout root, sourced by run-*, rebuild, update, game-control, bash 3.2-safe

# ini_get <file> <section> <key>: `key = value` lines under `[section]`,
# blank when unset or the file is missing
ini_get() {
  [ -f "$1" ] || return 0
  awk -v sec="[$2]" -v key="$3 =" '
    /^\[/ { on = ($0 == sec); next }
    on && index($0, key) == 1 { v = substr($0, length(key) + 1); sub(/^ +/, "", v); gsub(/"/, "", v); print v; exit }
  ' "$1"
}

# env_get <key>, blank when unset, read directly since a host shell never
# gets .env from compose
env_get() {
  grep "^$1=" .env 2>/dev/null | cut -d= -f2-
}

# VERSION's <major>.<minor>, then the commit count
phos_version() {
  printf '%s.%s' "$(cat VERSION)" "$(git rev-list --count HEAD 2>/dev/null || echo 0)"
}

# config/phos.ini when there is one, else nothing
phos_ini() {
  [ -f config/phos.ini ] && printf '%s' config/phos.ini
  return 0
}

# phos_get <section> <key>
phos_get() {
  ini_get "$(phos_ini)" "$1" "$2"
}

phos_is_git_host() {
  [ "$(phos_get git host)" = "true" ]
}

# skip-worktree: an update restores this host's phos.ini verbatim, so
# sections added upstream are appended here
phos_add_missing_sections() {
  local file; file="$(phos_ini)"
  [ -n "$file" ] || return
  if ! grep -qx '\[files\]' "$file"; then
    printf '\n[files]\n# host directories on the Files tab, comma separated, blank: the repo'"'"'s files/\n# priv: one r/w/d set per dir, same order, r browse and download,\n# w upload, new folder and rename, d delete, none: rwd\ndir =\npriv =\n' >> "$file"
    echo "[phos.ini] added the [files] section, set dir to publish a directory"
  fi
  if ! grep -qx '\[model\]' "$file"; then
    printf '\n[model]\n# host: true downloads the mesh model here and runs it for every host\n# gpu: true offloads it to this host'"'"'s nvidia gpu\n# url: download link to the model'"'"'s .gguf, no default\nhost = false\ngpu = false\nurl =\n' >> "$file"
    echo "[phos.ini] added the [model] section, set host and url on the one host with the memory and disk for the model"
  fi
}

# [model] host: the model and the web search run here
phos_is_model_host() {
  [ "$(phos_get model host)" = "true" ]
}

# [model] gpu: the image built with llama.cpp's cuda backend
phos_model_gpu() {
  [ "$(phos_get model gpu)" = "true" ]
}

# absolute host path published on the frontend's Files tab, the repo's own
# files/ when [files] dir is blank, so the mount always resolves
phos_files_dir() {
  local dir; dir="$(phos_get files dir)"
  if [ -z "$dir" ]; then
    printf '%s' "$PWD/files"
    return
  fi
  case "$dir" in
    /*|[A-Za-z]:*) printf '%s' "$dir" ;;
    *) printf '%s' "$PWD/$dir" ;;
  esac
}

# [files] dir, one absolute host path per line, nothing when unset, relative
# entries off $1, the checkout as the host sees it
phos_files_dir_list() {
  local raw d base; raw="$(phos_get files dir)"
  [ -n "$raw" ] || return 0
  base="${1:-$PWD}"
  local IFS=','
  for d in $raw; do
    d="${d# }"; d="${d%/}"
    [ -n "$d" ] || continue
    case "$d" in
      /*|[A-Za-z]:*) printf '%s\n' "$d" ;;
      *) printf '%s\n' "$base/$d" ;;
    esac
  done
}

# [files] priv, one entry per dir in the same order, none means rwd
phos_files_perm_list() {
  local raw p; raw="$(phos_get files priv)"
  local IFS=','
  for p in $raw; do
    printf '%s\n' "${p// /}"
  done
}

# shares in an override beside compose (no variable mount count there),
# rewritten every build, never committed
PHOS_FILES_OVERRIDE="docker-compose.files.yml"

# $1 the checkout as the host sees it, $2 whether those paths are statable
# here, 0 with an override for COMPOSE_FILE, 1 with only the fallback mount
phos_write_files_override() {
  local dirs=() perms=() dir perm i=0 base="${1:-$PWD}" vet="${2:-1}"
  while IFS= read -r dir; do
    if [ "$vet" = 1 ] && [ ! -d "$dir" ]; then
      echo "[files] skipping '$dir'; no such directory on this host" >&2
      continue
    fi
    dirs+=("$dir")
  done < <(phos_files_dir_list "$base")
  while IFS= read -r perm; do perms+=("$perm"); done < <(phos_files_perm_list)

  if [ "${#dirs[@]}" -eq 0 ]; then rm -f "$PHOS_FILES_OVERRIDE"; return 1; fi

  local dirCsv="" permCsv="" mounts=""
  for dir in "${dirs[@]}"; do
    perm="${perms[$i]-rwd}"
    [ -n "$perm" ] || perm="rwd"
    # nothing that writes: kernel-enforced too, not just the frontend
    case "$perm" in *w*|*d*) mounts="$mounts      - \"$dir:/shares/$i\"\n" ;;
      *) mounts="$mounts      - \"$dir:/shares/$i:ro\"\n" ;;
    esac
    dirCsv="${dirCsv:+$dirCsv,}$dir"
    permCsv="${permCsv:+$permCsv,}$perm"
    i=$((i + 1))
  done

  {
    echo "# generated from [files] in config/phos.ini, rewritten every build"
    echo "services:"
    echo "  phosphorus:"
    echo "    environment:"
    echo "      PHOS_FILES_DIRS: \"$dirCsv\""
    echo "      PHOS_FILES_PERMS: \"$permCsv\""
    echo "    volumes:"
    printf "%b" "$mounts"
  } > "$PHOS_FILES_OVERRIDE"
}
