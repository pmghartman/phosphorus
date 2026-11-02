// the self-hosted catalogue installed on the host itself, no containers: each a
// recipe of sh run as the login in ~/.phosphorus/services/<id>, sudo -n for what
// needs root (apt packages, system services); what it leaves running is a
// systemd unit, the login's own phos-<id> or a package's system one
import type { Service } from "./scripts.ts";

// one catalogue entry. install is run for an install and again for an update, so
// it is idempotent; remove undoes it, $KEEP 1 when the person keeps the data.
// Both run under helpers, in $dir, with .env loaded: IP (the host's tailnet
// address), PORT, URL (where the mesh opens it), DOMAIN, TZ, PUID, PGID, the
// secrets, A (amd64|arm64), X (x86_64|aarch64), XA (x64|arm64), DISTRO (debian),
// CODENAME (trixie), ID, NAME, OP (install|update|remove), data ($dir/data). In a TS template literal write sh variables as $VAR, never ${VAR}
export type Recipe = {
  id: string;
  name: string;
  category: string;
  tagline: string;
  about: string;
  // the project's own page, the store's source link
  home: string;
  // a dashboard-icons name when it isn't the id, .svg where it has no PNG; "" for none
  icon?: string;
  // the port it answers on when its own can't be set; else 18100 + its place
  port?: number;
  // needs root: apt packages, a system service, files outside the login's home; the
  // login's sudo password is asked at install when it has no passwordless sudo
  sudo?: boolean;
  // .env names given random hex on the first install, kept after
  secrets?: string[];
  // what the person should know once it's up: a first login, a setup page
  note?: string;
  install: string;
  remove: string;
};

