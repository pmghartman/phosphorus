// the catalogue's recipes, 1-20: media and its automation
import type { Recipe } from "../native.ts";

// .NET apps want ICU; without it they run in invariant mode rather than fail
const icu = `inv=Environment=DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=0
ls /usr/lib/*/libicuuc.so.* >/dev/null 2>&1 || inv=Environment=DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1`;

// Node 22 or later, for apps that ask for it
const node22 = `[ -x "$HOME/.local/node/bin/node" ] && PATH="$HOME/.local/node/bin:$PATH"
node_ensure
if [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  v=$(curl -fsSL https://nodejs.org/dist/index.json | python3 -c 'import json,sys; print(next(r["version"] for r in json.load(sys.stdin) if r["version"].startswith("v22.")))')
  unpack "https://nodejs.org/dist/$v/node-$v-linux-$XA.tar.xz" "$HOME/.local/node"
  PATH="$HOME/.local/node/bin:$PATH"
fi`;

// a Servarr app from its release tarball, its address and port in data/config.xml
const arr = (repo: string, app: string, asset: string) => `unpack "$(gh_asset ${repo} "${asset}")" "$dir/app"
c="$data/config.xml"
if [ -f "$c" ]; then
  sed -i -e "s|<Port>[0-9]*</Port>|<Port>$PORT</Port>|" -e "s|<BindAddress>[^<]*</BindAddress>|<BindAddress>$IP</BindAddress>|" "$c"
else
  cat > "$c" <<EOF
<Config>
  <BindAddress>$IP</BindAddress>
  <Port>$PORT</Port>
</Config>
EOF
fi
${icu}
unit "ExecStart=$dir/app/${app} -nobrowser -data=$data" "$inv"`;

