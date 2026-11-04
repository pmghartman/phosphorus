// phosphorus's own few apps, shipped with it rather than fetched: each written for
// the mesh, its manifest whole (data, the backup hooks, health, the web page)
import type { AppDef, SourceInfo, TreeEntry } from "@phosphorus/wire";
import { envFields } from "./manifest.ts";

// Forgejo as the mesh's git, its route forgejo.<domain> and git.<domain> as before. The image's own layout under
// /data: gitea/ the custom dir, app.ini, the sqlite db and app data, git/ the
// repositories and LFS. Queues in memory, the issue index in the db and the log on
// stdout, so nothing rebuildable is copied to standbys. On start a db failing its
// check (a standby's copy taken mid-write) is swapped for the last backup. With the
// runner profile picked an Actions runner runs beside it on its own Docker, both
// sides taking one shared secret from RUNNER_SECRET (its sha1 the 40 hex Forgejo
// wants), so it's registered with nothing to copy.
const forgejoCompose = `services:
  forgejo:
    image: codeberg.org/forgejo/forgejo:16
    restart: unless-stopped
    entrypoint:
      - sh
      - -c
      - |
        db=/data/gitea/forgejo.db
        if [ -s "$$db" ] && [ -s "$$db.phos-backup" ] && [ "$$(sqlite3 "$$db" 'PRAGMA quick_check' 2>&1)" != ok ]; then
          echo "phosphorus: $$db fails its check, the last backup put back"
          cp "$$db.phos-backup" "$$db" && rm -f "$$db-journal" "$$db-wal" "$$db-shm"
        fi
        case ",$$PHOS_PROFILES," in *,runner,*)
          s=$$(printf %s "$$RUNNER_SECRET" | sha1sum | cut -c1-40)
          (
            until curl -fsS -o /dev/null http://localhost:3000/api/healthz; do sleep 5; done
            su git -c "forgejo forgejo-cli actions register --name phosphorus --keep-labels --secret $$s" &&
              echo "phosphorus: the runner registered"
          ) &
        esac
        exec /usr/bin/entrypoint "$$@"
      - sh
    command: [/usr/bin/s6-svscan, /etc/s6]
    environment:
      USER_UID: \${PUID}
      USER_GID: \${PGID}
      FORGEJO__server__DOMAIN: \${APP_DOMAIN}
      FORGEJO__server__ROOT_URL: \${APP_URL}/
      FORGEJO__server__HTTP_PORT: "3000"
      FORGEJO__server__SSH_DOMAIN: \${APP_DOMAIN}
      FORGEJO__server__SSH_PORT: \${SSH_PORT:-2222}
      FORGEJO__server__SSH_LISTEN_PORT: "22"
      FORGEJO__server__DISABLE_SSH: "false"
      FORGEJO__server__START_SSH_SERVER: "false"
      FORGEJO__server__LFS_START_SERVER: "true"
      FORGEJO__server__APP_DATA_PATH: /data/gitea
      FORGEJO__database__DB_TYPE: sqlite3
      FORGEJO__database__PATH: /data/gitea/forgejo.db
      FORGEJO__repository__ROOT: /data/git/repositories
      FORGEJO__lfs__PATH: /data/git/lfs
      FORGEJO__session__PROVIDER: db
      FORGEJO__queue__TYPE: channel
      FORGEJO__indexer__ISSUE_INDEXER_TYPE: db
      FORGEJO__log__MODE: console
      FORGEJO__security__INSTALL_LOCK: "true"
      FORGEJO__security__SECRET_KEY: \${SECRET_KEY}
      FORGEJO__security__INTERNAL_TOKEN: \${INTERNAL_TOKEN}
      FORGEJO__cron_0X2E_git_gc_repos__ENABLED: "true"
      PHOS_PROFILES: \${COMPOSE_PROFILES:-}
      RUNNER_SECRET: \${RUNNER_SECRET}
    ports:
      - \${HTTP_PORT:-3001}:3000
      - \${SSH_PORT:-2222}:22
    volumes:
      - forgejo:/data
    healthcheck:
      test: [CMD, curl, -fsS, http://localhost:3000/api/healthz]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 60s
  runner-docker:
    image: data.forgejo.org/oci/docker:dind
    profiles: [runner]
    restart: unless-stopped
    privileged: true
    environment:
      DOCKER_TLS_CERTDIR: ""
    command: [dockerd, -H, tcp://0.0.0.0:2375, --tls=false]
    volumes:
      - runner-docker:/var/lib/docker
  runner:
    image: data.forgejo.org/forgejo/runner:13
    profiles: [runner]
    restart: unless-stopped
    user: \${PUID}:\${PGID}
    depends_on: [forgejo, runner-docker]
    environment:
      HOME: /data
      DOCKER_HOST: tcp://runner-docker:2375
      RUNNER_SECRET: \${RUNNER_SECRET}
      RUNNER_CAPACITY: \${RUNNER_CAPACITY:-2}
    volumes:
      - runner:/data
    entrypoint:
      - bash
      - -ec
      - |
        cd /data
        s=$$(printf %s "$$RUNNER_SECRET" | sha1sum | cut -c1-40)
        h=$$(printf %s "$$s" | cut -c1-16 | od -An -tx1 | tr -dc 0-9a-f)
        u="$$\{h:0:8}-$$\{h:8:4}-$$\{h:12:4}-$$\{h:16:4}-$$\{h:20:12}"
        cat > config.yml <<EOF
        log:
          level: info
        runner:
          file: .runner
          capacity: $$RUNNER_CAPACITY
          envs:
            DOCKER_HOST: tcp://runner-docker:2375
          labels:
            - docker:docker://data.forgejo.org/oci/node:lts
            - ubuntu-latest:docker://data.forgejo.org/oci/node:lts
            - docker-cli:docker://data.forgejo.org/oci/docker:cli
        container:
          network: host
          docker_host: "-"
        server:
          connections:
            phosphorus:
              url: http://forgejo:3000
              uuid: $$u
              token: $$s
        EOF
        echo "phosphorus: runner $$u for http://forgejo:3000"
        exec forgejo-runner --config config.yml daemon
volumes:
  forgejo: {}
  runner: {}
  runner-docker: {}
`;

