# phosphorus host desktop probe, read by sh -s: requests id\tcmd\tbase64(arg) on
# stdin, replies id\tok|err\tbase64(payload); records \036kind\targs then a body

umask 077
U=$(id -u)
if [ -z "$DBUS_SESSION_BUS_ADDRESS" ] && [ -S "/run/user/$U/bus" ]; then
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$U/bus"
  export DBUS_SESSION_BUS_ADDRESS
fi
[ -n "$XDG_RUNTIME_DIR" ] || XDG_RUNTIME_DIR="/run/user/$U"
export XDG_RUNTIME_DIR
T="${XDG_DATA_HOME:-$HOME/.local/share}/Trash"
E=$(mktemp 2>/dev/null || echo "/tmp/phos-desk-$$")
trap 'rm -f "$E"' EXIT
NL='
'

b64() { base64 | tr -d '\n'; }
fail() { printf '%s\n' "$*" >&2; return 1; }
mtime() { stat -c %Y "$1" 2>/dev/null; }

emit_file() {
  [ -f "$1" ] || return 0
  printf '\036file\t%s\t%s\n' "$1" "$(mtime "$1")"
  cat "$1" 2>/dev/null
  printf '\n'
}

# a desktop entry's [Desktop Entry] keys only
emit_entry() {
  [ -f "$1" ] || return 0
  printf '\036file\t%s\t%s\n' "$1" "$(mtime "$1")"
  awk '/^\[/{s=($0=="[Desktop Entry]")} s' "$1" 2>/dev/null |
    grep -E '^(\[Desktop Entry\]|Name|Exec|TryExec|Icon|Type|Terminal|NoDisplay|Hidden|OnlyShowIn|NotShowIn|URL|Categories)=?' 2>/dev/null
  printf '\n'
}

emit_ls() {
  printf '\036ls\t%s\n' "$1"
  ls -1 "$1" 2>/dev/null
}

