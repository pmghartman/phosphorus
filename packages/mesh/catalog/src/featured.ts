// phosphorus's own few apps, shipped with it rather than fetched: each written for
// the mesh, its manifest whole (data, the backup hooks, health, the web page)
import type { AppDef, SourceInfo, TreeEntry } from "@phosphorus/wire";
import { envFields } from "./manifest.ts";

// Forgejo as the mesh's git, its route forgejo.<domain> and git.<domain> as before. The image's own layout under
// /data: gitea/ the custom dir, app.ini, the sqlite db and app data, git/ the
// repositories and LFS. Queues in memory, the issue index in the db and the log on
// stdout, so nothing rebuildable is copied to standbys. On start a db failing its
// check (a standby's copy taken mid-write) is swapped for the last backup.
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
volumes:
  forgejo: {}
`;

const forgejoAbout = `Forgejo is a self-hosted git forge: repositories, issues, pull requests, packages and CI.

Installed from here it answers at forgejo.<your domain>, and at git.<your domain> too. Its data (the sqlite database, the repositories, LFS objects and avatars) lives in the stack's data folder; pick standby hosts and each keeps a copy, taken after a consistent sqlite \`.backup\` of the database, ready to take over.

SSH clones go to port 2222 (or the one you pick) of the host serving it, and the first account registered is the admin.`;

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
    { name: "HTTP_PORT", label: "Web port on the host", default: "3001" },
    { name: "SSH_PORT", label: "SSH port on the host", default: "2222" },
    { name: "SECRET_KEY", label: "Secret key", secret: true },
    { name: "INTERNAL_TOKEN", label: "Internal token", secret: true },
  ]),
  manifest: {
    volumes: [{ service: "forgejo", target: "/data", kind: "data" }],
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

export const apps: AppDef[] = [forgejo];

export const source: SourceInfo = {
  id: "phosphorus",
  name: "Phosphorus",
  repo: "https://github.com/pmghartman/phosphorus",
  licence: "Apache-2.0",
  apps: apps.length,
  fetchedAt: 0,
};

// an app's files as the page lists them
export const tree = (ref: string): TreeEntry[] =>
  apps.some((a) => a.ref === ref) ? [{ path: "docker-compose.yml", type: "file" }] : [];