const forgejoAbout = `Forgejo is a self-hosted git forge: repositories, issues, pull requests, packages and CI.

Installed from here it answers at forgejo.<your domain>, and at git.<your domain> too. Its data (the sqlite database, the repositories, LFS objects and avatars) lives in the stack's data folder; pick standby hosts and each keeps a copy, taken after a consistent sqlite \`.backup\` of the database, ready to take over.

SSH clones go to port 2222 (or the one you pick) of the host serving it, and the first account registered is the admin.

Pick the runner under Actions and a Forgejo Actions runner comes up beside it, already linked: it runs on its own Docker (privileged, in its own container), its jobs on \`docker\`, \`ubuntu-latest\` (Node) and \`docker-cli\`, as many at once as the runner's capacity. It runs where Forgejo runs and moves with it, reaching Forgejo inside the stack, so jobs check out code whether or not Forgejo is public. Turn it on or off later under settings on Forgejo's page.`;

export const forgejo: AppDef = {
  id: "forgejo",
  source: "phosphorus",
  ref: "forgejo",
  name: "Forgejo",
  tagline: "Git hosting: repositories, issues, pull requests",
  description: forgejoAbout,
  icon: "https://codeberg.org/forgejo/forgejo/raw/branch/forgejo/assets/logo.svg",
  category: "developer",
  repo: "https://codeberg.org/forgejo/forgejo",
  licence: "GPL-3.0-or-later",
  archs: ["amd64", "arm64"],
  compose: forgejoCompose,
  env: envFields(forgejoCompose, [
    { name: "HTTP_PORT", label: "web port on the host", default: "3001" },
    { name: "SSH_PORT", label: "SSH port on the host", default: "2222" },
    { name: "SECRET_KEY", label: "secret key", secret: true },
    { name: "INTERNAL_TOKEN", label: "internal token", secret: true },
    { name: "COMPOSE_PROFILES", label: "Actions runner", default: "none", options: ["none", "runner"] },
    { name: "RUNNER_CAPACITY", label: "runner's jobs at once", default: "2" },
    { name: "RUNNER_SECRET", label: "runner's shared secret", secret: true },
  ]),
  manifest: {
    volumes: [
      { service: "forgejo", target: "/data", kind: "data" },
      { service: "runner", target: "/data", kind: "data" },
      { service: "runner-docker", target: "/var/lib/docker", kind: "cache" },
    ],
    backup: {
      pre: [
        {
          service: "forgejo",
          run: [
            "sh",
            "-c",
            "db=/data/gitea/forgejo.db; [ ! -s $db ] || sqlite3 -cmd '.timeout 5000' $db \".backup '$db.phos-backup'\"",
          ],
        },
      ],
    },
    health: { service: "forgejo", path: "/api/healthz", port: 3000 },
    web: { service: "forgejo", port: 3000 },
    aliases: ["git"],
  },
};