list_dir() {
  for f in "$1"/*; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    t=f
    [ -d "$f" ] && t=d
    printf '\036ent\t%s\t%s\t%s\t%s\n' "$f" "$t" "$(mtime "$f")" "$(stat -c %s "$f" 2>/dev/null)"
  done
}

de() {
  for p in gnome-shell:gnome plasmashell:kde xfce4-session:xfce xfwm4:xfce; do
    if pgrep -u "$U" -x "${p%%:*}" >/dev/null 2>&1; then echo "${p#*:}"; return; fi
  done
  for p in gnome-shell:gnome plasmashell:kde xfce4-session:xfce; do
    if command -v "${p%%:*}" >/dev/null 2>&1; then echo "${p#*:}"; return; fi
  done
  echo plain
}

desk_dir() {
  d=$(sed -n 's/^XDG_DESKTOP_DIR="\(.*\)"$/\1/p' "$HOME/.config/user-dirs.dirs" 2>/dev/null | head -n 1)
  d=$(printf '%s' "$d" | sed "s|^\$HOME|$HOME|")
  [ -n "$d" ] || d="$HOME/Desktop"
  printf '%s' "$d"
}

do_desktop() {
  d=$(de)
  bus=0
  [ -n "$DBUS_SESSION_BUS_ADDRESS" ] && [ -S "/run/user/$U/bus" ] && bus=1
  full=0
  [ -n "$(ls -A "$T/files" 2>/dev/null)" ] && full=1
  printf '\036env\nuser=%s\nhome=%s\nde=%s\nbus=%s\nbinfull=%s\n' "$(id -un)" "$HOME" "$d" "$bus" "$full"
  case $d in
  gnome)
    for k in "org.gnome.desktop.background picture-uri" "org.gnome.desktop.background picture-uri-dark" \
      "org.gnome.desktop.background picture-options" "org.gnome.desktop.background primary-color" \
      "org.gnome.desktop.interface color-scheme" "org.gnome.desktop.interface accent-color" \
      "org.gnome.desktop.interface icon-theme" "org.gnome.desktop.interface gtk-theme" \
      "org.gnome.shell favorite-apps" "org.gnome.shell enabled-extensions" "org.gnome.shell disabled-extensions" \
      "org.gnome.desktop.interface clock-format" "org.gnome.desktop.interface clock-show-seconds" \
      "org.gnome.desktop.interface clock-show-weekday" \
      "org.gnome.shell.extensions.ding icon-size"; do
      v=$(gsettings get $k 2>/dev/null) || continue
      printf '\036gs\t%s\n%s\n' "$k" "$v"
    done
    ;;
  kde)
    emit_file "$HOME/.config/kdeglobals"
    a="$HOME/.config/plasma-org.kde.plasma.desktop-appletsrc"
    emit_file "$a"
    { sed -n 's|^Image=\(file://\)\{0,1\}||p' "$a" 2>/dev/null; echo /usr/share/wallpapers/Next; } | while IFS= read -r w; do
      for s in images images_dark; do [ -d "$w/contents/$s" ] && emit_ls "$w/contents/$s"; done
    done
    ;;
  xfce)
    for f in xfce4-desktop xsettings xfce4-panel; do emit_file "$HOME/.config/xfce4/xfconf/xfce-perchannel-xml/$f.xml"; done
    for f in "$HOME"/.config/xfce4/panel/launcher-*/*.desktop; do emit_entry "$f"; done
    ;;
  esac
  dd=$(desk_dir)
  list_dir "$dd"
  for f in "$dd"/*.desktop; do emit_entry "$f"; done
}

do_apps() {
  dirs="${XDG_DATA_HOME:-$HOME/.local/share}:$HOME/.local/share/flatpak/exports/share:/var/lib/flatpak/exports/share:${XDG_DATA_DIRS:-/usr/local/share:/usr/share}:/var/lib/snapd/desktop"
  printf '%s\n' "$dirs" | tr ':' '\n' | while IFS= read -r d; do
    [ -d "$d/applications" ] || continue
    printf '\036dir\t%s\n' "$d/applications"
    find "$d/applications" -name '*.desktop' 2>/dev/null | while IFS= read -r f; do emit_entry "$f"; done
  done
}

# a themed icon's file: the theme, what it inherits, then hicolor and the pixmaps
icon_find() {
  n=$1
  for b in "$HOME/.local/share/icons" "$HOME/.icons" /usr/local/share/icons /usr/share/icons \
    /var/lib/flatpak/exports/share/icons "$HOME/.local/share/flatpak/exports/share/icons"; do
    for t in $themes; do
      [ -d "$b/$t" ] || continue
      for s in scalable 256x256 128x128 96x96 64x64 48x48 512x512 32x32; do
        for c in apps places mimetypes devices status categories actions legacy; do
          for x in svg png; do
            [ -f "$b/$t/$s/$c/$n.$x" ] && { printf '%s' "$b/$t/$s/$c/$n.$x"; return 0; }
          done
        done
      done
      for c in apps places mimetypes devices status categories actions; do
        for s in scalable 64 48 96 128 256 32; do
          for x in svg png; do
            [ -f "$b/$t/$c/$s/$n.$x" ] && { printf '%s' "$b/$t/$c/$s/$n.$x"; return 0; }
          done
        done
      done
    done
  done
  for x in svg png; do [ -f "/usr/share/pixmaps/$n.$x" ] && { printf '%s' "/usr/share/pixmaps/$n.$x"; return 0; }; done
  return 1
}

do_icon() {
  set -f
  theme=$(printf '%s\n' "$1" | head -n 1)
  inh=""
  for b in /usr/share/icons "$HOME/.local/share/icons" "$HOME/.icons"; do
    [ -f "$b/$theme/index.theme" ] && inh="$inh $(sed -n 's/^Inherits=//p' "$b/$theme/index.theme" | tr ',' ' ')"
  done
  themes="$theme $inh hicolor Adwaita breeze"
  for n in $(printf '%s\n' "$1" | tail -n +2 | tr ',' ' '); do
    case $n in */*) continue ;; esac
    icon_find "$n" && { set +f; return 0; }
  done
  set +f
  return 0
}

