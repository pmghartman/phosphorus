// the catalogue's recipes, 61-80: development, AI, home, security and files
import type { Recipe } from "../native.ts";

// Node 24 with npm under .shared/node24 when the host's node is older or has no npm
const node24 = `if ! command -v npm >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 24 ]; then
  if [ ! -x "$shared/node24/bin/node" ] || [ "$OP" = update ]; then
    v=$(curl -fsSL https://nodejs.org/dist/index.json | python3 -c 'import json,sys; print(next(r["version"] for r in json.load(sys.stdin) if r["version"].startswith("v24.")))')
    unpack "https://nodejs.org/dist/$v/node-$v-linux-$XA.tar.xz" "$shared/node24"
  fi
  PATH="$shared/node24/bin:$PATH"
fi`;

export const recipes: Recipe[] = [
  {
    id: "code-server",
    name: "code-server",
    category: "development",
    tagline: "VS Code in the browser",
    about: "VS Code running on the host, opened on the login's home folder.",
    home: "https://coder.com/docs/code-server",
    note: "It has no password of its own: the Phosphorus login guards it.",
    install: `unpack "$(gh_asset coder/code-server "code-server-[0-9.]+-linux-$A[.]tar[.]gz")" "$dir/app"
unit "ExecStart=$dir/app/bin/code-server --bind-addr $IP:$PORT --auth none --disable-telemetry --disable-update-check --config $data/config.yaml --user-data-dir $data/user --extensions-dir $data/extensions $HOME"`,
    remove: "unit_gone",
  },
  {
    id: "jupyter",
    name: "JupyterLab",
    category: "development",
    tagline: "notebooks for code and data",
    about: "JupyterLab with Python; notebooks live in its data/notebooks.",
    home: "https://jupyter.org",
    note: "It runs without a token: the Phosphorus login guards it.",
    install: `py_venv jupyterlab
mkdir -p "$data/notebooks"
unit "Environment=JUPYTER_CONFIG_DIR=$data/config" "Environment=JUPYTER_DATA_DIR=$data/share" "ExecStart=$dir/venv/bin/jupyter lab --no-browser --ip=$IP --port=$PORT --ServerApp.root_dir=$data/notebooks --IdentityProvider.token= --ServerApp.allow_remote_access=True --ServerApp.allow_origin=$URL"`,
    remove: "unit_gone",
  },
  {
    id: "n8n",
    name: "n8n",
    category: "automation",
    tagline: "workflow automation",
    about: "Connect apps and APIs into automated workflows, visually.",
    home: "https://n8n.io",
    note: "Make its owner account on first open.",
    install: `${node24}
npm install --prefix "$dir/app" --omit=dev --no-audit --no-fund n8n@latest
unit "Environment=N8N_LISTEN_ADDRESS=$IP" "Environment=N8N_PORT=$PORT" "Environment=N8N_USER_FOLDER=$data" "Environment=N8N_EDITOR_BASE_URL=$URL/" "Environment=WEBHOOK_URL=$URL/" "Environment=N8N_PROXY_HOPS=1" "Environment=GENERIC_TIMEZONE=$TZ" "ExecStart=$dir/app/node_modules/.bin/n8n start"`,
    remove: "unit_gone",
  },
  {
    id: "node-red",
    name: "Node-RED",
    category: "automation",
    tagline: "flow-based wiring for devices and APIs",
    about: "Wire together devices, APIs and services in a browser editor; its flows and settings.js live in its data.",
    home: "https://nodered.org",
    install: `${node24}
npm install --prefix "$dir/app" --omit=dev --no-audit --no-fund node-red@latest
[ -f "$data/settings.js" ] || cat > "$data/settings.js" <<'EOF'
module.exports = {
  uiHost: process.env.IP,
  uiPort: Number(process.env.PORT),
  flowFile: "flows.json",
};
EOF
unit "ExecStart=$(command -v node) $dir/app/node_modules/node-red/red.js --userDir $data"`,
    remove: "unit_gone",
  },
  {
    id: "pgadmin",
    name: "pgAdmin",
    category: "development",
    tagline: "PostgreSQL administration",
    about: "The PostgreSQL admin UI, in its single-user desktop mode.",
    home: "https://www.pgadmin.org",
    note: "It has no login of its own: the Phosphorus login guards it.",
    install: `py_venv pgadmin4 gunicorn
cat > "$dir/config_phos.py" <<EOF
SERVER_MODE = False
DATA_DIR = "$data"
UPGRADE_CHECK_ENABLED = False
EOF
pg=$(ls -d "$dir"/venv/lib/python3*/site-packages/pgadmin4 | head -1)
unit "Environment=CONFIG_DISTRO_FILE_PATH=$dir/config_phos.py" "ExecStart=$dir/venv/bin/gunicorn --bind $IP:$PORT --workers 1 --threads 25 --timeout 86400 --limit-request-line 0 --chdir $pg pgAdmin4:app"`,
    remove: "unit_gone",
  },
  {
    id: "adminer",
    name: "Adminer",
    category: "development",
    tagline: "database management in one page",
    about: "A single-page admin for MySQL, PostgreSQL, SQLite and more.",
    home: "https://www.adminer.org",
    note: "Sign in with a database server's own user.",
    install: `php_ensure
mkdir -p "$dir/www"
fetch "$(gh_asset vrana/adminer "adminer-[0-9.]+[.]php")" "$dir/www/index.php"
unit "ExecStart=$PHP php-server --listen $IP:$PORT --root $dir/www"`,
    remove: "unit_gone",
  },
  {
    id: "open-webui",
    name: "Open WebUI",
    category: "ai",
    tagline: "a chat UI for local models",
    about: "A ChatGPT-style interface for Ollama and OpenAI-compatible models.",
    home: "https://openwebui.com",
    secrets: ["WEBUI_SECRET_KEY"],
    note: "The first account made is its admin; add Ollama or an OpenAI-compatible API in its settings.",
    install: `PYV=3.11 py_venv open-webui
unit "Environment=DATA_DIR=$data" "Environment=WEBUI_URL=$URL" "ExecStart=$dir/venv/bin/open-webui serve --host $IP --port $PORT"`,
    remove: "unit_gone",
  },
  {
    id: "searxng",
    name: "SearXNG",
    category: "ai",
    tagline: "a private metasearch engine",
    about: "Searches many engines at once without tracking you; its settings.yml is in its data.",
    home: "https://docs.searxng.org",
    secrets: ["SEARXNG_SECRET"],
    install: `unpack "https://github.com/searxng/searxng/archive/refs/heads/master.tar.gz" "$dir/app"
v=$(date +%Y.%m.%d)
cat > "$dir/app/searx/version_frozen.py" <<EOF
VERSION_STRING = "$v"
VERSION_TAG = "$v"
DOCKER_TAG = "$v"
GIT_URL = "https://github.com/searxng/searxng"
GIT_BRANCH = "master"
EOF
py_venv setuptools wheel pyyaml msgspec typing-extensions pybind11 granian
VIRTUAL_ENV="$dir/venv" uv pip install -q --no-build-isolation -e "$dir/app"
[ -f "$data/settings.yml" ] || cat > "$data/settings.yml" <<'EOF'
use_default_settings: true
search:
  formats:
    - html
    - json
EOF
unit "WorkingDirectory=$dir/app" "Environment=SEARXNG_SETTINGS_PATH=$data/settings.yml" "Environment=SEARXNG_BASE_URL=$URL/" "Environment=GRANIAN_INTERFACE=wsgi" "Environment=GRANIAN_HOST=$IP" "Environment=GRANIAN_PORT=$PORT" "ExecStart=$dir/venv/bin/granian searx.webapp:app"`,
    remove: "unit_gone",
  },
  {
    id: "libretranslate",
    name: "LibreTranslate",
    category: "ai",
    tagline: "machine translation, offline",
    about: "A translation API and page on open models, kept in its data.",
    home: "https://libretranslate.com",
    note: "Its first start downloads the language models, a few GB; it answers once they're in.",
    install: `PYV=3.11 py_venv libretranslate
unit "Environment=XDG_DATA_HOME=$data/share" "Environment=XDG_CACHE_HOME=$data/cache" "ExecStart=$dir/venv/bin/libretranslate --host $IP --port $PORT"`,
    remove: "unit_gone",
  },
  {
    id: "esphome",
    name: "ESPHome",
    category: "home",
    tagline: "firmware for ESP32 and ESP8266 devices",
    about: "Configure and flash microcontrollers for home automation from YAML, kept in its data/config.",
    home: "https://esphome.io",
    note: "Flash a new board once over USB from the browser; updates go over the air.",
    install: `py_venv esphome
mkdir -p "$data/config"
unit "Environment=PLATFORMIO_CORE_DIR=$data/platformio" "ExecStart=$dir/venv/bin/esphome dashboard --address $IP --port $PORT $data/config"`,
    remove: "unit_gone",
  },
  {
    id: "vaultwarden",
    name: "Vaultwarden",
    category: "security",
    tagline: "a Bitwarden-compatible password manager",
    about:
      "A light Bitwarden server, from the apt.crunchy.run Debian packages; the Bitwarden apps and extensions sync with it.",
    home: "https://github.com/dani-garcia/vaultwarden",
    sudo: true,
    note: "Create your account on first open, then give the Bitwarden apps its address as the server.",
    install: `apt_repo vaultwarden "https://apt.crunchy.run/keys/signing-key.asc" "deb [signed-by=/etc/apt/keyrings/vaultwarden.gpg] https://apt.crunchy.run/vaultwarden $CODENAME main"
apt_get vaultwarden vaultwarden-web-vault
sudo -n mkdir -p /etc/systemd/system/vaultwarden.service.d
sudo -n tee /etc/systemd/system/vaultwarden.service.d/phosphorus.conf >/dev/null <<EOF
[Service]
Environment=ROCKET_ADDRESS=$IP
Environment=ROCKET_PORT=$PORT
Environment=DOMAIN=$URL
EOF
sudo -n systemctl daemon-reload
sys_on vaultwarden`,
    remove: `sys_off vaultwarden
apt_gone vaultwarden vaultwarden-web-vault
sudo -n rm -rf /etc/systemd/system/vaultwarden.service.d
sudo -n rm -f /etc/apt/sources.list.d/vaultwarden.list /etc/apt/keyrings/vaultwarden.gpg
sudo -n systemctl daemon-reload`,
  },
  {
    id: "syncthing",
    name: "Syncthing",
    category: "files",
    tagline: "continuous file sync between devices",
    about: "Peer-to-peer folder sync; your devices reach it on the host's sync port 22000.",
    home: "https://syncthing.net",
    install: `unpack "$(gh_asset syncthing/syncthing "syncthing-linux-$A-v[0-9.]+[.]tar[.]gz")" "$dir/app"
unit "ExecStart=$dir/app/syncthing serve --home=$data --gui-address=http://$IP:$PORT --no-browser --no-restart --no-upgrade"`,
    remove: "unit_gone",
  },
  {
    id: "filebrowser",
    name: "File Browser",
    category: "files",
    tagline: "a web file manager",
    about: "Upload, download, edit and share the files in its data/files.",
    home: "https://filebrowser.org",
    note: "It runs without a login of its own: the Phosphorus login guards it.",
    install: `unpack "$(gh_asset filebrowser/filebrowser "linux-$A-filebrowser[.]tar[.]gz")" "$dir/app"
mkdir -p "$data/files"
unit "ExecStart=$dir/app/filebrowser -d $data/filebrowser.db -a $IP -p $PORT -r $data/files --noauth"`,
    remove: "unit_gone",
  },
  {
    id: "pairdrop",
    name: "PairDrop",
    category: "files",
    tagline: "send files between devices, AirDrop style",
    about: "Drop files between browsers on any device, peer to peer.",
    home: "https://pairdrop.net",
    install: `${node24}
t=$(gh_tag schlagmichdoch/PairDrop)
unpack "https://github.com/schlagmichdoch/PairDrop/archive/refs/tags/$t.tar.gz" "$dir/app"
(cd "$dir/app" && npm install --omit=dev --no-audit --no-fund)
unit "WorkingDirectory=$dir/app" "ExecStart=$(command -v node) server/index.js"`,
    remove: "unit_gone",
  },
  {
    id: "psitransfer",
    name: "PsiTransfer",
    category: "files",
    tagline: "share files by link",
    about: "Upload files and share them with a link, optionally with a password and expiry.",
    home: "https://github.com/psi-4ward/psitransfer",
    install: `${node24}
unpack "$(gh_asset psi-4ward/psitransfer "psitransfer-v[0-9.]+[.]tar[.]gz")" "$dir/app"
(cd "$dir/app" && npm install --omit=dev --no-audit --no-fund)
mkdir -p "$data/files"
unit "WorkingDirectory=$dir/app" "Environment=NODE_ENV=production" "Environment=PSITRANSFER_IFACE=$IP" "Environment=PSITRANSFER_PORT=$PORT" "Environment=PSITRANSFER_UPLOAD_DIR=$data/files" "ExecStart=$(command -v node) app.js"`,
    remove: "unit_gone",
  },
  {
    id: "duplicati",
    name: "Duplicati",
    category: "backup",
    tagline: "encrypted backups to anywhere",
    about: "Scheduled, encrypted, deduplicated backups to cloud storage or another host.",
    home: "https://duplicati.com",
    secrets: ["DUPLICATI_PASS", "DUPLICATI__SETTINGS_ENCRYPTION_KEY"],
    note: "Sign in with DUPLICATI_PASS from its .env.",
    install: `unpack "$(gh_asset duplicati/duplicati "duplicati-[0-9.]+_stable_[0-9-]+-linux-$XA-cli[.]zip")" "$dir/app"
(cd "$dir/app" && sh set-permissions.sh)
chmod 700 "$data"
h=$(echo "$URL" | sed 's|^[a-z]*://||; s|[:/].*$||')
icu=0
ls /usr/lib/*/libicuuc.so.* /usr/lib/libicuuc.so.* >/dev/null 2>&1 || icu=1
[ "$OP" = update ] || "$dir/app/duplicati-server" --server-datafolder="$data" --webservice-password-init="$DUPLICATI_PASS"
unit "Environment=DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=$icu" "ExecStart=$dir/app/duplicati-server --server-datafolder=$data --webservice-interface=$IP --webservice-port=$PORT --webservice-allowed-hostnames=$h --disable-update-check"`,
    remove: "unit_gone",
  },
  {
    id: "thelounge",
    name: "The Lounge",
    category: "communication",
    tagline: "IRC that stays connected",
    about: "A modern web IRC client that keeps you connected and scrolls back.",
    home: "https://thelounge.chat",
    secrets: ["LOUNGE_PASS"],
    note: "Sign in as the login's own name with LOUNGE_PASS from its .env.",
    install: `${node24}
npm install --prefix "$dir/app" --omit=dev --no-audit --no-fund thelounge@latest
export THELOUNGE_HOME="$data"
mkdir -p "$data/users"
u=$(id -un)
[ -f "$data/users/$u.json" ] || "$dir/app/node_modules/.bin/thelounge" add "$u" --password "$LOUNGE_PASS" --save-logs
unit "Environment=THELOUNGE_HOME=$data" "ExecStart=$dir/app/node_modules/.bin/thelounge start -c host=$IP -c port=$PORT -c reverseProxy=true"`,
    remove: "unit_gone",
  },
  {
    id: "element",
    name: "Element",
    category: "communication",
    tagline: "a Matrix chat client",
    about: "The Matrix web client; sign in to any homeserver.",
    home: "https://element.io",
    note: "It starts on matrix.org; set another default homeserver in its data/config.json.",
    install: `php_ensure
unpack "$(gh_asset element-hq/element-web "element-v[0-9.]+[.]tar[.]gz")" "$dir/app"
[ -f "$data/config.json" ] || cp "$dir/app/config.sample.json" "$data/config.json"
ln -sf "$data/config.json" "$dir/app/config.json"
unit "ExecStart=$PHP php-server --listen $IP:$PORT --root $dir/app"`,
    remove: "unit_gone",
  },
  {
    id: "crafty",
    name: "Crafty Controller",
    category: "games",
    tagline: "Minecraft servers from a web panel",
    about: "Creates, runs and backs up Minecraft servers, kept in its data, with Java 25 from apt.",
    home: "https://craftycontrol.com",
    icon: "crafty-controller",
    sudo: true,
    note: "Sign in as admin with the password in its data/config/default-creds.txt; it serves HTTPS with its own certificate.",
    install: `apt_get openjdk-25-jre-headless
t=$(curl -fsSL "https://gitlab.com/api/v4/projects/crafty-controller%2Fcrafty-4/releases/permalink/latest" | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"])')
unpack "https://gitlab.com/crafty-controller/crafty-4/-/archive/$t/crafty-4-$t.tar.gz" "$dir/app"
py_venv -r "$dir/app/requirements.txt"
mkdir -p "$data/config" "$data/servers" "$data/backups" "$data/logs" "$data/import"
if [ -z "$(ls -A "$data/config")" ]; then cp -r "$dir/app/app/config/." "$data/config/"; else cp -f "$dir/app/app/config/version.json" "$data/config/version.json"; fi
rm -rf "$dir/app/app/config"; ln -s "$data/config" "$dir/app/app/config"
for d in servers backups logs import; do rm -rf "$dir/app/$d"; ln -s "$data/$d" "$dir/app/$d"; done
python3 - "$data/config/config.json" "$PORT" <<'EOF'
import json, os, sys
p = sys.argv[1]
c = json.load(open(p)) if os.path.exists(p) else {}
c["https_port"] = int(sys.argv[2])
json.dump(c, open(p, "w"), indent=4)
EOF
unit "WorkingDirectory=$dir/app" "ExecStart=$dir/venv/bin/python main.py -d -i"`,
    remove: "unit_gone",
  },
  {
    id: "kiwix",
    name: "Kiwix",
    category: "media",
    tagline: "Wikipedia and whole libraries, offline",
    about: "Serves ZIM archives, from Wikipedia to Project Gutenberg's books, to read and search in the browser.",
    home: "https://kiwix.org",
    note: "Put .zim files from library.kiwix.org in its data/zim, then restart it.",
    install: `unpack "https://download.kiwix.org/release/kiwix-tools/kiwix-tools_linux-$X.tar.gz" "$dir/app"
mkdir -p "$data/zim"
cat > "$dir/library.sh" <<'EOF'
#!/bin/sh
# the library rebuilt from the ZIM files in data/zim at every start
cd "$(dirname "$0")"
rm -f data/library.new.xml
for z in "$PWD"/data/zim/*.zim; do
  if [ -f "$z" ]; then app/kiwix-manage data/library.new.xml add "$z"; fi
done
[ -f data/library.new.xml ] || echo '<library version="20110515"></library>' > data/library.new.xml
mv data/library.new.xml data/library.xml
EOF
chmod 755 "$dir/library.sh"
unit "ExecStartPre=$dir/library.sh" "ExecStart=$dir/app/kiwix-serve --address=$IP --port=$PORT --monitorLibrary --library $data/library.xml"`,
    remove: "unit_gone",
  },
];
