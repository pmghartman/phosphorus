// the catalogue's recipes, 21-40: downloads, documents and productivity
import type { Recipe } from "../native.ts";

// Node.js, the newest of a major line, under $dir/node and first on the PATH
const node = (
  major: number,
) => `v=$(curl -fsSL https://nodejs.org/dist/index.json | python3 -c 'import json,sys; print(next(r["version"] for r in json.load(sys.stdin) if r["version"].startswith("v${major}.")))')
[ "$("$dir/node/bin/node" -v 2>/dev/null)" = "$v" ] || unpack "https://nodejs.org/dist/$v/node-$v-linux-$XA.tar.xz" "$dir/node"
PATH="$dir/node/bin:$PATH"`;

// a folder of static files served by FrankenPHP
const serve = (root: string) => `php_ensure
unit "ExecStart=$PHP php-server --listen $IP:$PORT --root ${root}"`;

// the host the mesh opens it at, from $URL
const host = `h=$(echo "$URL" | sed -E 's|^[a-z]+://||; s|[:/].*||')`;

// the PostgreSQL cluster of version 17 or later: its port
const pgPort = `pgport=$(pg_lsclusters -h | awk '$1 >= 17 {print $3; exit}')`;

export const recipes: Recipe[] = [
  {
    id: "sabnzbd",
    name: "SABnzbd",
    category: "downloads",
    tagline: "a Usenet downloader",
    about: "Downloads, verifies and unpacks from Usenet, with a setup wizard on first open.",
    home: "https://sabnzbd.org",
    sudo: true,
    note: "Downloads land in its data/Downloads.",
    install: `apt_get par2 7zip
apt_get unrar || echo "no unrar package (Debian keeps it in non-free): RAR posts won't unpack"
unpack "$(gh_asset sabnzbd/sabnzbd "SABnzbd-[0-9.]+-src[.]tar[.]gz")" "$dir/app"
py_venv -r "$dir/app/requirements.txt"
(cd "$dir/app" && "$dir/venv/bin/python" tools/make_mo.py) || true
if [ ! -f "$data/sabnzbd.ini" ]; then
  ${host}
  cat > "$data/sabnzbd.ini" <<EOF
[misc]
host_whitelist = $h,
local_ranges = 100.64.0.0/10, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7
EOF
fi
unit "ExecStart=$dir/venv/bin/python $dir/app/SABnzbd.py --browser 0 --server $IP:$PORT --config-file $data/sabnzbd.ini"`,
    remove: "unit_gone",
  },
  {
    id: "nzbget",
    name: "NZBGet",
    category: "downloads",
    tagline: "an efficient Usenet downloader",
    about: "A fast Usenet downloader with unrar and 7-Zip built in; downloads land in its data/downloads.",
    home: "https://nzbget.com",
    note: "Its first login is nzbget / tegbzn6789, change it first.",
    install: `t=$(mktemp -d)
fetch "$(gh_asset nzbgetcom/nzbget "nzbget-[0-9.]+-bin-linux[.]run")" "$t/nzbget.run"
mkdir -p "$dir/app"
sh "$t/nzbget.run" --destdir "$dir/app" --silent
rm -rf "$t"
[ -f "$data/nzbget.conf" ] || sed "s|^MainDir=.*|MainDir=$data/downloads|" "$dir/app/webui/nzbget.conf.template" > "$data/nzbget.conf"
unit "ExecStart=$dir/app/nzbget -s -c $data/nzbget.conf -o OutputMode=log -o ControlIP=$IP -o ControlPort=$PORT"`,
    remove: "unit_gone",
  },
  {
    id: "jackett",
    name: "Jackett",
    category: "downloads",
    tagline: "torrent indexers behind one API",
    about: "A proxy that turns tracker searches into one Torznab API.",
    home: "https://github.com/Jackett/Jackett",
    install: `case "$A" in arm64) ja=ARM64 ;; *) ja=AMDx64 ;; esac
unpack "$(gh_asset Jackett/Jackett "Jackett[.]Binaries[.]Linux$ja[.]tar[.]gz")" "$dir/app"
inv=0
ls /usr/lib/*/libicuuc.so.* >/dev/null 2>&1 || inv=1
unit "Environment=XDG_CONFIG_HOME=$data" "Environment=DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=$inv" "ExecStart=$dir/app/jackett --NoRestart --NoUpdates --ListenPublic --Port $PORT"`,
    remove: "unit_gone",
  },
  {
    id: "metube",
    name: "MeTube",
    category: "downloads",
    tagline: "download videos from the web",
    about: "A web UI over yt-dlp: paste a link, get the video or audio in its data/downloads.",
    home: "https://github.com/alexta69/metube",
    install: `${node(22)}
uv_ensure
case "$A" in arm64) fa=linuxarm64 ;; *) fa=linux64 ;; esac
unpack "$(gh_asset BtbN/FFmpeg-Builds "ffmpeg-n8[.]1-latest-$fa-gpl-8[.]1[.]tar[.]xz")" "$dir/ffmpeg"
PATH="$dir/ffmpeg/bin:$PATH"
t=$(gh_tag alexta69/metube)
unpack "https://github.com/alexta69/metube/archive/refs/tags/$t.tar.gz" "$dir/app"
(
  cd "$dir/app/ui"
  pm=$(sed -n 's/.*"packageManager": *"\\([^"]*\\)".*/\\1/p' package.json)
  CI=true npx -y "$pm" install
  npx -y "$pm" run build
)
(cd "$dir/app" && UV_PROJECT_ENVIRONMENT="$dir/venv" uv sync -q --frozen --no-dev --python 3.13)
mkdir -p "$data/downloads" "$data/state"
unit "Environment=HOST=$IP" "Environment=BASE_DIR=$dir/app" "Environment=DOWNLOAD_DIR=$data/downloads" "Environment=TEMP_DIR=$data/downloads" "Environment=STATE_DIR=$data/state" "ExecStart=$dir/venv/bin/python $dir/app/app/main.py"`,
    remove: "unit_gone",
  },
  {
    id: "autobrr",
    name: "autobrr",
    category: "downloads",
    tagline: "grab releases the moment they're announced",
    about:
      "Watches trackers' IRC announce channels and RSS, filters releases and sends them to your torrent client or the *arrs.",
    home: "https://autobrr.com",
    note: "Its first open asks for an account.",
    install: `unpack "$(gh_asset autobrr/autobrr "autobrr_[0-9.]+_linux_($X|$A)[.]tar[.]gz")" "$dir/app"
unit "Environment=AUTOBRR__HOST=$IP" "Environment=AUTOBRR__PORT=$PORT" "Environment=AUTOBRR__CHECK_FOR_UPDATES=false" "ExecStart=$dir/app/autobrr --config $data"`,
    remove: "unit_gone",
  },
  {
    id: "nextcloud",
    name: "Nextcloud",
    category: "files",
    tagline: "files, calendar and contacts in your own cloud",
    about: "The self-hosted cloud suite, on FrankenPHP and SQLite here.",
    home: "https://nextcloud.com",
    note: "Its setup page asks for an admin account on first open.",
    install: `php_ensure
export NEXTCLOUD_CONFIG_DIR="$data/config/" PHP_INI_SCAN_DIR="$dir/php.d"
mkdir -p "$data/config" "$data/apps" "$data/files" "$dir/php.d"
chmod 770 "$data/files"
unpack "https://download.nextcloud.com/server/releases/latest.zip" "$dir/app"
ln -sfn "$data/apps" "$dir/app/custom_apps"
cat > "$dir/php.d/nextcloud.ini" <<'EOF'
memory_limit = 1G
upload_max_filesize = 16G
post_max_size = 16G
max_execution_time = 3600
max_input_time = 3600
output_buffering = 0
apc.enable_cli = 1
opcache.interned_strings_buffer = 32
EOF
${host}
case "$URL" in https:*) proto=https ;; *) proto=http ;; esac
cat > "$data/config/phosphorus.config.php" <<EOF
<?php
\\$CONFIG = array(
  'apps_paths' => array(
    array('path' => '$dir/app/apps', 'url' => '/apps', 'writable' => false),
    array('path' => '$data/apps', 'url' => '/custom_apps', 'writable' => true),
  ),
  'trusted_domains' => array('$h', '$IP:$PORT'),
  'overwrite.cli.url' => '$URL',
  'overwriteprotocol' => '$proto',
  'memcache.local' => '\\OC\\Memcache\\APCu',
);
EOF
if [ ! -f "$data/config/config.php" ]; then
  touch "$data/config/CAN_INSTALL"
  cat > "$data/config/autoconfig.php" <<EOF
<?php
\\$AUTOCONFIG = array('directory' => '$data/files', 'dbtype' => 'sqlite');
EOF
elif grep -q "'installed' => true" "$data/config/config.php"; then
  "$PHP" php-cli "$dir/app/occ" upgrade -n
  "$PHP" php-cli "$dir/app/occ" maintenance:mode --off -n || true
fi
unit "Environment=NEXTCLOUD_CONFIG_DIR=$data/config/" "Environment=PHP_INI_SCAN_DIR=$dir/php.d" "ExecStart=$PHP php-server --listen $IP:$PORT --root $dir/app"`,
    remove: "unit_gone",
  },
  {
    id: "paperless-ngx",
    name: "Paperless-ngx",
    category: "documents",
    tagline: "scan, index and archive every paper",
    about: "Turns scans into a searchable archive with OCR, tags and correspondents; Redis beside it.",
    home: "https://docs.paperless-ngx.com",
    sudo: true,
    secrets: ["PAPERLESS_SECRET_KEY"],
    note: "Its first open asks for an admin account; documents dropped in data/consume are taken in.",
    install: `apt_get redis-server build-essential pkg-config default-libmysqlclient-dev libpq-dev fonts-liberation gettext ghostscript gnupg icc-profiles-free tesseract-ocr tesseract-ocr-eng unpaper pngquant jbig2dec qpdf file libmagic1 poppler-utils
sys_on redis-server
unpack "$(gh_asset paperless-ngx/paperless-ngx "paperless-ngx-v[0-9.]+[.]tar[.]xz")" "$dir/app"
PYV=3.12 py_venv
VIRTUAL_ENV="$dir/venv" uv pip install -q --index-strategy unsafe-best-match -r "$dir/app/requirements.txt"
mkdir -p "$data/data" "$data/media" "$data/consume"
cat > "$dir/paperless.env" <<EOF
PAPERLESS_REDIS=redis://localhost:6379
PAPERLESS_REDIS_PREFIX=paperless
PAPERLESS_DBENGINE=sqlite
PAPERLESS_DATA_DIR=$data/data
PAPERLESS_MEDIA_ROOT=$data/media
PAPERLESS_CONSUMPTION_DIR=$data/consume
PAPERLESS_STATICDIR=$dir/app/static
PAPERLESS_URL=$URL
PAPERLESS_TIME_ZONE=$TZ
PAPERLESS_CONFIGURATION_PATH=$data/paperless.conf
EOF
[ -f "$data/paperless.conf" ] || printf '# your own settings: https://docs.paperless-ngx.com/configuration/\\nPAPERLESS_OCR_LANGUAGE=eng\\n' > "$data/paperless.conf"
(set -a; . "$dir/paperless.env"; set +a; cd "$dir/app/src" && "$dir/venv/bin/python" manage.py migrate --no-input)
cat > "$dir/run.sh" <<EOF
#!/bin/bash
cd "$dir/app/src"
"$dir/venv/bin/celery" --app paperless worker --loglevel INFO &
"$dir/venv/bin/celery" --app paperless beat --loglevel INFO &
"$dir/venv/bin/python" manage.py document_consumer &
"$dir/venv/bin/granian" --interface asginl --ws --loop uvloop --host $IP --port $PORT --workers 1 paperless.asgi:application &
wait -n
exit 1
EOF
chmod 755 "$dir/run.sh"
unit "EnvironmentFile=$dir/paperless.env" "ExecStart=/bin/bash $dir/run.sh"`,
    remove: "unit_gone",
  },
  {
    id: "wikijs",
    name: "Wiki.js",
    category: "documents",
    tagline: "a wiki with a modern editor",
    about: "A wiki with Markdown and visual editors, search and git sync, on PostgreSQL.",
    home: "https://js.wiki",
    sudo: true,
    secrets: ["DB_SECRET"],
    note: "Its first login is admin@example.com / 12345678, and it asks for a new password.",
    install: `apt_get postgresql
sys_on postgresql
if [ "$(ls /usr/lib/postgresql | sort -n | tail -1)" -lt 17 ]; then
  apt_repo pgdg "https://www.postgresql.org/media/keys/ACCC4CF8.asc" "deb [signed-by=/etc/apt/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt $CODENAME-pgdg main"
  apt_get postgresql-17
  sys_on postgresql
fi
${pgPort}
pg() { (cd / && sudo -n -u postgres psql -p "$pgport" -tAc "$1"); }
[ "$(pg "SELECT 1 FROM pg_roles WHERE rolname='wikijs'")" = 1 ] || pg "CREATE ROLE wikijs LOGIN"
pg "ALTER ROLE wikijs PASSWORD '$DB_SECRET'"
[ "$(pg "SELECT 1 FROM pg_database WHERE datname='wikijs'")" = 1 ] || pg "CREATE DATABASE wikijs OWNER wikijs"
${node(26)}
unpack "$(gh_asset requarks/wiki "wiki-js[.]tar[.]gz")" "$dir/app"
mkdir -p "$data/wiki"
cat > "$dir/app/config.yml" <<EOF
port: $PORT
bindIP: $IP
db:
  host: localhost
  port: $pgport
  user: wikijs
  pass: '$DB_SECRET'
  db: wikijs
  schema: wiki
  ssl: false
logLevel: info
logFormat: default
offline: false
dataPath: $data/wiki
scheduler:
  workers: auto
EOF
unit "Environment=NODE_ENV=production" "ExecStart=/bin/sh -c 'cd $dir/app && exec $dir/node/bin/node --no-experimental-webstorage backend'"`,
    remove: `unit_gone
if [ "$KEEP" != 1 ]; then
  ${pgPort}
  (cd / && sudo -n -u postgres psql -p "$pgport" -c "DROP DATABASE IF EXISTS wikijs" -c "DROP ROLE IF EXISTS wikijs")
fi`,
  },
  {
    id: "trilium",
    name: "Trilium Notes",
    category: "documents",
    tagline: "a hierarchical notebook for a lifetime of notes",
    about: "TriliumNext: notes in a tree, scripting, relation maps and sync.",
    home: "https://github.com/TriliumNext/Trilium",
    note: "Its first open sets a password.",
    install: `unpack "$(gh_asset TriliumNext/Trilium "TriliumNotes-Server-v[0-9.]+-linux-$XA[.]tar[.]xz")" "$dir/app"
unit "Environment=TRILIUM_DATA_DIR=$data" "Environment=TRILIUM_NETWORK_HOST=$IP" "Environment=TRILIUM_NETWORK_PORT=$PORT" "ExecStart=/bin/sh -c 'cd $dir/app && exec ./node/bin/node main.mjs'"`,
    remove: "unit_gone",
  },
  {
    id: "memos",
    name: "Memos",
    category: "documents",
    tagline: "quick notes, timeline style",
    about: "A lightweight place for short notes and ideas, in Markdown.",
    home: "https://usememos.com",
    note: "The first account made is its admin.",
    install: `unpack "$(gh_asset usememos/memos "memos_[0-9.]+_linux_$A[.]tar[.]gz")" "$dir/app"
mkdir -p "$data/config"
unit "ExecStart=$dir/app/memos --addr $IP --port $PORT --data $data --config-dir $data/config --instance-url $URL"`,
    remove: "unit_gone",
  },
  {
    id: "stirling-pdf",
    name: "Stirling-PDF",
    category: "tools",
    tagline: "every PDF operation in one page",
    about:
      "Merge, split, convert, compress, sign and OCR PDFs locally; office conversions need LibreOffice on the host.",
    home: "https://www.stirlingpdf.com",
    sudo: true,
    note: "Its first login is admin / stirling, change it.",
    install: `apt_get tesseract-ocr ocrmypdf ghostscript qpdf poppler-utils
case "$A" in arm64) ja=aarch64 ;; *) ja=x64 ;; esac
unpack "https://api.adoptium.net/v3/binary/latest/25/ga/linux/$ja/jre/hotspot/normal/eclipse" "$dir/jre"
mkdir -p "$dir/app"
fetch "$(gh_asset Stirling-Tools/Stirling-PDF "Stirling-PDF-with-login[.]jar")" "$dir/app/Stirling-PDF.jar"
unit "Environment=SERVER_ADDRESS=$IP" "Environment=SERVER_PORT=$PORT" "SuccessExitStatus=143" "ExecStart=/bin/sh -c 'cd $data && exec $dir/jre/bin/java -jar $dir/app/Stirling-PDF.jar'"`,
    remove: "unit_gone",
  },
  {
    id: "it-tools",
    name: "IT Tools",
    category: "tools",
    tagline: "handy tools for developers",
    about: "Encoders, converters, generators and calculators in one static page.",
    home: "https://it-tools.tech",
    install: `unpack "$(gh_asset CorentinTh/it-tools "it-tools-[0-9.]+-[0-9a-f]+[.]zip")" "$dir/app"
echo '<?php readfile(__DIR__ . "/index.html");' > "$dir/app/index.php"
${serve("$dir/app")}`,
    remove: "unit_gone",
  },
  {
    id: "cyberchef",
    name: "CyberChef",
    category: "tools",
    tagline: "the cyber swiss army knife",
    about: "GCHQ's web app for encoding, decoding, encryption and data analysis.",
    home: "https://github.com/gchq/CyberChef",
    install: `unpack "$(gh_asset gchq/CyberChef "CyberChef_.+[.]zip")" "$dir/app"
for f in "$dir"/app/CyberChef_*.html; do cp "$f" "$dir/app/index.html"; done
${serve("$dir/app")}`,
    remove: "unit_gone",
  },
  {
    id: "excalidraw",
    name: "Excalidraw",
    category: "tools",
    tagline: "hand-drawn style whiteboard",
    about: "A virtual whiteboard for sketching diagrams that look hand drawn, built from source here.",
    home: "https://excalidraw.com",
    install: `${node(22)}
unpack "https://github.com/excalidraw/excalidraw/archive/refs/heads/master.tar.gz" "$dir/src"
(
  cd "$dir/src"
  npx -y yarn@1.22.22 install --frozen-lockfile --network-timeout 600000
  NODE_ENV=production NODE_OPTIONS=--max-old-space-size=4096 npx -y yarn@1.22.22 build:app:docker
)
rm -rf "$dir/www"
mv "$dir/src/excalidraw-app/build" "$dir/www"
rm -rf "$dir/src"
${serve("$dir/www")}`,
    remove: "unit_gone",
  },
  {
    id: "drawio",
    name: "draw.io",
    category: "tools",
    tagline: "diagrams of every kind",
    about: "The diagram editor: flowcharts, network diagrams, UML and more.",
    home: "https://www.drawio.com",
    icon: "draw-io",
    install: `t=$(mktemp -d)
fetch "$(gh_asset jgraph/drawio "draw[.]war")" "$t/draw.war"
rm -rf "$dir/app"
mkdir -p "$dir/app"
python3 -m zipfile -e "$t/draw.war" "$dir/app"
rm -rf "$t" "$dir/app/WEB-INF" "$dir/app/META-INF"
${serve("$dir/app")}`,
    remove: "unit_gone",
  },
  {
    id: "vikunja",
    name: "Vikunja",
    category: "productivity",
    tagline: "to-do lists and projects",
    about: "Tasks, lists, kanban and gantt views for yourself or a team.",
    home: "https://vikunja.io",
    secrets: ["VIKUNJA_SERVICE_SECRET"],
    note: "Register the first account on its login page.",
    install: `unpack "$(gh_asset go-vikunja/vikunja "vikunja-v[0-9.]+-linux-$A-full[.]zip")" "$dir/app"
for f in "$dir"/app/vikunja-v*-linux-$A; do mv "$f" "$dir/app/vikunja"; done
chmod 755 "$dir/app/vikunja"
mkdir -p "$data/files"
unit "Environment=VIKUNJA_SERVICE_INTERFACE=$IP:$PORT" "Environment=VIKUNJA_SERVICE_PUBLICURL=$URL" "Environment=VIKUNJA_SERVICE_ROOTPATH=$data" "Environment=VIKUNJA_SERVICE_TIMEZONE=$TZ" "Environment=VIKUNJA_DATABASE_TYPE=sqlite" "Environment=VIKUNJA_DATABASE_PATH=$data/vikunja.db" "Environment=VIKUNJA_FILES_BASEPATH=$data/files" "ExecStart=$dir/app/vikunja"`,
    remove: "unit_gone",
  },
  {
    id: "kanboard",
    name: "Kanboard",
    category: "productivity",
    tagline: "a minimalist kanban board",
    about: "Simple project management with kanban, on FrankenPHP and SQLite here.",
    home: "https://kanboard.org",
    note: "Its first login is admin / admin, change it.",
    install: `t=$(gh_tag kanboard/kanboard)
unpack "https://github.com/kanboard/kanboard/archive/refs/tags/$t.tar.gz" "$dir/app"
mkdir -p "$data/plugins"
rm -rf "$dir/app/plugins" "$dir/app/data"
ln -s "$data/plugins" "$dir/app/plugins"
cat > "$dir/app/config.php" <<EOF
<?php
define('DATA_DIR', '$data');
define('PLUGIN_INSTALLER', true);
EOF
${serve("$dir/app")}`,
    remove: "unit_gone",
  },
  {
    id: "mealie",
    name: "Mealie",
    category: "home",
    tagline: "recipes, meal plans and shopping lists",
    about: "Import recipes from any site, plan meals and build shopping lists.",
    home: "https://mealie.io",
    sudo: true,
    note: "Its first login is changeme@example.com / MyPassword, change it.",
    install: `apt_get build-essential libldap2-dev libsasl2-dev ffmpeg
${node(24)}
uv_ensure
t=$(gh_tag mealie-recipes/mealie)
unpack "https://github.com/mealie-recipes/mealie/archive/refs/tags/$t.tar.gz" "$dir/app"
(
  cd "$dir/app/frontend"
  pm=$(sed -n 's/.*"packageManager": *"\\([^"]*\\)".*/\\1/p' package.json)
  npx -y "$pm" install --frozen-lockfile
  npx -y "$pm" generate
)
rm -rf "$dir/app/mealie/frontend"
cp -rL "$dir/app/frontend/dist" "$dir/app/mealie/frontend"
(cd "$dir/app" && UV_PROJECT_ENVIRONMENT="$dir/venv" uv sync -q --frozen --no-dev --python 3.14)
unit "Environment=API_HOST=$IP" "Environment=API_PORT=$PORT" "Environment=DATA_DIR=$data" "Environment=BASE_URL=$URL" "Environment=PRODUCTION=true" "ExecStart=$dir/venv/bin/mealie"`,
    remove: "unit_gone",
  },
  {
    id: "grocy",
    name: "grocy",
    category: "home",
    tagline: "groceries and household management",
    about: "Stock, shopping lists, chores and recipes for the household, on FrankenPHP here.",
    home: "https://grocy.info",
    note: "Its first login is admin / admin, change it.",
    install: `unpack "$(gh_asset grocy/grocy "grocy_[0-9.]+[.]zip")" "$dir/app"
mkdir -p "$data/plugins" "$data/viewcache"
[ -f "$data/config.php" ] || cp "$dir/app/config-dist.php" "$data/config.php"
php_ensure
unit "Environment=GROCY_DATAPATH=$data" "ExecStart=$PHP php-server --listen $IP:$PORT --root $dir/app/public"`,
    remove: "unit_gone",
  },
  {
    id: "actual",
    name: "Actual Budget",
    category: "finance",
    tagline: "envelope budgeting that's fast",
    about: "A local-first personal budgeting app with sync.",
    home: "https://actualbudget.org",
    icon: "actual-budget",
    note: "Its first open sets the server password.",
    install: `${node(22)}
mkdir -p "$dir/app"
npm install -q --prefix "$dir/app" --omit=dev @actual-app/sync-server@latest
unit "Environment=ACTUAL_HOSTNAME=$IP" "Environment=ACTUAL_PORT=$PORT" "Environment=ACTUAL_DATA_DIR=$data" "ExecStart=$dir/node/bin/node $dir/app/node_modules/@actual-app/sync-server/build/bin/actual-server.js"`,
    remove: "unit_gone",
  },
];