// Tavern built from its clone, on the host's network for the model gateway's 127.0.0.1;
// a db failing its check on start swapped for the last backup
const tavernCompose = `services:
  tavern:
    build:
      context: .
      dockerfile_inline: |
        FROM node:22-bookworm-slim AS deps
        RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
        WORKDIR /app
        COPY package.json package-lock.json ./
        RUN npm ci --omit=dev --no-audit --no-fund
        FROM node:22-bookworm-slim
        RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/* && git config --system --add safe.directory /app
        WORKDIR /app
        COPY --from=deps /app/node_modules node_modules
        COPY . .
        CMD ["node", "server/index.js"]
    restart: unless-stopped
    user: \${PUID}:\${PGID}
    network_mode: host
    entrypoint:
      - sh
      - -c
      - |
        node -e '
        const fs = require("fs"), db = "/app/data/tavern.db", bk = db + ".phos-backup";
        const has = (f) => fs.existsSync(f) && fs.statSync(f).size > 0;
        if (has(db) && has(bk)) {
          let ok = false;
          try {
            const c = new (require("better-sqlite3"))(db);
            ok = c.pragma("quick_check", { simple: true }) === "ok";
            c.close();
          } catch {}
          if (!ok) {
            console.log("phosphorus: " + db + " fails its check, the last backup put back");
            for (const x of ["-wal", "-shm", "-journal"]) fs.rmSync(db + x, { force: true });
            fs.copyFileSync(bk, db);
          }
        }'
        exec node server/index.js
    environment:
      TZ: \${TZ}
      TAVERN_PORT: "8484"
      TAVERN_DATA_DIR: /app/data
      TAVERN_UPDATES: "off"
    volumes:
      - tavern:/app/data
volumes:
  tavern: {}
`;

const tavernAbout = `Tavern is D&D 5e in a chat room: a strict rules engine decides every outcome while a dungeon master on the mesh's models tells the story. Campaigns, character sheets, grid combat and adventure modules read from a PDF.

Installed from here it's built from [its repository](https://github.com/pmghartman/tavern) on the host and answers at tavern.<your domain>. The DM asks phosphorus's model gateway as the tavern agent, its model assigned on the agents page. Its data (the sqlite database and the modules read in) lives in the stack's data folder; pick standby hosts and each keeps a copy, taken after a consistent backup of the database.

It runs on the host's own network, on port 8484, so the gateway on that host answers it.`;

