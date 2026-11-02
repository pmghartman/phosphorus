// the catalogue's recipes, 81-100: tools, web, calendars and notes
import type { Recipe } from "../native.ts";

// Node <v> of the app's own under .shared, npm and corepack's yarn with it,
// for builds that want a given Node whatever the host has
const nodeOf = (v: number) => `nd="$shared/node${v}"
if [ ! -x "$nd/bin/node" ] || [ "$OP" = update ]; then
  v=$(curl -fsSL https://nodejs.org/dist/index.json | python3 -c 'import json,sys; print(next(r["version"] for r in json.load(sys.stdin) if r["version"].startswith("v${v}.")))')
  unpack "https://nodejs.org/dist/$v/node-$v-linux-$XA.tar.xz" "$nd"
fi
PATH="$nd/bin:$PATH"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 COREPACK_ENABLE_AUTO_PIN=0 COREPACK_HOME="$nd/corepack"
corepack enable --install-directory "$nd/bin"`;

// FrankenPHP's own Caddy, no admin endpoint, plain HTTP on $IP:$PORT
const caddyHead = `{
	admin off
	auto_https off
	persist_config off
	frankenphp
}
http://:$PORT {
	bind $IP`;

export const recipes: Recipe[] = [
  {
    id: "opengist",
    name: "Opengist",
    category: "tools",
    tagline: "code snippets shared like gists",
    about: "Paste and share code and text, each snippet a git repository you can clone and push to.",
    home: "https://github.com/thomiceli/opengist",
    secrets: ["OG_SECRET_KEY"],
    note: "The first account registered becomes its admin.",
    install: `command -v git >/dev/null 2>&1 || { echo "opengist needs git on the host" >&2; exit 3; }
unpack "$(gh_asset thomiceli/opengist "opengist[0-9.]+-linux-$A[.]tar[.]gz")" "$dir/app"
unit "ExecStart=$dir/app/opengist" "Environment=OG_HTTP_HOST=$IP" "Environment=OG_HTTP_PORT=$PORT" "Environment=OG_OPENGIST_HOME=$data" "Environment=OG_EXTERNAL_URL=$URL" "Environment=OG_SSH_GIT_ENABLED=disabled"`,
    remove: "unit_gone",
  },
  {
    id: "librespeed",
    name: "LibreSpeed",
    category: "tools",
    tagline: "a speed test to your own host",
    about: "Measures the speed between your browser and the host.",
    home: "https://github.com/librespeed/speedtest-go",
    install: `unpack "$(gh_asset librespeed/speedtest-go "speedtest-go_[0-9.]+_linux_$A[.]tar[.]gz")" "$dir/app"
cat > "$dir/settings.toml" <<EOF
bind_address="$IP"
listen_port=$PORT
proxyprotocol_port=0
assets_path=""
statistics_password=""
redact_ip_addresses=false
database_type="none"
database_file="$data/speedtest.db"
enable_tls=false
enable_http2=false
EOF
unit "ExecStart=$dir/app/speedtest-backend -c $dir/settings.toml"`,
    remove: "unit_gone",
  },
  {
    id: "openspeedtest",
    name: "OpenSpeedTest",
    category: "tools",
    tagline: "a network speed test in HTML5",
    about: "A fast HTML5 speed test served from the host.",
    home: "https://openspeedtest.com",
    install: `php_ensure
unpack "https://github.com/openspeedtest/Speed-Test/archive/refs/heads/main.tar.gz" "$dir/app"
# uploads are POSTs to static files: read to the end and answered 200
cat > "$dir/app/sink.php" <<'EOF'
<?php
$f = fopen('php://input', 'rb');
while (!feof($f)) { fread($f, 1048576); }
EOF
printf 'post_max_size = 64M\\n' > "$dir/php.ini"
cat > "$dir/Caddyfile" <<EOF
${caddyHead}
	root * $dir/app
	header Cache-Control "no-store, no-cache, max-age=0, no-transform"
	header Access-Control-Allow-Origin "*"
	route {
		@options method OPTIONS
		respond @options 200
		@post method POST
		rewrite @post /sink.php
		php @post
		file_server
	}
}
EOF
unit "ExecStart=$PHP run --config $dir/Caddyfile"`,
    remove: "unit_gone",
  },
  {
    id: "privatebin",
    name: "PrivateBin",
    category: "tools",
    tagline: "an encrypted pastebin",
    about: "A pastebin whose server never sees the pasted text: it's encrypted in the browser.",
    home: "https://privatebin.info",
    install: `php_ensure
unpack "https://github.com/PrivateBin/PrivateBin/archive/refs/tags/$(gh_tag PrivateBin/PrivateBin).tar.gz" "$dir/app"
mkdir -p "$data/pastes"
[ -f "$data/conf.php" ] || sed 's|^dir = PATH "data"|dir = "'"$data"'/pastes"|' "$dir/app/cfg/conf.sample.php" > "$data/conf.php"
ln -sf "$data/conf.php" "$dir/app/cfg/conf.php"
unit "ExecStart=$PHP php-server --listen $IP:$PORT --root $dir/app"`,
    remove: "unit_gone",
  },
  {
    id: "wordpress",
    name: "WordPress",
    category: "web",
    tagline: "websites and blogs",
    about: "WordPress on FrankenPHP with a MariaDB database of its own.",
    home: "https://wordpress.org",
    sudo: true,
    secrets: ["DB_SECRET"],
    note: "Its setup page runs on first open.",
    install: `php_ensure
apt_get mariadb-server
sys_on mariadb
sudo -n mysql <<EOF
CREATE DATABASE IF NOT EXISTS wordpress CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'wordpress'@'localhost' IDENTIFIED BY '$DB_SECRET';
ALTER USER 'wordpress'@'localhost' IDENTIFIED BY '$DB_SECRET';
GRANT ALL PRIVILEGES ON wordpress.* TO 'wordpress'@'localhost';
FLUSH PRIVILEGES;
EOF
# the latest core over the site; an installed site keeps its wp-content
unpack "https://wordpress.org/latest.tar.gz" "$dir/core"
[ ! -f "$data/site/wp-config.php" ] || rm -rf "$dir/core/wp-content"
mkdir -p "$data/site"
cp -a "$dir/core/." "$data/site/"
rm -rf "$dir/core"
if [ ! -f "$data/site/wp-config.php" ]; then
  {
    echo "<?php"
    echo "define('DB_NAME', 'wordpress');"
    echo "define('DB_USER', 'wordpress');"
    echo "define('DB_PASSWORD', '$DB_SECRET');"
    echo "define('DB_HOST', 'localhost:/run/mysqld/mysqld.sock');"
    echo "define('DB_CHARSET', 'utf8mb4');"
    echo "define('DB_COLLATE', '');"
    curl -fsSL https://api.wordpress.org/secret-key/1.1/salt/
    cat <<'EOF'
$table_prefix = 'wp_';
if (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https') { $_SERVER['HTTPS'] = 'on'; }
define('WP_DEBUG', false);
if (!defined('ABSPATH')) { define('ABSPATH', __DIR__ . '/'); }
require_once ABSPATH . 'wp-settings.php';
EOF
  } > "$data/site/wp-config.php"
  chmod 600 "$data/site/wp-config.php"
fi
printf 'upload_max_filesize = 64M\\npost_max_size = 64M\\nmemory_limit = 256M\\n' > "$dir/php.ini"
unit "ExecStart=$PHP php-server --listen $IP:$PORT --root $data/site"`,
    remove: `unit_gone
if [ "$KEEP" != 1 ]; then sudo -n mysql -e "DROP DATABASE IF EXISTS wordpress; DROP USER IF EXISTS 'wordpress'@'localhost';" || true; fi`,
  },
  {
    id: "baikal",
    name: "Baïkal",
    category: "productivity",
    tagline: "a CalDAV and CardDAV server",
    about: "Calendars and contacts synced to every device.",
    home: "https://sabre.io/baikal",
    note: "Its setup page runs on first open: set the admin password and pick SQLite.",
    install: `php_ensure
unpack "$(gh_asset sabre-io/Baikal "baikal-[0-9.]+[.]zip")" "$dir/app"
# its settings and database kept in data, across updates
for d in config Specific; do
  [ -d "$data/$d" ] || cp -a "$dir/app/$d" "$data/$d"
  rm -rf "$dir/app/$d"
  ln -s "$data/$d" "$dir/app/$d"
done
unit "ExecStart=$PHP php-server --listen $IP:$PORT --root $dir/app/html"`,
    remove: "unit_gone",
  },
  {
    id: "radicale",
    name: "Radicale",
    category: "productivity",
    tagline: "a small CalDAV and CardDAV server",
    about: "A minimal calendar and contacts server.",
    home: "https://radicale.org",
    secrets: ["RADICALE_PASSWORD"],
    note: "Sign in as admin with RADICALE_PASSWORD from ~/.phosphorus/services/radicale/.env.",
    install: `py_venv radicale bcrypt
mkdir -p "$data/collections"
[ -f "$data/users" ] || "$dir/venv/bin/python" -c 'import bcrypt,os; print("admin:" + bcrypt.hashpw(os.environ["RADICALE_PASSWORD"].encode(), bcrypt.gensalt()).decode())' > "$data/users"
cat > "$dir/config" <<EOF
[server]
hosts = $IP:$PORT

[auth]
type = htpasswd
htpasswd_filename = $data/users
htpasswd_encryption = bcrypt

[storage]
filesystem_folder = $data/collections
EOF
unit "ExecStart=$dir/venv/bin/radicale --config $dir/config"`,
    remove: "unit_gone",
  },
  {
    id: "homebox",
    name: "HomeBox",
    category: "home",
    tagline: "an inventory of everything you own",
    about: "Track items, locations, warranties and receipts around the house.",
    home: "https://homebox.software",
    note: "Register the first account on its page.",
    install: `unpack "$(gh_asset sysadminsmedia/homebox "homebox_Linux_($X|$A)[.]tar[.]gz")" "$dir/app"
unit "ExecStart=$dir/app/homebox" "Environment=HBOX_MODE=production" "Environment=HBOX_WEB_HOST=$IP" "Environment=HBOX_WEB_PORT=$PORT" "Environment=HBOX_STORAGE_CONN_STRING=file://$data" "Environment=HBOX_STORAGE_PREFIX_PATH=files" "Environment=HBOX_DATABASE_DRIVER=sqlite3" "Environment=HBOX_DATABASE_SQLITE_PATH=$data/homebox.db?_pragma=busy_timeout=999&_pragma=journal_mode=WAL&_fk=1&_time_format=sqlite"`,
    remove: "unit_gone",
  },
  {
    id: "grist",
    name: "Grist",
    category: "productivity",
    tagline: "a spreadsheet that's also a database",
    about:
      "Relational spreadsheets with formulas in Python, forms and dashboards; built from source, formulas run unsandboxed as the login.",
    home: "https://www.getgrist.com",
    secrets: ["GRIST_SESSION_SECRET", "GRIST_BOOT_KEY"],
    note: "Its Quick setup asks for the boot key: GRIST_BOOT_KEY in ~/.phosphorus/services/grist/.env.",
    install: `${nodeOf(22)}
uv_ensure
tag=$(gh_tag gristlabs/grist-core)
# the community edition built aside, swapped in when it's done
if [ "$(cat "$dir/app/.tag" 2>/dev/null)" != "$tag" ]; then
  unpack "https://github.com/gristlabs/grist-core/archive/refs/tags/$tag.tar.gz" "$dir/build"
  (cd "$dir/build" && echo community > grist-edition && yarn install --frozen-lockfile --network-timeout 600000 && yarn run build:prod)
  rm -rf "$dir/app"
  mv "$dir/build" "$dir/app"
  uv venv -q --python 3.11 "$dir/app/sandbox_venv3"
  VIRTUAL_ENV="$dir/app/sandbox_venv3" uv pip install -q --no-deps -r "$dir/app/sandbox/requirements.txt"
  echo "$tag" > "$dir/app/.tag"
fi
mkdir -p "$data/docs"
unit "WorkingDirectory=$dir/app" "ExecStart=/bin/bash $dir/app/sandbox/run.sh" "Environment=NODE_ENV=production" 'Environment="NODE_OPTIONS=--no-deprecation --disable-proto=delete"' "Environment=GRIST_HOST=$IP" "Environment=APP_HOME_URL=$URL" "Environment=GRIST_DATA_DIR=$data/docs" "Environment=GRIST_INST_DIR=$data" "Environment=TYPEORM_DATABASE=$data/home.sqlite3" "Environment=GRIST_ORG_IN_PATH=true" "Environment=GRIST_SERVE_SAME_ORIGIN=true" "Environment=GRIST_SANDBOX_FLAVOR=unsandboxed" "Environment=GRIST_SANDBOX=$dir/app/sandbox_venv3/bin/python"`,
    remove: "unit_gone",
  },
  {
    id: "dokuwiki",
    name: "DokuWiki",
    category: "productivity",
    tagline: "a wiki kept in plain text files",
    about: "A simple wiki with no database: pages, revisions and media live as files.",
    home: "https://www.dokuwiki.org",
    note: "Open /install.php once to name the wiki and make its admin.",
    install: `php_ensure
# a release over the site, as DokuWiki upgrades: pages, users and settings stay
unpack "$(gh_asset dokuwiki/dokuwiki "dokuwiki-[0-9a-z-]+[.]tgz")" "$dir/release"
mkdir -p "$data/site"
cp -a "$dir/release/." "$data/site/"
rm -rf "$dir/release"
cat > "$dir/Caddyfile" <<EOF
${caddyHead}
	root * $data/site
	@private path /data/* /conf/* /bin/* /inc/* /vendor/*
	handle @private {
		respond 404
	}
	handle {
		php_server
	}
}
EOF
unit "ExecStart=$PHP run --config $dir/Caddyfile"`,
    remove: "unit_gone",
  },
  {
    id: "hedgedoc",
    name: "HedgeDoc",
    category: "documents",
    tagline: "collaborative Markdown notes",
    about: "Write Markdown together in real time, with diagrams, slides and sharing.",
    home: "https://hedgedoc.org",
    secrets: ["CMD_SESSION_SECRET"],
    note: "Notes can be written without an account; register with an email to keep your own.",
    install: `${nodeOf(22)}
unpack "$(gh_asset hedgedoc/hedgedoc "hedgedoc-[0-9.]+[.]tar[.]gz")" "$dir/app"
mkdir -p "$data/uploads"
rm -rf "$dir/app/public/uploads"
ln -s "$data/uploads" "$dir/app/public/uploads"
# its .yarnrc names a yarn release the tarball leaves out: corepack's yarn instead
(cd "$dir/app" && YARN_IGNORE_PATH=1 bash bin/setup)
host=$(echo "$URL" | sed 's|^[a-z]*://||; s|[/:].*||')
case "$URL" in https:*) ssl=true ;; *) ssl=false ;; esac
unit "WorkingDirectory=$dir/app" "ExecStart=$nd/bin/node $dir/app/app.js" "Environment=NODE_ENV=production" "Environment=CMD_HOST=$IP" "Environment=CMD_PORT=$PORT" "Environment=CMD_DB_URL=sqlite://$data/hedgedoc.sqlite" "Environment=CMD_DOMAIN=$host" "Environment=CMD_PROTOCOL_USESSL=$ssl" "Environment=CMD_URL_ADDPORT=false"`,
    remove: "unit_gone",
  },
  {
    id: "omni-tools",
    name: "OmniTools",
    category: "tools",
    tagline: "everyday tools for images, text and files",
    about: "Resize images, convert files, format text: all in the browser.",
    home: "https://github.com/iib0011/omni-tools",
    install: `${nodeOf(22)}
unpack "https://github.com/iib0011/omni-tools/archive/refs/tags/$(gh_tag iib0011/omni-tools).tar.gz" "$dir/src"
(cd "$dir/src" && HUSKY=0 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci && npm run build)
rm -rf "$dir/app"
mv "$dir/src/dist" "$dir/app"
rm -rf "$dir/src"
php_ensure
cat > "$dir/Caddyfile" <<EOF
${caddyHead}
	root * $dir/app
	try_files {path} /index.html
	file_server
}
EOF
unit "ExecStart=$PHP run --config $dir/Caddyfile"`,
    remove: "unit_gone",
  },
  {
    id: "anythingllm",
    name: "AnythingLLM",
    category: "ai",
    tagline: "chat with your documents",
    about: "Workspaces that answer from your documents with any LLM, local or hosted.",
    home: "https://anythingllm.com",
    icon: "anything-llm",
    secrets: ["JWT_SECRET", "SIG_KEY", "SIG_SALT"],
    note: "Its first open walks through picking an LLM.",
    install: `${nodeOf(24)}
export PUPPETEER_SKIP_DOWNLOAD=true PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true CHECKPOINT_DISABLE=1
unpack "https://github.com/Mintplex-Labs/anything-llm/archive/refs/tags/$(gh_tag Mintplex-Labs/anything-llm).tar.gz" "$dir/app"
# its database and settings live in server/storage and server/.env: kept in data
mkdir -p "$data/storage"
[ -n "$(ls -A "$data/storage")" ] || cp -a "$dir/app/server/storage/." "$data/storage/"
rm -rf "$dir/app/server/storage"
ln -s "$data/storage" "$dir/app/server/storage"
touch "$data/server.env"
ln -sf "$data/server.env" "$dir/app/server/.env"
ln -sf "$data/server.env" "$dir/app/server/.env.production"
(cd "$dir/app/frontend" && echo "VITE_API_BASE='/api'" > .env && yarn install --network-timeout 600000 && yarn build)
cp -R "$dir/app/frontend/dist" "$dir/app/server/public"
(cd "$dir/app/collector" && yarn install --production --network-timeout 600000)
(cd "$dir/app/server" && yarn install --production --network-timeout 600000 && npx prisma generate --schema=./prisma/schema.prisma && npx prisma migrate deploy --schema=./prisma/schema.prisma)
# the server and its document collector, both stopped when either stops
cat > "$dir/run.sh" <<'EOF'
#!/bin/bash
d=$(dirname "$0")/app
(cd "$d/collector" && exec node index.js) &
(cd "$d/server" && exec node index.js) &
wait -n
exit $?
EOF
unit "ExecStart=/bin/bash $dir/run.sh" "Environment=NODE_ENV=production" "Environment=SERVER_PORT=$PORT" "Environment=COLLECTOR_PORT=$((PORT + 10000))" "Environment=STORAGE_DIR=$data/storage" "Environment=DISABLE_TELEMETRY=true"`,
    remove: "unit_gone",
  },
  {
    id: "flowise",
    name: "Flowise",
    category: "ai",
    tagline: "build LLM apps by dragging blocks",
    about: "A visual builder for LLM agents and chains.",
    home: "https://flowiseai.com",
    note: "Its first open creates the admin account.",
    install: `${nodeOf(24)}
export PUPPETEER_SKIP_DOWNLOAD=true PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
npm install --prefix "$dir/app" --no-audit --no-fund flowise@latest
unit "ExecStart=$dir/app/node_modules/.bin/flowise start" "Environment=HOST=$IP" "Environment=DATABASE_PATH=$data" "Environment=SECRETKEY_PATH=$data" "Environment=LOG_PATH=$data/logs" "Environment=BLOB_STORAGE_PATH=$data/storage"`,
    remove: "unit_gone",
  },
  {
    id: "languagetool",
    name: "LanguageTool",
    category: "tools",
    tagline: "grammar and style checking",
    about: "A self-hosted grammar checker server for the LanguageTool browser extensions.",
    home: "https://languagetool.org",
    icon: "",
    sudo: true,
    note: "Set the extension's local server to its address followed by /v2.",
    install: `java_ensure
unpack "https://languagetool.org/download/LanguageTool-stable.zip" "$dir/app"
unit "ExecStart=$(command -v java) -cp $dir/app/languagetool-server.jar org.languagetool.server.HTTPServer --port $PORT --public --allow-origin *"`,
    remove: "unit_gone",
  },
  {
    id: "readeck",
    name: "Readeck",
    category: "reading",
    tagline: "keep and read web content",
    about: "Saves articles, pictures and videos to read later, with highlights.",
    home: "https://readeck.org",
    note: "Its first open creates the admin account.",
    install: `v=$(curl -fsSL https://codeberg.org/api/v1/repos/readeck/readeck/releases/latest | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"])')
bin_from "https://codeberg.org/readeck/readeck/releases/download/$v/readeck-$v-linux-$A" readeck
unit "ExecStart=$dir/bin/readeck serve -config $data/config.toml" "Environment=READECK_SERVER_HOST=$IP" "Environment=READECK_SERVER_PORT=$PORT" "Environment=READECK_DATA_DIRECTORY=$data"`,
    remove: "unit_gone",
  },
  {
    id: "convertx",
    name: "ConvertX",
    category: "tools",
    tagline: "convert files between hundreds of formats",
    about: "A web file converter over ffmpeg, ImageMagick, pandoc and more.",
    home: "https://github.com/C4illin/ConvertX",
    sudo: true,
    secrets: ["JWT_SECRET"],
    note: "Create the first account on its page; LibreOffice, Calibre and TeX converters are left out.",
    install: `apt_get ffmpeg imagemagick pandoc poppler-utils ghostscript
for p in graphicsmagick libvips-tools potrace libheif-examples libjxl-tools resvg mupdf-tools djvulibre-bin dcraw inkscape; do
  apt_get "$p" || echo "no $p here: its conversions are left out"
done
unpack "$(gh_asset oven-sh/bun "bun-linux-($XA|$X)[.]zip")" "$shared/bun"
chmod 755 "$shared/bun/bun"
PATH="$shared/bun:$PATH"
unpack "https://github.com/C4illin/ConvertX/archive/refs/tags/$(gh_tag C4illin/ConvertX).tar.gz" "$dir/src"
(cd "$dir/src" && bun install --frozen-lockfile && bun run build:bin)
# the one binary, its public folder beside it and data in ./data
rm -rf "$dir/public"
mv "$dir/src/public" "$dir/public"
mv -f "$dir/src/dist/convertx" "$dir/convertx"
rm -rf "$dir/src"
unit "ExecStart=$dir/convertx"`,
    remove: "unit_gone",
  },
  {
    id: "lubelogger",
    name: "LubeLogger",
    category: "home",
    tagline: "vehicle maintenance and fuel records",
    about: "Track services, repairs, fuel and reminders for your vehicles; built from source with .NET.",
    home: "https://lubelogger.com",
    install: `export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 DOTNET_ROOT="$shared/dotnet"
fetch "https://dot.net/v1/dotnet-install.sh" "$dir/dotnet-install.sh"
bash "$dir/dotnet-install.sh" --channel 10.0 --install-dir "$shared/dotnet"
inv=0
ls /usr/lib/*/libicuuc.so.* >/dev/null 2>&1 || inv=1
export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=$inv
unpack "https://github.com/hargata/lubelog/archive/refs/tags/$(gh_tag hargata/lubelog).tar.gz" "$dir/src"
rm -rf "$dir/app"
"$shared/dotnet/dotnet" publish "$dir/src/CarCareTracker.csproj" -c Release -o "$dir/app"
rm -rf "$dir/src"
# its data in ./data, the working directory's
unit "ExecStart=$shared/dotnet/dotnet $dir/app/CarCareTracker.dll --contentRoot $dir/app" "Environment=ASPNETCORE_URLS=http://$IP:$PORT" "Environment=DOTNET_ROOT=$shared/dotnet" "Environment=DOTNET_CLI_TELEMETRY_OPTOUT=1" "Environment=DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=$inv"`,
    remove: "unit_gone",
  },
  {
    id: "silverbullet",
    name: "SilverBullet",
    category: "documents",
    tagline: "a programmable notebook in Markdown",
    about: "Notes as Markdown files with links, queries and scripting.",
    home: "https://silverbullet.md",
    note: "Its setup page makes the admin account and first space on first open.",
    install: `unpack "$(gh_asset silverbulletmd/silverbullet "silverbullet-server-linux-$X[.]zip")" "$dir/app"
chmod 755 "$dir/app/silverbullet"
unit "ExecStart=$dir/app/silverbullet --hostname $IP --port $PORT $data"`,
    remove: "unit_gone",
  },
  {
    id: "flatnotes",
    name: "flatnotes",
    category: "documents",
    tagline: "notes as plain Markdown files",
    about: "A distraction-free note app over a folder of Markdown, behind the phosphorus login.",
    home: "https://github.com/dullage/flatnotes",
    install: `${nodeOf(22)}
uv_ensure
unpack "https://github.com/dullage/flatnotes/archive/refs/tags/$(gh_tag dullage/flatnotes).tar.gz" "$dir/app"
(cd "$dir/app" && npm ci --no-audit --no-fund && npm run build)
(cd "$dir/app" && UV_PROJECT_ENVIRONMENT="$dir/venv" uv sync --locked --no-dev --no-install-project)
mkdir -p "$data/notes"
unit "WorkingDirectory=$dir/app" "ExecStart=$dir/venv/bin/python -m uvicorn main:app --app-dir server --host $IP --port $PORT --proxy-headers --forwarded-allow-ips=*" "Environment=FLATNOTES_AUTH_TYPE=none" "Environment=FLATNOTES_PATH=$data/notes"`,
    remove: "unit_gone",
  },
];
