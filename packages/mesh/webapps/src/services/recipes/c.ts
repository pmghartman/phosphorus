// the catalogue's recipes, 41-60: reading, dashboards and monitoring
import type { Recipe } from "../native.ts";

export const recipes: Recipe[] = [
  {
    id: "linkding",
    name: "linkding",
    category: "reading",
    tagline: "bookmarks, minimal and fast",
    about: "A bookmark manager with tags, search and archiving.",
    home: "https://linkding.link",
    note: "First login admin / admin; change the password in its /admin page.",
    install: `tag=$(gh_tag sissbruecker/linkding)
unpack "https://github.com/sissbruecker/linkding/archive/refs/tags/$tag.tar.gz" "$dir/app"
node_ensure
uv_ensure
cd "$dir/app"
npm ci --no-audit --no-fund
npm run build
# uWSGI ships only as source: the lock's copy skipped, pyuwsgi's wheels in its place
UV_PROJECT_ENVIRONMENT="$dir/venv" uv sync --frozen --no-dev --no-install-package uwsgi --python 3.13
VIRTUAL_ENV="$dir/venv" uv pip install -q --upgrade pyuwsgi
rm -rf "$dir/app/data"; ln -s "$data" "$dir/app/data"
mkdir -p "$data/favicons" "$data/previews" "$data/assets"
export DJANGO_SETTINGS_MODULE=bookmarks.settings.prod
py="$dir/venv/bin/python"
"$py" manage.py collectstatic --noinput
"$py" manage.py generate_secret_key
"$py" manage.py migrate
"$py" manage.py enable_wal
LD_SUPERUSER_NAME=admin LD_SUPERUSER_PASSWORD=admin "$py" manage.py create_initial_superuser
"$py" manage.py migrate_tasks
cat > "$dir/uwsgi.ini" <<EOF
[uwsgi]
chdir = $dir/app
module = bookmarks.wsgi:application
env = DJANGO_SETTINGS_MODULE=bookmarks.settings.prod
http = $IP:$PORT
master = true
static-map = /static=static
static-map = /static=data/favicons
static-map = /static=data/previews
static-map = /robots.txt=static/robots.txt
processes = 2
threads = 2
buffer-size = 8192
die-on-term = true
EOF
cat > "$dir/run.sh" <<EOF
#!/bin/sh
cd "$dir/app"
"$py" manage.py run_huey -f &
exec "$dir/venv/bin/uwsgi" --ini "$dir/uwsgi.ini"
EOF
chmod 755 "$dir/run.sh"
unit "ExecStart=$dir/run.sh" "Environment=DJANGO_SETTINGS_MODULE=bookmarks.settings.prod" "Environment=LD_CSRF_TRUSTED_ORIGINS=$URL"`,
    remove: "unit_gone",
  },
  {
    id: "wallabag",
    name: "wallabag",
    category: "reading",
    tagline: "save the web, read it later",
    about: "Saves articles to read later, cleanly.",
    home: "https://wallabag.org",
    secrets: ["APP_SECRET"],
    note: "First login wallabag / wallabag.",
    install: `php_ensure
unpack "$(gh_asset wallabag/wallabag "wallabag-[0-9.]+[.]tar[.]gz")" "$dir/app"
mkdir -p "$data/db" "$data/images"
if [ ! -f "$data/parameters.yml" ]; then
  sed -e "s|^\\( *\\)database_driver: .*|\\1database_driver: pdo_sqlite|" \\
    -e "s|^\\( *\\)database_path: .*|\\1database_path: $data/db/wallabag.sqlite|" \\
    -e "s|^\\( *\\)database_charset: .*|\\1database_charset: utf8|" \\
    -e "s|^\\( *\\)secret: .*|\\1secret: $APP_SECRET|" \\
    -e "s|^\\( *\\)fosuser_registration: .*|\\1fosuser_registration: false|" \\
    -e "s|^\\( *\\)fosuser_confirmation: .*|\\1fosuser_confirmation: false|" \\
    "$dir/app/app/config/parameters.yml" > "$data/parameters.yml"
fi
sed -i "s|^\\( *\\)domain_name: .*|\\1domain_name: '$URL'|" "$data/parameters.yml"
ln -sf "$data/parameters.yml" "$dir/app/app/config/parameters.yml"
rm -rf "$dir/app/web/assets/images"; ln -s "$data/images" "$dir/app/web/assets/images"
# php-server routes to index.php: its app.php, the mesh's proxy trusted for the scheme and host
cat > "$dir/app/web/index.php" <<'EOF'
<?php
use Symfony\\Component\\HttpFoundation\\Request;
require __DIR__.'/../vendor/autoload.php';
Request::setTrustedProxies([$_SERVER['REMOTE_ADDR']], Request::HEADER_X_FORWARDED_ALL);
$kernel = new AppKernel('prod', false);
$request = Request::createFromGlobals();
$response = $kernel->handle($request);
$response->send();
$kernel->terminate($request, $response);
EOF
cd "$dir/app"
if [ -f "$data/db/wallabag.sqlite" ]; then
  "$PHP" php-cli bin/console doctrine:migrations:migrate --env=prod --no-interaction
else
  "$PHP" php-cli bin/console wallabag:install --env=prod --no-interaction
fi
"$PHP" php-cli bin/console cache:clear --env=prod
unit "ExecStart=$PHP php-server --listen $IP:$PORT --root $dir/app/web"`,
    remove: "unit_gone",
  },
  {
    id: "freshrss",
    name: "FreshRSS",
    category: "reading",
    tagline: "an RSS reader for many feeds",
    about: "A fast feed aggregator with a web reader and API for mobile apps.",
    home: "https://freshrss.org",
    note: "Its install page runs on first open: pick SQLite and make your account.",
    install: `php_ensure
tag=$(gh_tag FreshRSS/FreshRSS)
unpack "https://github.com/FreshRSS/FreshRSS/archive/refs/tags/$tag.tar.gz" "$dir/app"
cat > "$dir/app/constants.local.php" <<EOF
<?php
define('DATA_PATH', '$data');
EOF
"$PHP" php-cli "$dir/app/cli/prepare.php"
# its feeds refreshed every 20 minutes, as its cron job would
cat > "$dir/run.sh" <<EOF
#!/bin/sh
(while sleep 1200; do "$PHP" php-cli "$dir/app/app/actualize_script.php" >/dev/null 2>&1; done) &
exec "$PHP" php-server --listen "$IP:$PORT" --root "$dir/app/p"
EOF
chmod 755 "$dir/run.sh"
unit "ExecStart=$dir/run.sh"`,
    remove: "unit_gone",
  },
  {
    id: "rss-bridge",
    name: "RSS-Bridge",
    category: "reading",
    tagline: "feeds for sites that have none",
    about: "Generates RSS and Atom feeds for sites without them.",
    home: "https://github.com/RSS-Bridge/rss-bridge",
    install: `php_ensure
tag=$(gh_tag RSS-Bridge/rss-bridge)
unpack "https://github.com/RSS-Bridge/rss-bridge/archive/refs/tags/$tag.tar.gz" "$dir/app"
mkdir -p "$data/cache"
[ -f "$data/config.ini.php" ] || cat > "$data/config.ini.php" <<'EOF'
; <?php exit; ?> DO NOT REMOVE THIS LINE
; settings over config.default.ini.php
[system]
enabled_bridges[] = *
EOF
ln -sf "$data/config.ini.php" "$dir/app/config.ini.php"
rm -rf "$dir/app/cache"; ln -s "$data/cache" "$dir/app/cache"
unit "ExecStart=$PHP php-server --listen $IP:$PORT --root $dir/app"`,
    remove: "unit_gone",
  },
  {
    id: "changedetection",
    name: "changedetection.io",
    category: "monitoring",
    tagline: "know when a web page changes",
    about: "Watches pages for changes and notifies you, with filters and diffs.",
    home: "https://changedetection.io",
    install: `py_venv changedetection.io
unit "ExecStart=$dir/venv/bin/changedetection.io -h $IP -p $PORT -d $data" "Environment=BASE_URL=$URL"`,
    remove: "unit_gone",
  },
  {
    id: "homepage",
    name: "Homepage",
    category: "dashboards",
    tagline: "a start page for your services",
    about: "A fast, configurable dashboard with widgets for many services.",
    home: "https://gethomepage.dev",
    note: "Its settings are YAML files in its data/config.",
    install: `node_ensure
tag=$(gh_tag gethomepage/homepage)
unpack "https://github.com/gethomepage/homepage/archive/refs/tags/$tag.tar.gz" "$dir/app"
cd "$dir/app"
npx --yes pnpm@10 install --frozen-lockfile
npx --yes pnpm@10 build
mkdir -p "$data/config"
host=$(echo "$URL" | sed 's|^[a-z]*://||; s|/.*||')
unit "ExecStart=$dir/app/node_modules/.bin/next start -H $IP -p $PORT" "Environment=NODE_ENV=production" "Environment=HOMEPAGE_CONFIG_DIR=$data/config" "Environment=HOMEPAGE_ALLOWED_HOSTS=$host,$IP:$PORT"`,
    remove: "unit_gone",
  },
  {
    id: "glance",
    name: "Glance",
    category: "dashboards",
    tagline: "your feeds and services on one page",
    about: "A light dashboard of feeds, calendars, weather, bookmarks and service checks, in one binary.",
    home: "https://github.com/glanceapp/glance",
    note: "Its page is set in its data/glance.yml.",
    install: `unpack "$(gh_asset glanceapp/glance "glance-linux-$A[.]tar[.]gz")" "$dir/app"
[ -f "$data/glance.yml" ] || cat > "$data/glance.yml" <<EOF
server:
  host: $IP
  port: $PORT
pages:
  - name: Home
    columns:
      - size: small
        widgets:
          - type: calendar
      - size: full
        widgets:
          - type: search
          - type: hacker-news
EOF
sed -i -e "s|^  host: .*|  host: $IP|" -e "s|^  port: .*|  port: $PORT|" "$data/glance.yml"
unit "ExecStart=$dir/app/glance --config $data/glance.yml"`,
    remove: "unit_gone",
  },
  {
    id: "dashy",
    name: "Dashy",
    category: "dashboards",
    tagline: "a dashboard with status checks",
    about: "A highly configurable start page with themes and status indicators.",
    home: "https://dashy.to",
    note: "Edit it in the browser; its config is data/user-data/conf.yml.",
    install: `node_ensure
unpack "$(gh_asset Lissy93/dashy "dashy-[0-9.]+[.]tar[.]gz")" "$dir/app"
cd "$dir/app"
npm install --omit=dev --no-audit --no-fund
mkdir -p "$data/user-data"
[ -f "$data/user-data/conf.yml" ] || cp "$dir/app/user-data/conf.yml" "$data/user-data/conf.yml"
unit "ExecStart=$(command -v node) $dir/app/server.js" "Environment=NODE_ENV=production" "Environment=HOST=$IP" "Environment=USER_DATA_DIR=$data/user-data"`,
    remove: "unit_gone",
  },
  {
    id: "heimdall",
    name: "Heimdall",
    category: "dashboards",
    tagline: "an application dashboard",
    about: "A tidy page of links to your apps, some with live info.",
    home: "https://heimdall.site",
    install: `php_ensure
tag=$(gh_tag linuxserver/Heimdall)
unpack "https://github.com/linuxserver/Heimdall/archive/refs/tags/$tag.tar.gz" "$dir/app"
[ -f "$data/.env" ] || cp "$dir/app/.env.example" "$data/.env"
[ -d "$data/storage" ] || cp -R "$dir/app/storage" "$data/storage"
rm -rf "$dir/app/storage"; ln -s "$data/storage" "$dir/app/storage"
ln -sf "$data/.env" "$dir/app/.env"
setkey() { grep -v "^$1=" "$data/.env" > "$data/.env.new" || true; printf '%s=%s\\n' "$1" "$2" >> "$data/.env.new"; mv "$data/.env.new" "$data/.env"; }
# its database beside the .env: the path is taken from app/database
setkey DB_CONNECTION sqlite
setkey DB_DATABASE ../../data/app.sqlite
setkey APP_URL "$URL"
cd "$dir/app"
grep -q '^APP_KEY=base64:' "$data/.env" || "$PHP" php-cli artisan key:generate --force --no-interaction
unit "ExecStart=$PHP php-server --listen $IP:$PORT --root $dir/app/public"`,
    remove: "unit_gone",
  },
  {
    id: "uptime-kuma",
    name: "Uptime Kuma",
    category: "monitoring",
    tagline: "uptime monitoring with status pages",
    about: "Checks your sites and services and alerts you when one goes down.",
    home: "https://uptime.kuma.pet",
    note: "Its first open makes the admin account.",
    install: `node_ensure
tag=$(gh_tag louislam/uptime-kuma)
unpack "https://github.com/louislam/uptime-kuma/archive/refs/tags/$tag.tar.gz" "$dir/app"
unpack "$(gh_asset louislam/uptime-kuma "dist[.]tar[.]gz")" "$dir/app/dist"
cd "$dir/app"
npm ci --omit dev --no-audit --no-fund
unit "ExecStart=$(command -v node) $dir/app/server/server.js" "Environment=NODE_ENV=production" "Environment=UPTIME_KUMA_HOST=$IP" "Environment=UPTIME_KUMA_PORT=$PORT" "Environment=DATA_DIR=$data/"`,
    remove: "unit_gone",
  },
  {
    id: "grafana",
    name: "Grafana",
    category: "monitoring",
    tagline: "dashboards for every metric",
    about: "Graphs and alerts over Prometheus, InfluxDB and many more.",
    home: "https://grafana.com",
    note: "First login admin / admin.",
    install: `v=$(gh_tag grafana/grafana | sed 's/^v//')
unpack "https://dl.grafana.com/oss/release/grafana-$v.linux-$A.tar.gz" "$dir/app"
mkdir -p "$data/plugins" "$data/logs"
unit "ExecStart=$dir/app/bin/grafana server --homepath $dir/app" "Environment=GF_PATHS_DATA=$data" "Environment=GF_PATHS_LOGS=$data/logs" "Environment=GF_PATHS_PLUGINS=$data/plugins" "Environment=GF_SERVER_HTTP_ADDR=$IP" "Environment=GF_SERVER_HTTP_PORT=$PORT" "Environment=GF_SERVER_ROOT_URL=$URL"`,
    remove: "unit_gone",
  },
  {
    id: "prometheus",
    name: "Prometheus",
    category: "monitoring",
    tagline: "a metrics database",
    about: "Collects and queries time series; scrapes itself until you add targets to its data/prometheus.yml.",
    home: "https://prometheus.io",
    install: `unpack "$(gh_asset prometheus/prometheus "prometheus-[0-9.]+[.]linux-$A[.]tar[.]gz")" "$dir/app"
[ -f "$data/prometheus.yml" ] || cat > "$data/prometheus.yml" <<EOF
global:
  scrape_interval: 15s
scrape_configs:
  - job_name: prometheus
    static_configs:
      - targets: ["$IP:$PORT"]
EOF
unit "ExecStart=$dir/app/prometheus --config.file=$data/prometheus.yml --storage.tsdb.path=$data/tsdb --web.listen-address=$IP:$PORT"`,
    remove: "unit_gone",
  },
  {
    id: "influxdb",
    name: "InfluxDB",
    category: "monitoring",
    tagline: "a time series database",
    about: "InfluxDB 2 with its UI; its setup page creates the first user.",
    home: "https://www.influxdata.com",
    install: `# the newest 2.x: the repository's latest release is InfluxDB 3, which has no UI
v=$(curl -fsSL "https://api.github.com/repos/influxdata/influxdb/releases?per_page=100" | sed -n 's/.*"tag_name": *"v\\(2[.][0-9.]*\\)".*/\\1/p' | head -1)
[ -n "$v" ] || { echo "no InfluxDB 2 release found" >&2; exit 4; }
unpack "https://dl.influxdata.com/influxdb/releases/influxdb2-$v""_linux_$A.tar.gz" "$dir/app"
unit "ExecStart=$dir/app/influxd --http-bind-address=$IP:$PORT --bolt-path=$data/influxd.bolt --engine-path=$data/engine --sqlite-path=$data/influxd.sqlite --reporting-disabled"`,
    remove: "unit_gone",
  },
  {
    id: "glances",
    name: "Glances",
    category: "monitoring",
    tagline: "a live look at the machine",
    about: "CPU, memory, disks, network and processes of the host, in a web page.",
    home: "https://nicolargo.github.io/glances",
    install: `py_venv "glances[web]"
unit "ExecStart=$dir/venv/bin/glances -w -B $IP -p $PORT"`,
    remove: "unit_gone",
  },
  {
    id: "netdata",
    name: "Netdata",
    category: "monitoring",
    tagline: "every metric of the host, per second",
    about: "Real-time charts and alerts for the host's CPU, memory, disks, network, services and processes.",
    home: "https://www.netdata.cloud",
    port: 19999,
    sudo: true,
    install: `apt_repo netdata "https://repository.netdata.cloud/netdatabot.gpg.key" "deb [signed-by=/etc/apt/keyrings/netdata.gpg] https://repository.netdata.cloud/repos/stable/$DISTRO $CODENAME/ "
apt_get netdata
sudo -n mkdir -p /etc/netdata
sudo -n touch /etc/netdata/.opt-out-from-anonymous-statistics
sys_on netdata`,
    remove: `sys_off netdata
apt_gone netdata
sudo -n rm -f /etc/apt/sources.list.d/netdata.list /etc/apt/keyrings/netdata.gpg`,
  },
  {
    id: "beszel",
    name: "Beszel",
    category: "monitoring",
    tagline: "lightweight server monitoring",
    about: "A small hub for system stats and alerts from agents on your machines.",
    home: "https://beszel.dev",
    note: "Its first open makes the admin account; machines report to it through its agent.",
    install: `unpack "$(gh_asset henrygd/beszel "beszel_linux_$A[.]tar[.]gz")" "$dir/app"
unit "ExecStart=$dir/app/beszel serve --http $IP:$PORT --dir $data"`,
    remove: "unit_gone",
  },
  {
    id: "ntfy",
    name: "ntfy",
    category: "notifications",
    tagline: "push notifications by HTTP",
    about: "Send a notification to your phone or desktop with a simple PUT or POST.",
    home: "https://ntfy.sh",
    install: `unpack "$(gh_asset binwiederhier/ntfy "ntfy_[0-9.]+_linux_$A[.]tar[.]gz")" "$dir/app"
mkdir -p "$data/attachments"
unit "ExecStart=$dir/app/ntfy serve --listen-http $IP:$PORT --base-url $URL --cache-file $data/cache.db --attachment-cache-dir $data/attachments --behind-proxy"`,
    remove: "unit_gone",
  },
  {
    id: "gotify",
    name: "Gotify",
    category: "notifications",
    tagline: "a server for push messages",
    about: "Send and receive messages in real time.",
    home: "https://gotify.net",
    note: "First login admin / admin.",
    install: `unpack "$(gh_asset gotify/server "gotify-linux-$A[.]zip")" "$dir/app"
chmod 755 "$dir/app/gotify-linux-$A"
unit "ExecStart=$dir/app/gotify-linux-$A" "Environment=GOTIFY_SERVER_LISTENADDR=$IP" "Environment=GOTIFY_SERVER_PORT=$PORT" "Environment=GOTIFY_DATABASE_CONNECTION=$data/gotify.db" "Environment=GOTIFY_UPLOADEDIMAGESDIR=$data/images" "Environment=GOTIFY_PLUGINSDIR=$data/plugins"`,
    remove: "unit_gone",
  },
  {
    id: "alertmanager",
    name: "Alertmanager",
    category: "notifications",
    tagline: "alerts routed to wherever you read them",
    about: "Groups, silences and sends Prometheus alerts on to email, chat, ntfy-style webhooks and more.",
    home: "https://prometheus.io/docs/alerting/latest/alertmanager/",
    note: "Its receivers are set in its data/alertmanager.yml.",
    install: `unpack "$(gh_asset prometheus/alertmanager "alertmanager-[0-9.]+[.]linux-$A[.]tar[.]gz")" "$dir/app"
[ -f "$data/alertmanager.yml" ] || cat > "$data/alertmanager.yml" <<'EOF'
route:
  receiver: none
receivers:
  - name: none
EOF
unit "ExecStart=$dir/app/alertmanager --config.file=$data/alertmanager.yml --storage.path=$data --web.listen-address=$IP:$PORT --web.external-url=$URL --cluster.listen-address="`,
    remove: "unit_gone",
  },
  {
    id: "gitea",
    name: "Gitea",
    category: "development",
    tagline: "a light git forge",
    about: "Repositories, issues, pull requests and CI in one binary.",
    home: "https://about.gitea.com",
    note: "Its setup page runs on first open.",
    install: `bin_from "$(gh_asset go-gitea/gitea "gitea-[0-9.]+-linux-$A")" gitea
command -v git >/dev/null 2>&1 || apt_get git
ini="$data/custom/conf/app.ini"
mkdir -p "$(dirname "$ini")"
# its own SSH off: keys it adds would land in the login's authorized_keys
[ -f "$ini" ] || cat > "$ini" <<EOF
[server]
DISABLE_SSH = true

[database]
DB_TYPE = sqlite3
PATH = $data/data/gitea.db
EOF
GITEA__server__HTTP_ADDR="$IP" GITEA__server__HTTP_PORT="$PORT" GITEA__server__ROOT_URL="$URL/" "$dir/bin/gitea" config edit-ini --config "$ini" --in-place --apply-env
unit "ExecStart=$dir/bin/gitea web --work-path $data --config $ini" "Environment=GITEA_WORK_DIR=$data"`,
    remove: "unit_gone",
  },
];