export const tavern: AppDef = {
  id: "tavern",
  source: "phosphorus",
  ref: "tavern",
  name: "Tavern",
  tagline: "D&D 5e in a chat room, an AI dungeon master on the mesh",
  description: tavernAbout,
  icon: "https://raw.githubusercontent.com/pmghartman/tavern/main/src-tauri/app-icon.svg",
  category: "games",
  repo: "https://github.com/pmghartman/tavern",
  licence: "UNLICENSED",
  archs: ["amd64", "arm64"],
  compose: tavernCompose,
  env: envFields(tavernCompose, []),
  manifest: {
    volumes: [{ service: "tavern", target: "/app/data", kind: "data" }],
    backup: {
      pre: [
        {
          service: "tavern",
          run: [
            "node",
            "-e",
            'const fs = require("fs"), db = "/app/data/tavern.db";' +
              " if (fs.existsSync(db) && fs.statSync(db).size > 0) {" +
              ' const c = new (require("better-sqlite3"))(db, { timeout: 5000 });' +
              ' c.backup(db + ".phos-backup").then(() => c.close(), (e) => { console.error(e.message); process.exit(1); }); }',
          ],
        },
      ],
    },
    health: { service: "tavern", path: "/api/health", port: 8484 },
    web: { service: "tavern", port: 8484 },
  },
};

// Circuit's server built from its clone, the ui in the binary; nothing kept on the host
const circuitCompose = `services:
  circuit:
    build:
      context: .
      dockerfile_inline: |
        FROM rust:1-bookworm AS build
        WORKDIR /src
        COPY . .
        RUN cargo build --release -p circuit-server
        FROM debian:bookworm-slim
        COPY --from=build /src/target/release/circuit-server /usr/local/bin/circuit-server
        CMD ["circuit-server"]
    restart: unless-stopped
    user: \${PUID}:\${PGID}
    environment:
      PORT: "8099"
      CIRCUIT_UPDATES: "off"
    ports:
      - \${HTTP_PORT:-8099}:8099
`;

const circuitAbout = `Circuit is a schematic editor with a live solver: draw a circuit and watch it solve as you edit, DC, transient and graph layout from a Rust core.

Installed from here it's built from [its repository](https://github.com/pmghartman/circuit) on the host (several minutes the first time, while Rust compiles it) and answers at circuit.<your domain>. It keeps nothing on the host, so there's no data to copy to standbys.`;

export const circuit: AppDef = {
  id: "circuit",
  source: "phosphorus",
  ref: "circuit",
  name: "Circuit",
  tagline: "a schematic editor with a live circuit solver",
  description: circuitAbout,
  icon: "https://raw.githubusercontent.com/pmghartman/circuit/main/src-tauri/icons/icon.png",
  category: "engineering",
  repo: "https://github.com/pmghartman/circuit",
  licence: "Apache-2.0",
  archs: ["amd64", "arm64"],
  compose: circuitCompose,
  env: envFields(circuitCompose, [{ name: "HTTP_PORT", label: "web port on the host", default: "8099" }]),
  manifest: {
    volumes: [],
    health: { service: "circuit", path: "/api/version", port: 8099 },
    web: { service: "circuit", port: 8099 },
  },
};

// Jellyfin's own image: /config its data with config/ inside, /cache rebuildable;
// the media folder at /srv/media inside, so libraries keep their paths
const jellyfinCompose = `services:
  jellyfin:
    image: jellyfin/jellyfin:10.11.11
    restart: unless-stopped
    user: \${PUID}:\${PGID}
    environment:
      TZ: \${TZ}
      JELLYFIN_PublishedServerUrl: \${APP_URL}
    ports:
      - \${HTTP_PORT:-8096}:8096
    volumes:
      - jellyfin-config:/config
      - jellyfin-cache:/cache
      - \${MEDIA_DIR:-/srv/media}:/srv/media
volumes:
  jellyfin-config: {}
  jellyfin-cache: {}
`;