// the sh functions every recipe runs under
export const helpers = `
case "$(uname -m)" in
  x86_64|amd64) A=amd64; X=x86_64; XA=x64 ;;
  aarch64|arm64) A=arm64; X=aarch64; XA=arm64 ;;
  *) echo "unsupported machine: $(uname -m)" >&2; exit 3 ;;
esac
# the distribution and its release, for vendor apt repositories: debian trixie, ubuntu noble
DISTRO=$(. /etc/os-release; echo "$ID")
CODENAME=$(. /etc/os-release; echo "$VERSION_CODENAME")
data="$dir/data"
shared="$HOME/.phosphorus/services/.shared"
mkdir -p "$data" "$shared"
# sudo without a password where the login has that, else by the password given at
# install ($SUDO_ASKPASS, set up by the launch); a recipe's "sudo -n" means this too
sudo() {
  [ "$1" = -n ] && shift
  if command sudo -n true 2>/dev/null; then command sudo -n "$@"
  elif [ -n "$SUDO_ASKPASS" ]; then command sudo -A "$@"
  else echo "needs sudo for $(id -un): install it again with its sudo password" >&2; return 3; fi
}
need_sudo() { sudo true || exit 3; }
apt_fresh=0
# apt packages installed, the lists refreshed once a run; their services not started by apt
apt_get() {
  command -v apt-get >/dev/null 2>&1 || { echo "needs a Debian or Ubuntu host: there's no apt-get here" >&2; exit 3; }
  need_sudo
  if [ "$apt_fresh" = 0 ]; then sudo -n apt-get update -q; apt_fresh=1; fi
  sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -q -o Dpkg::Options::=--force-confold "$@"
}
# a vendor apt repository: name, its key's URL, its deb line ($KEYRING the key's path)
apt_repo() {
  need_sudo
  command -v gpg >/dev/null 2>&1 || apt_get gnupg ca-certificates
  sudo -n mkdir -p /etc/apt/keyrings
  curl -fsSL "$2" | gpg --dearmor | sudo -n tee "/etc/apt/keyrings/$1.gpg" >/dev/null
  KEYRING="/etc/apt/keyrings/$1.gpg"
  echo "$3" | sed "s|\\$KEYRING|$KEYRING|g" | sudo -n tee "/etc/apt/sources.list.d/$1.list" >/dev/null
  apt_fresh=0
}
# a package's system service on or off
sys_on() { need_sudo; sudo -n systemctl enable "$1"; sudo -n systemctl restart "$1"; }
sys_off() { sudo -n systemctl disable --now "$1" 2>/dev/null || true; }
# packages removed, purged too unless the data is kept
apt_gone() {
  need_sudo
  if [ "$KEEP" = 1 ]; then sudo -n apt-get remove -y -q "$@" || true; else sudo -n apt-get purge -y -q "$@" || true; fi
}
fetch() { curl -fsSL --retry 3 -o "$2" "$1"; }
gh_release() { curl -fsSL -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$1/releases/latest"; }
# the latest release's tag of owner/repo
gh_tag() { gh_release "$1" | sed -n 's/.*"tag_name": *"\\([^"]*\\)".*/\\1/p' | head -1; }
# the URL of the latest release's asset whose whole file name matches an extended regex
gh_asset() {
  u=$(gh_release "$1" | sed -n 's/.*"browser_download_url": *"\\([^"]*\\)".*/\\1/p' | grep -E "/($2)\\$" | head -1)
  [ -n "$u" ] || { echo "no release asset of $1 is named like $2" >&2; exit 4; }
  echo "$u"
}
# an archive (.tar.gz, .tgz, .tar.xz, .zip) from a URL into a folder, emptied
# first, its one top folder stripped
unpack() {
  t=$(mktemp -d); f="$t/a"
  fetch "$1" "$f"
  mkdir -p "$t/x"
  case "$1" in
    *.zip) python3 -m zipfile -e "$f" "$t/x" ;;
    *.tar.xz|*.txz) tar -xJf "$f" -C "$t/x" ;;
    *) tar -xzf "$f" -C "$t/x" ;;
  esac
  rm -rf "$2"; mkdir -p "$(dirname "$2")"
  if [ "$(ls -A "$t/x" | wc -l)" = 1 ] && [ -d "$t/x/$(ls -A "$t/x")" ]; then mv "$t/x/$(ls -A "$t/x")" "$2"; else mv "$t/x" "$2"; fi
  chmod -R u+rwX "$2"
  rm -rf "$t"
}
# one binary from a URL to $dir/bin/<name>, executable
bin_from() { mkdir -p "$dir/bin"; fetch "$1" "$dir/bin/$2.new"; chmod 755 "$dir/bin/$2.new"; mv "$dir/bin/$2.new" "$dir/bin/$2"; }
# Node 22 under ~/.local/node when node is missing or older than 20
node_ensure() {
  if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; then return; fi
  v=$(curl -fsSL https://nodejs.org/dist/index.json | python3 -c 'import json,sys; print(next(r["version"] for r in json.load(sys.stdin) if r["version"].startswith("v22.")))')
  unpack "https://nodejs.org/dist/$v/node-$v-linux-$XA.tar.xz" "$HOME/.local/node"
  PATH="$HOME/.local/node/bin:$PATH"
}
# uv, the Python installer, under ~/.local/bin: any Python version a recipe asks for
uv_ensure() {
  command -v uv >/dev/null 2>&1 && return
  curl -fsSL https://astral.sh/uv/install.sh | env UV_NO_MODIFY_PATH=1 sh
  PATH="$HOME/.local/bin:$PATH"
}
# a virtualenv in $dir/venv on Python 3.x (default 3.12), packages installed into it
py_venv() {
  uv_ensure
  [ -x "$dir/venv/bin/python" ] || uv venv -q --python "\${PYV:-3.12}" "$dir/venv"
  [ $# -eq 0 ] || VIRTUAL_ENV="$dir/venv" uv pip install -q --upgrade "$@"
}
# a JRE when there's no java
java_ensure() { command -v java >/dev/null 2>&1 || apt_get default-jre-headless; }
# FrankenPHP, PHP and a web server in one binary, shared by the PHP apps
php_ensure() {
  if [ ! -x "$shared/frankenphp" ] || [ "$OP" = update ]; then
    fetch "$(gh_asset php/frankenphp "frankenphp-linux-$X")" "$shared/frankenphp.new"
    chmod 755 "$shared/frankenphp.new"; mv "$shared/frankenphp.new" "$shared/frankenphp"
  fi
  PHP="$shared/frankenphp"
}
# the login's unit phos-<id>: its [Service] lines as arguments, the .env as its
# environment, restarted whenever it stops, started now and at every boot
unit() {
  u="$HOME/.config/systemd/user/phos-$ID.service"
  mkdir -p "$(dirname "$u")"
  {
    printf '[Unit]\\nDescription=%s, installed by phosphorus\\nStartLimitIntervalSec=0\\n\\n[Service]\\n' "$NAME"
    printf 'WorkingDirectory=%s\\nEnvironmentFile=%s/.env\\nEnvironment=PATH=%s\\nRestart=always\\nRestartSec=5\\n' "$dir" "$dir" "$PATH"
    for l in "$@"; do printf '%s\\n' "$l"; done
    printf '\\n[Install]\\nWantedBy=default.target\\n'
  } > "$u"
  systemctl --user daemon-reload
  systemctl --user enable "phos-$ID.service"
  systemctl --user restart "phos-$ID.service"
}
unit_gone() {
  systemctl --user disable --now "phos-$ID.service" 2>/dev/null || true
  rm -f "$HOME/.config/systemd/user/phos-$ID.service"
  systemctl --user daemon-reload 2>/dev/null || true
}
`;