export const recipes: Recipe[] = [
  {
    id: "jellyfin",
    name: "Jellyfin",
    category: "media",
    tagline: "your films, shows and music, streamed",
    about: "The free media server: libraries, transcoding, apps for every TV and phone.",
    home: "https://jellyfin.org",
    port: 8096,
    sudo: true,
    note: "Its setup wizard runs on first open.",
    install: `apt_repo jellyfin "https://repo.jellyfin.org/jellyfin_team.gpg.key" "deb [signed-by=/etc/apt/keyrings/jellyfin.gpg] https://repo.jellyfin.org/$DISTRO $CODENAME main"
apt_get jellyfin
sys_on jellyfin`,
    remove: `sys_off jellyfin
apt_gone jellyfin jellyfin-server jellyfin-web
sudo -n rm -f /etc/apt/sources.list.d/jellyfin.list /etc/apt/keyrings/jellyfin.gpg`,
  },
  {
    id: "plex",
    name: "Plex",
    category: "media",
    tagline: "the media server with apps everywhere",
    about: "Plex Media Server from Plex's own apt repository: libraries, streaming and apps on every screen.",
    home: "https://www.plex.tv",
    port: 32400,
    sudo: true,
    note: "Sign in with a Plex account on first open; a new server is claimed only from the host's own network, e.g. an SSH tunnel to localhost:32400/web.",
    install: `apt_repo plex "https://downloads.plex.tv/plex-keys/PlexSign.v2.key" "deb [signed-by=/etc/apt/keyrings/plex.gpg] https://repo.plex.tv/deb public main"
apt_get plexmediaserver
sys_on plexmediaserver`,
    remove: `sys_off plexmediaserver
apt_gone plexmediaserver
sudo -n rm -f /etc/apt/sources.list.d/plex.list /etc/apt/keyrings/plex.gpg`,
  },
  {
    id: "emby",
    name: "Emby",
    category: "media",
    tagline: "a media server for the whole house",
    about: "Emby Server from its official .deb: libraries, live TV and a DVR, streamed to its apps.",
    home: "https://emby.media",
    sudo: true,
    note: "Its setup wizard runs on first open.",
    install: `t=$(mktemp -d); chmod 755 "$t"
fetch "$(gh_asset MediaBrowser/Emby.Releases "emby-server-deb_[0-9.]+_$A[.]deb")" "$t/emby-server.deb"
chmod 644 "$t/emby-server.deb"
apt_get "$t/emby-server.deb"
rm -rf "$t"
c=/var/lib/emby/config/system.xml
sudo -n systemctl stop emby-server
if sudo -n test -f $c; then
  sudo -n sed -i -e "s|<HttpServerPortNumber>[0-9]*<|<HttpServerPortNumber>$PORT<|" -e "s|<PublicPort>[0-9]*<|<PublicPort>$PORT<|" $c
else
  sudo -n mkdir -p /var/lib/emby/config
  sudo -n tee $c >/dev/null <<EOF
<?xml version="1.0"?>
<ServerConfiguration xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <HttpServerPortNumber>$PORT</HttpServerPortNumber>
  <PublicPort>$PORT</PublicPort>
</ServerConfiguration>
EOF
fi
sudo -n chown -R emby:emby /var/lib/emby
sys_on emby-server`,
    remove: `sys_off emby-server
apt_gone emby-server`,
  },
  {
    id: "navidrome",
    name: "Navidrome",
    category: "media",
    tagline: "your music collection, Subsonic compatible",
    about: "A light music server and web player that every Subsonic app can stream from; music goes in its data/music.",
    home: "https://www.navidrome.org",
    install: `unpack "$(gh_asset navidrome/navidrome "navidrome_[0-9.]+_linux_$A[.]tar[.]gz")" "$dir/app"
mkdir -p "$data/music"
unit "ExecStart=$dir/app/navidrome --address $IP --port $PORT --datafolder $data --musicfolder $data/music"`,
    remove: "unit_gone",
  },
  {
    id: "audiobookshelf",
    name: "Audiobookshelf",
    category: "media",
    tagline: "audiobooks and podcasts, with progress synced",
    about: "An audiobook and podcast server with a web player and mobile apps, built from its release source.",
    home: "https://www.audiobookshelf.org",
    note: "The first open makes the root user; add a library folder such as its data/media.",
    install: `node_ensure
tag=$(gh_tag advplyr/audiobookshelf)
unpack "https://github.com/advplyr/audiobookshelf/archive/refs/tags/$tag.tar.gz" "$dir/src"
cd "$dir/src/client"
npm ci --no-audit --no-fund
npm run generate
cd "$dir/src"
npm ci --include=dev --ignore-scripts --no-audit --no-fund
npm run build:server
npm ci --omit=dev --no-audit --no-fund
cd "$dir"
rm -rf "$dir/app"; mv "$dir/src" "$dir/app"
mkdir -p "$data/config" "$data/metadata" "$data/media"
unit "ExecStart=$(command -v node) $dir/app/dist-server/index.js --host $IP --port $PORT --config $data/config --metadata $data/metadata" "WorkingDirectory=$dir/app" "Environment=NODE_ENV=production"`,
    remove: "unit_gone",
  },
  {
    id: "kavita",
    name: "Kavita",
    category: "media",
    tagline: "a reader for comics, manga and books",
    about: "A fast reading server for comics, manga, ebooks and PDFs.",
    home: "https://www.kavitareader.com",
    note: "The first open makes the admin account.",
    install: `unpack "$(gh_asset Kareadita/Kavita "kavita-linux-$XA[.]tar[.]gz")" "$dir/app"
mkdir -p "$data/config"
[ -f "$data/config/appsettings.json" ] || cp "$dir/app/config/appsettings-init.json" "$data/config/appsettings.json"
rm -rf "$dir/app/config"; ln -s "$data/config" "$dir/app/config"
python3 - "$data/config/appsettings.json" "$PORT" "$IP" <<'EOF'
import json, sys
p = sys.argv[1]
c = json.load(open(p, encoding="utf-8-sig"))
c["Port"] = int(sys.argv[2])
c["IpAddresses"] = sys.argv[3]
json.dump(c, open(p, "w"), indent=2)
EOF
${icu}
unit "ExecStart=$dir/app/Kavita" "WorkingDirectory=$dir/app" "$inv"`,
    remove: "unit_gone",
  },
  {
    id: "komga",
    name: "Komga",
    category: "media",
    tagline: "a comics and manga server",
    about: "Organises and serves comics and manga, with OPDS and a web reader; runs on Java.",
    home: "https://komga.org",
    sudo: true,
    note: "The first open makes the admin account.",
    install: `java_ensure
fetch "$(gh_asset gotson/komga "komga-[0-9.]+[.]jar")" "$dir/komga.jar.new"
mv "$dir/komga.jar.new" "$dir/komga.jar"
unit "ExecStart=$(command -v java) -jar $dir/komga.jar --server.address=$IP --server.port=$PORT" "Environment=KOMGA_CONFIGDIR=$data"`,
    remove: "unit_gone",
  },
  {
    id: "calibre-web",
    name: "Calibre-Web",
    category: "media",
    tagline: "browse and read a Calibre library",
    about: "A web front end for a Calibre ebook library: read, download, send to a reader.",
    home: "https://github.com/janeczku/calibre-web",
    note: "Log in as admin / admin123, change it, then point it at a folder holding a Calibre library's metadata.db.",
    install: `py_venv calibreweb
mkdir -p "$data/cache"
unit "ExecStart=$dir/venv/bin/cps -p $data/app.db -g $data/gdrive.db -i $IP" "Environment=CALIBRE_PORT=$PORT" "Environment=CACHE_DIRECTORY=$data/cache"`,
    remove: "unit_gone",
  },
  {
    id: "photoprism",
    name: "PhotoPrism",
    category: "media",
    tagline: "your photos, searchable and on a map",
    about: "An AI-powered photo library that tags, sorts and maps your pictures, from its release build with SQLite.",
    home: "https://www.photoprism.app",
    sudo: true,
    secrets: ["PHOTOPRISM_ADMIN_PASSWORD"],
    note: "Log in as admin with PHOTOPRISM_ADMIN_PASSWORD from its .env; photos go in its data/originals.",
    install: `apt_get libvips42t64 libimage-exiftool-perl ffmpeg
unpack "$(gh_asset photoprism/photoprism "photoprism_[0-9a-f-]+-linux-$A[.]tar[.]gz")" "$dir/app"
mkdir -p "$data/storage" "$data/originals" "$data/import"
unit "ExecStart=$dir/app/bin/photoprism start" \\
  "Environment=LD_LIBRARY_PATH=$dir/app/lib" \\
  "Environment=PHOTOPRISM_ASSETS_PATH=$dir/app/assets" \\
  "Environment=PHOTOPRISM_HTTP_HOST=$IP" \\
  "Environment=PHOTOPRISM_HTTP_PORT=$PORT" \\
  "Environment=PHOTOPRISM_SITE_URL=$URL/" \\
  "Environment=PHOTOPRISM_STORAGE_PATH=$data/storage" \\
  "Environment=PHOTOPRISM_ORIGINALS_PATH=$data/originals" \\
  "Environment=PHOTOPRISM_IMPORT_PATH=$data/import" \\
  "Environment=PHOTOPRISM_DATABASE_DRIVER=sqlite" \\
  "Environment=PHOTOPRISM_ADMIN_USER=admin"`,
    remove: "unit_gone",
  },
  {
    id: "owncast",
    name: "Owncast",
    category: "media",
    tagline: "your own live stream and chat",
    about: "A self-hosted live video server with chat; stream to it from OBS over RTMP on port 1935.",
    home: "https://owncast.online",
    sudo: true,
    note: "Its admin is at /admin, user admin, password abc123: change it and the stream key there.",
    install: `command -v ffmpeg >/dev/null 2>&1 || apt_get ffmpeg
oa=64bit; if [ "$A" = arm64 ]; then oa=arm64; fi
unpack "$(gh_asset owncast/owncast "owncast-[0-9.]+-linux-$oa[.]zip")" "$dir/app"
chmod 755 "$dir/app/owncast"
unit "ExecStart=$dir/app/owncast -webserverip $IP -webserverport $PORT"`,
    remove: "unit_gone",
  },
  {
    id: "tautulli",
    name: "Tautulli",
    category: "media",
    tagline: "who watched what on Plex",
    about: "Monitoring, history and statistics for a Plex server.",
    home: "https://tautulli.com",
    note: "Its setup wizard runs on first open and signs in to Plex.",
    install: `py_venv
tag=$(gh_tag Tautulli/Tautulli)
unpack "https://github.com/Tautulli/Tautulli/archive/refs/tags/$tag.tar.gz" "$dir/app"
if [ -f "$data/config.ini" ]; then
  sed -i -e "s|^http_host = .*|http_host = $IP|" -e "s|^http_port = .*|http_port = $PORT|" "$data/config.ini"
else
  cat > "$data/config.ini" <<EOF
[General]
http_host = $IP
http_port = $PORT
launch_browser = 0
EOF
fi
unit "ExecStart=$dir/venv/bin/python $dir/app/Tautulli.py --datadir $data --config $data/config.ini --port $PORT --nolaunch --nofork"`,
    remove: "unit_gone",
  },
  {
    id: "jellyseerr",
    name: "Seerr",
    category: "media",
    icon: "seerr",
    tagline: "requests for films and shows",
    about:
      "Lets people request films and shows for Jellyfin, Plex or Emby, sent on to Sonarr and Radarr; Jellyseerr and Overseerr merged as Seerr.",
    home: "https://github.com/seerr-team/seerr",
    note: "Its setup wizard runs on first open. The build takes several minutes.",
    install: `${node22}
tag=$(gh_tag seerr-team/seerr)
unpack "https://github.com/seerr-team/seerr/archive/refs/tags/$tag.tar.gz" "$dir/src"
cd "$dir/src"
CYPRESS_INSTALL_BINARY=0 npx -y pnpm@10 install --frozen-lockfile
COMMIT_TAG=$tag npx -y pnpm@10 build
cd "$dir"
rm -rf "$dir/app"; mv "$dir/src" "$dir/app"
unit "ExecStart=$(command -v node) dist/index.js" "WorkingDirectory=$dir/app" "Environment=NODE_ENV=production" "Environment=HOST=$IP" "Environment=PORT=$PORT" "Environment=CONFIG_DIRECTORY=$data" "Environment=COMMIT_TAG=$tag"`,
    remove: "unit_gone",
  },
  {
    id: "ombi",
    name: "Ombi",
    category: "media",
    tagline: "media requests for Plex, Jellyfin and Emby",
    about: "A request manager: friends ask for films, shows and music, sent on to Sonarr, Radarr and Lidarr.",
    home: "https://ombi.io",
    note: "Its setup wizard runs on first open.",
    install: `unpack "$(gh_asset Ombi-app/Ombi "linux-$XA[.]tar[.]gz")" "$dir/app"
${icu}
unit "ExecStart=$dir/app/Ombi --host http://$IP:$PORT --storage $data" "WorkingDirectory=$dir/app" "$inv"`,
    remove: "unit_gone",
  },
  {
    id: "sonarr",
    name: "Sonarr",
    category: "media",
    tagline: "TV series, found and organised",
    about: "Watches for new episodes and organises a TV library.",
    home: "https://sonarr.tv",
    note: "It asks for a login to set on first open.",
    install: arr("Sonarr/Sonarr", "Sonarr", "Sonarr[.]main[.][0-9.]+[.]linux-$XA[.]tar[.]gz"),
    remove: "unit_gone",
  },
  {
    id: "radarr",
    name: "Radarr",
    category: "media",
    tagline: "films, found and organised",
    about: "Watches for films and organises a movie library.",
    home: "https://radarr.video",
    note: "It asks for a login to set on first open.",
    install: arr("Radarr/Radarr", "Radarr", "Radarr[.]master[.][0-9.]+[.]linux-core-$XA[.]tar[.]gz"),
    remove: "unit_gone",
  },
  {
    id: "lidarr",
    name: "Lidarr",
    category: "media",
    tagline: "music, found and organised",
    about: "Watches for albums by the artists you follow and organises a music library.",
    home: "https://lidarr.audio",
    note: "It asks for a login to set on first open.",
    install: arr("Lidarr/Lidarr", "Lidarr", "Lidarr[.]master[.][0-9.]+[.]linux-core-$XA[.]tar[.]gz"),
    remove: "unit_gone",
  },
  {
    id: "prowlarr",
    name: "Prowlarr",
    category: "media",
    tagline: "one indexer list for the *arr apps",
    about: "Manages indexers once and syncs them to Sonarr, Radarr and Lidarr.",
    home: "https://prowlarr.com",
    note: "It asks for a login to set on first open.",
    install: arr("Prowlarr/Prowlarr", "Prowlarr", "Prowlarr[.]master[.][0-9.]+[.]linux-core-$XA[.]tar[.]gz"),
    remove: "unit_gone",
  },
  {
    id: "bazarr",
    name: "Bazarr",
    category: "media",
    tagline: "subtitles, fetched for your library",
    about: "Finds and downloads subtitles for what Sonarr and Radarr manage.",
    home: "https://www.bazarr.media",
    install: `unpack "$(gh_asset morpheus65535/bazarr "bazarr[.]zip")" "$dir/app"
py_venv -r "$dir/app/requirements.txt"
mkdir -p "$data/config"
[ -f "$data/config/config.yaml" ] || cat > "$data/config/config.yaml" <<EOF
general:
  ip: $IP
  port: $PORT
EOF
unit "ExecStart=$dir/venv/bin/python $dir/app/bazarr.py --no-update -c $data -p $PORT" "WorkingDirectory=$dir/app"`,
    remove: "unit_gone",
  },
  {
    id: "qbittorrent",
    name: "qBittorrent",
    category: "downloads",
    tagline: "a torrent client with a web UI",
    about:
      "qBittorrent's headless client and web UI, from Debian, run as the login; downloads go in its data/downloads.",
    home: "https://www.qbittorrent.org",
    sudo: true,
    secrets: ["WEBUI_PASSWORD"],
    note: "Log in as admin with WEBUI_PASSWORD from its .env.",
    install: `apt_get qbittorrent-nox
c="$data/qBittorrent/config/qBittorrent.conf"
mkdir -p "$(dirname "$c")" "$data/downloads"
if [ ! -f "$c" ]; then
  h=$(python3 -c 'import base64, hashlib, os, sys; s = os.urandom(16); print(base64.b64encode(s).decode() + ":" + base64.b64encode(hashlib.pbkdf2_hmac("sha512", sys.argv[1].encode(), s, 100000)).decode())' "$WEBUI_PASSWORD")
  cat > "$c" <<EOF
[LegalNotice]
Accepted=true

[BitTorrent]
Session\\DefaultSavePath=$data/downloads

[Preferences]
WebUI\\Address=$IP
WebUI\\Port=$PORT
WebUI\\Username=admin
WebUI\\Password_PBKDF2="@ByteArray($h)"
EOF
fi
unit "ExecStart=/usr/bin/qbittorrent-nox --profile=$data --webui-port=$PORT"`,
    remove: `unit_gone
apt_gone qbittorrent-nox`,
  },
  {
    id: "transmission",
    name: "Transmission",
    category: "downloads",
    tagline: "a small torrent client",
    about:
      "Transmission's daemon and web interface, from Debian, run as the login; downloads go in its data/downloads.",
    home: "https://transmissionbt.com",
    sudo: true,
    secrets: ["RPC_PASSWORD"],
    note: "Log in as admin with RPC_PASSWORD from its .env.",
    install: `apt_get transmission-daemon
sys_off transmission-daemon
mkdir -p "$data/downloads"
[ -f "$data/settings.json" ] || cat > "$data/settings.json" <<EOF
{
  "download-dir": "$data/downloads",
  "rpc-bind-address": "$IP",
  "rpc-port": $PORT,
  "rpc-whitelist-enabled": false,
  "rpc-host-whitelist-enabled": false,
  "rpc-authentication-required": true,
  "rpc-username": "admin",
  "rpc-password": "$RPC_PASSWORD"
}
EOF
unit "ExecStart=/usr/bin/transmission-daemon -f -g $data -p $PORT --rpc-bind-address $IP"`,
    remove: `unit_gone
apt_gone transmission-daemon`,
  },
];
