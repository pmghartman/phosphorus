<img src="apps/web/static/phosphorus-ascii.svg" alt="" width="280">

# Phosphorus

**A self-hosted service installer for every computer you own.**

<p>
  <a href="https://github.com/pmghartman/phosphorus/releases/latest"><img alt="release" src="https://img.shields.io/github/v/release/pmghartman/phosphorus?style=flat-square&color=a371f7"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/github/license/pmghartman/phosphorus?style=flat-square&color=f0883e"></a>
  <img alt="platforms" src="https://img.shields.io/badge/macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-555?style=flat-square">
</p>

Install Phosphorus on each machine and they find each other over your tailnet. Then pick an app, see at a glance whether it installs, and install it with one click onto any host. Choose one or more backup hosts, and if the main one goes down a backup takes over.

> **Status:** Phosphorus is being reshaped around the installer. Items marked *(in progress)* are being built on `main` now and are not in a release yet.

## Quick start

1. Grab Phosphorus from the [**latest release**](https://github.com/pmghartman/phosphorus/releases/latest); it has install steps for every platform.
2. On each machine, give it a free [Tailscale](https://tailscale.com) auth key when `phos` asks.
3. Run `phos`. It shows this host's state and a link to the web desktop; open that link from any device on your tailnet.

## Core

What every install has.

- **App installer** *(in progress)*. Browse apps from the catalogues below, or paste any public GitHub repo that has a Compose file. Each app's page shows its README, its files and its Compose file, then runs a quick check: images for your hosts' CPU, free ports, the settings it needs, and anything risky (privileged, host network). If it passes, install it onto the host you pick with one click. It runs under Docker Compose with its data kept in one folder, and its page gets its own subdomain.
- **Git.** [Forgejo](https://forgejo.org) is the first app on the services tab, written for the mesh: it answers at `forgejo.<your domain>` and, as before, `git.<your domain>`, keeps its sqlite database, repositories and LFS objects in its data folder, and with standby hosts each keeps a copy taken after a consistent `.backup` of the database. See [Git](#git).
- **Backup hosts** *(in progress)*. When installing, pick one or more standby hosts. They keep a fresh copy of the app's data and take over automatically if the main host fails. "Move to host…" hands an app over cleanly for maintenance.
- **Your own services, found.** Web pages already listening on any host are found and can be published on the mesh in one click, behind the Phosphorus login or public.
- **Terminal.** One tabbed window that opens a shell on any host.
- **Files.** Your folders on each host *(being simplified, with one home synced to every host, in progress)*.
- **Settings** *(in progress)*. Profile, appearance, users, agents, hosts and their status, updates, about.
- **An MCP server**, so Claude can work your mesh for you.
- **Mesh updates.** Every host updated from one place.

## Optional apps

Off by default. An admin installs them from the Apps page, and every host serves its own copy, signed and checked before it runs.

| App | What it does | Status |
|---|---|---|
| Code | Claude Code or opencode sessions in a folder on any host, run there as your own login, on the mesh's models or your Claude subscription | installable, [`optional/code`](optional/code) |
| Chat | Mesh-wide chat with channels, direct messages, attachments and agents posting through the MCP tools, every host holding the whole history | installable, [`optional/chat`](optional/chat) |
| Games | Game servers you start and stop from the desktop or an agent, each run on its host as a login an admin allowed, with join addresses on the tailnet | installable, [`optional/games`](optional/games) |
| Viewer | Images with zoom, video, audio and PDFs from any host's files, plus a plain text editor; opening a file in Files opens it here, without it files download | installable, [`optional/viewer`](optional/viewer) |

Each optional app lives in [`optional/<id>`](optional) and is built into a signed bundle with `bun run app <id> OUT VERSION`.

## App catalogues

The installer reads these catalogues at run time, fetching them from their own repos on your host. Their files are never copied into this repo, and every app shows its source and licence. Phosphorus's own few apps ship with it.

| Catalogue | Licence | Used |
|---|---|---|
| Phosphorus's own ([`packages/mesh/catalog/src/featured.ts`](packages/mesh/catalog/src/featured.ts)): Forgejo | Apache-2.0 (the app: GPL-3.0-or-later) | yes, shipped |
| [CasaOS App Store](https://github.com/IceWhaleTech/CasaOS-AppStore) | Apache-2.0 | yes |
| [Runtipi App Store](https://github.com/runtipi/runtipi-appstore) | GPL-3.0 | yes, fetched at run time only |
| [Cosmos servapps](https://github.com/azukaar/cosmos-servapps-official) | AGPL-3.0 | yes, fetched at run time only |
| Umbrel apps | none stated | no |

App logos belong to their projects and are loaded from the catalogue, not shipped.

## Git

Install **Forgejo** from the services tab onto any host with Docker, and pick standby hosts to keep copies. It answers at `forgejo.<your domain>`, and at `git.<your domain>` as an alias so old remotes keep working; the first account registered is the admin. SSH clones go to port 2222 (or the one you pick) of the host serving it, over the tailnet. The MCP `forgejo` tool calls its API as you, with the login saved as the `forgejo` page login (one saved as `git` still works).

### Moving from the built-in git

Earlier versions ran Forgejo themselves on the hosts with `[git] host = true`, its data in `/var/lib/phosphorus/git`. That code is gone; the data stays where it is until you delete it.

On first start of this version the services tab offers admins the move, and installing Forgejo from its page does the same: the old master's data (the copy with the newest version) is copied into Forgejo's data folder on that host, owned by the stack's user, Forgejo installed there with the old servants as standbys, its secret key and internal token carried over. Once `forgejo.<your domain>` shows your repos, press **delete the old copies**; nothing is deleted before that.

By hand instead, as root on the old master (the host whose `/var/lib/phosphorus/git/GIT_VERSION` has the highest first number):

```sh
old=/var/lib/phosphorus/git new=/var/lib/phosphorus/stacks/forgejo/data/forgejo
mkdir -p $new/gitea/conf $new/git
cp -a $old/db/forgejo.db $new/gitea/
cp -a $old/obj/forgejo-repositories $new/git/repositories
[ -d $old/obj/lfs ] && cp -a $old/obj/lfs $new/git/lfs
for d in $old/obj/*; do case ${d##*/} in forgejo-repositories|lfs|tmp) ;; *) cp -a $d $new/gitea/ ;; esac; done
chown -R 1000:1000 $new
[ -d $old/custom ] && cp -a $old/custom/. $new/gitea/
sed -e "s#$old/obj/forgejo-repositories#/data/git/repositories#g" -e "s#$old/obj/lfs#/data/git/lfs#g" \
    -e "s#$old/db/forgejo.db#/data/gitea/forgejo.db#g" -e "s#$old/[a-z]*#/data/gitea#g" -e "s#$old#/data/gitea#g" \
    -e 's#^RUN_USER *=.*#RUN_USER = git#' -e '/^WORK_PATH *=/d' $old/conf/app.ini > $new/gitea/conf/app.ini
grep -E '^(SECRET_KEY|INTERNAL_TOKEN)' $new/gitea/conf/app.ini
```

Then open Forgejo on the services tab and press **install it empty instead**, on that host with the old git hosts as standbys, giving it the secret key and internal token printed above. In Forgejo's site administration, run *Resynchronize pre-receive, update and post-receive hooks of all repositories* once. When it serves your repos, remove `/var/lib/phosphorus/git` and the `phosphorus-git` user on each old git host, or press **delete the old copies** on the services tab.

## The `phos` command

Kept small on purpose; everything else is in the web desktop.

```
phos            this host's state and the link to the web desktop (asks for keys on a new host)
phos keys       change this host's keys (Tailscale, domain, tunnel, admin password)
phos start | stop | restart
phos status
phos update     update this host
phos uninstall
phos version | help
```

## Repository layout

| Path | What's there |
|---|---|
| [`apps/`](apps) | The programs that ship: `host` (the `phosphorus` binary and `phos`), `tray` (macOS and Windows menu-bar app), `web` (the desktop page) |
| [`packages/`](packages) | The core's libraries, by area: `core` (shared types, theme, app SDK), `mesh` (peers, store, election, installer, updates, users), `net`, `host`, `home`, `server`, `ai`, `chat` |
| [`optional/`](optional) | Optional apps, one folder each, built into signed bundles |
| [`scripts/`](scripts) | Build, test, licences, icons and app bundles |
| [`packaging/`](packaging) | Installers for each platform |
| [`config/`](config) | Per-host config defaults: `phosphorus.ini`, `services.export` |

```bash
bun install
bun run check   # dependency links and types
bun run test
bun run web     # build the desktop page
```

## License

Apache 2.0, see [`LICENSE`](LICENSE). Bundled software keeps its own license; full texts ship in each installer as `THIRD_PARTY_NOTICES.txt`, generated at build time by `bun run licenses`.

<p align="center">
  <img src=".github/assets/wright-alchemist.jpg" alt="The Alchemist Discovering Phosphorus, Joseph Wright of Derby" width="420">
</p>

<p align="center"><sub><i>The Alchymist, In Search of the Philosopher's Stone, Discovers Phosphorus</i>, Joseph Wright of Derby, 1771: Hennig Brand in 1669. Public domain, via <a href="https://commons.wikimedia.org/wiki/File:Joseph_Wright_of_Derby_The_Alchemist.jpg">Wikimedia Commons</a>.</sub></p>
