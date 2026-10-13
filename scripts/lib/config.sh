#!/bin/bash
# readers for config/hesperus.ini, config/services.export and .env, from the
# home, sourced by run-*, rebuild, update, game-control, bash 3.2-safe

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

# the release's own, stamped by CI
hesperus_version() { tr -d '[:space:]' < VERSION; }

# the release's images, CI-built, cuda per [model] gpu
HESPERUS_REGISTRY="ghcr.io/pmghartman"

# $1 docker or "sudo docker": the release's images pulled and tagged as
# compose names them, so a source build never runs
hesperus_pull_images() {
  local docker="$1" v sfx="" pair from to
  v="$(hesperus_version)"
  hesperus_model_gpu && [ "$(uname -m)" = x86_64 ] && sfx="-cuda"
  for pair in "hesperus:$v$sfx=hesperus:latest" "hesperus-git:$v=hesperus-git:latest"; do
    from="$HESPERUS_REGISTRY/${pair%%=*}" to="${pair#*=}"
    $docker pull -q "$from" >/dev/null && $docker tag "$from" "$to" || return 1
  done
}

# config/hesperus.ini when there is one, else nothing
hesperus_ini() {
  [ -f config/hesperus.ini ] && printf '%s' config/hesperus.ini
  return 0
}

# hesperus_get <section> <key>
hesperus_get() {
  ini_get "$(hesperus_ini)" "$1" "$2"
}

hesperus_is_git_host() {
  [ "$(hesperus_get git host)" = "true" ]
}

# the installer never overwrites this host's hesperus.ini, so sections added
# since are appended here
hesperus_add_missing_sections() {
  local file; file="$(hesperus_ini)"
  [ -n "$file" ] || return
  if ! grep -qx '\[files\]' "$file"; then
    printf '\n[files]\n# host directories on the Files tab, comma separated, blank: the home'"'"'s files/\n# priv: one r/w/d set per dir, same order, r browse and download,\n# w upload, new folder and rename, d delete, none: rwd\ndir =\npriv =\n' >> "$file"
    echo "[hesperus.ini] added the [files] section, set dir to publish a directory"
  fi
  if ! grep -qx '\[model\]' "$file"; then
    printf '\n[model]\n# host: true downloads the mesh model here and runs it for every host\n# gpu: true offloads it to this host'"'"'s nvidia gpu\n# url: download link to the model'"'"'s .gguf, no default\nhost = false\ngpu = false\nurl =\n' >> "$file"
    echo "[hesperus.ini] added the [model] section, set host and url on the one host with the memory and disk for the model"
  fi
}

# [model] host: the model and the web search run here
hesperus_is_model_host() {
  [ "$(hesperus_get model host)" = "true" ]
}

# [model] gpu: the image built with llama.cpp's cuda backend
hesperus_model_gpu() {
  [ "$(hesperus_get model gpu)" = "true" ]
}

# absolute host path published on the frontend's Files tab, the home's own
# files/ when [files] dir is blank, so the mount always resolves
hesperus_files_dir() {
  local dir; dir="$(hesperus_get files dir)"
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
# entries off $1, the home as the host sees it
hesperus_files_dir_list() {
  local raw d base; raw="$(hesperus_get files dir)"
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

# [files] dir entries inside old checkout $1 copied into this home and made
# relative to it, $2=all for relative ones too (a migration's, off the checkout)
hesperus_rehome_files() {
  local old="$1" all="${2:-}" ini raw d rel out="" changed=0
  ini="$(hesperus_ini)"
  [ -n "$ini" ] && [ -n "$old" ] && [ "$old" != "$PWD" ] || return 0
  raw="$(hesperus_get files dir)"
  [ -n "$raw" ] || return 0
  local IFS=','
  for d in $raw; do
    d="${d# }"; d="${d%/}"
    case "$d" in
      '') continue ;;
      "$old"/*) rel="${d#"$old"/}" ;;
      /*|[A-Za-z]:*) out="${out:+$out,}$d"; continue ;;
      *) rel="$d"; [ "$all" = all ] || { out="${out:+$out,}$d"; continue; } ;;
    esac
    if [ -d "$old/$rel" ]; then
      echo "[files] copying $old/$rel into $PWD/$rel"
      mkdir -p "$rel" && cp -a "$old/$rel/." "$rel/" || return 1
    fi
    out="${out:+$out,}$rel"; changed=1
  done
  [ "$changed" = 1 ] || return 0
  awk -v v="$out" '/^\[/{on=($0=="[files]")} on && /^dir =/{print "dir = " v; next} {print}' "$ini" > "$ini.tmp" \
    && mv "$ini.tmp" "$ini" && echo "[files] dir now $out, under $PWD"
}

# [files] priv, one entry per dir in the same order, none means rwd
hesperus_files_perm_list() {
  local raw p; raw="$(hesperus_get files priv)"
  local IFS=','
  for p in $raw; do
    printf '%s\n' "${p// /}"
  done
}

# shares in an override beside compose (no variable mount count there),
# rewritten every build, never committed
HESPERUS_FILES_OVERRIDE="docker-compose.files.yml"

# $1 the home as the host sees it, $2 whether those paths are statable
# here, 0 with an override for COMPOSE_FILE, 1 with only the fallback mount
hesperus_write_files_override() {
  local dirs=() perms=() dir perm i=0 base="${1:-$PWD}" vet="${2:-1}"
  while IFS= read -r dir; do
    if [ "$vet" = 1 ] && [ ! -d "$dir" ]; then
      echo "[files] skipping '$dir'; no such directory on this host" >&2
      continue
    fi
    dirs+=("$dir")
  done < <(hesperus_files_dir_list "$base")
  while IFS= read -r perm; do perms+=("$perm"); done < <(hesperus_files_perm_list)

  if [ "${#dirs[@]}" -eq 0 ]; then rm -f "$HESPERUS_FILES_OVERRIDE"; return 1; fi

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
    echo "# generated from [files] in config/hesperus.ini, rewritten every build"
    echo "services:"
    echo "  hesperus:"
    echo "    environment:"
    echo "      HESPERUS_FILES_DIRS: \"$dirCsv\""
    echo "      HESPERUS_FILES_PERMS: \"$permCsv\""
    echo "    volumes:"
    printf "%b" "$mounts"
  } > "$HESPERUS_FILES_OVERRIDE"
}