# path, then the trashinfo to write beside it
do_delete() {
  p=$(printf '%s\n' "$1" | head -n 1)
  info=$(printf '%s\n' "$1" | tail -n +2)
  [ -e "$p" ] || [ -L "$p" ] || { fail "not found: $p"; return; }
  mkdir -p "$T/files" "$T/info" || return
  [ "$(stat -c %d "$p")" = "$(stat -c %d "$T/files")" ] || { fail "it's on another disk than the trash, so nothing was deleted"; return; }
  b=$(basename "$p")
  n=$b
  k=1
  while [ -e "$T/files/$n" ] || [ -e "$T/info/$n.trashinfo" ]; do
    k=$((k + 1))
    n="$b.$k"
  done
  printf '%s\n' "$info" >"$T/info/$n.trashinfo" || return
  mv -- "$p" "$T/files/$n" || { rm -f -- "$T/info/$n.trashinfo"; return 1; }
}

do_open() {
  p=$1
  [ -e "$p" ] || [ -L "$p" ] || { fail "not found: $p"; return; }
  t=f
  [ -d "$p" ] && t=d
  printf '\036stat\t%s\t%s\t%s\n' "$t" "$(mtime "$p")" "$(stat -c %s "$p" 2>/dev/null)"
  case $p in *.desktop) emit_entry "$p" ;; esac
}

do_ls() {
  [ -d "$1" ] || { fail "not a folder: $1"; return; }
  d=${1%/}
  for f in "$d"/* "$d"/.[!.]*; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    t=f
    [ -d "$f" ] && t=d
    printf '\036ent\t%s\t%s\t%s\t%s\n' "$f" "$t" "$(mtime "$f")" "$(stat -c %s "$f" 2>/dev/null)"
  done
}

do_roots() { df -kP 2>/dev/null; }

# the wallpaper no wider than a screen as a jpeg, by whichever converter the host has;
# nothing when it has none, the picture then read as it is
do_wall() {
  [ -f "$1" ] || { fail "not found: $1"; return; }
  o=$(mktemp 2>/dev/null || echo "/tmp/phos-wall-$$")
  j="$o.jpg"
  if command -v magick >/dev/null 2>&1; then magick "$1[0]" -auto-orient -resize '2560x2560>' -quality 85 "$j"
  elif command -v convert >/dev/null 2>&1; then convert "$1[0]" -auto-orient -resize '2560x2560>' -quality 85 "$j"
  elif command -v vipsthumbnail >/dev/null 2>&1; then vipsthumbnail "$1" --size '2560x2560>' -o "$j[Q=85]"
  elif command -v ffmpeg >/dev/null 2>&1; then ffmpeg -v quiet -y -i "$1" -frames:v 1 -vf "scale='min(2560,iw)':'min(2560,ih)':force_original_aspect_ratio=decrease" -q:v 3 "$j"
  fi 2>/dev/null
  [ -s "$j" ] && b64 <"$j"
  rm -f "$o" "$j"
  return 0
}

while IFS='	' read -r id cmd arg; do
  a=$(printf '%s' "$arg" | base64 -d 2>/dev/null)
  case $cmd in
  desktop | apps | icon | wall | delete | open | ls | roots) ;;
  *)
    printf '%s\terr\t%s\n' "$id" "$(printf 'no such request: %s' "$cmd" | b64)"
    continue
    ;;
  esac
  if out=$("do_$cmd" "$a" </dev/null 2>"$E"); then st=ok; else st=err; out="$out$NL$(cat "$E")"; fi
  printf '%s\t%s\t%s\n' "$id" "$st" "$(printf '%s' "$out" | b64)"
done