const jellyfinAbout = `Jellyfin is a media server: films, shows, music and books from your own folders, streamed to a browser, a phone or a TV.

Installed from here it answers at jellyfin.<your domain>, and at media.<your domain> for players still set to that address. Your media folder appears at /srv/media inside it, so a library at /srv/media/movies keeps that path. Its settings, users and watch history live in the stack's data folder; its cache is rebuilt wherever it runs.`;

export const jellyfin: AppDef = {
  id: "jellyfin",
  source: "phosphorus",
  ref: "jellyfin",
  name: "Jellyfin",
  tagline: "your films, shows and music, streamed anywhere",
  description: jellyfinAbout,
  icon: "https://raw.githubusercontent.com/jellyfin/jellyfin-ux/master/branding/SVG/icon-transparent.svg",
  category: "media",
  repo: "https://github.com/jellyfin/jellyfin",
  licence: "GPL-2.0-only",
  archs: ["amd64", "arm64"],
  compose: jellyfinCompose,
  env: envFields(jellyfinCompose, [
    { name: "HTTP_PORT", label: "web port on the host", default: "8096" },
    { name: "MEDIA_DIR", label: "media folder on the host", default: "/srv/media" },
  ]),
  manifest: {
    volumes: [
      { service: "jellyfin", target: "/config", kind: "data" },
      { service: "jellyfin", target: "/cache", kind: "cache" },
    ],
    health: { service: "jellyfin", path: "/health", port: 8096 },
    web: { service: "jellyfin", port: 8096 },
    // the old address, for TVs and phones still set to it
    aliases: ["media"],
  },
};

// Audiobookshelf: /config its sqlite db, /metadata covers and caches, the books from the host
const audiobookshelfCompose = `services:
  audiobookshelf:
    image: ghcr.io/advplyr/audiobookshelf:2.36.0
    restart: unless-stopped
    user: \${PUID}:\${PGID}
    environment:
      TZ: \${TZ}
    ports:
      - \${HTTP_PORT:-13378}:80
    volumes:
      - audiobookshelf-config:/config
      - audiobookshelf-metadata:/metadata
      - \${AUDIOBOOKS_DIR:-/srv/media/audiobooks}:/audiobooks
volumes:
  audiobookshelf-config: {}
  audiobookshelf-metadata: {}
`;

const audiobookshelfAbout = `Audiobookshelf serves audiobooks and podcasts: progress synced across devices, chapters, bookmarks, and its own phone apps.

Installed from here it answers at audiobookshelf.<your domain>. Your audiobooks folder appears at /audiobooks inside it; its database, covers and metadata live in the stack's data folder.`;

export const audiobookshelf: AppDef = {
  id: "audiobookshelf",
  source: "phosphorus",
  ref: "audiobookshelf",
  name: "Audiobookshelf",
  tagline: "audiobooks and podcasts, your progress on every device",
  description: audiobookshelfAbout,
  icon: "https://raw.githubusercontent.com/advplyr/audiobookshelf/master/client/static/icon.svg",
  category: "media",
  repo: "https://github.com/advplyr/audiobookshelf",
  licence: "GPL-3.0-only",
  archs: ["amd64", "arm64"],
  compose: audiobookshelfCompose,
  env: envFields(audiobookshelfCompose, [
    { name: "HTTP_PORT", label: "web port on the host", default: "13378" },
    { name: "AUDIOBOOKS_DIR", label: "audiobooks folder on the host", default: "/srv/media/audiobooks" },
  ]),
  manifest: {
    volumes: [
      { service: "audiobookshelf", target: "/config", kind: "data" },
      { service: "audiobookshelf", target: "/metadata", kind: "data" },
    ],
    health: { service: "audiobookshelf", path: "/healthcheck", port: 80 },
    web: { service: "audiobookshelf", port: 80 },
  },
};