// a value single-quoted for sh
export const q = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;

// the .env every recipe reads: the place it runs, the login's ids, its secrets made once
export function envSetup(r: { port: number; secrets: string[] }, w: { ip: string; domain: string; url: string }) {
  return (
    "touch .env; chmod 600 .env\n" +
    'setenv() { grep -v "^$1=" .env > .env.new || true; printf \'%s=%s\\n\' "$1" "$2" >> .env.new; mv .env.new .env; chmod 600 .env; }\n' +
    `setenv IP ${q(w.ip)}\nsetenv PORT ${r.port}\nsetenv DOMAIN ${q(w.domain)}\nsetenv URL ${q(w.url)}\n` +
    'setenv PUID "$(id -u)"\nsetenv PGID "$(id -g)"\n' +
    'setenv TZ "$(cat /etc/timezone 2>/dev/null || timedatectl show -p Timezone --value 2>/dev/null || echo UTC)"\n' +
    (r.secrets.length
      ? `for k in ${r.secrets.join(" ")}; do grep -q "^$k=" .env || setenv "$k" "$(od -An -N32 -tx1 /dev/urandom | tr -d ' \\n')"; done\n`
      : "")
  );
}

// .env's names as sh variables, exported for what the recipe starts
export const loadEnv = "set -a; . ./.env; set +a\n";

// a dashboard-icons file off jsDelivr
const iconOf = (name: string) =>
  !name
    ? ""
    : name.endsWith(".svg")
      ? `https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/${name}`
      : `https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/${name}.png`;

// recipes as the catalogue's services, ports 18100 + their place unless their own:
// the list is append only, so an installed copy keeps its port across updates
export function servicesOf(recipes: Recipe[]): Service[] {
  return recipes.map((r, i) => ({
    id: r.id,
    name: r.name,
    tagline: r.tagline,
    about: r.note ? `${r.about} ${r.note}` : r.about,
    features: [],
    category: r.category,
    by: new URL(r.home).hostname.replace(/^www\./, ""),
    repo: r.home,
    icon: iconOf(r.icon ?? r.id),
    port: r.port ?? 18100 + i,
    os: ["linux"],
    compat: r.sudo
      ? "Linux with apt: Debian 12+ or Ubuntu 22.04+, amd64 or arm64"
      : "Linux with systemd, amd64 or arm64",
    needs: r.sudo
      ? "sudo for your login on the host: it installs system packages, your sudo password asked when it needs one"
      : "nothing but your login: installed in your home, no root",
    data: ["data", ".env"],
    install: "",
    update: "",
    remove: "",
    native: { install: r.install, remove: r.remove, secrets: r.secrets ?? [], sudo: !!r.sudo },
  }));
}