// JupyterLab from a pixi workspace in /lab/hub, seeded when missing; its env
// rebuilt from pixi.lock on first start, its own page the one origin allowed
const jupyterlabCompose = `services:
  jupyterlab:
    image: ghcr.io/prefix-dev/pixi:0.83.0-bookworm
    restart: unless-stopped
    user: \${PUID}:\${PGID}
    working_dir: /lab
    entrypoint:
      - sh
      - -c
      - |
        set -e
        mkdir -p hub
        if [ ! -f hub/pixi.toml ]; then
          printf '%s\\n' '[workspace]' 'name = "lab"' 'channels = ["conda-forge"]' 'platforms = ["linux-64", "linux-aarch64"]' '' '[dependencies]' 'python = "3.12.*"' 'jupyterlab = ">=4.2"' 'ipykernel = "*"' > hub/pixi.toml
        fi
        [ -f hub/jupyter_server_config.py ] || echo 'c = get_config()' > hub/jupyter_server_config.py
        exec pixi run --manifest-path hub/pixi.toml jupyter lab --config=hub/jupyter_server_config.py --ip=0.0.0.0 --port=8888 --no-browser --ServerApp.root_dir=/lab --ServerApp.allow_origin="$$APP_URL" --ServerApp.trust_xheaders=True
    environment:
      TZ: \${TZ}
      HOME: /lab
      XDG_CACHE_HOME: /lab/.cache
      APP_URL: \${APP_URL}
      JUPYTER_TOKEN: \${JUPYTER_TOKEN}
    ports:
      - \${HTTP_PORT:-8888}:8888
    volumes:
      - jupyterlab:/lab
volumes:
  jupyterlab: {}
`;

const jupyterlabAbout = `JupyterLab: notebooks, a terminal and an editor in the browser, its Python from a [pixi](https://pixi.sh) workspace.

Installed from here it answers at jupyterlab.<your domain>. Everything lives in the stack's data folder: notebooks and files at its top, the workspace in hub/ (pixi.toml, pixi.lock and jupyter_server_config.py), seeded with Python 3.12 and JupyterLab when missing. Add packages to hub/pixi.toml; the environment is built on first start, which takes a few minutes.

Sign in with the token you type at install; a token set in hub/jupyter_server_config.py wins over it.`;

export const jupyterlab: AppDef = {
  id: "jupyterlab",
  source: "phosphorus",
  ref: "jupyterlab",
  name: "JupyterLab",
  tagline: "notebooks, a terminal and an editor in the browser",
  description: jupyterlabAbout,
  icon: "https://raw.githubusercontent.com/jupyterlab/jupyterlab/main/packages/ui-components/style/icons/jupyter/jupyter.svg",
  category: "developer",
  repo: "https://github.com/jupyterlab/jupyterlab",
  licence: "BSD-3-Clause",
  archs: ["amd64", "arm64"],
  compose: jupyterlabCompose,
  env: envFields(jupyterlabCompose, [
    { name: "HTTP_PORT", label: "web port on the host", default: "8888" },
    { name: "JUPYTER_TOKEN", label: "token to sign in with (type one to know it)", secret: true },
  ]),
  manifest: {
    volumes: [{ service: "jupyterlab", target: "/lab", kind: "data" }],
    health: { service: "jupyterlab", path: "/api", port: 8888 },
    web: { service: "jupyterlab", port: 8888 },
  },
};

export const apps: AppDef[] = [forgejo, tavern, circuit, jellyfin, audiobookshelf, jupyterlab];

export const source: SourceInfo = {
  id: "phosphorus",
  name: "phosphorus",
  repo: "https://github.com/pmghartman/phosphorus",
  licence: "Apache-2.0",
  apps: apps.length,
  fetchedAt: 0,
};

// an app's files as the page lists them
export const tree = (ref: string): TreeEntry[] =>
  apps.some((a) => a.ref === ref) ? [{ path: "docker-compose.yml", type: "file" }] : [];
